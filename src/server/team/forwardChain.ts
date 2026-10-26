// Forward chains (profile routing): work a provider limit forwarded travels
// as handoff replies — each forward enqueues a new message with `in_reply_to`
// on the old one and a handoff package, and marks the old one `forwarded`.
// The chain is the only structured link between an assignment's instruction
// and its current holder, so every reader of "who holds the forwarded work
// now" follows it here: TaskNotices' revision notices (task-revision-
// publication D3) and the plan pause's holder (revision-control D6). Reads
// only — the chain is written by the limit outcomes' forward.
import type { Database } from 'bun:sqlite'
import type { TeamMessage } from '../../shared/team'
import type { MailboxStore } from './mailboxStore'

/** The bound on hops a forward chain may span, matching the mail hop limit's order. */
export const FORWARD_MAX_HOPS = 20

/** The newest handoff reply carrying the forwarded work on, or null. */
export function forwardSuccessor(mail: Pick<MailboxStore, 'get'>, db: Database, messageId: string): TeamMessage | null {
  const row = db.prepare('SELECT id FROM team_messages WHERE in_reply_to = ? AND handoff IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(messageId) as { id: string } | null
  return row ? mail.get(row.id) : null
}

/**
 * The chain's end message: while the message reads forwarded, follow its
 * successor, at most {@link FORWARD_MAX_HOPS} hops. The end's `claimedBy`
 * is the current holder; an unclaimed end (the successor is still queued)
 * leaves null, and the caller decides what an unclaimed holder means.
 */
export function forwardEnd(mail: Pick<MailboxStore, 'get'>, db: Database, messageId: string): TeamMessage | null {
  let message = mail.get(messageId)
  for (let hop = 0; message?.state === 'forwarded' && hop < FORWARD_MAX_HOPS; hop++) {
    message = forwardSuccessor(mail, db, message.id)
  }
  return message
}
