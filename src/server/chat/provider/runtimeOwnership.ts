// Owned work of one Kawai chat driver adapter (task 6.1, A5): every promise a
// package driver returns (start, send, its turn result, interrupt, kill,
// shutdown) and every promise a host callback returns is registered here,
// never dropped. A rejection is kept raw and logged; `settled()` joins
// everything registered so far (and anything registered while it waits),
// then reports the failures it has not reported yet, once: it rejects with
// the original object for one failure, or an AggregateError of the originals
// for several. Callers waiting at the same time share one report; a later
// wait reports only newer failures. Nothing here awaits itself: `settled()`
// called from inside tracked work would wait for that work, so the adapter
// never calls it from its own jobs.
import { logger } from '../../logger'

export class OwnedWork {
  private readonly live = new Set<Promise<unknown>>()
  private readonly failures: Array<{ label: string; error: unknown }> = []
  /** How many failures a settled() report already carried. */
  private reported = 0
  private joining: Promise<void> | null = null

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

  /**
   * Resolves once every registered job (including ones registered meanwhile)
   * settled, or rejects with the failures not yet reported. `before` runs
   * between joins, so the adapter can register work that only an outside
   * caller may start (a re-acquired terminal join).
   */
  settled(before?: () => void): Promise<void> {
    this.joining ??= this.join(before).finally(() => {
      this.joining = null
    })
    return this.joining
  }

  private async join(before?: () => void): Promise<void> {
    before?.()
    while (this.live.size > 0) {
      await Promise.allSettled([...this.live])
      before?.()
    }
    const fresh = this.failures.slice(this.reported)
    this.reported = this.failures.length
    if (fresh.length === 1) throw fresh[0]!.error
    if (fresh.length > 1) throw new AggregateError(fresh.map((f) => f.error), `${fresh.length} owned chat runtime operations failed`)
  }
}
