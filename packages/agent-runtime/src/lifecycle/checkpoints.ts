// Caller checkpoint persistence (design §2, R10, I2; task 4.4, Claude unit).
//
// - Report. A runtime identity the driver has not reported yet calls the
//   caller's onCheckpoint as an owned job (stop joins it). Reports run one at
//   a time in arrival order, and a synchronous throw counts as a rejection.
//   The identity the caller supplied as `resume` counts as already reported.
// - Gate. A send admitted while a persistence is pending is not acknowledged
//   until it settles. The admission is decided at call time, so a refusal
//   (busy, unsupported, stopped) stays a refusal (L08). It is withdrawn while
//   waiting and decided again synchronously afterwards, so released waiters
//   commit one at a time in FIFO order (L21). A waiter released by one
//   persistence waits again if another became pending meanwhile. An
//   interrupt any time after the call refuses the send as interrupted (L10):
//   the boundary is read before the first yield, and a cancelled admission
//   is not withdrawn twice.
// - Rejection is sticky: every waiting and later send is refused with
//   category `checkpoint`, unless the stop had already begun when it
//   rejected, in which case the sends are refused as stopped. The raw
//   rejection stays an owned failure, so the stop reports it. The host is
//   told outside every owned job, so the disposal it requests never joins
//   itself.
// - A send from inside onCheckpoint would wait for its own persistence: it
//   is refused at once (by actual async ancestry, not a pending flag).
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ContinuationMode, ResumeCheckpoint } from '../contract.js'
import { AgentRuntimeError, type AgentErrorInfo } from '../errors.js'
import type { Admission, DriverLifecycle } from './lifecycle.js'

/** The refusal of a send, and the error event, after a persistence rejected. */
export const CHECKPOINT_FAILED: AgentErrorInfo = { category: 'checkpoint', message: 'the runtime identity could not be persisted' }

export interface CheckpointHost {
  lifecycle: DriverLifecycle
  persist: ((checkpoint: ResumeCheckpoint) => void | Promise<void>) | undefined
  /** Called once, outside every owned job, when a persistence rejects. */
  failed(error: unknown): void
}

interface Failure {
  error: unknown
  /** The stop had already begun when the persistence rejected. */
  duringStop: boolean
}

export class CheckpointGate {
  private reported: string | null
  private pending: Promise<void> | null = null
  private failure: Failure | null = null
  private readonly callback = new AsyncLocalStorage<true>()

  constructor(private readonly host: CheckpointHost, resumed: string | null) {
    this.reported = resumed
  }

  /** The runtime made `checkpoint` known: persist it after any earlier one. */
  report(checkpoint: ResumeCheckpoint): void {
    const persist = this.host.persist
    if (!persist || this.failure || checkpoint.runtimeSessionId === this.reported) return
    this.reported = checkpoint.runtimeSessionId
    const previous = this.pending
    const jobs = this.host.lifecycle.jobs
    const job = jobs.run(`checkpoint:${checkpoint.runtimeSessionId}`, () =>
      this.callback.run(true, async () => {
        if (previous) await previous.catch(() => {})
        if (this.failure) return
        await persist({ ...checkpoint })
      }),
    )
    this.pending = job
    job.then(
      () => {
        if (this.pending === job) this.pending = null
      },
      (error: unknown) => {
        if (this.pending === job) this.pending = null
        if (this.failure) return
        const state = this.host.lifecycle.state
        this.failure = { error, duringStop: state === 'stopping' || state === 'stopped' }
        jobs.outside(() => this.host.failed(error))
      },
    )
  }

  /**
   * Admit a send (lifecycle.admitSend), hold it until no persistence is
   * pending, then run `commit` with the final admission in the same
   * synchronous step that decided it: returning the admission across an
   * await would let another released waiter decide from the same state.
   */
  async admit<T>(continuation: ContinuationMode | undefined, commit: (admission: Admission) => T): Promise<T> {
    if (this.callback.getStore()) {
      throw new AgentRuntimeError({ category: 'internal', message: 'send() inside onCheckpoint would wait for its own persistence' })
    }
    const refused = this.refusal()
    if (refused) throw refused
    const lifecycle = this.host.lifecycle
    // L10: the cancellation boundary is read before the first yield and never re-read.
    const epoch = lifecycle.interruptions
    let admission: Admission | null = await lifecycle.admitSend(continuation)
    for (;;) {
      const cancelled = epoch !== lifecycle.interruptions
      const failure = this.refusal()
      if (admission !== null) {
        if (!cancelled && !failure && !this.pending) return commit(admission)
        // Release the held admission, unless the interrupt already discounted it:
        // withdrawing it again would alter newer work's queue accounting.
        if (!cancelled) lifecycle.withdraw(admission)
        admission = null
      }
      if (failure) throw failure
      if (cancelled) throw new AgentRuntimeError({ category: 'not-ready', code: 'interrupted', message: 'interrupted before the send was acknowledged' })
      if (this.pending) {
        while (this.pending) await this.pending.catch(() => {})
        continue
      }
      admission = lifecycle.admitNow(continuation)
    }
  }

  /** The sticky refusal after a persistence rejected outside a stop. */
  private refusal(): AgentRuntimeError | null {
    const failure = this.failure
    return failure && !failure.duringStop ? new AgentRuntimeError({ ...CHECKPOINT_FAILED }, [failure.error]) : null
  }
}
