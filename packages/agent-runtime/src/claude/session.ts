// The Claude driver core (tasks 2.2/2.4, 4.1): the pinned SDK's query() on
// the owned spawner, through the shared lifecycle core.
//
// - Generations. Each generation's message loop is an owned job that
//   completes only at the leader's actual exit. start resolves on the CLI's
//   initialize response. A respawn after an unexpected exit resumes the same
//   conversation. A generation's resume target is fixed before its query; a
//   CLI refusal of it fails start with category `resume` (generations.ts).
//   A resumed generation whose first init names another conversation is
//   refused before anything adopts it (G1): its turns fail with category
//   `resume`, later sends are refused, and the driver disposes itself.
// - Turn binding. Results and content frames bind to turns by the client UUID
//   each prompt carries (the CLI turn binder), so a late, duplicate or
//   previous-turn result never completes the turn opened since. A queued
//   prompt that the CLI consumed into the active turn resolves with that
//   turn's result. Otherwise it opens as the next turn with no idle state in
//   between.
// - A result frame binds once per session: every frame id is kept for the
//   session's life, and a frame without one is refused.
// - Agent-started turns. An init that no submission opened starts an
//   agent-started turn (L24), but only while idle.
// - Checkpoints. A new session id is persisted before later sends are
//   acknowledged, and an interrupt refuses every send still waiting
//   (lifecycle/checkpoints.ts). State publications are held while a turn
//   opens or settles, so a callback never reenters a half-finished step.
// - Interrupt capability. A generation sends cancelQueued on interrupt until
//   an init's capabilities array lacks interrupt_cancel_queued_v1 (each such
//   array replaces the answer); then it sends a plain interrupt and logs
//   interrupt-cancel-queued-unsupported. Stop never interrupts.
// - Facts. Usage, context, quota and limit-wait facts (usageFacts.ts) are fed
//   before the frame mapping; their control calls are owned jobs (usageControls.ts).
// - Composition. Permissions, host integrations, requests (canUseTool) and
//   frame mapping are composed here. A generation is registered before its
//   query() call. The owned spawner reports each process before any recorder
//   sees it, and creates none once stop has begun.
// - Stop marks every owned process, aborts each query with its token, ends
//   input, terminates every generation and joins every owned job. Only then
//   does it account each generation from the native evidence its owner froze
//   at exit: a pre-stop, nonzero, trapped or unsent-signal end fails the
//   stop, nesting the token AbortErrors stored for it. Every other failure
//   (init, read, control, callback, recorder, cleanup) fails it too, kept by
//   identity.
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AnswerOptions, AnswerOutcome, InterruptReceipt, ProcessExitFact, ProcessExitReceipt, ResumeCheckpoint, SubmitOptions, TaskOutput, TurnHandle } from '../contract.js'
import { AgentRuntimeError, type AgentErrorInfo } from '../errors.js'
import { EventStream, type EventBody } from '../eventStream.js'
import type { PendingRequest, QuestionAnswers } from '../events.js'
import { CHECKPOINT_FAILED, CheckpointGate } from '../lifecycle/checkpoints.js'
import { DriverLifecycle, type Admission } from '../lifecycle/lifecycle.js'
import { resolveExecutable, resolveLaunch } from '../process/launch.js'
import type { LeaderExit } from '../process/ownedProcess.js'
import { OldFrameScope } from '../common/oldFrame.js'
import { bindToolSet, type BoundToolSet } from '../tools/toolSet.js'
import type { RawChatCommand } from './commands.js'
import { ClaudeFrames } from './frames.js'
import { composeSessionSdkOptions } from './integrations.js'
import { composeClaudePermissions, type ClaudePermissionComposition } from './permissions.js'
import { accountGenerations, cancelledByStop, generationOptions, interruptGeneration, keepStartupFailure, loadSdk, newGeneration, ownedSpawn, readTaskOutput, startFailure, stopQueryTask, terminateGenerations, type Generation, type SdkModule } from './generations.js'
import { ClaudeRequests } from './requests.js'
import { SeenResultFrames } from './resultFrames.js'
import { settleResult, type ResultSettlementHost } from './resultSettlement.js'
import { CliTurnBinder, type CliContractViolation } from './turnBinder.js'
import { OpenTurns } from './openTurns.js'
import { composeEnvelope } from './compose.js'
import { checkSubmission, newTurn, promptMessage, type Turn } from './turns.js'
import { ClaudeUsageFacts } from './usageFacts.js'
import { UsageControls } from './usageControls.js'
import type { ClaudeSessionOptions } from './sessionOptions.js'
export type { ClaudeQueryFactory, ClaudeSessionOptions } from './sessionOptions.js'

export class ClaudeSession {
  readonly runtime = 'claude' as const
  readonly lifecycle: DriverLifecycle
  private readonly events: EventStream
  private readonly generations: Generation[] = []
  /** Open turns in FIFO order: the active turn first, then queued ones (L21). */
  private readonly open: OpenTurns
  private readonly oldFrame = new OldFrameScope()
  private readonly binder: CliTurnBinder
  /** Logs a deviation from the pinned CLI contract (docs/claude-cli-contract.md). */
  private readonly violation: (reason: CliContractViolation) => void
  private readonly requests: ClaudeRequests
  private readonly frames: ClaudeFrames
  private readonly checkpoints: CheckpointGate
  private readonly usage: ClaudeUsageFacts
  private readonly controls: UsageControls

  /** Validated once at construction: an unenforceable restriction never starts. */
  private readonly permissions: ClaudePermissionComposition | null
  private readonly tools: BoundToolSet | null
  /** The CLI's session id, from the latest system/init. */
  private runtimeSessionId: string | null
  private readonly results: ResultSettlementHost
  /** Sticky once a resumed generation named another conversation (G1). */
  private resumeFailure: AgentErrorInfo | null = null
  /** Minted when stop cancels the queries: the abort reason that marks its own cancellations. */
  private stopToken: object | null = null

  constructor(private readonly options: ClaudeSessionOptions) {
    this.tools = bindToolSet(options.tools)
    // Only an omitted policy means none: any supplied value, null included, is validated.
    this.permissions = options.permissions === undefined ? null : composeClaudePermissions(options.permissions)
    this.runtimeSessionId = options.resume?.runtimeSessionId ?? null
    const { callbacks, logger } = options
    this.events = new EventStream((event) => this.notify('onEvent', () => callbacks.onEvent(event)))
    this.usage = new ClaudeUsageFacts({ callbacks, notify: (name, callback) => this.notify(name, callback) })
    this.open = new OpenTurns({ emit: (body) => this.emit(body), notify: (name, callback) => this.notify(name, callback), onTurnResult: callbacks.onTurnResult, settling: (turn, cause) => this.usage.turnSettling(turn, cause), settled: (turn) => this.usage.turnSettled(turn) })
    this.lifecycle = new DriverLifecycle({ continuations: new Set(['queue']), ...(callbacks.onState ? { onState: callbacks.onState } : {}) })
    this.controls = new UsageControls({
      lifecycle: this.lifecycle,
      quotaSource: options.quotaSource ?? 'none',
      ...(options.claimUsagePull ? { claimUsagePull: options.claimUsagePull } : {}),
      noData: (info) => { const onQuotaNoData = callbacks.onQuotaNoData; if (onQuotaNoData) this.notify('onQuotaNoData', () => onQuotaNoData(info)) },
      stopToken: () => this.stopToken,
      current: () => this.current(),
      facts: this.usage,
    })
    const persist = callbacks.onCheckpoint && ((checkpoint: ResumeCheckpoint) => callbacks.onCheckpoint!(checkpoint))
    const failed = () => { this.events.emit({ type: 'error', error: CHECKPOINT_FAILED }); void this.shutdown().catch(() => {}) }
    this.checkpoints = new CheckpointGate({ lifecycle: this.lifecycle, persist, failed }, this.runtimeSessionId)
    this.violation = (reason) => logger?.warn({ reason }, 'claude_cli_contract_violation')
    this.binder = new CliTurnBinder({
      violation: this.violation,
      unknownUuid: (uuid) => logger?.warn({ uuid }, 'claude_unknown_result_uuid'),
    })
    this.requests = new ClaudeRequests({
      emit: (body) => this.emit(body),
      turnId: () => this.active()?.turnId ?? '',
      ...(callbacks.onRequest ? { onRequest: callbacks.onRequest } : {}),
      notify: (name, callback) => this.notify(name, callback),
      unanswered: options.unansweredRequests ?? 'deny',
    })
    this.frames = new ClaudeFrames({
      emit: (body) => this.emit(body),
      frameTurnId: () => (this.binder.framesBelongToActive() ? (this.active()?.turnId ?? null) : null),
      activeTurnId: () => this.active()?.turnId ?? null,
      callbacks,
      notify: (name, callback) => this.notify(name, callback),
      compacted: (boundaryId, preTokens, postTokens) => this.usage.compacted(boundaryId, preTokens, postTokens, this.active()),
    })
    const { binder, open, lifecycle } = this
    this.results = { seenResults: new SeenResultFrames(), binder, open, lifecycle, ...(logger ? { logger } : {}), active: () => this.active(), emit: (body) => this.events.emit(body) }
  }

  /**
   * Run a host callback. A throw never escapes into the message loop or
   * teardown; it is retained as an owned failure, so stop reports it.
   */
  private notify(name: string, callback: () => void): void {
    try {
      callback()
    } catch (error) {
      this.lifecycle.jobs.track(`callback:${name}`, Promise.reject(error)).catch(() => {})
    }
  }

  private emit(body: EventBody): void {
    if (body.type === 'tool_call' && this.active()?.turnId === body.turnId) this.active()!.toolIds.add(body.toolCallId)
    this.events.emit(body)
    if (body.type === 'turn_completed' || body.type === 'turn_interrupted') this.frames.turnEnded()
    else if (body.type === 'request_resolved') this.frames.requestResolved()
  }

  get state() {
    return this.lifecycle.state
  }

  private active(): Turn | null {
    return this.open.active()
  }

  start(): Promise<void> {
    return this.lifecycle.start((generation) => this.spawnGeneration(generation))
  }

  private current(): Generation | null {
    return this.generations.at(-1) ?? null
  }

  private async spawnGeneration(number: number): Promise<void> {
    const launch = resolveLaunch(this.options.launch)
    this.usage.spawned(launch.childEnv)
    const executable = launch.executablePath ?? resolveExecutable(launch, 'claude')
    const sdk = await loadSdk()
    // Stop may have begun while the SDK loaded: refuse before any query exists.
    if (this.stopBegun()) throw this.lifecycle.cancelled('the driver was stopped while starting')
    this.binder.reset()
    // The conversation this generation resumes is fixed before its query exists.
    const generation = newGeneration(number, sdk, this.runtimeSessionId)
    const spawn = ownedSpawn(generation, launch, this.options.wire, () => this.stopBegun())
    const options = generationOptions(generation, this.composeSdkOptions(sdk), launch, executable, this.requests.canUseTool, spawn)
    // Registered before query(): the SDK spawns inside it, and a recorder may reenter stop there.
    this.generations.push(generation)
    try {
      generation.query = this.options.queryFactory ? this.options.queryFactory({ prompt: generation.input, options }) : sdk.query({ prompt: generation.input, options })
    } catch (error) {
      generation.retired = true
      if (generation.spawn === 'refused') throw this.lifecycle.cancelled('the driver was stopped before its process was created', [error])
      throw new AgentRuntimeError({ category: 'transport', message: 'the Claude Code query could not be created' }, [error])
    }
    this.reportSpawn(generation, launch)
    this.frames.commands.beginLoading()
    void this.lifecycle.jobs.run(`generation:${number}`, () => this.consume(generation))
    let initialized: Awaited<ReturnType<Query['initializationResult']>>
    try {
      initialized = await generation.query.initializationResult()
    } catch (error) {
      throw await startFailure(generation, this.stopToken, error, (message, causes) => this.lifecycle.cancelled(message, causes))
    }
    generation.initialized = true
    if (generation === this.current() && Array.isArray(initialized?.commands)) this.frames.commands.applyCommands(initialized.commands as RawChatCommand[])
    this.controls.initialized(generation)
  }

  /** onSpawn (R2): one actual query construction's launch provenance. */
  private reportSpawn(generation: Generation, launch: { cwd: string; childEnv: Readonly<Record<string, string>> }): void {
    const onSpawn = this.options.callbacks.onSpawn
    if (!onSpawn) return
    const info = {
      generation: generation.number,
      cwd: launch.cwd,
      childEnv: { ...launch.childEnv },
      systemPromptAppend: this.options.systemPromptAppend ?? '',
      effort: this.options.effort ?? null,
      model: this.options.model ?? null,
      resumed: Boolean(generation.resumeTarget),
    }
    this.notify('onSpawn', () => onSpawn(info))
  }

  private stopBegun(): boolean {
    return this.lifecycle.state === 'stopping' || this.lifecycle.state === 'stopped'
  }

  /** The SDK options of every generation (integrations.ts, composeSessionSdkOptions). */
  private composeSdkOptions(sdk: SdkModule): Partial<Options> {
    return composeSessionSdkOptions(sdk, this.options.sdkOptions ?? {}, this.permissions, {
      tools: this.tools,
      ...(this.options.systemPromptAppend ? { systemPromptAppend: this.options.systemPromptAppend } : {}),
      ...(this.options.onToolObservation ? { onToolObservation: this.options.onToolObservation } : {}),
      ...(this.options.auditHooks ? { auditHooks: this.options.auditHooks } : {}),
      ...(this.options.callbacks.onCwdChanged ? { onCwdChanged: this.options.callbacks.onCwdChanged } : {}),
      turnId: () => this.active()?.turnId ?? null,
      sessionId: () => this.runtimeSessionId,
      observe: (name, callback) => this.notify(name, callback),
      run: (label, body) => this.runOwned(label, body),
    })
  }

  /** Host work started by the CLI or a provider control: an owned job stop joins, refused once stop has begun. */
  private runOwned<T>(label: string, body: () => Promise<T>): Promise<T> | null {
    return this.stopBegun() ? null : this.lifecycle.jobs.run(label, body)
  }

  /** The generation's owned job: read every message, then wait for the ACTUAL exit. */
  private async consume(generation: Generation): Promise<void> {
    let failure: unknown = null
    try {
      for await (const message of generation.query) this.handle(generation, message)
    } catch (error) {
      failure = error
    }
    generation.readEnded = true
    const exit = generation.owned ? await generation.owned.leaderExit : null
    try {
      this.generationEnded(generation, exit)
    } finally {
      generation.markEnded()
    }
    // A read failure is kept unless it is exactly the stop's own cancellation of this query.
    if (failure !== null && !cancelledByStop(generation, this.stopToken, failure)) throw failure
  }

  /** L14-L16: classify and decide every affected turn in one held step, then publish (as refuseSubstitution). */
  private generationEnded(generation: Generation, exit: LeaderExit | null): void {
    // No process existed: the start failure reports it, not an exit (U01).
    if (generation.owned?.exited?.kind === 'spawn-failed') return
    const error: AgentErrorInfo = { category: 'transport', message: 'the agent process exited unexpectedly' }
    const publish = this.lifecycle.holdState(() => {
      if (this.lifecycle.processExit(generation.number) !== 'unexpected') return null
      this.binder.reset()
      return this.open.decide(this.open.take(), 'process-ended', error, 'process_ended')
    })
    if (!publish) return
    const code = exit?.kind === 'exited' ? exit.code : null
    const signal = exit?.kind === 'exited' ? exit.signal : null
    this.requests.cancelAll('process ended')
    this.events.emit({ type: 'error', error })
    publish()
    this.usage.endAll('process-ended')
    this.frames.processEnded()
    const report = { generation: generation.number, code, signal, reason: exit?.kind === 'spawn-failed' ? 'spawn failed' : null }
    this.notify('onProcessEnd', () => this.options.callbacks.onProcessEnd?.(report))
  }

  private handle(generation: Generation, message: SDKMessage): void {
    // A superseded or failed generation's frames never reach the conversation.
    if (generation.retired || generation !== this.current()) return
    if (keepStartupFailure(generation, message)) return
    const frame = message as unknown as Record<string, unknown>
    const bound = this.binder.framesBelongToActive() ? this.active() : null
    if (this.usage.sessionFrame(frame)) return
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') return this.init(generation, message)
        if (message.subtype === 'api_retry') this.usage.apiRetry(frame, bound)
        return this.frames.system(message)
      case 'assistant': {
        this.usage.assistant(frame, bound)
        const content = this.frames.assistant(message)
        const turn = this.active()
        if (!content || !turn) return
        if (content.text) turn.finalText = content.text
        turn.model = content.model ?? turn.model
        return
      }
      case 'user':
        return this.frames.user(message)
      case 'stream_event':
        this.usage.partial(frame, this.active(), bound)
        this.frames.partial(message)
        return
      case 'result':
        // INV-A2: decide, then this frame's publications and observations (old-frame scope), then a queued successor.
        // The result's model window is read before the turn settles, as the source driver did, so a host
        // writing its context reading at the turn boundary sees the reading this result completes.
        this.lifecycle.holdState(() => {
          this.oldFrame.run(() => (this.usage.result(frame), settleResult(this.results, message)))
          this.promote(generation)
        })
        this.controls.probe(generation)
        return
    }
  }

  private init(generation: Generation, message: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>): void {
    // G1: a resumed generation's first identity must be its target, before any adoption, checkpoint, model, binder or turn effect.
    if (generation.resumeTarget !== null && !generation.identityConfirmed) {
      if (message.session_id !== generation.resumeTarget) return this.refuseSubstitution(generation)
      generation.identityConfirmed = true
    }
    // Each init reporting a capabilities array replaces this generation's answer; any other value keeps it.
    const capabilities = (message as { capabilities?: unknown }).capabilities
    if (Array.isArray(capabilities)) generation.cancelQueued = capabilities.includes('interrupt_cancel_queued_v1')
    if (message.session_id) {
      this.runtimeSessionId = message.session_id
      this.checkpoints.report({ runtime: 'claude', runtimeSessionId: message.session_id })
    }
    this.usage.model(message.model)
    this.frames.commands.applyTerminalCommands((message as { terminal_slash_commands?: string[] }).terminal_slash_commands)
    // An init that no submission opened is an agent-started turn (L24); it
    // opens only while idle (L25 binds, L26 ignores), and an init that opens
    // an interrupted turn whose result is owed opens nothing.
    if (this.binder.init() !== 'open') return
    const turn = newTurn(crypto.randomUUID(), null, '')
    this.lifecycle.holdState(() => {
      if (this.lifecycle.native(turn.turnId) !== 'open') return
      this.open.push(turn)
      this.openTurn(turn, true)
    })
  }

  /**
   * G1/R10: the runtime answered a resume with another conversation (or
   * none); nothing of it is adopted. With no callback, the generation
   * retires, the owned failure becomes sticky, and every open turn's result
   * is decided. Only then: request cancellations, the error, the opened
   * turns' completions and each handle once, so a stop or interrupt
   * reentered from those callbacks finds no open turn. Then the driver
   * disposes itself from outside the consuming job.
   */
  private refuseSubstitution(generation: Generation): void {
    generation.retired = true
    const error: AgentErrorInfo = { category: 'resume', message: 'the runtime did not resume the supplied conversation' }
    this.resumeFailure = error
    this.lifecycle.jobs.track(`resume:${generation.number}`, Promise.reject(new AgentRuntimeError({ ...error }))).catch(() => {})
    this.binder.reset()
    const publish = this.open.decide(this.open.take(), 'failed', error, 'resume_refused')
    this.requests.cancelAll('resume refused')
    this.events.emit({ type: 'error', error })
    this.lifecycle.holdState(publish)
    this.lifecycle.jobs.outside(() => void this.shutdown().catch(() => {}))
  }

  /** A queued turn opens after its predecessor's frame, unless a stop began or the generation changed meanwhile. */
  private promote(generation: Generation): void {
    const next = this.open.next()
    if (next && !next.opened && !next.settled && !this.stopBegun() && !generation.retired && generation === this.current()) this.openTurn(next, false)
  }

  /** R10/I2: acknowledged only once any pending identity persistence succeeded (the gate, lifecycle/checkpoints.ts). */
  send(text: string, submit: SubmitOptions = {}): Promise<TurnHandle> {
    // R9: the Codex-only skill mode is refused, not ignored, before anything is admitted.
    if (submit.codexSkills !== undefined) return Promise.reject(new AgentRuntimeError({ category: 'unsupported', message: 'codexSkills is not supported by the Claude runtime' }))
    if (this.resumeFailure) return Promise.reject(new AgentRuntimeError({ ...this.resumeFailure }))
    return this.checkpoints.admit(submit.continuation, {
      // P12/P13: the host decides before anything is enqueued or emitted, and
      // an accepted submission keeps the identity the host recorded.
      prepare: () => {
        const messageUuid = submit.messageUuid ?? crypto.randomUUID()
        const turnId = crypto.randomUUID()
        checkSubmission(this.options.beforeSubmit, { messageUuid, turnId, text, context: submit.context })
        // R4: the host's additions to this prompt, on the same identities;
        // the admission decides again after it, as after beforeSubmit.
        const envelope = composeEnvelope(this.options.composePrompt, { messageUuid, turnId, text, context: submit.context }, (pending) => {
          this.lifecycle.jobs.track('callback:composePrompt', Promise.resolve(pending)).catch(() => {})
        })
        const turn = newTurn(turnId, messageUuid, text)
        turn.envelope = envelope
        return turn
      },
      commit: (admission, turn) => this.accept(turn, admission),
    })
  }

  /**
   * Acceptance is the enqueue: it comes first, and a refused enqueue
   * accepts nothing. The prompt is the turn's before any publication, so an
   * interrupt from a callback during turn_started or user_message finds the
   * turn holding it and owes its result once.
   */
  private accept(turn: Turn, admission: Admission): TurnHandle {
    const messageUuid = turn.messageUuid!
    const pushed = this.current()!.input.push(promptMessage(turn.text, messageUuid, turn.envelope))
    if (!pushed) throw new AgentRuntimeError({ category: 'stopped', message: 'the driver is stopped' })
    this.open.push(turn)
    this.frames.sent(messageUuid, turn.text)
    this.binder.promptSent(messageUuid, turn.turnId)
    if (admission === 'new-turn') this.lifecycle.holdState(() => this.openTurn(turn, false))
    return { turnId: turn.turnId, messageUuid, result: turn.result }
  }

  /** Emit turn_started (and the opening user message of a submitted turn). */
  private openTurn(turn: Turn, agentStarted: boolean): void {
    // INV-A2: inside a decided frame's scope the turn holds its admission now and opens after it.
    this.oldFrame.openTurn({ mark: () => void (turn.opened = true), begin: () => void (agentStarted || this.lifecycle.beginTurn(turn.turnId)), settled: () => turn.settled, announce: () => {
      this.binder.turnOpened(turn.turnId, agentStarted)
      const trigger = agentStarted ? this.frames.takeTrigger() : null
      this.frames.turnOpened()
      this.emit({ type: 'turn_started', turnId: turn.turnId, ...(trigger ? { trigger } : {}) })
      if (turn.messageUuid !== null) this.emit({ type: 'user_message', turnId: turn.turnId, text: turn.text, messageUuid: turn.messageUuid })
    } })
  }

  /**
   * L09/L10/L13, R3 A4: refuse every waiting send first (before any
   * callback), then settle the active and queued turns at once with state
   * publications held, then ask the CLI to stop the turn. Cancelling a
   * waiting send makes the receipt requested even with no active turn.
   */
  async interrupt(): Promise<InterruptReceipt> {
    if (this.stopBegun()) throw new AgentRuntimeError({ category: 'stopped', message: 'the driver is stopped' })
    // INV-A2: from a decided frame's own publications or observations it acts on that frame's turn only, already decided.
    if (this.oldFrame.active) return { outcome: 'no-active-turn', processExit: false }
    const cancelled = this.checkpoints.cancelWaiting()
    const receipt = this.lifecycle.holdState(() => this.interruptTurns())
    return cancelled > 0 ? { outcome: 'requested', processExit: false } : receipt
  }

  private interruptTurns(): InterruptReceipt {
    const receipt = this.lifecycle.interrupt()
    const generation = this.current()
    if (generation) this.binder.promptsWithdrawn(generation.input.clearPending().flatMap((m) => (m.uuid ? [m.uuid] : [])))
    this.requests.cancelAll('interrupted')
    const error: AgentErrorInfo = { category: 'stopped', message: 'the turn was interrupted' }
    const turns = this.open.take()
    const active = turns[0]?.opened ? turns[0] : undefined
    if (active) this.binder.turnInterrupted(active.turnId)
    this.open.settleAll(turns, error)
    this.frames.interrupted()
    if (generation && active) {
      // Stop and urgent mail reach here; kill and shutdown never interrupt.
      if (!generation.cancelQueued) this.violation('interrupt-cancel-queued-unsupported')
      void this.lifecycle.jobs.run(
        `interrupt:${generation.number}`,
        async () => {
          const cancelled = await interruptGeneration(generation)
          // Cancelled prompts never run: an interrupted turn whose prompts were all cancelled owes no result.
          if (generation === this.current()) this.binder.promptsWithdrawn(cancelled)
        },
        { expectedCancellation: (error) => cancelledByStop(generation, this.stopToken, error) },
      )
    }
    return receipt
  }

  resolveApproval(requestId: string, decision: 'allow' | 'deny', options?: AnswerOptions): AnswerOutcome {
    return this.requests.resolveApproval(requestId, decision, options)
  }

  answerQuestion(requestId: string, answers: QuestionAnswers, options?: AnswerOptions): AnswerOutcome {
    return this.requests.answerQuestion(requestId, answers, options)
  }

  pendingRequests(): PendingRequest[] {
    return this.requests.list()
  }

  /** A background task's output tail through the CLI's get_task_output control; null when unavailable. */
  getTaskOutput(taskId: string): Promise<TaskOutput | null> {
    return this.taskControl(`task-output:${taskId}`, null, (query) => readTaskOutput(query, taskId))
  }

  /** Stop one background task; false when refused, unknown or no live process. */
  stopTask(taskId: string): Promise<boolean> {
    return this.taskControl(`stop-task:${taskId}`, false, (query) => stopQueryTask(query, taskId))
  }

  /** A task control on the live query as an owned job; `fallback` with no live process or once stop began. */
  private async taskControl<T>(label: string, fallback: T, body: (query: Query) => Promise<T>): Promise<T> {
    const query = this.current()?.query
    const owned = query && this.lifecycle.state !== 'exited' ? this.runOwned(label, () => body(query)) : null
    return owned ? await owned : fallback
  }

  kill(): Promise<ProcessExitReceipt> {
    return this.lifecycle.stop('kill', () => this.teardown('kill'), () => accountGenerations(this.generations))
  }

  shutdown(): Promise<ProcessExitReceipt> {
    return this.lifecycle.stop('shutdown', () => this.teardown('shutdown'), () => accountGenerations(this.generations))
  }

  /** Close every input and request, settle open turns as stopped (L11), terminate every owned generation. */
  private async teardown(mode: 'kill' | 'shutdown'): Promise<ProcessExitFact[]> {
    // The lifecycle runs teardown once per stop; its token is minted before any callback below can run.
    this.stopToken = { reason: 'the agent-runtime driver is stopping' }
    const error: AgentErrorInfo = { category: 'stopped', message: 'the driver was stopped' }
    this.requests.close()
    this.open.settleAll(this.open.take(), error)
    this.usage.endAll('cancelled')
    this.binder.reset()
    this.frames.processEnded()
    return terminateGenerations(this.generations, mode, this.options.terminate ?? {}, this.stopToken)
  }
}
