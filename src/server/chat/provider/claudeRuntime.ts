// Kawai's Claude chat driver over @motuslabs/agent-runtime (task 6.1). The
// package owns the SDK session (turns, requests, frames, usage, workers,
// tasks); Kawai keeps what is Kawai's:
// - one package driver per agent process, the profile, model, effort and
//   prompt read per spawn (a refused name or unknown profile refuses that
//   start or send synchronously). A respawn quiesces the old owner strictly
//   (runtimeBoot.ts) and resumes the saved session id.
// - approvals and questions: team tools granted silently, the auto policy
//   without a card; question deadlines and holds are Kawai's timers
//   (claudeQuestionDeadlines.ts), a due one answering with Kawai's note (R5).
// - R4: a workspace context is recorded at the package's pre-submit commit
//   (its turn id), then rides `pasted_content`; a peer turn carries `origin`.
//   A refused record enqueues nothing and reads as Kawai's error text.
// - R10: a send made during an active turn is recorded and shown under that
//   turn at its admission, in order; a later turn running it opens as
//   resumed (queuedEchoes.ts).
// - GAP8: a later process's first spawn re-anchors the last forwarded
//   context reading on its profile window, as a correction, before its first
//   frame (claudeContextMirror.ts).
// - recovered worker and task rows under the live rosters; a task's output
//   file stays in the sidecar records only (D); Kawai's event identity,
//   statuses, spawn provenance, outbound audit and error texts.
// Every package promise and every promise a host callback returns, the
// direct onEvent/onStatus publications included, is owned (runtimeOwnership.ts); `settled()` joins them, re-acquires a terminal call
// refused from inside a callback (TerminalJoin), and reports raw failures once.
import type { AgentEvent, BackgroundTask, ClaudeAgentDriver, ClaudeDriverOptions, PendingRequest, Worker } from '@motuslabs/agent-runtime'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import type { ChatApprovalDecision, ChatApprovalPolicy, ChatBackgroundTask, ChatCommandState, ChatPeerMessage, ChatPendingRequest, ChatQuestion, ChatQuestionAnswer, ChatWorker } from '../../../shared/chat'
import type { WorkspaceMessageContext } from '../../../shared/planWorkspace'
import type { SessionStatus } from '../../../shared/types'
import { TEAM_ALLOWED_TOOLS, type TeamToolSpec } from '../../team/mailboxTools'
import { formatEnvelope } from '../../team/envelope'
import { decideApproval } from '../approvalPolicy'
import type { BackgroundTaskRecord } from '../chatBackgroundTasks'
import type { ChatSessionDriverOptions } from '../ChatSessionDriver'
import { realTimerScheduler } from '../timerScheduler'
import type { ChatAgentDriver, ChatSendOutcome } from './driver'
import { auditDeniedCard, auditHookReplay, auditSpawnEnd, claudeSpawnLaunch, createClaudeRuntime, launchFields, teamToolSet, type CreateClaudeRuntime } from './claudeRuntimeLaunch'
import { QuestionDeadlines } from './claudeQuestionDeadlines'
import { callKey, forwardedCallbacks, mergedTaskRecords, mergedTasks, mergedWorkers, promptEnvelope, recordedContext, resolvedDraft, timeoutNote } from './claudeRuntimeViews'
import { requestOutcome } from './codexRuntimeSupport'
import { ChatEventSequencer, chatDraftOf, type ChatEventDraft } from './runtimeEvents'
import { OwnedWork, TerminalJoin, outsideRuntime } from './runtimeOwnership'
import { DeliveredTurns } from './deliveredTurns'
import { QueuedEchoes } from './queuedEchoes'
import { RuntimeBoot } from './runtimeBoot'
import { ClaudeContextMirror } from './claudeContextMirror'

/** The adapter's options: the old driver's, with the query factory only when injected. */
export type ClaudeChatDriverOptions = Omit<ChatSessionDriverOptions, 'queryFactory' | 'teamMcpServer'> &
  Partial<Pick<ChatSessionDriverOptions, 'queryFactory'>> & {
    /** The team tool table, bound as one host ToolSet (the old driver took an SDK MCP server). */
    teamTools?: readonly TeamToolSpec[]
  }

/** The package's own unexpected-exit error; Kawai reports the exit once, at onProcessEnd. */
const PROCESS_EXIT = 'the agent process exited unexpectedly'
const KILLED = 'This session was killed; the message was not sent.'
const WITHDRAWN = 'The message was not sent: it was interrupted before the agent started.'

export function createClaudeChatDriver(options: ClaudeChatDriverOptions, create: CreateClaudeRuntime = createClaudeRuntime): ChatAgentDriver & { settled(): Promise<void> } {
  return new ClaudeChatDriver(options, create)
}

class ClaudeChatDriver implements ChatAgentDriver {
  private readonly boot: RuntimeBoot<ClaudeAgentDriver>
  private killed = false
  private dead = false
  private sessionId: string | null
  private projectPath: string
  private executablePath: string | undefined
  private readonly sequencer = new ChatEventSequencer()
  private readonly owned: OwnedWork
  private activeTurnId: string | null = null
  private sending = 0
  private lastStatus: SessionStatus | null = null
  /** Loading until the first spawn reports its commands, as the old driver's tracker (and the package's) start. */
  private commandState: ChatCommandState = { status: 'loading', commands: [] }
  private spawnId = 'ob-s-none'
  private spawnOpen = false
  private readonly seenToolCallIds = new Set<string>()
  /** The latest tool call per tool and input, for a card's audit row. */
  private readonly toolCalls = new Map<string, string>()
  private readonly cards = new Map<string, { tool: string; input: unknown; toolCallId: string }>()
  /** Requests Kawai settles itself (team tools, the auto policy): no card, no pending entry. */
  private readonly granted = new Map<string, 'silent' | 'policy'>()
  private readonly deadlines: QuestionDeadlines
  private readonly peers = new Map<string, ChatPeerMessage>()
  /** A delivery's turn opens at deliver() (deliveredTurns.ts). */
  private readonly delivered = new DeliveredTurns((draft) => this.emit(draft))
  /** A send queued behind the active turn shows where it was admitted (queuedEchoes.ts). */
  private readonly echoes = new QueuedEchoes(
    (draft, at) => this.owned.hosted('onEvent', () => this.options.onEvent(this.sequencer.stamp(draft, at))),
    (error) => void this.owned.track('callback:onEvent', Promise.reject(error)),
  )
  /** Interrupts so far: a send still waiting for its driver when one lands is withdrawn. */
  private interrupts = 0
  /** Contextual sends by message UUID: the context to record, then the live event's attachment. */
  private readonly contexts = new Map<string, WorkspaceMessageContext>()
  /** A refused record's Kawai text, by message UUID, for the refused send's error. */
  private readonly refusals = new Map<string, string>()
  private readonly terminals: TerminalJoin
  private liveWorkers: Worker[] = []
  private liveTasks: BackgroundTask[] = []
  private readonly recoveredWorkers: ChatWorker[]
  private readonly recoveredTasks: BackgroundTaskRecord[]
  private readonly audit
  private readonly contextMirror = new ClaudeContextMirror()

  constructor(private readonly options: ClaudeChatDriverOptions, private readonly create: CreateClaudeRuntime) {
    this.sessionId = options.resumeSessionId ?? null
    this.projectPath = options.projectPath
    this.executablePath = options.claudeExecutablePath
    this.owned = new OwnedWork(options.sessionId)
    this.terminals = new TerminalJoin(this.owned)
    this.boot = new RuntimeBoot(this.owned, () => this.killed, 'the previous agent process did not stop cleanly')
    // R5: a due deadline answers through the package with Kawai's note as the response.
    this.deadlines = new QuestionDeadlines(options.timerScheduler ?? realTimerScheduler, () => options.getQuestionAutoAnswerMs?.() ?? 0, (requestId, deadline) => {
      if (!this.killed && !this.dead) this.boot.current?.answerQuestion(requestId, deadline.answers, { decidedBy: 'timeout', response: timeoutNote(deadline.waitMs) })
    })
    this.recoveredWorkers = (options.recoveredWorkers ?? []).map((row) => ({ ...row, live: false }))
    this.recoveredTasks = options.recoveredBackgroundTasks ?? []
    this.audit = auditHookReplay({ sink: options.outbound, spawnId: () => this.spawnId, cwd: () => this.projectPath })
  }

  get isDead(): boolean {
    return this.dead
  }

  /** Joins every owned promise (A5) and a re-acquired terminal call; raw failures once (TerminalJoin). */
  settled(): Promise<void> {
    return this.terminals.settled()
  }

  getCommandState(): ChatCommandState {
    return this.commandState
  }

  start(): void {
    if (this.killed) return
    void this.ensure()
  }

  setClaudeExecutablePath(path: string | undefined): void {
    this.executablePath = path
  }

  setProjectPath(path: string): void {
    this.projectPath = path
  }

  send(text: string): void {
    if (this.killed) return
    void this.submit(text, crypto.randomUUID())
  }

  /**
   * A contextual send (plan-workspace §4): the record is the package's
   * pre-submit decision for this UUID, so a refusal opens, emits and
   * enqueues nothing; the live user event carries the context.
   */
  sendWorkspaceContext(text: string, context: WorkspaceMessageContext): Promise<ChatSendOutcome> {
    if (this.killed) return Promise.resolve({ ok: false, error: KILLED })
    const messageUuid = crypto.randomUUID()
    this.contexts.set(messageUuid, context)
    return this.submit(text, messageUuid, context)
  }

  deliver(envelope: ChatPeerMessage): void {
    if (this.killed) throw new Error('Recipient was killed')
    if (this.activeTurnId || this.sending > 0 || this.pendingCount() > 0 || this.liveWorkers.some((w) => w.live)) throw new Error('Recipient is not idle')
    const messageUuid = crypto.randomUUID()
    this.peers.set(messageUuid, envelope)
    const sent = this.submit(formatEnvelope(envelope), messageUuid)
    const turnId = (this.activeTurnId = this.delivered.open(envelope))
    void sent.then((outcome) => {
      if (!outcome.ok && this.delivered.abandon() === turnId && this.activeTurnId === turnId) this.activeTurnId = null
      this.refreshStatus()
    })
  }

  async interrupt(): Promise<void> {
    this.deadlines.clearAll()
    // Sends still waiting for the driver are withdrawn; a delivery the package has not opened closes here.
    this.interrupts += 1
    if (this.delivered.abandon(true) === this.activeTurnId) this.activeTurnId = null
    const inner = this.boot.live
    if (!inner) {
      this.refreshStatus()
      return
    }
    await this.owned.track('interrupt', inner.interrupt())
    this.refreshStatus()
  }

  kill(): void {
    this.stop('kill')
  }

  shutdown(): void {
    this.stop('shutdown')
  }

  onApprovalPolicyChanged(policy: ChatApprovalPolicy): void {
    if (policy !== 'auto') return
    const inner = this.boot.current
    for (const request of inner?.pendingRequests() ?? []) {
      if (request.kind !== 'approval' || this.granted.has(request.requestId)) continue
      this.granted.set(request.requestId, 'policy')
      inner!.resolveApproval(request.requestId, 'allow', { decidedBy: 'policy' })
    }
    this.refreshStatus()
  }

  resolveApproval(requestId: string, decision: ChatApprovalDecision): { ok: true } | { ok: false; error: string } {
    return requestOutcome(this.granted.has(requestId) ? undefined : this.boot.current?.resolveApproval(requestId, decision === 'allow' ? 'allow' : 'deny'), 'approval', requestId)
  }

  answerQuestion(requestId: string, answers: Record<string, ChatQuestionAnswer>): { ok: true } | { ok: false; error: string } {
    const outcome = this.boot.current?.answerQuestion(requestId, answers)
    if (outcome?.ok) this.deadlines.clear(requestId)
    return requestOutcome(outcome, 'question', requestId)
  }

  holdQuestion(requestId: string): { ok: true } | { ok: false; error: string } {
    const request = (this.boot.current?.pendingRequests() ?? []).find((r) => r.requestId === requestId && !this.granted.has(r.requestId))
    if (!request) return { ok: false, error: `No pending question with id ${requestId}; it may already be answered or cancelled` }
    if (request.kind !== 'question') return { ok: false, error: `Request ${requestId} is not a question` }
    if (!this.deadlines.get(requestId)) return { ok: false, error: `Request ${requestId} has no auto-answer deadline to hold` }
    this.deadlines.clear(requestId)
    this.emit({ type: 'question_auto_answer_held', requestId })
    return { ok: true }
  }

  getPendingRequests(): ChatPendingRequest[] {
    return (this.boot.current?.pendingRequests() ?? []).filter((r) => !this.granted.has(r.requestId)).map((request) => this.pendingOf(request))
  }

  getSeenToolCallIds(): Set<string> {
    return new Set(this.seenToolCallIds)
  }

  getWorkers(): ChatWorker[] {
    return mergedWorkers(this.liveWorkers, this.recoveredWorkers)
  }

  /** The client roster: never an output file (contract D). */
  getBackgroundTasks(): ChatBackgroundTask[] {
    return mergedTasks(this.liveTasks, this.recoveredTasks)
  }

  /** The sidecar records: the observed output file, else the recovered one. */
  getBackgroundTaskRecords(): BackgroundTaskRecord[] {
    return mergedTaskRecords(this.liveTasks, this.recoveredTasks)
  }

  async getTaskOutput(taskId: string): Promise<{ output: string; total_bytes: number; truncated: boolean } | null> {
    const inner = this.boot.live
    if (!inner) return null
    const output = await this.owned.track('task-output', inner.getTaskOutput(taskId))
    return output ? { output: output.output, total_bytes: output.totalBytes, truncated: output.truncated } : null
  }

  async stopTask(taskId: string): Promise<boolean> {
    const inner = this.boot.live
    if (!inner) return false
    return (await this.owned.track('stop-task', inner.stopTask(taskId))) ?? false
  }

  // ---------------------------------------------------------------- internals

  /**
   * One submission; settles with its admission (the caller-admission
   * invariant): ok once the package committed it, else why nothing was
   * opened, emitted or enqueued. A refused record is that outcome alone —
   * Kawai's own decision, no error event and no owned failure; any other
   * failure keeps its error event and stays owned raw.
   */
  private submit(text: string, messageUuid: string, context?: WorkspaceMessageContext): Promise<ChatSendOutcome> {
    // A refused profile or registered name throws here, before anything is accepted.
    const ready = this.ensure()
    const epoch = this.interrupts
    this.sending += 1
    this.refreshStatus()
    const job = ready.then(async (inner): Promise<ChatSendOutcome> => {
      if (!inner || this.killed || epoch !== this.interrupts) return { ok: false, error: this.killed ? KILLED : inner ? WITHDRAWN : 'The agent process did not start; the message was not sent.' }
      // Queued behind an active turn, else a new turn (the package decides at its commit).
      this.echoes.submitted(messageUuid)
      let handle: Awaited<ReturnType<ClaudeAgentDriver['send']>>
      try {
        handle = await inner.send(text, { messageUuid, ...(context ? { context: context as never } : {}), continuation: 'queue' })
      } catch (error) {
        this.echoes.settled(messageUuid, null)
        throw error
      }
      this.echoes.settled(messageUuid, { turnId: handle.turnId, text, ...(context ? { context } : {}) })
      void this.owned.track('turn', handle.result.finally(() => this.echoes.forget(messageUuid, handle.turnId)))
      return { ok: true }
    })
    const outcome = job.catch((error: unknown): ChatSendOutcome => {
      const refused = this.refusals.get(messageUuid)
      if (refused) return { ok: false, error: refused }
      const message = `The message was not sent: ${error instanceof Error ? error.message : String(error)}`
      if (!this.killed && !(error instanceof AgentRuntimeError && error.code === 'interrupted')) this.emit({ type: 'error', message })
      void this.owned.track('send', Promise.reject(error))
      return { ok: false, error: message }
    }).finally(() => {
      this.contexts.delete(messageUuid)
      this.refusals.delete(messageUuid)
      this.peers.delete(messageUuid)
      this.sending -= 1
      this.refreshStatus()
    })
    void this.owned.track('send', outcome)
    return outcome
  }

  /** The live package driver, building one when none runs (see the header). */
  private ensure(): Promise<ClaudeAgentDriver | null> {
    return this.boot.ensure(() => {
      const spawn = claudeSpawnLaunch({ ...this.options, projectPath: this.projectPath, claudeExecutablePath: this.executablePath, injected: Boolean(this.options.queryFactory) })
      this.dead = false
      return () => this.create(this.innerOptions(spawn), this.options.queryFactory, this.options.wire)
    }, (error) => {
      const cause = error instanceof AgentRuntimeError && error.causes[0] instanceof Error ? error.causes[0] : error
      this.markDead(`The agent process failed to start: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
  }

  private innerOptions(spawn: ReturnType<typeof claudeSpawnLaunch>): ClaudeDriverOptions {
    const options = this.options
    const prompt = options.getSystemPromptAppend?.() ?? ''
    const effort = options.getEffort?.()
    const tools = teamToolSet(options.teamTools)
    return {
      ...launchFields(options, spawn),
      ...(this.sessionId ? { resume: { runtime: 'claude' as const, runtimeSessionId: this.sessionId } } : {}),
      ...(spawn.model ? { model: spawn.model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(prompt ? { systemPromptAppend: prompt } : {}),
      ...(tools ? { tools } : {}),
      beforeSubmit: (submission) => {
        // During an active turn the package commits this send as queued in the same step: it is
        // recorded and shown under the active turn, as the old driver did (queuedEchoes.ts).
        const display = this.boot.current?.state === 'active' ? this.activeTurnId : null
        const context = this.contexts.get(submission.messageUuid)
        const refusal = context ? recordedContext(options, display ? { ...submission, turnId: display } : submission, context) : null
        if (refusal) this.refusals.set(submission.messageUuid, refusal)
        else if (display) this.echoes.hold(submission.messageUuid, display)
        return refusal ? { accepted: false, reason: refusal } : { accepted: true }
      },
      composePrompt: (submission) => promptEnvelope(submission, this.peers.get(submission.messageUuid)),
      auditHooks: { onHook: (event) => this.audit(event.kind, event.input) },
      callbacks: this.callbacks(),
    }
  }

  private callbacks(): ClaudeDriverOptions['callbacks'] {
    const options = this.options
    const hosted = (label: string, fn: () => unknown) => this.owned.hosted(label, fn)
    return {
      onEvent: (event) => this.onRuntimeEvent(event),
      onState: () => this.refreshStatus(),
      onRequest: (request) => {
        const how = this.granted.get(request.requestId)
        if (request.kind === 'approval' && how) this.boot.current?.resolveApproval(request.requestId, 'allow', { decidedBy: how === 'silent' ? 'team' : 'policy' })
        else if (request.kind === 'question') this.ask(request)
      },
      // The critical identity persistence: the host's own promise is the barrier; run outside the callback ancestry (outsideRuntime).
      onCheckpoint: (checkpoint) => {
        if (checkpoint.runtimeSessionId === this.sessionId) return
        this.sessionId = checkpoint.runtimeSessionId
        return outsideRuntime(() => options.onSdkSessionId?.(checkpoint.runtimeSessionId)) as void
      },
      ...forwardedCallbacks(options, hosted),
      // The respawn mirror (claudeContextMirror.ts) is updated before the host sees the reading.
      onContextUsage: (usage, meta) => {
        this.contextMirror.observe(usage, meta)
        hosted('onContextUsage', () => options.onContextUsage?.(usage, meta))
      },
      onWorkers: (workers) => {
        this.liveWorkers = workers
        hosted('onWorkers', () => options.onWorkers?.(this.getWorkers()))
        this.refreshStatus()
      },
      onBackgroundTasks: (tasks) => {
        this.liveTasks = tasks
        hosted('onBackgroundTasks', () => options.onBackgroundTasks?.(this.getBackgroundTasks()))
      },
      onCommandState: (state) => {
        this.commandState = state
        hosted('onCommandState', () => options.onCommandState?.(state))
      },
      onSpawn: (info) => {
        this.spawnId = `ob-s-${crypto.randomUUID()}`
        this.spawnOpen = true
        // A later process's first spawn re-anchors the retained reading before any of its frames (GAP8).
        const correction = this.contextMirror.spawned(info.generation, info.childEnv)
        if (correction) hosted('onContextUsage', () => options.onContextUsage?.(correction.usage, correction.meta))
        hosted('onSpawn', () => options.onSpawn?.({ cwd: info.cwd, systemPromptAppend: info.systemPromptAppend, effort: info.effort, model: info.model, env: { ...info.childEnv }, resumed: info.resumed }))
      },
      onProcessEnd: (report) => {
        this.boot.exited(report)
        this.markDead('The agent process exited unexpectedly')
      },
    }
  }

  private onRuntimeEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'approval_request': {
        // The request's native tool-call ID first; the stream's tool_use map only when the runtime gave none.
        const toolCallId = event.toolCallId ?? this.toolCalls.get(callKey(event.tool, event.input)) ?? ''
        this.cards.set(event.requestId, { tool: event.tool, input: event.input, toolCallId })
        if (TEAM_ALLOWED_TOOLS.includes(event.tool)) this.granted.set(event.requestId, 'silent')
        else if (decideApproval(this.options.getApprovalPolicy?.() ?? 'manual', event.tool) === 'allow') this.granted.set(event.requestId, 'policy')
        else this.emit({ type: 'approval_request', turnId: event.turnId, requestId: event.requestId, tool: event.tool, input: event.input as Record<string, unknown> }, event.at)
        break
      }
      case 'question_request':
        // Emitted with its deadline once onRequest armed it (same dispatch).
        break
      case 'request_resolved': {
        const card = this.cards.get(event.requestId)
        this.cards.delete(event.requestId)
        const how = this.granted.get(event.requestId)
        this.granted.delete(event.requestId)
        const deadline = this.deadlines.get(event.requestId)
        this.deadlines.clear(event.requestId)
        if (how === 'silent') break
        if (card && (event.outcome === 'denied' || event.outcome === 'cancelled')) auditDeniedCard(this.options.outbound, card, { spawnId: this.spawnId, cwd: this.projectPath, interrupted: event.outcome === 'cancelled' })
        this.emit(resolvedDraft(event, how === 'policy', card?.tool, deadline?.answers), event.at)
        break
      }
      case 'user_message': {
        // A delivery's peer message was shown when deliver() opened its turn.
        if (this.peers.delete(event.messageUuid)) break
        // A queued send shows where it was admitted.
        if (!this.echoes.shown(event.messageUuid)) break
        const context = this.contexts.get(event.messageUuid)
        this.emit({ type: 'user_message', turnId: event.turnId, text: event.text, messageUuid: event.messageUuid, ...(context ? { workspaceContext: context } : {}) }, event.at)
        break
      }
      case 'error':
        // An unexpected exit is reported once, by onProcessEnd.
        if (event.error.message !== PROCESS_EXIT) this.emit({ type: 'error', message: event.error.message }, event.at)
        break
      default: {
        if (event.type === 'turn_started') {
          const absorbed = this.delivered.started(event.turnId, Boolean(event.trigger))
          this.activeTurnId = this.delivered.shownId(event.turnId)
          if (absorbed) break
        }
        if (event.type === 'turn_completed' || event.type === 'turn_interrupted') this.activeTurnId = null
        if (event.type === 'tool_call') {
          this.seenToolCallIds.add(event.toolCallId)
          this.toolCalls.set(callKey(event.tool, event.input), event.toolCallId)
        }
        const draft = chatDraftOf(event)
        if (draft) this.emit(draft, event.at)
        if (event.type === 'turn_completed' || event.type === 'turn_interrupted') this.delivered.ended(event.turnId)
      }
    }
    this.refreshStatus()
  }

  /** A question's card, with its deadline when one is armed (question-auto-answer D2). */
  private ask(request: Extract<PendingRequest, { kind: 'question' }>): void {
    const questions = request.questions as ChatQuestion[]
    if (!this.killed && !this.dead) this.deadlines.arm(request.requestId, request.at, questions)
    this.emit({ type: 'question_request', turnId: request.turnId, requestId: request.requestId, questions, ...this.deadlines.autoAnswer(request.requestId) }, request.at)
  }

  private pendingOf(request: PendingRequest): ChatPendingRequest {
    if (request.kind === 'approval') return { kind: 'approval', requestId: request.requestId, tool: request.tool, input: request.input as Record<string, unknown>, at: request.at }
    return { kind: 'question', requestId: request.requestId, questions: request.questions as ChatQuestion[], at: request.at, ...this.deadlines.autoAnswer(request.requestId) }
  }

  private pendingCount(): number {
    return this.getPendingRequests().length
  }

  /** The process is gone or never started: the next start or send respawns with resume. */
  private markDead(reason: string): void {
    this.dead = true
    this.activeTurnId = null
    this.deadlines.clearAll()
    this.endSpawn()
    this.liveWorkers = this.liveWorkers.map((worker) => ({ ...worker, live: false }))
    this.liveTasks = this.liveTasks.map((task) => ({ ...task, live: false }))
    this.owned.hosted('onProcessEnd', () => this.options.onProcessEnd?.())
    this.emit({ type: 'error', message: reason })
    this.commandState = { status: 'unavailable', commands: [] }
    this.owned.hosted('onCommandState', () => this.options.onCommandState?.(this.commandState))
    this.refreshStatus()
  }

  private stop(how: 'kill' | 'shutdown'): void {
    if (this.killed) {
      // A later outside call owns the terminal join an inner call could not.
      this.terminals.reacquire()
      return
    }
    this.killed = true
    this.deadlines.clearAll()
    const inner = this.boot.current
    const booting = this.boot.booting
    if (inner && this.boot.live) this.terminals.begin(how, () => inner[how]())
    else if (booting) void this.owned.track(how, booting.then((started) => void (started && this.terminals.begin(how, () => started[how]()))))
    else if (inner) this.terminals.begin('kill', () => inner.kill())
    this.activeTurnId = null
    this.endSpawn()
    this.refreshStatus()
  }

  private endSpawn(): void {
    if (!this.spawnOpen) return
    this.spawnOpen = false
    auditSpawnEnd(this.options.outbound, this.spawnId)
  }

  private refreshStatus(): void {
    // While Kawai's view is held for a queued send, the status follows it (submit's settle refreshes).
    if (this.echoes.holding) return
    const next: SessionStatus = this.pendingCount() > 0 ? 'permission' : this.activeTurnId || this.sending > 0 || this.liveWorkers.some((w) => w.live) ? 'working' : 'waiting'
    if (next === this.lastStatus) return
    this.lastStatus = next
    this.owned.hosted('onStatus', () => this.options.onStatus(next))
  }

  /** Package turn ids are shown under a delivery's opened id (deliveredTurns.ts). */
  private emit(draft: ChatEventDraft, at?: string | null): void {
    this.echoes.emit(this.delivered.shown(draft), at)
  }
}
