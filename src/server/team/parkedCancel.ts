// Cancelling mail, including parked work with its resume message (team-mailbox-
// management D2). Split from `MailboxStore` to keep it small: the store hands
// this module a narrow host (its transaction, reads, and logged transition),
// so every state change still goes through the store's single logging path.
// One invariant holds for every caller: parked work always has a live resume,
// or is cancelled together with it.
import type { MessageState, TeamMessage } from '../../shared/team'
import type { StoreActor } from './messageEvents'

/** Longest agent-supplied cancel or discard text kept on a row. */
export const REASON_LIMIT = 300

const SYSTEM: StoreActor = { kind: 'system' }

/** Outcome of a cancel: cancelled, or why not (nothing changed). */
export type CancelResult =
  | { ok: true }
  | { ok: false; code: 'resume-in-flight'; holder: string | null; resumeId: string }
  | { ok: false; code: 'linked-resume'; parkedId: string }
  | { ok: false; code: 'state-changed'; state: MessageState | null }

/** What the store lends: all writes use its conditional, event-logging transition. */
export interface ParkedCancelHost {
  transaction<T>(run: () => T): T
  get(id: string): TeamMessage | null
  /** The parked message whose `resume_message_id` is this id. */
  parkedFor(resumeMessageId: string): TeamMessage | null
  transition(id: string, from: MessageState[], set: Record<string, string | number | null>, kind: 'cancelled' | 'discarded', actor: StoreActor): boolean
  /** Clear a parked row's resume link without a state change, and publish it. */
  unlinkResume(parkedId: string): void
}

/** `reason` column update for an agent's cancel or discard; humans write none. */
export function actionReason(actor: StoreActor, verb: 'cancelled' | 'discarded', reason?: string): { reason?: string } {
  // The human's own action records a reason only when Kawai acts for them
  // with one (plan-supervision D6: "answered by the owner"); the panel gives none.
  if (actor.kind === 'human') return reason?.trim() ? { reason: reason.trim().slice(0, REASON_LIMIT) } : {}
  if (actor.kind !== 'agent') return {}
  return { reason: `${verb} by ${actor.sessionId}: ${(reason ?? '').trim().slice(0, REASON_LIMIT)}` }
}

export class ParkedCancel {
  constructor(private readonly host: ParkedCancelHost) {}

  /**
   * Cancel queued, scheduled, held, or parked mail.
   * - Parked: a `queued`/`awaiting-request` resume is cancelled with the work
   *   in one transaction, so it can never be claimed afterwards. A `claimed`,
   *   `delivered`, or `uncertain` (possibly delivered) resume means the resume
   *   turn may be in flight: refused (`resume-in-flight`), nothing changed. A
   *   `dead` resume is discarded with the work. Work with no resume is
   *   cancelled alone.
   * - A resume linked to parked work is refused (`linked-resume`) for every
   *   actor; kawai's own replacement goes through {@link replaceResume}.
   * An agent actor's `reason` is written on the row, cut and attributed (D4).
   */
  cancel(id: string, actor: StoreActor, reason?: string): CancelResult {
    return this.host.transaction((): CancelResult => {
      const before = this.host.get(id)
      const changed: CancelResult = { ok: false, code: 'state-changed', state: before?.state ?? null }
      if (!before) return changed
      const resume = before.state === 'parked' && before.resumeMessageId ? this.host.get(before.resumeMessageId) : null
      if (resume && ['claimed', 'delivered', 'uncertain'].includes(resume.state)) {
        return { ok: false, code: 'resume-in-flight', holder: before.claimedBy, resumeId: resume.id }
      }
      const linked = ['queued', 'awaiting-request'].includes(before.state) ? this.host.parkedFor(id) : null
      if (linked) return { ok: false, code: 'linked-resume', parkedId: linked.id }
      const cancelled = this.host.transition(id, ['queued', 'awaiting-request', 'parked'], {
        state: 'cancelled', parked_until: null, resume_message_id: null,
        ...actionReason(actor, 'cancelled', reason),
      }, 'cancelled', actor)
      if (!cancelled) return { ...changed, state: this.host.get(id)?.state ?? null }
      if (resume) this.settleResume(resume, `parked work ${id} cancelled`, actor)
      return { ok: true }
    })
  }

  /**
   * Kawai's own resume bookkeeping (re-park, unpark, release, forward): unlink
   * the parked row's resume and end it if nobody has taken it. The
   * `linked-resume` refusal is for outside callers, not for this.
   */
  replaceResume(parkedId: string): void {
    this.host.transaction(() => {
      const resumeId = this.host.get(parkedId)?.resumeMessageId
      if (!resumeId) return
      this.host.unlinkResume(parkedId)
      const resume = this.host.get(resumeId)
      if (resume) this.settleResume(resume, null, SYSTEM)
    })
  }

  /**
   * End a resume nobody has taken: a waiting one is cancelled, a dead one is
   * discarded so a later human Retry cannot revive it for work that moved on.
   * Claimed, delivered, and uncertain resumes may have run and are left alone.
   */
  private settleResume(resume: TeamMessage, reason: string | null, actor: StoreActor): void {
    const set: Record<string, string> = reason ? { reason } : {}
    if (['queued', 'awaiting-request'].includes(resume.state)) {
      this.host.transition(resume.id, ['queued', 'awaiting-request'], { state: 'cancelled', ...set }, 'cancelled', actor)
    } else if (resume.state === 'dead') {
      this.host.transition(resume.id, ['dead'], { state: 'discarded', ...set }, 'discarded', actor)
    }
  }
}
