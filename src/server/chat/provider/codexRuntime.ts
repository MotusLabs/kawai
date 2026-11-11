// Kawai's Codex chat driver over @motuslabs/agent-runtime (task 6.1): the
// public package factory runs the app-server; this adapter keeps Kawai's
// authority and shapes (codex-chat-sessions D2-D8, the R2 bounded amendment):
// - Launch, per spawn: the profile home, the executable, the server env minus
//   withheld credential names (re-derived at every spawn), the session's
//   project path; the one workspace-write sandbox with the Git common
//   directory as its extra root and the profile's network; the role prompt,
//   model and team tools. The package's own respawn is never used: a dead
//   process is replaced by a new package driver built from these inputs,
//   only after the old one's kill settled (its exit is joined) and resuming
//   the saved thread. A rejected kill counts only when its causes are
//   exactly the exits already reported (quiesced()); otherwise nothing
//   respawns and the session stays dead.
// - Effort: read when Kawai accepts the send (as before), carried by the
//   minted message UUID and handed to the package's getEffort when that very
//   send commits (beforeSubmit runs just before its commit, sends in order).
// - Requests: the session policy read when each approval arrives; auto grants
//   it with no card (decidedBy policy), a live switch to auto grants pending
//   cards. Cards show Kawai's input (command, file paths, permissions). A
//   declined or cancelled card feeds the outbound audit. Async agentMessage
//   questions are this adapter's cards, answered as a turn on the thread.
// - A send while a turn runs steers it; mail delivers as a peer turn under
//   its message id. Every package promise is owned (runtimeOwnership.ts).
// - Events keep Kawai's identity and texts (runtimeEvents.ts); a process
//   exit reports Kawai's message with its code or signal.
import os from 'node:os'
import { createCodexDriver } from '@motuslabs/agent-runtime/codex'
import type { AgentEvent, CodexAgentDriver, CodexDriverOptions, Effort, Logger, PendingRequest, ToolSet } from '@motuslabs/agent-runtime'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import type { ChatApprovalDecision, ChatApprovalPolicy, ChatBackgroundTask, ChatCommandState, ChatPeerMessage, ChatPendingRequest, ChatQuestion, ChatQuestionAnswer, ChatWorker } from '../../../shared/chat'
import type { SessionStatus } from '../../../shared/types'
import { logger } from '../../logger'
import { formatEnvelope } from '../../team/envelope'
import type { BackgroundTaskRecord } from '../chatBackgroundTasks'
import { codexSpawnEnv } from '../codexProfiles'
import { auditDeniedCard, auditItem, auditSpawnEnd } from '../codex/codexAudit'
import { asyncQuestions } from '../codex/codexEvents'
import { gitCommonDir } from '../codex/codexSandbox'
import type { CodexSessionDriverOptions } from '../codex/codexThread'
import { TEAM_NAMESPACE } from '../codex/codexTools'
import type { ThreadItem } from '../codex/protocol/v2/ThreadItem'
import type { ChatAgentDriver } from './driver'
import { ChatEventSequencer, chatDraftOf, chatLimitSignal, chatUsageReport, type ChatEventDraft } from './runtimeEvents'
import { OwnedWork } from './runtimeOwnership'
import { validateAsyncAnswers } from './runtimeQuestions'

/** The package factory; repository tests pass the private same-core seam. */
export type CreateCodexRuntime = (options: CodexDriverOptions) => CodexAgentDriver

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXIT_MESSAGE = 'the Codex app-server exited unexpectedly'

/**
 * The package's own description of a generation's unexpected exit, as its
 * stop reports it (one native-exit cause per crashed generation).
 */
export function exitCause(generation: number, code: number | null, signal: string | null): string {
  return `agent process generation ${generation} ${signal ? `ended by ${signal}` : `exited with code ${code}`} before the stop`
}

/**
 * Whether a rejected kill still left its owner quiesced. The package rejects
 * a stop only after its terminal join, and an unexpected exit is itself one
 * of the stop's causes. So a rejection whose every cause is exactly an exit
 * this adapter already heard through onProcessEnd quiesced; any other cause
 * (a teardown that could not confirm the exit, another owned failure) did
 * not, and nothing respawns over it.
 */
export function quiesced(error: unknown, exits: readonly string[]): boolean {
  if (!(error instanceof AgentRuntimeError) || error.category !== 'stop') return false
  const remaining = [...exits]
  for (const cause of error.causes) {
    const at = cause instanceof AgentRuntimeError && cause.category === 'transport' ? remaining.indexOf(cause.message) : -1
    if (at < 0) return false
    remaining.splice(at, 1)
  }
  return error.causes.length > 0
}

/** A package logger writing Kawai's structured log. */
export function runtimeLogger(sessionId: string): Logger {
  const write = (level: 'debug' | 'info' | 'warn' | 'error') => (obj: object, msg?: string) => logger[level](msg ?? 'agent_runtime', { sessionId, ...(obj as Record<string, unknown>) })
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/** The approval card's input: what the request names, plus the started item's paths (codexRequests D5). */
function cardInput(tool: string, params: Record<string, unknown>, item: Record<string, unknown> | undefined): Record<string, unknown> {
  const reason = typeof params.reason === 'string' && params.reason ? { reason: params.reason } : {}
  if (tool === 'Bash') return { command: params.command ?? item?.command ?? '', ...(params.cwd ? { cwd: params.cwd } : {}), ...reason }
  if (tool === 'Edit') return { file_path: item?.file_path ?? '', paths: item?.paths ?? [], ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}), ...reason }
  return { permissions: params.permissions ?? {}, ...(params.cwd ? { cwd: params.cwd } : {}), ...reason }
}

interface Card {
  tool: string
  itemId: string
  input: Record<string, unknown>
}

interface AsyncQuestion {
  requestId: string
  turnId: string
  questions: ChatQuestion[]
  at: string
}

export function createCodexChatDriver(options: CodexSessionDriverOptions, create: CreateCodexRuntime = createCodexDriver): ChatAgentDriver & { settled(): Promise<void> } {
  return new CodexChatDriver(options, create)
}

class CodexChatDriver implements ChatAgentDriver {
  private inner: CodexAgentDriver | null = null
  private innerEnded = false
  private booting: Promise<CodexAgentDriver | null> | null = null
  private killed = false
  private dead = false
  private threadId: string | null
  private projectPath: string
  private readonly sequencer = new ChatEventSequencer()
  private readonly owned: OwnedWork
  private activeTurnId: string | null = null
  private sending = 0
  private lastStatus: SessionStatus | null = null
  private commandState: ChatCommandState = { status: 'unavailable', commands: [] }
  private readonly efforts = new Map<string, Effort | undefined>()
  private turnEffort: Effort | undefined
  private spawnEffort: Effort | undefined
  private spawnId = 'ob-s-none'
  private spawnOpen = false
  private readonly seenToolCallIds = new Set<string>()
  private readonly itemInputs = new Map<string, Record<string, unknown>>()
  private readonly cards = new Map<string, Card>()
  private readonly autoGranted = new Set<string>()
  private readonly peers = new Map<string, ChatPeerMessage>()
  private readonly silent = new Set<string>()
  private readonly asked = new Set<string>()
  private readonly questions = new Map<string, AsyncQuestion>()
  /** The unexpected exits the package reported for the current inner driver. */
  private exits: string[] = []

  constructor(private readonly options: CodexSessionDriverOptions, private readonly create: CreateCodexRuntime) {
    this.threadId = options.resumeThreadId ?? null
    this.projectPath = options.projectPath
    this.owned = new OwnedWork(options.sessionId)
  }

  get isDead(): boolean {
    return this.dead
  }

  /** Joins every package promise this driver registered (A5). */
  settled(): Promise<void> {
    return this.owned.settled()
  }

  getCommandState(): ChatCommandState {
    return this.commandState
  }

  start(): void {
    if (this.killed) return
    void this.ensure()
  }

  setProjectPath(path: string): void {
    // The next spawn's cwd (the running thread keeps its own).
    this.projectPath = path
  }

  send(text: string): void {
    if (this.killed) return
    this.submit(text, crypto.randomUUID())
  }

  deliver(envelope: ChatPeerMessage): void {
    if (this.killed) throw new Error('Recipient was killed')
    if (this.activeTurnId || this.sending > 0 || this.pendingCount() > 0) throw new Error('Recipient is not idle')
    const messageUuid = UUID.test(envelope.messageId) ? envelope.messageId : crypto.randomUUID()
    this.peers.set(messageUuid, envelope)
    this.submit(formatEnvelope(envelope), messageUuid)
  }

  async interrupt(): Promise<void> {
    this.cancelQuestions()
    const inner = this.inner
    this.refreshStatus()
    if (!inner || this.innerEnded) return
    const done = this.owned.track('interrupt', inner.interrupt())
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.interruptTimeoutMs ?? 5_000)
      timer.unref?.()
    })
    await Promise.race([done, bound]).finally(() => clearTimeout(timer))
  }

  kill(): void {
    this.stop('kill')
  }

  shutdown(): void {
    this.stop('shutdown')
  }

  onApprovalPolicyChanged(policy: ChatApprovalPolicy): void {
    if (policy !== 'auto') return
    const inner = this.inner
    for (const request of inner?.pendingRequests() ?? []) {
      if (request.kind !== 'approval') continue
      this.autoGranted.add(request.requestId)
      inner!.resolveApproval(request.requestId, 'allow', { decidedBy: 'policy' })
    }
    this.refreshStatus()
  }

  resolveApproval(requestId: string, decision: ChatApprovalDecision): { ok: true } | { ok: false; error: string } {
    const outcome = this.inner?.resolveApproval(requestId, decision === 'allow' ? 'allow' : 'deny')
    if (!outcome || (!outcome.ok && outcome.reason === 'not-pending')) return { ok: false, error: `No pending approval with id ${requestId}; it may already be answered or cancelled` }
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.message }
  }

  answerQuestion(requestId: string, answers: Record<string, ChatQuestionAnswer>): { ok: true } | { ok: false; error: string } {
    const own = this.questions.get(requestId)
    if (own) {
      const validated = validateAsyncAnswers(own.questions, answers)
      if (!validated.ok) return validated
      this.questions.delete(requestId)
      this.emit({ type: 'request_resolved', requestId, outcome: 'answered', decidedBy: 'user' })
      // The answer is turn input on the thread, shown as no user message.
      const messageUuid = crypto.randomUUID()
      this.silent.add(messageUuid)
      this.submit(own.questions.map((question, i) => `${question.question}: ${validated.answers[i]!.join(', ')}`).join('\n'), messageUuid)
      return { ok: true }
    }
    const outcome = this.inner?.answerQuestion(requestId, answers)
    if (!outcome || (!outcome.ok && outcome.reason === 'not-pending')) return { ok: false, error: `No pending question with id ${requestId}; it may already be answered or cancelled` }
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.message }
  }

  holdQuestion(requestId: string): { ok: true } | { ok: false; error: string } {
    const isQuestion = this.questions.has(requestId) || (this.inner?.pendingRequests() ?? []).some((r) => r.requestId === requestId && r.kind === 'question')
    if (!isQuestion) {
      const approval = (this.inner?.pendingRequests() ?? []).some((r) => r.requestId === requestId)
      return { ok: false, error: approval ? `Request ${requestId} is not a question` : `No pending question with id ${requestId}; it may already be answered or cancelled` }
    }
    // Codex chats never arm an auto-answer deadline (QA-U4).
    return { ok: false, error: `Request ${requestId} has no auto-answer deadline to hold` }
  }

  getPendingRequests(): ChatPendingRequest[] {
    const runtime = (this.inner?.pendingRequests() ?? []).filter((r) => !this.autoGranted.has(r.requestId)).map((request) => this.pendingOf(request))
    const own: ChatPendingRequest[] = [...this.questions.values()].map((q) => ({ kind: 'question', requestId: q.requestId, questions: q.questions, at: q.at }))
    return [...runtime, ...own]
  }

  getSeenToolCallIds(): Set<string> {
    return new Set(this.seenToolCallIds)
  }

  // Non-goals for Codex chats (design D7): no worker roster, no background tasks.
  getWorkers(): ChatWorker[] {
    return []
  }

  getBackgroundTasks(): ChatBackgroundTask[] {
    return []
  }

  getBackgroundTaskRecords(): BackgroundTaskRecord[] {
    return []
  }

  getTaskOutput(): Promise<null> {
    return Promise.resolve(null)
  }

  stopTask(): Promise<boolean> {
    return Promise.resolve(false)
  }

  // ---------------------------------------------------------------- internals

  private submit(text: string, messageUuid: string): void {
    // A spawn refusal (a registered CODEX_HOME) throws here, before anything is accepted.
    const ready = this.ensure()
    // The effort of this send, read when Kawai accepted it (root driver order).
    if (this.options.getEffort) this.efforts.set(messageUuid, this.options.getEffort())
    this.sending += 1
    this.refreshStatus()
    const job = ready.then(async (inner) => {
      if (!inner || this.killed) return
      const steer = inner.state === 'active'
      const handle = await inner.send(text, { messageUuid, ...(steer ? { continuation: 'steer' as const } : {}) }).catch((error: unknown) => {
        // A steer prepared for a turn that ended meanwhile goes as a new turn.
        if (steer && (error as { code?: unknown } | null)?.code === 'turn-ended') return inner.send(text, { messageUuid })
        throw error
      })
      void this.owned.track('turn', handle.result)
    })
    void this.owned.track('send', job.catch((error: unknown) => {
      this.emit({ type: 'error', message: `Codex refused the turn: ${error instanceof Error ? error.message : String(error)}` })
      throw error
    }).finally(() => {
      this.efforts.delete(messageUuid)
      this.sending -= 1
      this.refreshStatus()
    }))
  }

  /**
   * The live package driver, building one when none runs (see the header).
   * The spawn environment is composed now, synchronously, so a registered
   * name refuses the caller's start or send itself, as before.
   */
  private ensure(): Promise<CodexAgentDriver | null> {
    if (this.killed) return Promise.resolve(null)
    if (this.booting) return this.booting
    if (this.inner && !this.innerEnded) return Promise.resolve(this.inner)
    const env = codexSpawnEnv(this.options.serverEnv ?? process.env, this.options.codexHome, this.options.withheldCredentials())
    this.dead = false
    const previous = this.inner
    const resumed = this.threadId !== null
    const boot = (async (): Promise<CodexAgentDriver | null> => {
      if (previous) {
        // The old owner must truly quiesce first (see quiesced()).
        const exits = this.exits
        const stopped = await previous.kill().then(() => true, (error: unknown) => {
          void this.owned.track('retire', Promise.reject(error))
          return quiesced(error, exits)
        })
        if (!stopped) throw new Error('the previous app-server did not stop cleanly')
      }
      if (this.killed) return null
      const commonDir = await gitCommonDir(this.projectPath)
      if (this.killed) return null
      const inner = this.create(this.innerOptions(env, commonDir))
      this.inner = inner
      this.exits = []
      this.innerEnded = false
      await inner.start()
      return inner
    })()
    const settled = boot.catch((error: unknown) => {
      // A process that died while booting already reported its exit (root order).
      if (!this.killed && !(this.inner && this.innerEnded)) {
        // The package names the step ("Codex could not start a thread: …");
        // Kawai's text keeps its own prefix over the underlying failure.
        const cause = error instanceof AgentRuntimeError && error.causes[0] instanceof Error ? error.causes[0] : error
        const message = cause instanceof Error ? cause.message : String(cause)
        logger.warn('codex_thread_start_failed', { sessionId: this.options.sessionId, error: message })
        this.emit({ type: 'error', message: `Codex could not ${resumed ? 'resume' : 'start'} the thread: ${message}` })
        this.dead = true
        this.refreshStatus()
      }
      throw error
    })
    void this.owned.track('start', settled)
    const ready = settled.then((inner) => inner, () => null).finally(() => {
      if (this.booting === ready) this.booting = null
    })
    this.booting = ready
    return ready
  }

  private innerOptions(env: Record<string, string>, commonDir: string | null): CodexDriverOptions {
    const options = this.options
    const prompt = options.getSystemPromptAppend?.() ?? ''
    this.spawnEffort = options.getEffort?.()
    const table = options.teamTools ?? []
    const tools: ToolSet | undefined = table.length
      ? {
          namespace: TEAM_NAMESPACE,
          tools: table.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.schema,
            handler: async (input: unknown) => {
              try {
                return { content: JSON.stringify(await tool.handler(input)) }
              } catch (error) {
                return { content: error instanceof Error ? error.message : String(error), isError: true }
              }
            },
          })),
        }
      : undefined
    return {
      logger: runtimeLogger(options.sessionId),
      launch: { cwd: this.projectPath, childEnv: env, executablePath: options.executable, homeDir: options.codexHome, cacheDir: os.tmpdir(), tempDir: os.tmpdir() },
      permissions: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: options.network, writableRoots: commonDir ? [commonDir] : [], userInput: 'enabled', elicitation: 'disabled' },
      ...(this.threadId ? { resume: { runtime: 'codex' as const, runtimeSessionId: this.threadId } } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(prompt ? { systemPromptAppend: prompt } : {}),
      ...(tools ? { tools } : {}),
      ...(options.getEffort ? { getEffort: () => this.turnEffort } : {}),
      beforeSubmit: (submission) => {
        this.turnEffort = this.efforts.get(submission.messageUuid)
        return { accepted: true }
      },
      wire: { record: (frame) => options.wire.record(frame.direction, frame.text) },
      unansweredRequests: 'wait',
      ...(options.claimRateLimitsRead ? { claimRateLimitsRead: options.claimRateLimitsRead } : {}),
      // R3: every opened thread's rollout, a resume's moved one included (the
      // checkpoint never re-reports a resumed id); null keeps the stored path.
      onThreadOpened: (info) => {
        if (info.transcriptPath) options.onTranscriptPath?.(info.transcriptPath)
      },
      auditHooks: { onItem: (item) => this.onItem(item.kind, item.itemId, item.detail as Record<string, unknown>) },
      callbacks: this.callbacks(),
    }
  }

  private callbacks(): CodexDriverOptions['callbacks'] {
    const options = this.options
    return {
      onEvent: (event) => this.onRuntimeEvent(event),
      onState: () => this.refreshStatus(),
      onRequest: (request) => {
        if (request.kind === 'approval' && this.autoGranted.has(request.requestId)) this.inner?.resolveApproval(request.requestId, 'allow', { decidedBy: 'policy' })
      },
      onCheckpoint: (checkpoint) => {
        if (checkpoint.runtimeSessionId !== this.threadId) {
          this.threadId = checkpoint.runtimeSessionId
          options.onSdkSessionId?.(checkpoint.runtimeSessionId)
        }
      },
      onModel: (model) => options.onModel?.(model),
      onActivity: (activity) => options.onActivity?.(activity),
      onCommandState: (state) => {
        this.commandState = state
        options.onCommandState?.(state)
      },
      onContextUsage: (usage, meta) => options.onContextUsage?.(usage, meta),
      onCompactionObservation: (o) =>
        options.onCompaction?.({ trigger: o.trigger, startedAt: o.startedAt, endedAt: o.endedAt, preTokens: o.preTokens, postTokens: o.postTokens, durationSeconds: o.durationSeconds, outcome: o.outcome }, o.sourceId ?? undefined),
      onQuotaReport: (report) => options.onRateLimit?.(chatUsageReport(report, 'provider')),
      onQuotaNoData: () => options.onUsageNoData?.(),
      onLimitEvent: (event) => {
        const signal = chatLimitSignal(event)
        if (signal) options.onLimitEvent?.(signal)
      },
      onSpawn: (info) => {
        this.spawnId = `ob-s-${crypto.randomUUID()}`
        this.spawnOpen = true
        options.onSpawn?.({ cwd: info.cwd, systemPromptAppend: info.systemPromptAppend, effort: this.spawnEffort ?? null, model: info.model, env: { ...info.childEnv }, resumed: info.resumed })
      },
      onProcessEnd: (report) => {
        this.exits.push(exitCause(report.generation, report.code, report.signal))
        this.innerEnded = true
        this.dead = true
        this.endSpawn()
        this.cancelQuestions()
        options.onProcessEnd?.()
        const how = report.signal ? `on ${report.signal}` : report.code !== null ? `with code ${report.code}` : 'without starting'
        this.emit({ type: 'error', message: `The Codex app-server exited ${how}` })
        this.refreshStatus()
      },
    }
  }

  private onRuntimeEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'approval_request': {
        const input = (event.input ?? {}) as Record<string, unknown>
        const itemId = typeof input.itemId === 'string' ? input.itemId : ''
        const card: Card = { tool: event.tool, itemId, input: cardInput(event.tool, input, this.itemInputs.get(itemId)) }
        this.cards.set(event.requestId, card)
        // The policy of the moment the request arrives (D5); onRequest grants it.
        if ((this.options.getApprovalPolicy?.() ?? 'manual') === 'auto') this.autoGranted.add(event.requestId)
        else this.emit({ type: 'approval_request', turnId: event.turnId, requestId: event.requestId, tool: event.tool, input: card.input }, event.at)
        break
      }
      case 'question_request':
        this.emit({ type: 'question_request', turnId: event.turnId, requestId: event.requestId, questions: event.questions as ChatQuestion[] }, event.at)
        break
      case 'request_resolved': {
        const card = this.cards.get(event.requestId)
        this.cards.delete(event.requestId)
        const granted = this.autoGranted.delete(event.requestId)
        if (card && (event.outcome === 'denied' || event.outcome === 'cancelled')) {
          auditDeniedCard(this.options.outbound, { tool: card.tool, itemId: card.itemId, input: card.input, ...(event.outcome === 'cancelled' ? { reason: 'interrupted' } : {}) }, { spawnId: this.spawnId, cwd: this.projectPath })
        }
        const decidedBy = granted || event.decidedBy === 'policy' ? 'policy' : event.decidedBy === 'caller' ? 'user' : undefined
        this.emit({ type: 'request_resolved', requestId: event.requestId, outcome: event.outcome, ...(decidedBy ? { decidedBy } : {}), ...(decidedBy === 'policy' && card ? { tool: card.tool } : {}) }, event.at)
        break
      }
      case 'user_message': {
        const peer = this.peers.get(event.messageUuid)
        this.peers.delete(event.messageUuid)
        if (this.silent.delete(event.messageUuid)) break
        if (peer) this.emit({ type: 'peer_message', turnId: event.turnId, ...peer }, event.at)
        else this.emit({ type: 'user_message', turnId: event.turnId, text: event.text, messageUuid: event.messageUuid }, event.at)
        break
      }
      case 'error':
        // The exit is reported with its code at onProcessEnd.
        if (event.error.message !== EXIT_MESSAGE) this.emit({ type: 'error', message: event.error.message }, event.at)
        break
      case 'notice':
        this.emit(event.kind === 'compacted' ? { type: 'notice', text: 'Context compacted', kind: 'compacted' } : { type: 'notice', text: event.text }, event.at)
        break
      default: {
        if (event.type === 'turn_started') {
          // Per-item state lives one turn: approvals and questions arrive within it.
          this.seenToolCallIds.clear()
          this.itemInputs.clear()
          this.asked.clear()
          this.activeTurnId = event.turnId
        }
        if (event.type === 'turn_completed' || event.type === 'turn_interrupted') this.activeTurnId = null
        if (event.type === 'tool_call') {
          this.seenToolCallIds.add(event.toolCallId)
          this.itemInputs.set(event.toolCallId, event.input as Record<string, unknown>)
        }
        const draft = chatDraftOf(event)
        if (draft) this.emit(draft, event.at)
      }
    }
    this.refreshStatus()
  }

  /** Every item edge: the outbound audit (D13) and 0.163.0's async questions. */
  private onItem(kind: string, itemId: string, detail: Record<string, unknown>): void {
    if (kind === 'agentMessage') {
      const questions = this.activeTurnId && !this.asked.has(itemId) ? asyncQuestions(detail.questions) : null
      if (questions) {
        this.asked.add(itemId)
        const requestId = `req-codex-${crypto.randomUUID()}`
        this.questions.set(requestId, { requestId, turnId: this.activeTurnId!, questions, at: new Date().toISOString() })
        this.emit({ type: 'question_request', turnId: this.activeTurnId!, requestId, questions })
        this.refreshStatus()
      }
      return
    }
    if (!this.activeTurnId) return
    const phase = detail.status === 'inProgress' ? 'started' : 'completed'
    auditItem(phase, detail as unknown as ThreadItem, { sink: this.options.outbound, spawnId: this.spawnId, cwd: this.projectPath })
  }

  private pendingOf(request: PendingRequest): ChatPendingRequest {
    if (request.kind === 'question') return { kind: 'question', requestId: request.requestId, questions: request.questions as ChatQuestion[], at: request.at }
    const card = this.cards.get(request.requestId)
    return { kind: 'approval', requestId: request.requestId, tool: request.tool, input: card?.input ?? request.input, at: request.at }
  }

  private pendingCount(): number {
    return this.getPendingRequests().length
  }

  private cancelQuestions(): void {
    for (const requestId of [...this.questions.keys()]) {
      this.questions.delete(requestId)
      this.emit({ type: 'request_resolved', requestId, outcome: 'cancelled' })
    }
  }

  private stop(how: 'kill' | 'shutdown'): void {
    if (this.killed) return
    this.killed = true
    this.cancelQuestions()
    const inner = this.inner
    const booting = this.booting
    if (inner && !this.innerEnded) void this.owned.track(how, inner[how]())
    else if (booting) void this.owned.track(how, booting.then((started) => started?.[how]()))
    else if (inner) void this.owned.track(how, inner.kill())
    this.endSpawn()
    this.refreshStatus()
  }

  private endSpawn(): void {
    if (!this.spawnOpen) return
    this.spawnOpen = false
    auditSpawnEnd(this.options.outbound, this.spawnId)
  }

  private refreshStatus(): void {
    const next: SessionStatus = this.pendingCount() > 0 ? 'permission' : this.activeTurnId || this.sending > 0 ? 'working' : 'waiting'
    if (next === this.lastStatus) return
    this.lastStatus = next
    this.options.onStatus(next)
  }

  private emit(draft: ChatEventDraft, at?: string | null): void {
    this.options.onEvent(this.sequencer.stamp(draft, at))
  }
}
