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
// never calls it from its own jobs. TerminalJoin re-issues a terminal call
// the package refused as a self-join from the next outside caller.
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
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

  /**
   * Run a forwarded host callback. A returned promise is owned here (the
   * package's notifier only catches synchronous throws); a throw goes to the
   * package, whose stop reports it.
   */
  hosted(label: string, fn: () => unknown): void {
    const result = fn()
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as PromiseLike<unknown>).then === 'function') {
      void this.track(`callback:${label}`, Promise.resolve(result))
    }
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

/**
 * A driver's terminal calls (kill/shutdown) over its OwnedWork (decision
 * note-d342e9bf, A5/A10). The package refuses a terminal join made from inside
 * its own callback (category `internal`) while its teardown runs on; that
 * refusal is not a failure but a mark: the next outside caller — a later
 * kill, or settled() — re-issues the call, so a real caller always joins the
 * terminal cleanup. settled() re-issues once per call; refused again (it was
 * itself called from inside a callback), it reports that refusal once instead
 * of waiting on itself, and the mark stays for a later caller.
 */
export class TerminalJoin {
  private pending: { how: string; call: () => Promise<unknown>; refusal: unknown; reported: boolean } | null = null

  constructor(private readonly owned: OwnedWork) {}

  /** One owned terminal call; a self-join refusal marks it for an outside caller. */
  begin(how: string, call: () => Promise<unknown>): void {
    const attempt = call().then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof AgentRuntimeError && error.category === 'internal') {
          this.pending = { how, call, refusal: error, reported: false }
          return undefined
        }
        throw error
      },
    )
    void this.owned.track(how, attempt)
  }

  /** Re-issue a refused terminal call from this outside caller. */
  reacquire(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    this.begin(pending.how, pending.call)
  }

  settled(): Promise<void> {
    let reissued = false
    return this.owned.settled(() => {
      const pending = this.pending
      if (!pending) return
      if (!reissued) {
        reissued = true
        this.reacquire()
      } else if (!pending.reported) {
        pending.reported = true
        void this.owned.track(`${pending.how}:refused`, Promise.reject(pending.refusal))
      }
    })
  }
}
