// Caller checkpoint persistence (design §2, R10, I2; task 4.4, Claude unit).
//
// - Report. A runtime identity the driver has not reported yet calls the
//   caller's onCheckpoint as an owned job (stop joins it). Reports run one at
//   a time in arrival order, and a synchronous throw counts as a rejection.
//   The identity the caller supplied as `resume` counts as already reported.
// - Gate. A send is decided at call time where it can be: a refusal (busy,
//   unsupported, not-ready, stopped) is settled before the first yield and
//   stays a refusal (L08). An undecided send is a waiter: it waits for a
//   start in progress and for every pending persistence, then runs the
//   host's beforeSubmit, then revalidates (cancellation, sticky failure,
//   pending persistence, admission) and commits in one synchronous step, so
//   released waiters commit one at a time in FIFO order (L21) and nothing
//   holds a queue admission across a callback.
// - Interrupt (L10, R3 A4). cancelWaiting() decides every waiter that exists
//   when the interrupt is entered, before any callback runs: each is refused
//   not-ready/interrupted at once, without waiting for the start or the
//   persistence, which stay owned work the stop joins. A send made from a
//   callback the interrupt triggers is new work.
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

/** The two steps of an accepted send: the host's check, then the synchronous commit. */
export interface AdmitSteps<P, T> {
  prepare(): P
  commit(admission: Admission, prepared: P): T
}

interface Waiter {
  decided: boolean
  resolve(value: unknown): void
  reject(error: unknown): void
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
  /** Undecided sends, in call order. */
  private readonly waiters = new Set<Waiter>()

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
   * Admit a send. `prepare` (the host's beforeSubmit) runs once the send no
   * longer waits; `commit` runs in the same synchronous step that decided
   * the final admission and must enqueue first, so a throw from it means
   * nothing was accepted. The promise settles with the commit's value, or
   * with the refusal that decided the send.
   */
  admit<P, T>(continuation: ContinuationMode | undefined, steps: AdmitSteps<P, T>): Promise<T> {
    if (this.callback.getStore()) {
      return Promise.reject(new AgentRuntimeError({ category: 'internal', message: 'send() inside onCheckpoint would wait for its own persistence' }))
    }
    const refused = this.refusal()
    if (refused) return Promise.reject(refused)
    const lifecycle = this.host.lifecycle
    if (lifecycle.state !== 'starting') {
      // Decided now when it is a refusal; otherwise only the kind is known, and nothing is held.
      try {
        lifecycle.withdraw(lifecycle.admitNow(continuation))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { decided: false, resolve: resolve as (value: unknown) => void, reject }
      this.waiters.add(waiter)
      void this.hold(waiter, continuation, steps)
    })
  }

  /**
   * L10/R3 A4: refuse every waiter as interrupted, at once. Returns how many
   * were cancelled. Every one is decided before the caller runs anything
   * else, so no callback can accept or re-cancel it.
   */
  cancelWaiting(): number {
    const cancelled = Array.from(this.waiters)
    this.waiters.clear()
    for (const waiter of cancelled) waiter.decided = true
    for (const waiter of cancelled) waiter.reject(new AgentRuntimeError({ category: 'not-ready', code: 'interrupted', message: 'interrupted before the send was acknowledged' }))
    return cancelled.length
  }

  private decide(waiter: Waiter): boolean {
    if (waiter.decided) return false
    waiter.decided = true
    this.waiters.delete(waiter)
    return true
  }

  private async hold<P, T>(waiter: Waiter, continuation: ContinuationMode | undefined, steps: AdmitSteps<P, T>): Promise<void> {
    const lifecycle = this.host.lifecycle
    try {
      const starting = lifecycle.initialization
      if (starting) {
        try {
          await starting
        } catch (error) {
          if (waiter.decided) return
          const now = lifecycle.state
          if (now === 'stopping' || now === 'stopped') throw new AgentRuntimeError({ category: 'stopped', message: 'the driver is stopped' })
          throw new AgentRuntimeError({ category: 'not-ready', message: 'the driver failed to start' }, [error])
        }
      } else {
        await null
      }
      if (!(this.clear(waiter) ?? (await this.released(waiter)))) return
      lifecycle.withdraw(lifecycle.admitNow(continuation))
      const prepared = steps.prepare()
      // beforeSubmit may have interrupted, stopped or sent: decide again from now, without a yield unless a persistence is pending.
      if (!(this.clear(waiter) ?? (await this.released(waiter)))) return
      const admission = lifecycle.admitNow(continuation)
      this.decide(waiter)
      let value: T
      try {
        value = steps.commit(admission, prepared)
      } catch (error) {
        lifecycle.withdraw(admission)
        waiter.reject(error)
        return
      }
      waiter.resolve(value)
    } catch (error) {
      if (this.decide(waiter)) waiter.reject(error)
    }
  }

  /**
   * Synchronously: false when the send was decided (an interrupt), true
   * when nothing is pending, null when a persistence is pending; throws the
   * sticky refusal.
   */
  private clear(waiter: Waiter): boolean | null {
    if (waiter.decided) return false
    const failure = this.refusal()
    if (failure) throw failure
    return this.pending ? null : true
  }

  /** Wait until no persistence is pending (a waiter released by one waits again for the next). */
  private async released(waiter: Waiter): Promise<boolean> {
    for (;;) {
      while (this.pending && !waiter.decided) await this.pending.catch(() => {})
      const clear = this.clear(waiter)
      if (clear !== null) return clear
    }
  }

  /** The sticky refusal after a persistence rejected outside a stop. */
  private refusal(): AgentRuntimeError | null {
    const failure = this.failure
    return failure && !failure.duringStop ? new AgentRuntimeError({ ...CHECKPOINT_FAILED }, [failure.error]) : null
  }
}
