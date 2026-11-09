// The Claude driver core (tasks 2.2/2.4, 4.1): the pinned SDK's query() on
// the owned spawner, through the shared lifecycle core.
//
// - Generations. Each generation's message loop is an owned job that
//   completes only at the leader's actual exit. start resolves on the CLI's
//   initialize response. A respawn after an unexpected exit resumes the same
//   conversation.
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
import type { Options, Query, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AnswerOptions, AnswerOutcome, InterruptReceipt, ProcessExitFact, ProcessExitReceipt, ResumeCheckpoint, SubmitOptions, TaskOutput, TurnHandle, TurnOutcome } from '../contract.js'
import { AgentRuntimeError, type AgentErrorInfo } from '../errors.js'
import { EventStream, type EventBody } from '../eventStream.js'
import type { PendingRequest, QuestionAnswers } from '../events.js'
import { CHECKPOINT_FAILED, CheckpointGate } from '../lifecycle/checkpoints.js'
import { DriverLifecycle, type Admission } from '../lifecycle/lifecycle.js'
import { resolveExecutable, resolveLaunch } from '../process/launch.js'
import type { LeaderExit } from '../process/ownedProcess.js'
import { bindToolSet, type BoundToolSet } from '../tools/toolSet.js'
import type { RawChatCommand } from './commands.js'
import { ClaudeFrames } from './frames.js'
import { claudeIntegrationOptions, mergeHooks } from './integrations.js'
import { composeClaudePermissions, withPermissions, type ClaudePermissionComposition } from './permissions.js'
import { accountGenerations, cancelledByStop, interruptGeneration, linkedAbort, loadSdk, newGeneration, ownedSpawn, readTaskOutput, stopQueryTask, terminateGenerations, type Generation } from './generations.js'
import { ClaudeRequests } from './requests.js'
import { SeenResultFrames } from './resultFrames.js'
import { CliTurnBinder } from './turnBinder.js'
import { OpenTurns } from './openTurns.js'
import { checkSubmission, newTurn, resultErrorText, resultUuids, type Turn } from './turns.js'
import type { ClaudeSessionOptions } from './sessionOptions.js'
export type { ClaudeQueryFactory, ClaudeSessionOptions } from './sessionOptions.js'

export class ClaudeSession {
  readonly runtime = 'claude' as const
  readonly lifecycle: DriverLifecycle
  private readonly events: EventStream
  private readonly generations: Generation[] = []
  /** Open turns in FIFO order: the active turn first, then queued ones (L21). */
  private readonly open: OpenTurns
  private readonly binder: CliTurnBinder
  private readonly requests: ClaudeRequests
  private readonly frames: ClaudeFrames
  private readonly checkpoints: CheckpointGate

  /** Validated once at construction: an unenforceable restriction never starts. */
  private readonly permissions: ClaudePermissionComposition | null
  private readonly tools: BoundToolSet | null
  /** The CLI's session id, from the latest system/init. */
  private runtimeSessionId: string | null
  private lastModel: string | null = null
  private readonly seenResults = new SeenResultFrames()
  /** Minted when stop cancels the queries: the abort reason that marks its own cancellations. */
  private stopToken: object | null = null

  constructor(private readonly options: ClaudeSessionOptions) {
    this.tools = bindToolSet(options.tools)
    // Only an omitted policy means none: any supplied value, null included, is validated.
    this.permissions = options.permissions === undefined ? null : composeClaudePermissions(options.permissions)
    this.runtimeSessionId = options.resume?.runtimeSessionId ?? null
    const { callbacks, logger } = options
    this.events = new EventStream((event) => this.notify('onEvent', () => callbacks.onEvent(event)))
    this.open = new OpenTurns({ emit: (body) => this.emit(body), notify: (name, callback) => this.notify(name, callback), onTurnResult: callbacks.onTurnResult })
    this.lifecycle = new DriverLifecycle({ continuations: new Set(['queue']), ...(callbacks.onState ? { onState: callbacks.onState } : {}) })
    const persist = callbacks.onCheckpoint && ((checkpoint: ResumeCheckpoint) => callbacks.onCheckpoint!(checkpoint))
    const failed = () => { this.events.emit({ type: 'error', error: CHECKPOINT_FAILED }); void this.shutdown().catch(() => {}) }
    this.checkpoints = new CheckpointGate({ lifecycle: this.lifecycle, persist, failed }, this.runtimeSessionId)
    this.binder = new CliTurnBinder({
      violation: (reason) => logger?.warn({ reason }, 'claude_cli_contract_violation'),
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
      compacted: (boundaryId, preTokens) => {
        const onCompaction = callbacks.onCompaction
        const turnId = this.active()?.turnId ?? null
        if (onCompaction) this.notify('onCompaction', () => onCompaction({ boundaryId, turnId, preTokens }))
      },
    })
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
    const executable = launch.executablePath ?? resolveExecutable(launch, 'claude')
    const sdk = await loadSdk()
    // Stop may have begun while the SDK loaded: refuse before any query exists.
    if (this.stopBegun()) throw this.lifecycle.cancelled('the driver was stopped while starting')
    this.binder.reset()
    const generation = newGeneration(number, sdk)
    const composed = this.composeSdkOptions(sdk)
    const options: Options = {
      settingSources: [],
      includePartialMessages: true,
      ...composed,
      // Requests ride canUseTool, which bypass mode never consults: leave it unset there.
      ...(composed.permissionMode === 'bypassPermissions' ? {} : { canUseTool: this.requests.canUseTool }),
      ...(this.runtimeSessionId ? { resume: this.runtimeSessionId } : {}),
      // The query's cancel is the stop's; a caller's controller forwards into it with its own reason.
      abortController: linkedAbort(generation.abort, composed.abortController),
      cwd: launch.cwd,
      pathToClaudeCodeExecutable: executable,
      // Ignored by the owned spawner (I3); passed so the SDK computes nothing from process.env.
      env: { ...launch.childEnv },
      spawnClaudeCodeProcess: ownedSpawn(generation, launch, this.options.wire, () => this.stopBegun()),
    }
    // Registered before query(): the SDK spawns inside it, and a recorder may reenter stop there.
    this.generations.push(generation)
    try {
      generation.query = this.options.queryFactory ? this.options.queryFactory({ prompt: generation.input, options }) : sdk.query({ prompt: generation.input, options })
    } catch (error) {
      generation.retired = true
      if (generation.spawn === 'refused') throw this.lifecycle.cancelled('the driver was stopped before its process was created', [error])
      throw new AgentRuntimeError({ category: 'transport', message: 'the Claude Code query could not be created' }, [error])
    }
    this.frames.commands.beginLoading()
    void this.lifecycle.jobs.run(`generation:${number}`, () => this.consume(generation))
    let initialized: Awaited<ReturnType<Query['initializationResult']>>
    try {
      initialized = await generation.query.initializationResult()
    } catch (error) {
      // The SDK's rejection is never proof that the stop caused it: it stays a failure the stop reports.
      generation.retired = true
      // A spawn failure created no process: start fails and the prior state returns.
      const exit = generation.owned?.exited
      // Proven no launch: the owned spawner refused because stop had begun.
      if (generation.spawn === 'refused') throw this.lifecycle.cancelled('the driver was stopped before its process was created', [error])
      if (exit?.kind === 'spawn-failed') throw new AgentRuntimeError({ category: 'dependency', message: 'the Claude Code executable could not be started' }, [error])
      if (cancelledByStop(generation, this.stopToken, error)) throw this.lifecycle.cancelled('the driver was stopped while starting', [error])
      // A process that exited while starting is classified first (L14: exited, one process end), then start rejects.
      if (exit || generation.readEnded) await generation.ended
      throw new AgentRuntimeError({ category: 'transport', message: 'the Claude Code process did not initialize' }, [error])
    }
    if (generation === this.current() && Array.isArray(initialized?.commands)) this.frames.commands.applyCommands(initialized.commands as RawChatCommand[])
  }

  private stopBegun(): boolean {
    return this.lifecycle.state === 'stopping' || this.lifecycle.state === 'stopped'
  }

  /**
   * Caller SDK options, then this session's integrations (tool server, prompt
   * append, observation hooks after the caller's), then the policy, which
   * overrides policy fields and puts its deny hook first.
   */
  private composeSdkOptions(sdk: Parameters<typeof claudeIntegrationOptions>[0]): Partial<Options> {
    const base = this.options.sdkOptions ?? {}
    const integration = claudeIntegrationOptions(sdk, {
      tools: this.tools,
      ...(this.options.systemPromptAppend ? { systemPromptAppend: this.options.systemPromptAppend } : {}),
      ...(this.options.onToolObservation ? { onToolObservation: this.options.onToolObservation } : {}),
      ...(this.options.auditHooks ? { auditHooks: this.options.auditHooks } : {}),
      turnId: () => this.active()?.turnId ?? null,
      sessionId: () => this.runtimeSessionId,
      observe: (name, callback) => this.notify(name, callback),
      run: (label, body) => this.runOwned(label, body),
    })
    const hooks = mergeHooks(base.hooks, integration.hooks)
    const composed: Partial<Options> = {
      ...base,
      ...(integration.mcpServers ? { mcpServers: { ...base.mcpServers, ...integration.mcpServers } } : {}),
      ...(integration.systemPrompt ? { systemPrompt: integration.systemPrompt } : {}),
      ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    }
    return this.permissions ? withPermissions(composed, this.permissions) : composed
  }

  /** Host work started by the CLI or a provider control: an owned job stop joins, refused once stop has begun. */
  private runOwned<T>(label: string, body: () => Promise<T>): Promise<T> | null {
    const state = this.lifecycle.state
    if (state === 'stopping' || state === 'stopped') return null
    return this.lifecycle.jobs.run(label, body)
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

  private generationEnded(generation: Generation, exit: LeaderExit | null): void {
    // No process existed: the start failure reports it, not an exit (U01).
    if (generation.owned?.exited?.kind === 'spawn-failed') return
    if (this.lifecycle.processExit(generation.number) !== 'unexpected') return
    const code = exit?.kind === 'exited' ? exit.code : null
    const signal = exit?.kind === 'exited' ? exit.signal : null
    const error: AgentErrorInfo = { category: 'transport', message: 'the agent process exited unexpectedly' }
    this.binder.reset()
    this.requests.cancelAll('process ended')
    this.events.emit({ type: 'error', error })
    for (const turn of this.open.take()) this.open.settle(turn, 'process-ended', error, 'process_ended')
    this.frames.processEnded()
    const report = { generation: generation.number, code, signal, reason: exit?.kind === 'spawn-failed' ? 'spawn failed' : null }
    this.notify('onProcessEnd', () => this.options.callbacks.onProcessEnd?.(report))
  }

  private handle(generation: Generation, message: SDKMessage): void {
    // A superseded or failed generation's frames never reach the conversation.
    if (generation.retired || generation !== this.current()) return
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.init(message)
        else this.frames.system(message)
        return
      case 'assistant': {
        const content = this.frames.assistant(message)
        const turn = this.active()
        if (!content || !turn) return
        if (content.text) turn.finalText = content.text
        turn.model = content.model ?? turn.model
        return
      }
      case 'user':
        this.frames.user(message)
        return
      case 'stream_event':
        this.frames.partial(message)
        return
      case 'result':
        this.result(message)
        return
    }
  }

  private init(message: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>): void {
    if (message.session_id) {
      this.runtimeSessionId = message.session_id
      this.checkpoints.report({ runtime: 'claude', runtimeSessionId: message.session_id })
    }
    if (typeof message.model === 'string' && message.model && message.model !== this.lastModel) {
      const model = message.model
      this.lastModel = model
      const onModel = this.options.callbacks.onModel
      if (onModel) this.notify('onModel', () => onModel(model))
    }
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

  private result(message: SDKResultMessage): void {
    this.lifecycle.holdState(() => this.settleResult(message))
  }

  private settleResult(message: SDKResultMessage): void {
    const identity = this.seenResults.first(message.uuid)
    if (identity === 'unidentified') this.options.logger?.warn({}, 'claude_result_without_frame_uuid')
    if (identity !== 'first') return
    const uuids = resultUuids(message)
    if (this.binder.result(uuids, message.queued_turn_count) === 'drop') return
    const turn = this.active()
    if (!turn || turn.settled) return
    // Queued prompts the CLI consumed into this turn share its result.
    const absorbed = this.open.queuedWith(uuids, turn)
    for (const _ of absorbed) this.lifecycle.withdraw('queue')
    if (!this.lifecycle.result(turn.turnId)) return
    this.open.remove([turn, ...absorbed])
    const failed = message.subtype !== 'success' || message.is_error
    if (!failed && message.subtype === 'success') turn.finalText = message.result
    const error: AgentErrorInfo | null = failed ? { category: 'provider', message: resultErrorText(message) } : null
    const result = this.open.settle(turn, failed ? 'failed' : 'success', error, message.subtype, message)
    for (const queued of absorbed) {
      queued.settled = true
      queued.resolve(result)
    }
    if (failed) this.events.emit({ type: 'error', error: error! })
    const next = this.open.next()
    if (next) this.openTurn(next, false)
  }

  /** R10/I2: acknowledged only once any pending identity persistence succeeded (the gate, lifecycle/checkpoints.ts). */
  send(text: string, submit: SubmitOptions = {}): Promise<TurnHandle> {
    return this.checkpoints.admit(submit.continuation, {
      // P12/P13: the host decides before anything is enqueued or emitted, and
      // an accepted submission keeps the identity the host recorded.
      prepare: () => {
        const messageUuid = submit.messageUuid ?? crypto.randomUUID()
        const turnId = crypto.randomUUID()
        checkSubmission(this.options.beforeSubmit, { messageUuid, turnId, text, context: submit.context })
        return newTurn(turnId, messageUuid, text)
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
    const pushed = this.current()!.input.push({
      type: 'user',
      message: { role: 'user', content: turn.text },
      parent_tool_use_id: null,
      uuid: messageUuid,
      session_id: '',
    } as SDKUserMessage)
    if (!pushed) throw new AgentRuntimeError({ category: 'stopped', message: 'the driver is stopped' })
    this.open.push(turn)
    this.frames.sent(messageUuid, turn.text)
    this.binder.promptSent(messageUuid, turn.turnId)
    if (admission === 'new-turn') this.lifecycle.holdState(() => this.openTurn(turn, false))
    return { turnId: turn.turnId, messageUuid, result: turn.result }
  }

  /** Emit turn_started (and the opening user message of a submitted turn). */
  private openTurn(turn: Turn, agentStarted: boolean): void {
    turn.opened = true
    if (!agentStarted) this.lifecycle.beginTurn(turn.turnId)
    this.binder.turnOpened(turn.turnId, agentStarted)
    const trigger = agentStarted ? this.frames.takeTrigger() : null
    this.frames.turnOpened()
    this.emit({ type: 'turn_started', turnId: turn.turnId, ...(trigger ? { trigger } : {}) })
    if (turn.messageUuid !== null) this.emit({ type: 'user_message', turnId: turn.turnId, text: turn.text, messageUuid: turn.messageUuid })
  }

  /**
   * L09/L10/L13, R3 A4: refuse every waiting send first (before any
   * callback), then settle the active and queued turns at once with state
   * publications held, then ask the CLI to stop the turn. Cancelling a
   * waiting send makes the receipt requested even with no active turn.
   */
  async interrupt(): Promise<InterruptReceipt> {
    if (this.stopBegun()) throw new AgentRuntimeError({ category: 'stopped', message: 'the driver is stopped' })
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
  async getTaskOutput(taskId: string): Promise<TaskOutput | null> {
    const query = this.current()?.query
    if (!query || this.lifecycle.state === 'exited') return null
    const owned = this.runOwned(`task-output:${taskId}`, () => readTaskOutput(query, taskId))
    return owned ? await owned : null
  }

  /** Stop one background task; false when refused, unknown or no live process. */
  async stopTask(taskId: string): Promise<boolean> {
    const query = this.current()?.query
    if (!query || this.lifecycle.state === 'exited') return false
    const owned = this.runOwned(`stop-task:${taskId}`, () => stopQueryTask(query, taskId))
    return owned ? await owned : false
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
    this.binder.reset()
    this.frames.processEnded()
    return terminateGenerations(this.generations, mode, this.options.terminate ?? {}, this.stopToken)
  }
}
