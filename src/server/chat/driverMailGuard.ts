// The teamMail calls on ChatSessionManager's driver-event path must never
// throw: their writes run on the shared rollback-journal connection, and a
// failing write used to escape handleDriverEvent and kill the process (the
// #269 CI crash). MailboxStore's transactions now begin IMMEDIATE, so a
// writer waits for the busy budget instead of failing at once — but any
// failure (a holder outlasting it, a torn database) must still degrade to a
// log line, never a crash. This module owns that guard, so tests can drive
// it without a full manager; the manager calls it from handleDriverEvent.
//
// A failed turn-end settle must not strand the claimed message: the settle
// is retried a bounded number of times on an unref'd timer. One chain per
// session: the first failing attempt arms it, and a later failing attempt
// joins the live chain instead of being dropped — after the claims-scoped
// settle (B1) each attempt's settle covers exactly the claims its own
// snapshot captured, so dropping the second attempt would strand them. Each
// settle runs in its own try/catch and only the failed subset re-arms; the
// bound is per chain, so an arrival inherits the rounds the chain has left
// and cannot extend them. After the last failure the mail is left to
// mailbox recovery (the next turn end, failure, archive, kill, or startup
// reconciliation). close() marks the guard closed at shutdown: a settle
// arriving afterwards runs nothing and arms no timer — recovery owns the
// mail from there.
import { logger } from '../logger'

/** Retries after the synchronous attempt fails; the last failure gives up. */
export const SETTLE_RETRIES = 3
export const SETTLE_RETRY_DELAY_MS = 1000

type LogFields = Record<string, unknown>
type Cancel = () => void

export interface DriverMailGuardOptions {
  log?: (event: string, fields: LogFields) => void
  logError?: (event: string, fields: LogFields) => void
  /** Injectable pause so tests stay deterministic; the default unrefs its timer. */
  schedule?: (run: () => void, delayMs: number) => Cancel
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class DriverMailGuard {
  private readonly pending = new Map<string, Array<() => void>>()
  private readonly cancels = new Set<Cancel>()
  private closed = false
  private readonly log: (event: string, fields: LogFields) => void
  private readonly logError: (event: string, fields: LogFields) => void
  private readonly schedule: (run: () => void, delayMs: number) => Cancel

  constructor(options: DriverMailGuardOptions = {}) {
    this.log = options.log ?? ((event, fields) => logger.warn(event, fields))
    this.logError = options.logError ?? ((event, fields) => logger.error(event, fields))
    this.schedule = options.schedule ?? ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  }

  /** Run a fire-and-forget step, logging (never throwing) a failure under `event`. */
  guard(event: string, step: () => void, fields: LogFields = {}): void {
    try {
      step()
    } catch (error) {
      this.log(event, { ...fields, error: messageOf(error) })
    }
  }

  /** The same, returning `fallback` when the step throws. */
  guardResult<T>(fallback: T, event: string, step: () => T, fields: LogFields = {}): T {
    try {
      return step()
    } catch (error) {
      this.log(event, { ...fields, error: messageOf(error) })
      return fallback
    }
  }

  /**
   * Settle a session's claimed mail (the turn-end settlement). The first
   * attempt runs inline — the handler continues either way; failures are
   * retried on the timer until the bound, then left to mailbox recovery.
   */
  settleRecipient(sessionId: string, settle: () => void): void {
    // Closed at shutdown: a late driver event must not write against the
    // closing mailbox or arm retries past it — recovery owns the mail.
    if (this.closed) return
    try {
      settle()
      return
    } catch (error) {
      this.log('chat_mail_settle_failed', { sessionId, error: messageOf(error) })
    }
    this.arm(sessionId, settle, SETTLE_RETRIES)
  }

  /** Cancel pending retries and refuse further settles (server shutdown). */
  close(): void {
    this.closed = true
    for (const cancel of this.cancels) cancel()
    this.cancels.clear()
    this.pending.clear()
  }

  private arm(sessionId: string, settle: () => void, remaining: number): void {
    // One chain per session: a pending retry re-runs every settle that
    // joined it, and the bound keeps total work bounded — a later failing
    // attempt's claims were captured after the earlier attempt's snapshot,
    // so its settle joins instead of being dropped. Closed guards arm
    // nothing.
    if (this.closed) return
    const chain = this.pending.get(sessionId)
    if (chain) {
      chain.push(settle)
      return
    }
    this.startChain(sessionId, [settle], remaining)
  }

  private startChain(sessionId: string, settles: Array<() => void>, remaining: number): void {
    this.pending.set(sessionId, settles)
    const cancel = this.schedule(() => {
      this.cancels.delete(cancel)
      this.pending.delete(sessionId)
      this.retry(sessionId, settles, remaining)
    }, SETTLE_RETRY_DELAY_MS)
    this.cancels.add(cancel)
  }

  private retry(sessionId: string, settles: Array<() => void>, remaining: number): void {
    // Each settle covers its own snapshot: one failure never takes down
    // another attempt's settle, and only the failed subset re-arms.
    const failed: Array<() => void> = []
    for (const settle of settles) {
      try {
        settle()
      } catch (error) {
        failed.push(settle)
        this.log('chat_mail_settle_retry_failed', { sessionId, retriesLeft: remaining - 1, error: messageOf(error) })
      }
    }
    if (failed.length === 0) return
    if (remaining > 1) this.startChain(sessionId, failed, remaining - 1)
    else this.logError('chat_mail_settle_exhausted', { sessionId, retries: SETTLE_RETRIES, unsettled: failed.length })
  }
}
