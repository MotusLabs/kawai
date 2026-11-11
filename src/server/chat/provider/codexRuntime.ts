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
//   the saved thread, under runtimeBoot.ts's strict quiescence; otherwise
//   nothing respawns and the session stays dead.
// - Effort: read when Kawai accepts the send (as before), carried by the
//   minted message UUID and handed to the package's getEffort when that very
//   send commits (beforeSubmit runs just before its commit, sends in order).
// - Requests: the session policy read when each approval arrives; auto grants
//   it with no card (decidedBy policy), a live switch to auto grants pending
//   cards. Cards show Kawai's input (command, file paths, permissions). A
//   declined or cancelled card feeds the outbound audit. Async agentMessage
//   questions are this adapter's cards, answered as a turn on the thread.
// - A send while a turn runs steers it; mail delivers as a peer turn under
//   its message id. Mail and question answers send codexSkills 'none'
//   (text only, R9); a human send keeps the catalog's skill inputs, and a
//   project move lists the new directory's skills on the live process
//   (setSkillDirectory, R11). Every
//   package promise, and every promise a host callback returns (the
//   direct onEvent/onStatus publications included), is owned (runtimeOwnership.ts); settled() joins them
//   and reports their raw failures once.
// - Terminal joins: a kill or shutdown the package refused from inside its
//   own callback is re-issued by the next outside caller (TerminalJoin).
// - Events keep Kawai's identity and texts (runtimeEvents.ts); a process
//   exit reports Kawai's message with its code or signal.
import { isAbsolute } from 'node:path'
import { createCodexDriver } from '@motuslabs/agent-runtime/codex'
import type { AgentEvent, CodexAgentDriver, CodexDriverOptions, Effort } from '@motuslabs/agent-runtime'
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
import type { ThreadItem } from '../codex/protocol/v2/ThreadItem'
import type { ChatAgentDriver } from './driver'
import { ChatEventSequencer, chatDraftOf, type ChatEventDraft } from './runtimeEvents'
import { cardInput, forwardedCallbacks, holdRefusal, launchFields, pendingOf, requestOutcome, teamToolSet, type AsyncQuestion, type Card } from './codexRuntimeSupport'
import { OwnedWork, TerminalJoin, outsideRuntime } from './runtimeOwnership'
import { DeliveredTurns } from './deliveredTurns'
import { RuntimeBoot } from './runtimeBoot'
import { validateAsyncAnswers } from './runtimeQuestions'

/** The package factory; repository tests pass the private same-core seam. */
export type CreateCodexRuntime = (options: CodexDriverOptions) => CodexAgentDriver

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXIT_MESSAGE = 'the Codex app-server exited unexpectedly'

export function createCodexChatDriver(options: CodexSessionDriverOptions, create: CreateCodexRuntime = createCodexDriver): ChatAgentDriver & { settled(): Promise<void> } {
  return new CodexChatDriver(options, create)
}

class CodexChatDriver implements ChatAgentDriver {
  private readonly boot: RuntimeBoot<CodexAgentDriver>
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
  /** A delivery's turn opens at deliver() (deliveredTurns.ts). */
  private readonly delivered = new DeliveredTurns((draft) => this.emit(draft))
  /** Interrupts so far: a send still waiting for its driver when one lands is withdrawn. */
  private interrupts = 0
  private readonly silent = new Set<string>()
  private readonly asked = new Set<string>()
  private readonly questions = new Map<string, AsyncQuestion>()
  /** Terminal calls, re-issued from an outside caller when the package refused a self-join. */
  private readonly terminals: TerminalJoin

  constructor(private readonly options: CodexSessionDriverOptions, private readonly create: CreateCodexRuntime) {
    this.threadId = options.resumeThreadId ?? null
    this.projectPath = options.projectPath
    this.owned = new OwnedWork(options.sessionId)
    this.terminals = new TerminalJoin(this.owned)
    this.boot = new RuntimeBoot(this.owned, () => this.killed, 'the previous app-server did not stop cleanly')
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

  setProjectPath(path: string): void {
    // The next spawn's cwd (the running thread keeps its own); the live
    // generation's skill catalog moves at once (R11, as the source's
    // commands.changeDirectory did).
    this.projectPath = path
    this.moveSkills(this.boot.live)
  }

  /** R11: the live package driver lists the current project's skills; unchanged is a no-op there. */
  private moveSkills(inner: CodexAgentDriver | null): void {
    if (inner && isAbsolute(this.projectPath)) inner.setSkillDirectory?.(this.projectPath)
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
    const sent = this.submit(formatEnvelope(envelope), messageUuid, 'none')
    const turnId = (this.activeTurnId = this.delivered.open(envelope))
    void sent.then((accepted) => {
      if (!accepted && this.delivered.abandon() === turnId && this.activeTurnId === turnId) this.activeTurnId = null
      this.refreshStatus()
    })
  }

  async interrupt(): Promise<void> {
    this.cancelQuestions()
    // Sends still waiting for the driver are withdrawn; a delivery the package has not opened closes here.
    this.interrupts += 1
    if (this.delivered.abandon(true) === this.activeTurnId) this.activeTurnId = null
    const inner = this.boot.live
    this.refreshStatus()
    if (!inner) return
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
    const inner = this.boot.current
    for (const request of inner?.pendingRequests() ?? []) {
      if (request.kind !== 'approval') continue
      this.autoGranted.add(request.requestId)
      inner!.resolveApproval(request.requestId, 'allow', { decidedBy: 'policy' })
    }
    this.refreshStatus()
  }

  resolveApproval(requestId: string, decision: ChatApprovalDecision): { ok: true } | { ok: false; error: string } {
    return requestOutcome(this.boot.current?.resolveApproval(requestId, decision === 'allow' ? 'allow' : 'deny'), 'approval', requestId)
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
      this.submit(own.questions.map((question, i) => `${question.question}: ${validated.answers[i]!.join(', ')}`).join('\n'), messageUuid, 'none')
      return { ok: true }
    }
    return requestOutcome(this.boot.current?.answerQuestion(requestId, answers), 'question', requestId)
  }

  holdQuestion(requestId: string): { ok: true } | { ok: false; error: string } {
    return holdRefusal(requestId, this.questions.has(requestId), this.boot.current?.pendingRequests() ?? [])
  }

  getPendingRequests(): ChatPendingRequest[] {
    const runtime = (this.boot.current?.pendingRequests() ?? []).filter((r) => !this.autoGranted.has(r.requestId)).map((request) => pendingOf(request, this.cards))
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

  /** One submission; settles true once the package accepted it (never rejects). */
  /**
   * `codexSkills` 'none' (R9) keeps a peer delivery or an internal answer
   * text-only, as the source driver's deliver and answer paths were; a human
   * send omits it and keeps the catalog's skill inputs.
   */
  private submit(text: string, messageUuid: string, codexSkills?: 'none'): Promise<boolean> {
    // A spawn refusal (a registered CODEX_HOME) throws here, before anything is accepted.
    const ready = this.ensure()
    // The effort of this send, read when Kawai accepted it (root driver order).
    if (this.options.getEffort) this.efforts.set(messageUuid, this.options.getEffort())
    const epoch = this.interrupts
    this.sending += 1
    this.refreshStatus()
    const job = ready.then(async (inner) => {
      // A send still waiting for its driver when an interrupt landed is withdrawn.
      if (!inner || this.killed || epoch !== this.interrupts) return false
      const steer = inner.state === 'active'
      const mode = codexSkills ? { codexSkills } : {}
      const handle = await inner.send(text, { messageUuid, ...mode, ...(steer ? { continuation: 'steer' as const } : {}) }).catch((error: unknown) => {
        // A steer prepared for a turn that ended meanwhile goes as a new turn, with the same skill mode.
        if (steer && (error as { code?: unknown } | null)?.code === 'turn-ended') return inner.send(text, { messageUuid, ...mode })
        throw error
      })
      void this.owned.track('turn', handle.result)
      return true
    })
    const sent = job.catch((error: unknown) => {
      this.emit({ type: 'error', message: `Codex refused the turn: ${error instanceof Error ? error.message : String(error)}` })
      throw error
    }).finally(() => {
      this.efforts.delete(messageUuid)
      this.sending -= 1
      this.refreshStatus()
    })
    void this.owned.track('send', sent)
    return sent.then((accepted) => accepted, () => false)
  }

  /**
   * The live package driver, building one when none runs (see the header).
   * The spawn environment is composed now, synchronously, so a registered
   * name refuses the caller's start or send itself, as before.
   */
  private ensure(): Promise<CodexAgentDriver | null> {
    let resumed = false
    // A move while this driver booted, after its launch cwd was taken, reaches its catalog once it is ready.
    return this.boot.ensure(() => {
      const env = codexSpawnEnv(this.options.serverEnv ?? process.env, this.options.codexHome, this.options.withheldCredentials())
      this.dead = false
      resumed = this.threadId !== null
      return async () => {
        const commonDir = await gitCommonDir(this.projectPath)
        return this.killed ? null : this.create(this.innerOptions(env, commonDir))
      }
    }, (error) => {
      // The package names the step ("Codex could not start a thread: …");
      // Kawai's text keeps its own prefix over the underlying failure.
      const cause = error instanceof AgentRuntimeError && error.causes[0] instanceof Error ? error.causes[0] : error
      const message = cause instanceof Error ? cause.message : String(cause)
      logger.warn('codex_thread_start_failed', { sessionId: this.options.sessionId, error: message })
      this.emit({ type: 'error', message: `Codex could not ${resumed ? 'resume' : 'start'} the thread: ${message}` })
      this.dead = true
      this.refreshStatus()
    }).then((inner) => {
      this.moveSkills(inner)
      return inner
    })
  }

  private innerOptions(env: Record<string, string>, commonDir: string | null): CodexDriverOptions {
    const options = this.options
    const prompt = options.getSystemPromptAppend?.() ?? ''
    this.spawnEffort = options.getEffort?.()
    const tools = teamToolSet(options.teamTools ?? [])
    return {
      ...launchFields(options, this.projectPath, env, commonDir),
      ...(this.threadId ? { resume: { runtime: 'codex' as const, runtimeSessionId: this.threadId } } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(prompt ? { systemPromptAppend: prompt } : {}),
      ...(tools ? { tools } : {}),
      ...(options.getEffort ? { getEffort: () => this.turnEffort } : {}),
      beforeSubmit: (submission) => {
        this.turnEffort = this.efforts.get(submission.messageUuid)
        return { accepted: true }
      },
      // R3: every opened thread's rollout, a resume's moved one included (the
      // checkpoint never re-reports a resumed id); null keeps the stored path.
      // Its returned promise goes back to the package, which owns it (A10).
      onThreadOpened: (info) => (info.transcriptPath ? (options.onTranscriptPath?.(info.transcriptPath) as void) : undefined),
      auditHooks: { onItem: (item) => this.onItem(item.kind, item.itemId, item.detail as Record<string, unknown>) },
      callbacks: this.callbacks(),
    }
  }

  private callbacks(): CodexDriverOptions['callbacks'] {
    const options = this.options
    const hosted = (label: string, fn: () => unknown) => this.owned.hosted(label, fn)
    return {
      onEvent: (event) => this.onRuntimeEvent(event),
      onState: () => this.refreshStatus(),
      onRequest: (request) => {
        if (request.kind === 'approval' && this.autoGranted.has(request.requestId)) this.boot.current?.resolveApproval(request.requestId, 'allow', { decidedBy: 'policy' })
      },
      // The critical identity persistence: the host's own promise is the barrier; run outside the callback ancestry (outsideRuntime).
      onCheckpoint: (checkpoint) => {
        if (checkpoint.runtimeSessionId === this.threadId) return
        this.threadId = checkpoint.runtimeSessionId
        return outsideRuntime(() => options.onSdkSessionId?.(checkpoint.runtimeSessionId)) as void
      },
      ...forwardedCallbacks(options, hosted),
      onCommandState: (state) => {
        this.commandState = state
        hosted('onCommandState', () => options.onCommandState?.(state))
      },
      onSpawn: (info) => {
        this.spawnId = `ob-s-${crypto.randomUUID()}`
        this.spawnOpen = true
        hosted('onSpawn', () => options.onSpawn?.({ cwd: info.cwd, systemPromptAppend: info.systemPromptAppend, effort: this.spawnEffort ?? null, model: info.model, env: { ...info.childEnv }, resumed: info.resumed }))
      },
      onProcessEnd: (report) => {
        this.boot.exited(report)
        this.dead = true
        this.endSpawn()
        this.cancelQuestions()
        hosted('onProcessEnd', () => options.onProcessEnd?.())
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
        // A delivery's peer message was shown when deliver() opened its turn.
        if (this.peers.delete(event.messageUuid)) break
        if (this.silent.delete(event.messageUuid)) break
        this.emit({ type: 'user_message', turnId: event.turnId, text: event.text, messageUuid: event.messageUuid }, event.at)
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
          const absorbed = this.delivered.started(event.turnId, Boolean(event.trigger))
          this.activeTurnId = this.delivered.shownId(event.turnId)
          if (absorbed) break
        }
        if (event.type === 'turn_completed' || event.type === 'turn_interrupted') this.activeTurnId = null
        if (event.type === 'tool_call') {
          this.seenToolCallIds.add(event.toolCallId)
          this.itemInputs.set(event.toolCallId, event.input as Record<string, unknown>)
        }
        const draft = chatDraftOf(event)
        if (draft) this.emit(draft, event.at)
        if (event.type === 'turn_completed' || event.type === 'turn_interrupted') this.delivered.ended(event.turnId)
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
    if (this.killed) {
      // A later outside call owns the terminal join an inner call could not.
      this.terminals.reacquire()
      return
    }
    this.killed = true
    this.cancelQuestions()
    const inner = this.boot.current
    const booting = this.boot.booting
    if (inner && this.boot.live) this.terminals.begin(how, () => inner[how]())
    else if (booting) void this.owned.track(how, booting.then((started) => void (started && this.terminals.begin(how, () => started[how]()))))
    else if (inner) this.terminals.begin('kill', () => inner.kill())
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
    this.owned.hosted('onStatus', () => this.options.onStatus(next))
  }

  /** Package turn ids are shown under a delivery's opened id (deliveredTurns.ts). */
  private emit(draft: ChatEventDraft, at?: string | null): void {
    const stamped = this.sequencer.stamp(this.delivered.shown(draft), at)
    this.owned.hosted('onEvent', () => this.options.onEvent(stamped))
  }
}
