// Owned asynchronous work (design §3, task 2.2). Every producer, loop,
// provider control, initialization, usage/context probe and tool-handler
// promise a driver starts is tracked here, so stop can join all of it.
// Jobs admitted while a join is running (late work started by work already
// in flight) are joined too. Failures are kept, except the cancellations a
// stop itself caused. A job may not join the registry it runs in: that would
// wait on itself forever, so it fails at once instead.

import { AsyncLocalStorage } from 'node:async_hooks'
import { AgentRuntimeError } from '../errors.js'

export interface JobFailure {
  label: string
  error: unknown
}

export interface TrackOptions {
  /** True for the rejection this stop's own cancellation is expected to cause. */
  expectedCancellation?(error: unknown): boolean
}

export class OwnedJobs {
  private readonly live = new Set<Promise<void>>()
  private readonly failures: JobFailure[] = []
  private readonly context = new AsyncLocalStorage<OwnedJobs>()
  private stopping = false

  /** Live job count, for diagnostics and tests. */
  get size(): number {
    return this.live.size
  }

  /** Mark that a stop has begun; expected cancellations are then ignored. */
  beginStop(): void {
    this.stopping = true
  }

  /**
   * Run `body` as an owned job and return its result. The job's failure is
   * also retained for the stop to report, unless it is an expected
   * cancellation during stop.
   */
  run<T>(label: string, body: () => Promise<T>, options: TrackOptions = {}): Promise<T> {
    const result = this.context.run(this, body)
    const settled = result.then(
      () => undefined,
      (error: unknown) => {
        if (this.stopping && options.expectedCancellation?.(error)) return
        this.failures.push({ label, error })
      },
    )
    this.live.add(settled)
    void settled.finally(() => this.live.delete(settled))
    return result
  }

  /** Track an already-started promise as an owned job. */
  track<T>(label: string, promise: Promise<T>, options: TrackOptions = {}): Promise<T> {
    return this.run(label, () => promise, options)
  }

  /** Run `fn` outside any of this registry's jobs (stop's own work is never a job). */
  outside<T>(fn: () => T): T {
    return this.context.exit(fn)
  }

  /** True when the caller is running inside one of this registry's jobs. */
  insideJob(): boolean {
    return this.context.getStore() === this
  }

  /**
   * Wait until no owned job is live, including jobs admitted during the
   * wait. Returns the retained failures. Rejects at once (category
   * `internal`) when called from inside one of these jobs.
   */
  async join(): Promise<JobFailure[]> {
    if (this.insideJob()) {
      throw new AgentRuntimeError({ category: 'internal', message: 'an owned job cannot join its own registry' })
    }
    while (this.live.size > 0) await Promise.all(this.live)
    return [...this.failures]
  }
}
