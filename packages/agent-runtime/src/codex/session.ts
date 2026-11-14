// The Codex driver core (task 4.2, with the Codex parts of 4.3-4.5): one
// owned `codex app-server` per generation (appServerTransport.ts), composed
// with the shared lifecycle core, checkpoint gate and event stream.
//
// - Start. Explicit and promptless: initialize, then thread/start or
//   thread/resume of the saved thread id, re-reading the launch per
//   generation. A refused resume, or one answered with another thread, fails
//   with category `resume`, never falls back to a fresh thread, and the next
//   start tries the same id. Readiness awaits the checkpoint's persistence.
// - Identity. send mints the turn id and message UUID (clientUserMessageId).
//   The native turn id binds only from the turn/start reply or turn/started
//   (turns.ts); results and facts bind by it, so a late or foreign frame
//   completes nothing (R03). An unbound app-server turn is agent-started
//   while idle (L24), binds to the active turn while active (L25), else
//   opens nothing (L26).
// - Continuation. steer joins the active turn via turn/steer with that
//   turn's own native id as expectedTurnId and shares its result (L22);
//   queue is unsupported (L23).
// - Policy. The composed permissions go on every thread/start, thread/resume
//   and turn/start. A server request gets a fixed answer, a host request
//   (requests.ts), a host tool call or a deliberate error reply; requests and
//   tools of a retired generation reach no host code. All host work is owned.
// - Quota. One optional rate-limit read per driver, or per ready generation its claim permits.
// - Skills. The generation's own skills/list catalog (skills.ts) publishes
//   onCommandState, and a new turn's input appends the typed skill inputs
//   its text names unless the send chose codexSkills 'none' (R9); they are
//   taken from the catalog when send() is called, before any wait, so a later
//   move or skills/changed cannot change an accepted send's inputs
//   (task-752c9e4c C2); a steer carries text only, as before. setSkillDirectory (R11) moves the live
//   generation's catalog to another directory.
// - Activity. The in-tree driver's rules (activity.ts) publish onActivity
//   from the published events and the open turn's notifications; a settled,
//   foreign or retired frame publishes nothing.
// - Stop. The lifecycle reserves the terminal first; teardown decides the
//   open turn, closes requests, publishes, then stops every current and
//   retired transport and joins all owned work; accounting adds each
//   process's native evidence. An unexpected exit likewise decides the open
//   turn before any callback, then reports one error and one onProcessEnd.
import path from 'node:path'
import type { AnswerOptions, AnswerOutcome, InterruptReceipt, ProcessExitFact, ProcessExitReceipt, SubmitOptions, TurnHandle, TurnOutcome } from '../contract.js'
import { AgentRuntimeError, type AgentErrorInfo } from '../errors.js'
import { EventStream, type EventBody } from '../eventStream.js'
import { OldFrameScope } from '../common/oldFrame.js'
import type { PendingRequest, QuestionAnswers } from '../events.js'
import type { JsonObject } from '../json.js'
import type { CodexThreadOpened, Effort } from '../options.js'
import { CHECKPOINT_FAILED, CheckpointGate } from '../lifecycle/checkpoints.js'
import { DriverLifecycle } from '../lifecycle/lifecycle.js'
import { resolveExecutable, resolveLaunch } from '../process/launch.js'
import type { LeaderExit } from '../process/ownedProcess.js'
import { bindToolSet, type BoundToolSet } from '../tools/toolSet.js'
import { checkSubmission } from '../claude/turns.js'
import { AppServerRpcError, AppServerTransport, ServerRequestRefusal } from './appServerTransport.js'
import { CodexFacts } from './facts.js'
import { claimQuotaRead } from './quotaRead.js'
import { accountGenerations, CAPABILITIES, CLIENT_INFO, newGeneration, rpcError, startFailure, stopGeneration, threadOpened, threadParams, type CodexGeneration } from './generation.js'
import { codexTurnStartParams, composeCodexPermissions, type CodexPermissionComposition } from './permissions.js'
import { cancelReply, CodexRequests } from './requests.js'
import type { CodexSessionOptions } from './sessionOptions.js'
import { CodexSkillDiscovery, type CodexSkillInput } from './skills.js'
import { CodexActivity } from './activity.js'
import { dispatchCodexToolCall, type CodexDynamicToolCall } from './tools.js'
import { completionOutcome, decideTurn, INTERRUPTED, newCodexTurn, type CodexTurnState } from './turns.js'
export type { CodexSessionOptions } from './sessionOptions.js'

interface Prepared {
  messageUuid: string
  turnId: string
  text: string
  /** R9/C2: the catalog's skill inputs a new turn appends, captured at send() (none for codexSkills 'none'). */
  skills: CodexSkillInput[]
  /** The active turn a steer was prepared against, else null. */
  steers: CodexTurnState | null
}

const STOPPED: AgentErrorInfo = { category: 'stopped', message: 'the driver was stopped' }

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
  /** The current generation's bound native turn ids (late input for a settled turn is dropped). */
  private readonly native = new Map<string, CodexTurnState>()
  private readonly oldFrame = new OldFrameScope()
  /** Submitted turns whose native id is not known yet, oldest first. */
  private unbound: CodexTurnState[] = []
  /** Without a claim callback: the one account/rateLimits/read of this driver was requested. */
  private quotaRequested = false
  /** Native skills from the app-server's own catalog (skills.ts); private turn inputs. */
  private readonly skills: CodexSkillDiscovery
  /** C1: the in-tree driver's activity rules (activity.ts), fed from published events and open-turn notifications. */
  private readonly activity: CodexActivity

  constructor(private readonly options: CodexSessionOptions) {
    this.tools = bindToolSet(options.tools)
    this.permissions = composeCodexPermissions(options.permissions)
    this.threadId = options.resume?.runtimeSessionId ?? null
    const { callbacks } = options
    this.activity = new CodexActivity((activity) => {
      const onActivity = callbacks.onActivity
      if (onActivity) this.notify('onActivity', () => onActivity(activity))
    })
    // F2: the activity transition is decided before onEvent and published after it (activity.ts).
    this.events = new EventStream((event) => this.activity.event(event, () => this.notify('onEvent', () => callbacks.onEvent(event))))
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
    this.skills = new CodexSkillDiscovery({
      request: (generation, params) => this.listSkills(generation as CodexGeneration, params),
      publish: (state) => {
        const onCommandState = callbacks.onCommandState
        if (onCommandState) this.notify('onCommandState', () => onCommandState(state))
      },
      warn: (fields, message) => options.logger?.warn(fields, message),
    })
  }

  /** One owned skills/list on that generation; the job itself never fails (discovery is optional). */
  private listSkills(generation: CodexGeneration, params: Record<string, unknown>): Promise<unknown> | null {
    const job = this.runOwned(`skills:${generation.number}`, async () => {
      try {
        return { response: await generation.transport.request('skills/list', params as JsonObject) }
      } catch (error) {
        return { error }
      }
    })
    return job ? job.then((outcome) => ('error' in outcome ? Promise.reject(outcome.error) : outcome.response)) : null
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

  /** onSpawn (R2): one actual app-server construction's launch provenance. */
  private reportSpawn(generation: CodexGeneration, launch: { cwd: string; childEnv: Readonly<Record<string, string>> }): void {
    const onSpawn = this.options.callbacks.onSpawn
    if (!onSpawn) return
    const info = {
      generation: generation.number,
      cwd: launch.cwd,
      childEnv: { ...launch.childEnv },
      systemPromptAppend: this.options.systemPromptAppend ?? '',
      effort: this.options.effort ?? null,
      model: this.options.model ?? null,
      resumed: generation.resumeTarget !== null,
    }
    this.notify('onSpawn', () => onSpawn(info))
  }

  /** onQuotaNoData (R2): a permitted account/rateLimits/read answered nothing usable. */
  private quotaNoData(): void {
    const onQuotaNoData = this.options.callbacks.onQuotaNoData
    if (onQuotaNoData) this.notify('onQuotaNoData', () => onQuotaNoData({ source: 'report', accountScope: 'session' }))
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
    // Readiness waits on the checkpoint barrier: from inside onCheckpoint it would wait on itself.
    if (this.checkpoints.insideCallback() && this.lifecycle.state === 'starting') {
      return Promise.reject(new AgentRuntimeError({ category: 'internal', message: 'start() inside onCheckpoint would wait for its own persistence' }))
    }
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
      ...(this.options.terminate ? { terminate: this.options.terminate } : {}), ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
      ...(this.options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      ...(this.options.requestTimeoutsMs !== undefined ? { requestTimeoutsMs: this.options.requestTimeoutsMs } : {}),
    })
    // The resume target is fixed before the process exists; a superseded generation is retired first.
    generation = newGeneration(number, transport, this.threadId)
    const previous = this.current()
    if (previous) this.retire(previous)
    // Native turn ids and token totals are the generation's own: a successor may reuse one, and old frames are dropped.
    this.native.clear()
    this.facts.generation()
    this.generations.push(generation)
    // The process and its reader live outside this initialization job: host callbacks they run are not inside it.
    this.lifecycle.jobs.outside(() => transport.start())
    this.reportSpawn(generation, launch)
    this.skills.start(generation, launch.cwd)
    let step: 'initialize' | 'thread/start' | 'thread/resume' = 'initialize'
    let opened: ReturnType<typeof threadOpened>
    try {
      await transport.initialize()
      step = generation.resumeTarget ? 'thread/resume' : 'thread/start'
      opened = threadOpened(await transport.request(step, threadParams(launch, generation.resumeTarget, this.options, this.permissions, this.tools)))
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
    // R3: the opening's facts are fixed before any host callback runs.
    const openedFacts = { generation: generation.number, threadId: opened.threadId, transcriptPath: opened.path ? opened.path : null, resumed: generation.resumeTarget !== null }
    generation.threadId = opened.threadId
    this.threadId = opened.threadId
    this.facts.reportModel(opened.model)
    // The readiness barrier: start resolves only once the configured persistence of this identity finished.
    await this.checkpoints.report({ runtime: 'codex', runtimeSessionId: opened.threadId, ...(opened.path ? { transcriptPath: opened.path } : {}) })
    const refused = this.checkpoints.failedRefusal()
    if (refused) throw refused
    if (this.stopBegun()) throw this.lifecycle.cancelled('the driver was stopped while its checkpoint persisted')
    this.reportThreadOpened(generation, openedFacts)
    if (this.stopBegun()) throw this.lifecycle.cancelled('the driver was stopped while its thread opening was observed')
    const quota = { claim: this.options.claimRateLimitsRead, firstRead: () => !this.quotaRequested && (this.quotaRequested = true), stopBegun: () => this.stopBegun() }
    claimQuotaRead(generation, { ...quota, notify: (name, callback) => this.notify(name, callback), runOwned: (label, body) => this.runOwned(label, body), current: () => this.current(), facts: this.facts, noData: () => this.quotaNoData() })
    if (this.stopBegun()) throw this.lifecycle.cancelled('the driver was stopped while its quota read was claimed')
    this.skills.ready(generation)
  }

  /**
   * R3 onThreadOpened: once per actual generation, only while it is current,
   * not retired and not stopping. Noncritical: a throw or a rejected promise
   * is owned work the stop reports, and nothing here depends on it.
   */
  private reportThreadOpened(generation: CodexGeneration, info: CodexThreadOpened): void {
    const observer = this.options.onThreadOpened
    if (!observer || generation.retired || generation !== this.current() || this.stopBegun()) return
    this.notify('onThreadOpened', () => {
      const result = observer({ ...info }) as unknown
      if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
        this.lifecycle.jobs.track('callback:onThreadOpened', Promise.resolve(result)).catch(() => {})
      }
    })
  }

  /** Retire a generation and stop its transport as owned work (joined by stop). */
  private retire(generation: CodexGeneration): Promise<ProcessExitFact> {
    this.skills.stop(generation)
    const { stopping, first } = stopGeneration(generation)
    if (first) this.lifecycle.jobs.track(`stop:${generation.number}`, stopping).catch(() => {})
    return stopping
  }

  // ---- runtime input -------------------------------------------------------

  /**
   * The open turn a notification or request names, by bound native id only,
   * or null. Nothing here binds or opens a turn: only turn/started and the
   * turn/start reply bind a native id, so a request or item frame cannot
   * attach itself to (or mint) a turn.
   */
  private turnFor(params: Record<string, unknown>): CodexTurnState | null {
    const id = typeof params.turnId === 'string' ? params.turnId : null
    if (id === null) return this.turn
    const known = this.native.get(id)
    return known && !known.settled ? known : null
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
    if (method === 'skills/changed') return this.skills.changed(generation)
    if (method === 'turn/completed') {
      const raw = params.turn as { id?: unknown } | undefined
      return typeof raw?.id === 'string' ? this.turnCompleted(raw as never) : undefined
    }
    const turn = this.turnFor(params)
    if (turn) this.activity.notification(method, params)
    this.facts.notification(method, params, turn)
  }

  /** L24-L26: an app-server turn; a submitted turn awaiting its id binds first. */
  private turnStarted(params: Record<string, unknown>): void {
    const raw = params.turn as { id?: unknown } | undefined
    const id = typeof raw?.id === 'string' ? raw.id : null
    if (id === null || this.native.has(id)) return
    const unbound = this.unbound[0]
    if (unbound) return this.bindNative(unbound, id)
    const turn = newCodexTurn(crypto.randomUUID(), null, '', this.facts.model)
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
    const { outcome, error } = completionOutcome(raw, () => this.facts.turnError(raw.error ?? null))
    // F2/INV-A2: the outcome is decided before the final limit observer runs, and the frame's publications and
    // observations run in the old-frame scope, so a callback reentered from them neither replaces it nor reaches a successor.
    this.oldFrame.run(() => {
      const settled = this.lifecycle.holdState(() => {
        if (!this.lifecycle.result(turn.turnId)) return false
        this.turn = null
        const publish = this.decide(turn, outcome, error, outcome === 'failed' ? 'error_during_execution' : outcome, this.facts.terminalReason(raw.error ?? null))
        if (outcome === 'failed') this.facts.finalLimit(raw.error ?? null)
        publish?.()
        return true
      })
      if (settled && error && outcome === 'failed') this.emit({ type: 'error', error })
    })
  }

  /** Decide a turn's result now (marking it settled) and return the step that publishes it (turns.ts), then ends its wait. */
  private decide(turn: CodexTurnState, outcome: TurnOutcome, error: AgentErrorInfo | null, subtype: string, terminalReason: string | null = null): (() => void) | null {
    const publish = decideTurn(turn, outcome, error, subtype, terminalReason, { emit: (body) => this.emit(body), notify: (name, callback) => this.notify(name, callback), onTurnResult: this.options.callbacks.onTurnResult })
    return publish && (() => (publish(), this.facts.turnSettled(turn.turnId, outcome)))
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
    this.facts.endAll('process-ended')
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
    // R9: the mode is read once, here, so a wait or a later caller mutation cannot change it.
    const mode: unknown = submit.codexSkills
    if (mode !== undefined && mode !== 'auto' && mode !== 'none') {
      return Promise.reject(new AgentRuntimeError({ category: 'unsupported', message: "codexSkills must be 'auto' or 'none'" }))
    }
    // C2: the catalog this send saw, before the admission wait lets a move or skills/changed clear it.
    const skills = mode === 'none' ? [] : this.skills.inputs(text)
    return this.checkpoints.admit(submit.continuation, {
      prepare: (): Prepared => {
        const steers = submit.continuation === 'steer' && this.turn && !this.turn.settled ? this.turn : null
        const messageUuid = submit.messageUuid ?? crypto.randomUUID()
        const turnId = steers?.turnId ?? crypto.randomUUID()
        checkSubmission(this.options.beforeSubmit, { messageUuid, turnId, text, context: submit.context })
        return { messageUuid, turnId, text, skills, steers }
      },
      commit: (admission, prepared) => {
        if ((admission === 'steer') !== (prepared.steers !== null) || (prepared.steers && prepared.steers !== this.turn)) {
          throw new AgentRuntimeError({ category: 'not-ready', code: 'turn-ended', message: 'the turn this message was prepared for has ended' })
        }
        return admission === 'steer' ? this.steer(prepared, prepared.steers!) : this.begin(prepared, this.turnEffort())
      },
    })
  }

  private input(text: string): unknown[] {
    return [{ type: 'text', text, text_elements: [] }]
  }

  /**
   * A new turn (P13 identities). F1: the accepted turn and its owned reply job
   * exist before turn/start is written, so a stop reentered from the wire
   * recorder during that write finds and settles the turn. The turn opens
   * after the write only if it is still current and unsettled; otherwise the
   * already-settled handle is returned and nothing opens after the stop.
   */
  private begin(prepared: Prepared, chosen: Effort | undefined): TurnHandle {
    const generation = this.current()!
    const turn = newCodexTurn(prepared.turnId, prepared.messageUuid, prepared.text, this.facts.model)
    // A numeric effort has no Codex equivalent and is omitted, as before.
    const effort = typeof chosen === 'string' ? { effort: chosen } : {}
    const params = codexTurnStartParams({ threadId: generation.threadId, input: [...this.input(prepared.text), ...prepared.skills], clientUserMessageId: prepared.messageUuid, ...effort }, this.permissions)
    this.turn = turn
    this.unbound.push(turn)
    let write!: (reply: Promise<unknown>) => void
    const written = new Promise<Promise<unknown>>((resolve) => (write = resolve))
    void this.lifecycle.jobs.run(`turn:${turn.turnId}`, async () => {
      try {
        const reply = await written
        const id = ((await reply) as { turn?: { id?: unknown } } | null)?.turn?.id
        if (typeof id === 'string') this.bindNative(turn, id)
      } catch (error) {
        if (this.stopBegun() && error instanceof AgentRuntimeError && error.category === 'stopped') return
        this.failTurn(turn, rpcError(error, 'Codex refused the turn'))
      }
    })
    try {
      write(generation.transport.request('turn/start', params as JsonObject))
    } catch (error) {
      write(Promise.reject(error))
    }
    if (!turn.settled && turn === this.turn && !this.stopBegun()) this.lifecycle.holdState(() => this.openTurn(turn, false))
    return { turnId: turn.turnId, messageUuid: prepared.messageUuid, result: turn.result }
  }

  /**
   * The effort for a new turn (R2): the caller's live choice, read once as its
   * turn/start is about to be sent, else the fixed option. A throwing reader
   * refuses the turn with its raw error; one that stopped the driver sends nothing.
   */
  private turnEffort(): Effort | undefined {
    const read = this.options.getEffort
    if (!read) return this.options.effort
    let chosen: Effort | undefined
    try {
      chosen = read()
    } catch (error) {
      throw new AgentRuntimeError({ category: 'configuration', code: 'effort', message: 'the effort callback threw' }, [error])
    }
    if (this.stopBegun()) throw new AgentRuntimeError({ category: 'stopped', message: 'the driver was stopped while its turn effort was read' })
    return chosen
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
        if (!turn.settled) this.emit({ type: 'error', error: rpcError(error, 'Codex refused the steered message') })
      }
    })
    return { turnId: turn.turnId, messageUuid: prepared.messageUuid, result: turn.result }
  }

  private failTurn(turn: CodexTurnState, error: AgentErrorInfo): void {
    const settled = this.lifecycle.holdState(() => {
      if (turn.settled || turn !== this.turn || !this.lifecycle.result(turn.turnId)) return false
      this.turn = null
      this.decide(turn, 'failed', error, 'error_during_execution')?.()
      return true
    })
    if (settled) this.emit({ type: 'error', error })
  }

  private openTurn(turn: CodexTurnState, agentStarted: boolean): void {
    // INV-A2: inside a decided frame's scope the turn holds its admission now and opens after it.
    this.oldFrame.openTurn({ mark: () => void (turn.opened = true), begin: () => void (agentStarted || this.lifecycle.beginTurn(turn.turnId)), settled: () => turn.settled, announce: () => {
      this.emit({ type: 'turn_started', turnId: turn.turnId, ...(agentStarted ? { trigger: { kind: 'resumed' as const } } : {}) })
      if (turn.messageUuid !== null) this.emit({ type: 'user_message', turnId: turn.turnId, text: turn.text, messageUuid: turn.messageUuid })
    } })
  }

  /** L09/L10, R3 A4: refuse waiting sends first, then settle the turn held, then ask Codex to stop it. INV-A2: in a decided frame's scope it acts on that frame's turn only. */
  async interrupt(): Promise<InterruptReceipt> {
    if (this.stopBegun()) throw new AgentRuntimeError({ category: 'stopped', message: 'the driver is stopped' })
    if (this.oldFrame.active) return { outcome: 'no-active-turn', processExit: false }
    const cancelled = this.checkpoints.cancelWaiting()
    const receipt = this.lifecycle.holdState(() => {
      const receipt = this.lifecycle.interrupt()
      // The turn's outcome is decided before the request cancellations publish anything.
      const turn = this.turn
      this.turn = null
      const publish = turn ? this.decide(turn, 'interrupted', INTERRUPTED, 'interrupted') : null
      this.requests.cancelAll()
      publish?.()
      const generation = this.current()
      if (turn && generation && !generation.retired) this.sendInterrupt(generation, turn)
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

  /** R11: the live generation's skill catalog moves to `cwd` (skills.ts); thread and launch cwds stay. */
  setSkillDirectory(cwd: string): void {
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) {
      throw new AgentRuntimeError({ category: 'configuration', message: 'setSkillDirectory needs a nonempty absolute directory' })
    }
    if (this.stopBegun()) return
    this.skills.changeDirectory(cwd)
  }

  kill(): Promise<ProcessExitReceipt> {
    return this.lifecycle.stop('kill', () => this.teardown(), () => accountGenerations(this.generations))
  }

  shutdown(): Promise<ProcessExitReceipt> {
    return this.lifecycle.stop('shutdown', () => this.teardown(), () => accountGenerations(this.generations))
  }

  /** Close requests, settle the open turn as stopped (L11), stop every generation and wait for each actual exit. */
  private async teardown(): Promise<ProcessExitFact[]> {
    // Decide the open turn first, then close requests (their resolved events), then publish the turn.
    const turn = this.turn
    this.turn = null
    this.unbound = []
    const publish = turn ? this.decide(turn, 'interrupted', STOPPED, 'interrupted') : null
    this.requests.close()
    publish?.()
    this.facts.endAll('cancelled')
    const stops = this.generations.map((generation) => this.retire(generation))
    const settled = await Promise.allSettled(stops)
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  }
}
