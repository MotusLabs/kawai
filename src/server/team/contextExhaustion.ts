// The context-exhaustion outcome (chat-context-exhaustion D4): a turn that
// ended failed with an exhausting terminal reason never processed the mail it
// carried, so nothing of the limit policy applies — no park, forward, or
// cooldown. In one transaction it dead-letters the turn's mail
// (`context-exhausted`), releases parked work the session holds to its group
// (cancelling its resume), dead-letters direct mail still queued for the
// session, and marks a spawned member with a task for release. The caller
// sends the decision note after the commit from the returned facts.
import type { Database } from 'bun:sqlite'
import type { ChatHandoffPackage } from '../../shared/team'
import type { ChatSessionRecord } from '../db'
import type { MailboxStore, TeamMessage } from './mailboxStore'
import type { MemberRelease } from './memberRelease'
import type { LimitOutcomes } from './routing/limitOutcomes'

export const CONTEXT_EXHAUSTED_REASON = 'context-exhausted'

/** What the turn dropped; the decision note's facts. */
export interface ExhaustionOutcome {
  sessionId: string
  /** The message the turn handled, as it stands after the outcome; null when none was tracked. */
  dropped: TeamMessage | null
  /** HEAD at the dropped message's claim, read before a release clears it. */
  claimCommit: string | null
  /** Tool calls since the dropped message's claim. */
  progress: ChatHandoffPackage['progress'] | null
  /** Parked work released to a group (or dead-lettered without one). */
  released: TeamMessage[]
  /** Direct mail dead-lettered while queued for the session. */
  deadDirect: number
  /** Whether a pending release was written for a spawned member. */
  markedForRelease: boolean
}

export interface ContextExhaustionOptions {
  store: MailboxStore
  outcomes: Pick<LimitOutcomes, 'takeExhaustedWork'>
  releases: Pick<MemberRelease, 'markContextExhausted'>
  getRecord: (id: string) => ChatSessionRecord | undefined
}

export class ContextExhaustion {
  constructor(private readonly db: Database, private readonly options: ContextExhaustionOptions) {}

  /** The session's turn ended with its context exhausted; its mail was settled first. */
  turnExhausted(sessionId: string): ExhaustionOutcome {
    const { store } = this.options
    const work = this.options.outcomes.takeExhaustedWork(sessionId)
    return this.db.transaction((): ExhaustionOutcome => {
      const record = this.options.getRecord(sessionId)
      // A resume turn's work is the parked message: it returns to its group below.
      const handled = work ? store.get(work.messageId) : null
      if (handled?.state === 'delivered') store.deadLetterDelivered(handled.id, CONTEXT_EXHAUSTED_REASON)
      else if (handled?.state === 'claimed') store.deadLetter(handled.id, CONTEXT_EXHAUSTED_REASON)
      // Parked work first: its scheduled resume is cancelled with it rather
      // than dead-lettered below as queued direct mail.
      const released: TeamMessage[] = []
      for (const parked of store.parkedBy(sessionId)) {
        const groupId = parked.toKind === 'group' ? parked.toId : record?.groupId ?? null
        store.replaceResume(parked.id)
        store.release(parked.id, groupId)
        // Without a group the work would wait for this very session: dead-letter it instead.
        if (!groupId) store.deadLetter(parked.id, CONTEXT_EXHAUSTED_REASON)
        const after = store.get(parked.id)
        if (after) released.push(after)
      }
      const deadDirect = store.deadLetterDirectTo(sessionId, CONTEXT_EXHAUSTED_REASON)
      const markedForRelease = this.options.releases.markContextExhausted(sessionId)
      return {
        sessionId,
        dropped: handled ? store.get(handled.id) : null,
        claimCommit: handled?.claimCommit ?? null,
        progress: work?.progress ?? null,
        released, deadDirect, markedForRelease,
      }
    })()
  }
}
