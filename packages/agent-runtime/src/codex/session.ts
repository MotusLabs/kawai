// The Codex driver core (task 4.2, with the Codex parts of 4.3-4.5): one
// owned `codex app-server` per generation (appServerTransport.ts), composed
// with the shared lifecycle core, checkpoint gate and event stream.
//
// - Start. Explicit and promptless: initialize, then thread/start, or
//   thread/resume of the saved thread id (generation.ts). Every generation
//   reads the launch again and spawns with exactly its cwd and env. A resume
//   that is refused, or answered with another thread, fails start with
//   category `resume` and never falls back to a fresh thread; the next start
//   tries the same saved id again.
// - Identity. send mints the turn id and message UUID (clientUserMessageId);
//   the app-server's turn id binds from the turn/start reply or turn/started,
//   whichever comes first (turns.ts). Results and facts bind only by that
//   native id, so a late or foreign turn/completed completes nothing (R03).
//   An app-server turn no send opened is agent-started while idle (L24),
//   binds to the active turn while active (L25), and opens nothing otherwise.
// - Continuation. steer joins the active turn through turn/steer with its
//   native id as expectedTurnId; the handle shares that turn's result (L22).
//   queue is unsupported (L23).
// - Policy. The composed permissions go on every thread/start, thread/resume
//   and turn/start. Server requests follow their disposition: a fixed answer,
//   a host request (requests.ts), a host tool call (tools.ts) or a deliberate
//   error reply. Every host request, tool call and control is an owned job.
// - Checkpoints. The thread id and path are reported through the gate before
//   dependent sends are acknowledged; interrupt refuses every waiting send.
// - Stop. The lifecycle reserves the terminal promise first; teardown closes
//   requests, settles the open turn as stopped, then stops every generation's
//   transport (current and retired) and joins all owned work; accounting adds
//   each process's native evidence.
// - Unexpected exit. The open turn's outcome is decided before any callback;
//   then requests cancel, one transport error, the turn's completion and one
//   onProcessEnd.
import type { AnswerOptions, AnswerOutcome, InterruptReceipt, ProcessExitFact, ProcessExitReceipt, SubmitOptions, TurnHandle, TurnOutcome } from '../contract.js'
import { AgentRuntimeError, type AgentErrorInfo } from '../errors.js'
import { EventStream, type EventBody } from '../eventStream.js'
import type { PendingRequest, QuestionAnswers } from '../events.js'
import type { JsonObject } from '../json.js'
import { CHECKPOINT_FAILED, CheckpointGate } from '../lifecycle/checkpoints.js'
import { DriverLifecycle } from '../lifecycle/lifecycle.js'
import { resolveExecutable, resolveLaunch, type ResolvedLaunch } from '../process/launch.js'
import type { LeaderExit } from '../process/ownedProcess.js'
import { bindToolSet, type BoundToolSet } from '../tools/toolSet.js'
import { checkSubmission } from '../claude/turns.js'
import { AppServerRpcError, AppServerTransport, ServerRequestRefusal } from './appServerTransport.js'
import { codexErrorCategory, rpcErrorInfo } from './auth.js'
import { CodexFacts } from './facts.js'
import { accountGenerations, CAPABILITIES, CLIENT_INFO, newGeneration, startFailure, stopGeneration, threadOpened, type CodexGeneration } from './generation.js'
import { codexThreadResumeParams, codexThreadStartParams, codexTurnStartParams, composeCodexPermissions, type CodexPermissionComposition } from './permissions.js'
import { cancelReply, CodexRequests } from './requests.js'
import type { CodexSessionOptions } from './sessionOptions.js'
import { codexDynamicTools, dispatchCodexToolCall, type CodexDynamicToolCall } from './tools.js'
import { codexTurnResult, newCodexTurn, type CodexTurnState } from './turns.js'
export type { CodexSessionOptions } from './sessionOptions.js'

interface Prepared {
  messageUuid: string
  turnId: string
  text: string
  /** The active turn a steer was prepared against, else null. */
  steers: CodexTurnState | null
}

const STOPPED: AgentErrorInfo = { category: 'stopped', message: 'the driver was stopped' }
const INTERRUPTED: AgentErrorInfo = { category: 'stopped', message: 'the turn was interrupted' }

export class CodexSession {
  readonly runtime = 'codex' as const
  readonly lifecycle: DriverLifecycle
  private readonly events: EventStream
  private readonly generations: CodexGeneration[] = []
  private readonly requests: CodexRequests
  private readonly checkpoints: CheckpointGate
  private readonly facts: CodexFacts
  private readonly permissions: CodexPermissionComposition
  private readonly tools: BoundToolSet | null
  /** The saved or opened thread: every later generation resumes it. */
  private threadId: string | null
  /** The open turn (Codex runs one at a time). */
  private turn: CodexTurnState | null = null
  /** Every bound native turn id, for the session's life (late input for a settled turn is dropped). */
  private readonly native = new Map<string, CodexTurnState>()
  /** Submitted turns whose native id is not known yet, oldest first. */
  private unbound: CodexTurnState[] = []
  private model: string | null = null

  constructor(private readonly options: CodexSessionOptions) {
    this.tools = bindToolSet(options.tools)
    this.permissions = composeCodexPermissions(options.permissions)
    this.threadId = options.resume?.runtimeSessionId ?? null
    const { callbacks } = options
    this.events = new EventStream((event) => this.notify('onEvent', () => callbacks.onEvent(event)))
    this.lifecycle = new DriverLifecycle({ continuations: new Set(['steer']), ...(callbacks.onState ? { onState: callbacks.onState } : {}) })
    const persist = callbacks.onCheckpoint && ((checkpoint: Parameters<NonNullable<typeof callbacks.onCheckpoint>>[0]) => callbacks.onCheckpoint!(checkpoint))
    const failed = () => {
      this.events.emit({ type: 'error', error: CHECKPOINT_FAILED })
      void this.shutdown().catch(() => {})
    }
    this.checkpoints = new CheckpointGate({ lifecycle: this.lifecycle, persist, failed }, this.threadId)
    this.requests = new CodexRequests({
      emit: (body) => this.events.emit(body),
      turnId: (params) => this.turnFor(params)?.turnId ?? '',
      ...(callbacks.onRequest ? { onRequest: callbacks.onRequest } : {}),
      notify: (name, callback) => this.notify(name, callback),
      unanswered: options.unansweredRequests ?? 'deny',
    })
    this.facts = new CodexFacts({
      emit: (body) => this.events.emit(body),
      notify: (name, callback) => this.notify(name, callback),
      callbacks,
      ...(options.onToolObservation ? { onToolObservation: options.onToolObservation } : {}),
      ...(options.auditHooks ? { auditHooks: options.auditHooks } : {}),
    })
  }

  /** Run a host callback; a throw is retained as an owned failure the stop reports (R11). */
  private notify(name: string, callback: () => void): void {
    try {
      callback()
    } catch (error) {
      this.lifecycle.jobs.track(`callback:${name}`, Promise.reject(error)).catch(() => {})
    }
  }

  private emit(body: EventBody): void {
    this.events.emit(body)
  }

  get state() {
    return this.lifecycle.state
  }

  private stopBegun(): boolean {
    return this.lifecycle.state === 'stopping' || this.lifecycle.state === 'stopped'
  }

  private current(): CodexGeneration | null {
    return this.generations.at(-1) ?? null
  }

  /** Owned host work; refused (null) once stop has begun. */
  private runOwned<T>(label: string, body: () => Promise<T>): Promise<T> | null {
    if (this.stopBegun()) return null
    return this.lifecycle.jobs.run(label, body)
  }

  start(): Promise<void> {
    return this.lifecycle.start((generation) => this.boot(generation))
  }

  private async boot(number: number): Promise<void> {
    const launch = resolveLaunch(this.options.launch)
    const command = resolveExecutable(launch, 'codex')
    if (this.stopBegun()) throw this.lifecycle.cancelled('the driver was stopped while starting')
    let generation!: CodexGeneration
    const transport = new AppServerTransport({
      launch,
      generation: number,
      command,
      ...(this.options.wire ? { wire: this.options.wire } : {}),
      clientInfo: CLIENT_INFO,
      capabilities: CAPABILITIES,
      onNotification: (method, params) => this.notification(generation, method, params),
      onServerRequest: (method, params, signal) => this.serverRequest(generation, method, params, signal),
      onExit: (exit) => this.exited(generation, exit),
      ...(this.options.terminate ? { terminate: this.options.terminate } : {}),
      ...(this.options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
    })
    // The resume target is fixed before the process exists; a superseded generation is retired first.
    generation = newGeneration(number, transport, this.threadId)
    const previous = this.current()
    if (previous) this.retire(previous)
    this.generations.push(generation)
    // The process and its reader live outside this initialization job: host callbacks they run are not inside it.
    this.lifecycle.jobs.outside(() => transport.start())
    let step: 'initialize' | 'thread/start' | 'thread/resume' = 'initialize'
    let opened: ReturnType<typeof threadOpened>
    try {
      await transport.initialize()
      step = generation.resumeTarget ? 'thread/resume' : 'thread/start'
      opened = threadOpened(await transport.request(step, this.threadParams(launch, generation.resumeTarget)))
      if (!opened) throw new AgentRuntimeError({ category: 'transport', message: `the app-server answered ${step} without a thread` })
      if (generation.resumeTarget !== null && opened.threadId !== generation.resumeTarget) {
        throw new AgentRuntimeError({ category: 'resume', message: 'the app-server did not resume the saved thread' })
      }
    } catch (error) {
      this.retire(generation)
      if (this.stopBegun() && error instanceof AgentRuntimeError && error.category === 'stopped') throw this.lifecycle.cancelled('the driver was stopped while starting', [error])
      if (error instanceof AgentRuntimeError && (error.category === 'resume' || error.category === 'transport') && error.causes.length === 0) throw error
      throw startFailure(step, error)
    }
    if (this.stopBegun()) throw this.lifecycle.cancelled('the driver was stopped while starting')
    generation.threadId = opened.threadId
    this.threadId = opened.threadId
    this.reportModel(opened.model)
    this.checkpoints.report({ runtime: 'codex', runtimeSessionId: opened.threadId, ...(opened.path ? { transcriptPath: opened.path } : {}) })
  }

  /** thread/start or thread/resume parameters: caller fields, then the policy (which wins). */
  private threadParams(launch: ResolvedLaunch, resumeTarget: string | null): JsonObject {
    const caller: Record<string, unknown> = {
      cwd: launch.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.systemPromptAppend ? { developerInstructions: this.options.systemPromptAppend } : {}),
    }
    if (resumeTarget !== null) return codexThreadResumeParams(resumeTarget, { ...caller, excludeTurns: true }, this.permissions) as JsonObject
    const dynamicTools = codexDynamicTools(this.tools)
    return codexThreadStartParams({ ...caller, ephemeral: false, ...(dynamicTools ? { dynamicTools } : {}) }, this.permissions) as JsonObject
  }

  private reportModel(model: string | null): void {
    if (!model || model === this.model) return
    this.model = model
    const onModel = this.options.callbacks.onModel
    if (onModel) this.notify('onModel', () => onModel(model))
  }

  /** Retire a generation and stop its transport as owned work (joined by stop). */
  private retire(generation: CodexGeneration): Promise<ProcessExitFact> {
    const { stopping, first } = stopGeneration(generation)
    if (first) this.lifecycle.jobs.track(`stop:${generation.number}`, stopping).catch(() => {})
    return stopping
  }

  // ---- runtime input -------------------------------------------------------

  /** The open turn a notification or request names (by native id), or null. */
  private turnFor(params: Record<string, unknown>): CodexTurnState | null {
    const id = typeof params.turnId === 'string' ? params.turnId : null
    if (id === null) return this.turn
    const known = this.native.get(id)
    if (known) return known.settled ? null : known
    const unbound = this.unbound[0]
    if (!unbound) return null
    this.bindNative(unbound, id)
    return unbound.settled ? null : unbound
  }

  private bindNative(turn: CodexTurnState, id: string): void {
    if (turn.codexTurnId !== null || this.native.has(id)) return
    turn.bind(id)
    this.native.set(id, turn)
    this.unbound = this.unbound.filter((t) => t !== turn)
    const generation = this.current()
    if (turn.interruptOwed && generation && !generation.retired) this.sendInterrupt(generation, turn)
  }

  private notification(generation: CodexGeneration, method: string, params: JsonObject): void {
    if (generation.retired || generation !== this.current() || this.stopBegun()) return
    if (typeof params.threadId === 'string' && params.threadId !== generation.threadId) return
    if (method === 'turn/started') return this.turnStarted(params)
    if (method === 'turn/completed') {
      const raw = params.turn as { id?: unknown } | undefined
      return typeof raw?.id === 'string' ? this.turnCompleted(raw as never) : undefined
    }
    const turn = this.turnFor(params)
    this.facts.notification(method, params, turn)
  }

  /** L24-L26: an app-server turn; a submitted turn awaiting its id binds first. */
  private turnStarted(params: Record<string, unknown>): void {
    const raw = params.turn as { id?: unknown } | undefined
    const id = typeof raw?.id === 'string' ? raw.id : null
    if (id === null || this.native.has(id)) return
    const unbound = this.unbound[0]
    if (unbound) return this.bindNative(unbound, id)
    const turn = newCodexTurn(crypto.randomUUID(), null, '', this.model)
    this.lifecycle.holdState(() => {
      const disposition = this.lifecycle.native(turn.turnId)
      if (disposition === 'bind' && this.turn) this.native.set(id, this.turn)
      if (disposition !== 'open') return
      this.turn = turn
      this.bindNative(turn, id)
      this.openTurn(turn, true)
    })
  }

  private turnCompleted(raw: { id: string; status?: unknown; error?: { message?: unknown; codexErrorInfo?: unknown } | null; items?: unknown[] }): void {
    const turn = this.turnFor({ turnId: raw.id })
    if (!turn || turn !== this.turn) return
    this.facts.finalText(turn, raw.items)
    const status = raw.status
    const failed = status === 'failed' || (raw.error != null && status !== 'completed' && status !== 'interrupted')
    const error: AgentErrorInfo | null = failed ? this.facts.turnError(raw.error ?? null) : status === 'interrupted' ? INTERRUPTED : null
    const outcome: TurnOutcome = failed ? 'failed' : status === 'interrupted' ? 'interrupted' : 'success'
    const settled = this.lifecycle.holdState(() => {
      if (!this.lifecycle.result(turn.turnId)) return false
      this.turn = null
      this.settle(turn, outcome, error, failed ? 'error_during_execution' : outcome, this.facts.terminalReason(raw.error ?? null))
      return true
    })
    if (settled && error && outcome === 'failed') this.emit({ type: 'error', error })
  }

  /** Settle a turn once: its event (if it opened), its handle, onTurnResult. */
  private settle(turn: CodexTurnState, outcome: TurnOutcome, error: AgentErrorInfo | null, subtype: string, terminalReason: string | null = null): void {
    this.decide(turn, outcome, error, subtype, terminalReason)?.()
  }

  /** Decide a turn's result now (marking it settled) and return the step that publishes it. */
  private decide(turn: CodexTurnState, outcome: TurnOutcome, error: AgentErrorInfo | null, subtype: string, terminalReason: string | null = null): (() => void) | null {
    if (turn.settled) return null
    turn.settled = true
    const result = codexTurnResult(turn, outcome, error)
    return () => {
      if (turn.opened && outcome === 'interrupted') this.emit({ type: 'turn_interrupted', turnId: turn.turnId })
      else if (turn.opened) {
        this.emit({
          type: 'turn_completed', turnId: turn.turnId, subtype, isError: outcome !== 'success', usage: result.usage, finalText: result.finalText,
          totalCostUsd: null, providerCostUsd: null, numTurns: null, terminalReason,
        })
      }
      turn.resolve(result)
      const onTurnResult = this.options.callbacks.onTurnResult
      if (onTurnResult) this.notify('onTurnResult', () => onTurnResult(result))
    }
  }

  /** L14: decide the open turn before any callback, then publish in order; onProcessEnd once. */
  private exited(generation: CodexGeneration, exit: LeaderExit): void {
    if (generation.retired) return
    const error: AgentErrorInfo = { category: 'transport', message: 'the Codex app-server exited unexpectedly' }
    const publish = this.lifecycle.holdState(() => {
      if (this.lifecycle.processExit(generation.number) !== 'unexpected') return null
      const turn = this.turn
      this.turn = null
      this.unbound = []
      return (turn && this.decide(turn, 'process-ended', error, 'process_ended')) || (() => {})
    })
    this.retire(generation)
    if (!publish) return
    this.requests.cancelAll()
    this.emit({ type: 'error', error })
    publish()
    const report = { generation: generation.number, code: exit.kind === 'exited' ? exit.code : null, signal: exit.kind === 'exited' ? exit.signal : null, reason: exit.kind === 'spawn-failed' ? 'spawn failed' : null }
    this.notify('onProcessEnd', () => this.options.callbacks.onProcessEnd?.(report))
  }

  private serverRequest(generation: CodexGeneration, method: string, params: JsonObject, signal: AbortSignal): unknown {
    const disposition = this.permissions.disposition(method)
    if (disposition.kind === 'respond') return disposition.result
    if (disposition.kind === 'error') throw new ServerRequestRefusal(-32601, disposition.message)
    const live = !generation.retired && generation === this.current()
    if (disposition.kind === 'tool') {
      const job = live ? this.runOwned(`tool:${String(params.callId ?? '')}`, () => dispatchCodexToolCall(this.tools, generation.threadId, params as CodexDynamicToolCall)) : null
      return job ?? dispatchCodexToolCall(null, null, params as CodexDynamicToolCall)
    }
    if (!live || (typeof params.threadId === 'string' && params.threadId !== generation.threadId)) return cancelReply(method, params)
    return this.runOwned(`request:${method}`, () => this.requests.serve(method, params, signal)) ?? cancelReply(method, params)
  }

  // ---- caller operations ---------------------------------------------------

  /** R10/I2: acknowledged only once any pending identity persistence succeeded. */
  send(text: string, submit: SubmitOptions = {}): Promise<TurnHandle> {
    return this.checkpoints.admit(submit.continuation, {
      prepare: (): Prepared => {
        const steers = submit.continuation === 'steer' && this.turn && !this.turn.settled ? this.turn : null
        const messageUuid = submit.messageUuid ?? crypto.randomUUID()
        const turnId = steers?.turnId ?? crypto.randomUUID()
        checkSubmission(this.options.beforeSubmit, { messageUuid, turnId, text, context: submit.context })
        return { messageUuid, turnId, text, steers }
      },
      commit: (admission, prepared) => {
        if ((admission === 'steer') !== (prepared.steers !== null) || (prepared.steers && prepared.steers !== this.turn)) {
          throw new AgentRuntimeError({ category: 'not-ready', code: 'turn-ended', message: 'the turn this message was prepared for has ended' })
        }
        return admission === 'steer' ? this.steer(prepared, prepared.steers!) : this.begin(prepared)
      },
    })
  }

  private input(text: string): unknown[] {
    return [{ type: 'text', text, text_elements: [] }]
  }

  /** A new turn: turn/start is written first, then the turn opens (P13 identities). */
  private begin(prepared: Prepared): TurnHandle {
    const generation = this.current()!
    const turn = newCodexTurn(prepared.turnId, prepared.messageUuid, prepared.text, this.model)
    const effort = typeof this.options.effort === 'string' ? { effort: this.options.effort } : {}
    const params = codexTurnStartParams({ threadId: generation.threadId, input: this.input(prepared.text), clientUserMessageId: prepared.messageUuid, ...effort }, this.permissions)
    const reply = generation.transport.request('turn/start', params as JsonObject)
    this.turn = turn
    this.unbound.push(turn)
    this.lifecycle.holdState(() => this.openTurn(turn, false))
    void this.lifecycle.jobs.run(`turn:${turn.turnId}`, async () => {
      try {
        const id = (await reply as { turn?: { id?: unknown } } | null)?.turn?.id
        if (typeof id === 'string') this.bindNative(turn, id)
      } catch (error) {
        if (this.stopBegun() && error instanceof AgentRuntimeError && error.category === 'stopped') return
        this.failTurn(turn, this.rpcError(error, 'Codex refused the turn'))
      }
    })
    return { turnId: turn.turnId, messageUuid: prepared.messageUuid, result: turn.result }
  }

  /** L22: the message joins the active turn; the handle shares its result. */
  private steer(prepared: Prepared, turn: CodexTurnState): TurnHandle {
    const generation = this.current()!
    this.emit({ type: 'user_message', turnId: turn.turnId, text: prepared.text, messageUuid: prepared.messageUuid })
    void this.lifecycle.jobs.run(`steer:${prepared.messageUuid}`, async () => {
      const id = await Promise.race([turn.native, generation.ended, turn.result.then(() => null)])
      if (id === null || turn.settled) return
      try {
        await generation.transport.request('turn/steer', { threadId: generation.threadId, input: this.input(prepared.text), expectedTurnId: id, clientUserMessageId: prepared.messageUuid } as JsonObject)
      } catch (error) {
        if (this.stopBegun() && error instanceof AgentRuntimeError && error.category === 'stopped') return
        if (!turn.settled) this.emit({ type: 'error', error: this.rpcError(error, 'Codex refused the steered message') })
      }
    })
    return { turnId: turn.turnId, messageUuid: prepared.messageUuid, result: turn.result }
  }

  private rpcError(error: unknown, what: string): AgentErrorInfo {
    if (error instanceof AppServerRpcError) return { category: codexErrorCategory(rpcErrorInfo(error.error), 'provider'), message: `${what}: ${error.message}` }
    return { category: 'transport', message: `${what}: ${error instanceof Error ? error.message : String(error)}` }
  }

  private failTurn(turn: CodexTurnState, error: AgentErrorInfo): void {
    const settled = this.lifecycle.holdState(() => {
      if (turn.settled || turn !== this.turn || !this.lifecycle.result(turn.turnId)) return false
      this.turn = null
      this.settle(turn, 'failed', error, 'error_during_execution')
      return true
    })
    if (settled) this.emit({ type: 'error', error })
  }

  private openTurn(turn: CodexTurnState, agentStarted: boolean): void {
    turn.opened = true
    if (!agentStarted) this.lifecycle.beginTurn(turn.turnId)
    this.emit({ type: 'turn_started', turnId: turn.turnId, ...(agentStarted ? { trigger: { kind: 'resumed' as const } } : {}) })
    if (turn.messageUuid !== null) this.emit({ type: 'user_message', turnId: turn.turnId, text: turn.text, messageUuid: turn.messageUuid })
  }

  /** L09/L10, R3 A4: refuse waiting sends first, then settle the turn held, then ask Codex to stop it. */
  async interrupt(): Promise<InterruptReceipt> {
    if (this.stopBegun()) throw new AgentRuntimeError({ category: 'stopped', message: 'the driver is stopped' })
    const cancelled = this.checkpoints.cancelWaiting()
    const receipt = this.lifecycle.holdState(() => {
      const receipt = this.lifecycle.interrupt()
      this.requests.cancelAll()
      const turn = this.turn
      this.turn = null
      if (turn) {
        this.settle(turn, 'interrupted', INTERRUPTED, 'interrupted')
        const generation = this.current()
        if (generation && !generation.retired) this.sendInterrupt(generation, turn)
      }
      return receipt
    })
    return cancelled > 0 ? { outcome: 'requested', processExit: false } : receipt
  }

  /** turn/interrupt once the native id is known; owed until the turn/start reply binds it. */
  private sendInterrupt(generation: CodexGeneration, turn: CodexTurnState): void {
    if (turn.codexTurnId === null) {
      turn.interruptOwed = true
      return
    }
    const turnId = turn.codexTurnId
    turn.interruptOwed = false
    void this.runOwned(`interrupt:${turn.turnId}`, async () => {
      try {
        await generation.transport.request('turn/interrupt', { threadId: generation.threadId, turnId } as JsonObject)
      } catch (error) {
        // The turn already ended, the process went away or the stop closed the transport: nothing more to stop.
        if (error instanceof AppServerRpcError || error instanceof AgentRuntimeError) return
        throw error
      }
    })
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

  kill(): Promise<ProcessExitReceipt> {
    return this.lifecycle.stop('kill', () => this.teardown(), () => accountGenerations(this.generations))
  }

  shutdown(): Promise<ProcessExitReceipt> {
    return this.lifecycle.stop('shutdown', () => this.teardown(), () => accountGenerations(this.generations))
  }

  /** Close requests, settle the open turn as stopped (L11), stop every generation and wait for each actual exit. */
  private async teardown(): Promise<ProcessExitFact[]> {
    this.requests.close()
    const turn = this.turn
    this.turn = null
    this.unbound = []
    if (turn) this.settle(turn, 'interrupted', STOPPED, 'interrupted')
    const stops = this.generations.map((generation) => this.retire(generation))
    const settled = await Promise.allSettled(stops)
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  }
}
