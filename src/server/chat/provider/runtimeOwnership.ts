// Owned work of one Kawai chat driver adapter (task 6.1, A5): every promise a
// package driver returns (start, send, its turn result, interrupt, kill,
// shutdown) is registered here, never dropped. A rejection is kept raw, once,
// and logged; `settled()` joins everything registered so far (and anything
// registered while it waits), so a caller can wait for the adapter to
// quiesce before reusing or deleting what it depends on. Nothing here
// awaits itself: `settled()` called from inside tracked work would wait for
// that work, so the adapter never calls it from its own jobs.
import { logger } from '../../logger'

export class OwnedWork {
  private readonly live = new Set<Promise<unknown>>()
  private readonly failures: Array<{ label: string; error: unknown }> = []

  constructor(private readonly sessionId: string) {}

  /** Register `promise`; its rejection is retained raw and logged once. Returns a promise that never rejects. */
  track<T>(label: string, promise: Promise<T>): Promise<T | undefined> {
    const owned = promise.then(
      (value) => value,
      (error: unknown) => {
        this.failures.push({ label, error })
        logger.warn('chat_runtime_owned_failure', { sessionId: this.sessionId, label, error: error instanceof Error ? error.message : String(error) })
        return undefined
      },
    )
    this.live.add(owned)
    void owned.finally(() => this.live.delete(owned))
    return owned
  }

  /** Every raw rejection retained so far, oldest first. */
  retained(): Array<{ label: string; error: unknown }> {
    return this.failures.slice()
  }

  /** Resolves once every registered job (including ones registered meanwhile) settled. */
  async settled(): Promise<void> {
    while (this.live.size > 0) await Promise.allSettled([...this.live])
  }
}
