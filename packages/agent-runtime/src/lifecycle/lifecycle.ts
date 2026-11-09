// The driver lifecycle core (design "Lifecycle decision table", task 2.2):
// the state machine both drivers share for L01-L26. A driver calls the
// operations below for caller calls (start, admitSend, interrupt, stop) and
// for runtime inputs (ready, result, native, processExit); the runtime-
// specific work runs in the bodies it passes in, as owned jobs. Admission is
// decided synchronously from the current state, so nothing is admitted once
// stop has begun. Stop is terminal and memoized: it closes admission, runs
// the driver's teardown, then joins every owned job, and succeeds only when
// all of it succeeded.

import { AgentRuntimeError } from '../errors.js'
import type { ContinuationMode, DriverState, InterruptReceipt, ProcessExitFact, ProcessExitReceipt } from '../contract.js'
import { OwnedJobs } from './jobs.js'

export type Admission = 'new-turn' | 'queue' | 'steer'
export type ExitDisposition = 'unexpected' | 'stopping' | 'ignored'

export interface LifecycleOptions {
  /** Continuation modes this runtime supports beyond new-turn. */
  continuations: ReadonlySet<Exclude<ContinuationMode, 'new-turn'>>
  onState?(state: DriverState): void
}

function refusal(category: 'not-ready' | 'busy' | 'stopped' | 'unsupported', message: string, code?: string, causes: unknown[] = []): AgentRuntimeError {
  return new AgentRuntimeError({ category, message, ...(code ? { code } : {}) }, causes)
}

export class DriverLifecycle {
  readonly jobs = new OwnedJobs()
  private current: DriverState = 'unstarted'
  private generationNumber = 0
  private starting: Promise<void> | null = null
  private activeTurn: string | null = null
  private queued = 0
  /** Bumped by interrupt so sends waiting on initialization can tell (L10). */
  private interruptEpoch = 0
  private terminal: Promise<ProcessExitReceipt> | null = null
  /** Errors minted by cancelled(): the only failures a stop may exclude. */
  private readonly cancellations = new WeakSet<object>()

  constructor(private readonly options: LifecycleOptions) {}

  get state(): DriverState {
    return this.current
  }

  get generation(): number {
    return this.generationNumber
  }

  get activeTurnId(): string | null {
    return this.activeTurn
  }

  /** Changes on every interrupt that cancelled something; waiters compare it (L10). */
  get interruptions(): number {
    return this.interruptEpoch
  }

  /**
   * A throwing onState never interrupts a transition (stop would otherwise
   * abort before its teardown is installed); the throw is retained as an
   * owned failure, so the stop result reports it.
   */
  private setState(next: DriverState): void {
    if (next === this.current) return
    this.current = next
    const onState = this.options.onState
    if (!onState) return
    try {
      onState(next)
    } catch (error) {
      this.jobs.track('callback:onState', Promise.reject(error)).catch(() => {})
    }
  }

  /**
   * L01-L04/L13. `initialize` spawns the generation and resolves when the
   * runtime is ready; its failure rejects start and restores the prior state.
   */
  start(initialize: (generation: number) => Promise<void>): Promise<void> {
    switch (this.current) {
      case 'stopping':
      case 'stopped':
        return Promise.reject(refusal('stopped', 'the driver is stopped'))
      case 'starting':
        return this.starting!
      case 'idle':
      case 'active':
        return Promise.resolve()
    }
    const prior = this.current
    const generation = ++this.generationNumber
    this.setState('starting')
    // Initialization is owned and joined. Its failure rejects start AND stays
    // retained for stop, unless it is a cancellation the driver minted at its source.
    const run = this.jobs.run(`initialize:${generation}`, () => initialize(generation), { expectedCancellation: (error) => this.isStopCancellation(error) })
    this.starting = run.then(
      () => {
        this.ready(generation)
        if (this.current === 'stopping' || this.current === 'stopped') throw refusal('stopped', 'the driver was stopped while starting')
      },
      (error: unknown) => {
        if (this.current === 'starting' && this.generationNumber === generation) this.setState(prior)
        throw error
      },
    )
    // The shared promise is observed by every caller; keep it from being an unhandled rejection.
    this.starting.catch(() => {})
    return this.starting
  }

  /**
   * The error a driver mints at the source when the stop itself cancelled
   * one of its owned operations: the driver's own refusal or cancel, never a
   * wrapper around a provider's rejection. Only such an error is excluded
   * from the stop's failures. A failure whose cause is unknown, even one
   * that arrives after termination, stays a failure the stop reports.
   */
  cancelled(message: string, causes: unknown[] = []): AgentRuntimeError {
    const error = refusal('stopped', message, undefined, causes)
    this.cancellations.add(error)
    return error
  }

  isStopCancellation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && this.cancellations.has(error)
  }

  /** L17/L18: only the current generation's readiness while starting opens the driver. */
  ready(generation: number): boolean {
    if (this.current !== 'starting' || generation !== this.generationNumber) return false
    this.setState('idle')
    return true
  }

  /** L05-L08/L13/L21-L23: decide admission; while starting, wait and recheck (L06). */
  async admitSend(continuation: ContinuationMode = 'new-turn'): Promise<Admission> {
    if (this.current === 'starting') {
      const epoch = this.interruptEpoch
      try {
        await this.starting
      } catch (error) {
        // Re-read after the await: stop may have begun meanwhile.
        const now = this.state
        if (now === 'stopping' || now === 'stopped') throw refusal('stopped', 'the driver is stopped')
        throw refusal('not-ready', 'the driver failed to start', undefined, [error])
      }
      if (epoch !== this.interruptEpoch) throw refusal('not-ready', 'interrupted while waiting for the driver to start', 'interrupted')
    }
    return this.admitNow(continuation)
  }

  /** Decide admission from the current state, synchronously (the commit point after any wait). */
  admitNow(continuation: ContinuationMode = 'new-turn'): Admission {
    switch (this.current) {
      case 'unstarted':
      case 'exited':
      case 'starting':
        throw refusal('not-ready', 'the driver is not started')
      case 'stopping':
      case 'stopped':
        throw refusal('stopped', 'the driver is stopped')
      case 'idle':
        return 'new-turn'
      case 'active':
        if (continuation === 'new-turn') throw refusal('busy', 'a turn is active')
        if (!this.options.continuations.has(continuation)) throw refusal('unsupported', `continuation mode ${continuation} is not supported by this runtime`)
        if (continuation === 'queue') this.queued += 1
        return continuation
    }
  }

  /** Undo an admission whose submission was refused before anything was enqueued (P12). */
  withdraw(admission: Admission): void {
    if (admission === 'queue' && this.queued > 0) this.queued -= 1
  }

  /** The admitted new turn (or the queued turn now opening) has its identity. */
  beginTurn(turnId: string): void {
    if (this.current !== 'idle' && this.current !== 'active') return
    if (this.activeTurn !== null && this.queued > 0) this.queued -= 1
    this.activeTurn = turnId
    this.setState('active')
  }

  /** L19-L20/L21: the matching result ends its turn; a queued turn keeps the driver active. */
  result(turnId: string): boolean {
    if (this.current !== 'active' || turnId !== this.activeTurn) return false
    if (this.queued === 0) {
      this.activeTurn = null
      this.setState('idle')
    }
    return true
  }

  /** L24-L26: runtime input opening a turn without send. 'open' only while idle. */
  native(turnId: string): 'open' | 'bind' | 'ignored' {
    if (this.current === 'idle') {
      this.beginTurn(turnId)
      return 'open'
    }
    return this.current === 'active' ? 'bind' : 'ignored'
  }

  /** L09/L10: cancel queued and waiting work; never an exit claim. */
  interrupt(): InterruptReceipt {
    if (this.current === 'active') {
      this.activeTurn = null
      this.queued = 0
      this.interruptEpoch += 1
      this.setState('idle')
      return { outcome: 'requested', processExit: false }
    }
    if (this.current === 'starting') {
      this.interruptEpoch += 1
      return { outcome: 'requested', processExit: false }
    }
    if (this.current === 'stopping' || this.current === 'stopped') throw refusal('stopped', 'the driver is stopped')
    return { outcome: 'no-active-turn', processExit: false }
  }

  /** L14-L16: classify a process generation's end. 'unexpected' is reported once. */
  processExit(generation: number): ExitDisposition {
    if (this.current === 'stopping') return 'stopping'
    if (generation !== this.generationNumber) return 'ignored'
    if (this.current !== 'starting' && this.current !== 'idle' && this.current !== 'active') return 'ignored'
    this.activeTurn = null
    this.queued = 0
    this.setState('exited')
    return 'unexpected'
  }

  /**
   * L11/L12: the terminal stop. Admission closes synchronously; `teardown`
   * closes queues and streams and terminates every owned generation; then
   * every owned job is joined. Then `account`, a closed synchronous step
   * that starts no work, adds the native causes read from the joined
   * processes' frozen evidence; its own throw is one more cause. A stop
   * requested from inside an owned job still begins, but that caller is
   * refused instead of joining itself. The transaction, with its first
   * mode, is published before any callback can run (F1): the onState
   * publication and the teardown's own turn settlement may reenter stop,
   * and a reentered call shares this one outcome instead of starting a
   * second teardown.
   */
  stop(mode: 'kill' | 'shutdown', teardown: () => Promise<ProcessExitFact[]>, account: () => unknown[] = () => []): Promise<ProcessExitReceipt> {
    if (!this.terminal) {
      let run!: (body: Promise<ProcessExitReceipt>) => void
      this.terminal = new Promise<ProcessExitReceipt>((resolve) => (run = resolve))
      this.terminal.catch(() => {})
      this.jobs.beginStop()
      this.setState('stopping')
      run(this.jobs.outside(() => this.runStop(mode, teardown, account)))
    }
    if (this.jobs.insideJob()) {
      return Promise.reject(new AgentRuntimeError({ category: 'internal', message: 'stop was requested from inside an owned job; it continues without this caller' }))
    }
    return this.terminal
  }

  private async runStop(mode: 'kill' | 'shutdown', teardown: () => Promise<ProcessExitFact[]>, account: () => unknown[]): Promise<ProcessExitReceipt> {
    const causes: unknown[] = []
    let processes: ProcessExitFact[] = []
    try {
      processes = await teardown()
    } catch (error) {
      causes.push(error)
    }
    const failures = await this.jobs.join()
    causes.push(...failures.map((f) => f.error))
    try {
      causes.push(...account())
    } catch (error) {
      causes.push(error)
    }
    if (causes.length > 0) {
      throw new AgentRuntimeError({ category: 'stop', message: `stop failed: ${causes.length} owned operation(s) failed` }, causes)
    }
    this.activeTurn = null
    this.queued = 0
    this.setState('stopped')
    // The stopped notification runs after the join; a throw there is reported, not lost.
    const late = await this.jobs.join()
    if (late.length > failures.length) {
      throw new AgentRuntimeError({ category: 'stop', message: 'stop completed but a state callback failed' }, late.slice(failures.length).map((f) => f.error))
    }
    return { scope: 'agent-processes', mode, processes, js: 'settled' }
  }
}
