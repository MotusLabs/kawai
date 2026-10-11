// Durable team mail (agent-teams design D1/D5/D10): every message lives in
// the `team_messages` table from send to settle, so the queue survives
// restarts and the mailbox view reads the same rows the dispatcher does.
// Claims are atomic (`UPDATE … WHERE state='queued'` — the changed-row count
// picks the one winner), and delivery is recorded as three durable facts:
// claimed → pushed_at (just before the turn push) → delivered_at (the
// recipient transcript carried the id). Threads count hops along the reply
// chain; a send past the limit is stored dead-lettered instead of queued.
import type { Database } from 'bun:sqlite'

import type { MessageState, MessagePriority, TeamMessage } from '../../shared/team'
export type { MessageState, MessagePriority, TeamMessage } from '../../shared/team'

export interface EnqueueInput {
  teamId: string
  toKind: 'group' | 'session'
  toId: string
  fromSession: string
  fromGroup: string | null
  originPath: string
  priority?: MessagePriority
  tags?: string[]
  body: string
  /** The message being replied to; absent starts a new thread. */
  inReplyTo?: TeamMessage
  deliverAt?: string | null
  attachThread?: boolean
  /** Sender group's hopLimit, else the default. */
  hopLimit?: number
}

export const DEFAULT_HOP_LIMIT = 20

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_messages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_group TEXT,
  origin_path TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  tags TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT NOT NULL,
  in_reply_to TEXT,
  hop INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  deliver_at TEXT,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  delivered_at TEXT,
  reason TEXT,
  possible_duplicate INTEGER NOT NULL DEFAULT 0,
  attach_thread INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS team_messages_queue ON team_messages (team_id, state);
CREATE INDEX IF NOT EXISTS team_messages_thread ON team_messages (thread_id);
`

const nowIso = () => new Date().toISOString()

export class MailboxStore {
  private readonly listeners = new Set<(teamId: string, message?: TeamMessage) => void>()

  subscribe(listener: (teamId: string, message?: TeamMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(id: string, changed: boolean): boolean {
    if (changed) {
      const message = this.get(id)
      if (message) for (const listener of this.listeners) listener(message.teamId, message)
    }
    return changed
  }

  constructor(private readonly db: Database) {
    db.exec(CREATE_TABLE_SQL)
  }

  /**
   * Store a new message. It is queued — or dead-lettered with reason
   * `hop-limit` when its hop along the reply chain exceeds the limit.
   */
  enqueue(input: EnqueueInput, now = nowIso()): TeamMessage {
    const id = crypto.randomUUID()
    const hop = input.inReplyTo ? input.inReplyTo.hop + 1 : 1
    const limit = input.hopLimit ?? DEFAULT_HOP_LIMIT
    const overLimit = hop > limit
    this.db.prepare(`INSERT INTO team_messages
      (id, team_id, to_kind, to_id, from_session, from_group, origin_path, priority, tags,
       thread_id, in_reply_to, hop, body, state, deliver_at, created_at, reason, attach_thread)
      VALUES ($id, $teamId, $toKind, $toId, $fromSession, $fromGroup, $originPath, $priority, $tags,
       $threadId, $inReplyTo, $hop, $body, $state, $deliverAt, $createdAt, $reason, $attachThread)`).run({
      $id: id,
      $teamId: input.teamId,
      $toKind: input.toKind,
      $toId: input.toId,
      $fromSession: input.fromSession,
      $fromGroup: input.fromGroup,
      $originPath: input.originPath,
      $priority: input.priority ?? 'normal',
      $tags: JSON.stringify(input.tags ?? []),
      $threadId: input.inReplyTo?.threadId ?? id,
      $inReplyTo: input.inReplyTo?.id ?? null,
      $hop: hop,
      $body: input.body,
      $state: overLimit ? 'dead' : 'queued',
      $deliverAt: input.deliverAt ?? null,
      $createdAt: now,
      $reason: overLimit ? 'hop-limit' : null,
      $attachThread: input.attachThread ? 1 : 0,
    })
    this.changed(id, true)
    return this.get(id)!
  }

  get(id: string): TeamMessage | null {
    const row = this.db.prepare('SELECT * FROM team_messages WHERE id = $id').get({ $id: id })
    return row ? mapRow(row as Record<string, unknown>) : null
  }

  /**
   * The next message an idle recipient should get: urgent before normal,
   * direct before group, then oldest. Scheduled rows count once due.
   */
  nextEligible(recipient: { teamId: string; sessionId: string; groupId: string | null }, now = nowIso()): TeamMessage | null {
    const row = this.db.prepare(`SELECT * FROM team_messages
      WHERE team_id = $teamId AND state = 'queued'
        AND (deliver_at IS NULL OR deliver_at <= $now)
        AND ((to_kind = 'session' AND to_id = $sessionId)
          OR (to_kind = 'group' AND $groupId IS NOT NULL AND to_id = $groupId))
      ORDER BY (priority = 'urgent') DESC, (to_kind = 'session') DESC, created_at, rowid
      LIMIT 1`).get({
      $teamId: recipient.teamId, $sessionId: recipient.sessionId,
      $groupId: recipient.groupId, $now: now,
    })
    return row ? mapRow(row as Record<string, unknown>) : null
  }

  /** Atomic claim: true for exactly one caller per queued (or held) message. */
  claim(id: string, sessionId: string, now = nowIso()): boolean {
    return this.changed(id, this.db.prepare(`UPDATE team_messages SET state = 'claimed', claimed_by = $sessionId, claimed_at = $now
      WHERE id = $id AND state IN ('queued', 'awaiting-request')`).run({
      $id: id, $sessionId: sessionId, $now: now,
    }).changes === 1)
  }

  /** Re-check recipient availability inside the transaction that wins the claim. */
  claimWhen(id: string, sessionId: string, isEligible: () => boolean): boolean {
    return this.db.transaction(() => isEligible() && this.claim(id, sessionId))()
  }

  /** Urgent direct mail held while the recipient's card awaits the human. */
  holdForRequest(id: string): boolean {
    return this.transition(id, ['queued'], { state: 'awaiting-request' })
  }

  /** Written immediately before the turn push (D10 step 2). */
  markPushed(id: string, now = nowIso()): boolean {
    return this.changed(id, this.db.prepare(`UPDATE team_messages SET pushed_at = $now
      WHERE id = $id AND state = 'claimed'`).run({ $id: id, $now: now }).changes === 1)
  }

  /** The acknowledgement boundary (D10 step 3): the transcript carried the id. */
  markDelivered(id: string, now = nowIso()): boolean {
    return this.changed(id, this.db.prepare(`UPDATE team_messages SET state = 'delivered', delivered_at = $now
      WHERE id = $id AND state = 'claimed'`).run({ $id: id, $now: now }).changes === 1)
  }

  /** Back to the queue; the claim and push are forgotten. */
  requeue(id: string): boolean {
    return this.transition(id, ['claimed', 'awaiting-request'], {
      state: 'queued', claimed_by: null, claimed_at: null, pushed_at: null,
    })
  }

  deadLetter(id: string, reason: string): boolean {
    return this.transition(id, ['queued', 'claimed', 'awaiting-request'], { state: 'dead', reason })
  }

  /** Receipt neither confirmed nor refuted (D10): out of automatic delivery. */
  holdUncertain(id: string, reason: string): boolean {
    return this.transition(id, ['claimed'], { state: 'uncertain', reason })
  }

  /** The user cancels a queued or scheduled message. */
  cancel(id: string): boolean {
    return this.transition(id, ['queued', 'awaiting-request'], { state: 'cancelled' })
  }

  /**
   * The user retries a dead letter (queued again, its hop reset so the
   * thread may continue) or an uncertain message (to the same recipient only,
   * as direct mail flagged as a possible duplicate).
   */
  retry(id: string): boolean {
    const message = this.get(id)
    if (message?.state === 'dead') {
      return this.transition(id, ['dead'], { state: 'queued', hop: 1, reason: null })
    }
    if (message?.state === 'uncertain' && message.claimedBy) {
      return this.transition(id, ['uncertain'], {
        state: 'queued', to_kind: 'session', to_id: message.claimedBy,
        claimed_by: null, claimed_at: null, pushed_at: null, reason: null, possible_duplicate: 1,
      })
    }
    return false
  }

  /** The user discards a dead or uncertain message for good. */
  discard(id: string): boolean {
    return this.transition(id, ['dead', 'uncertain'], { state: 'discarded' })
  }

  /** Direct mail queued for a killed session can never arrive: dead-letter it. */
  deadLetterDirectTo(sessionId: string, reason: string): number {
    const affected = this.db.prepare("SELECT id FROM team_messages WHERE to_kind = 'session' AND to_id = $sessionId AND state IN ('queued', 'awaiting-request')").all({ $sessionId: sessionId }) as Array<{ id: string }>
    const count = this.db.prepare(`UPDATE team_messages SET state = 'dead', reason = $reason
      WHERE to_kind = 'session' AND to_id = $sessionId AND state IN ('queued', 'awaiting-request')`).run({
      $sessionId: sessionId, $reason: reason,
    }).changes
    for (const row of affected) this.changed(row.id, true)
    return count
  }

  /** Claimed rows not yet acknowledged (startup reconciliation, D10). */
  unacknowledgedClaims(): TeamMessage[] {
    return this.select(`state = 'claimed'`, {})
  }

  /** Every message of a thread, oldest first. */
  thread(threadId: string): TeamMessage[] {
    return this.select('thread_id = $threadId', { $threadId: threadId })
  }

  /** Urgent direct mail held for a session's pending request. */
  awaitingRequestFor(sessionId: string): TeamMessage[] {
    return this.select(`state = 'awaiting-request' AND to_kind = 'session' AND to_id = $sessionId`, {
      $sessionId: sessionId,
    })
  }

  /** Teams with mail that may be deliverable now. */
  teamsWithQueuedMail(now = nowIso()): string[] {
    return (this.db.prepare(`SELECT DISTINCT team_id FROM team_messages
      WHERE state = 'queued' AND (deliver_at IS NULL OR deliver_at <= $now)`).all({ $now: now }) as Array<{ team_id: string }>)
      .map(row => row.team_id)
  }

  /** Earliest future due time among scheduled rows; null when none. */
  nextDueAt(now = nowIso()): string | null {
    const row = this.db.prepare(`SELECT MIN(deliver_at) AS due FROM team_messages
      WHERE state = 'queued' AND deliver_at > $now`).get({ $now: now }) as { due: string | null }
    return row.due
  }

  /** The mailbox view: everything not settled, plus dead and uncertain. */
  listForTeam(teamId: string): TeamMessage[] {
    return this.select(`team_id = $teamId AND state IN ('queued', 'awaiting-request', 'claimed', 'dead', 'uncertain')`, {
      $teamId: teamId,
    })
  }

  private select(where: string, params: Record<string, string>): TeamMessage[] {
    return (this.db.prepare(`SELECT * FROM team_messages WHERE ${where} ORDER BY created_at, rowid`)
      .all(params) as Record<string, unknown>[]).map(mapRow)
  }

  private transition(id: string, from: MessageState[], set: Record<string, string | number | null>): boolean {
    const assignments = Object.keys(set).map(column => `${column} = $${column}`).join(', ')
    const states = from.map((_, index) => `$from${index}`).join(', ')
    const params: Record<string, string | number | null> = { $id: id }
    for (const [column, value] of Object.entries(set)) params[`$${column}`] = value
    from.forEach((state, index) => { params[`$from${index}`] = state })
    return this.changed(id, this.db.prepare(`UPDATE team_messages SET ${assignments} WHERE id = $id AND state IN (${states})`)
      .run(params).changes === 1)
  }
}

function mapRow(row: Record<string, unknown>): TeamMessage {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
  let tags: string[] = []
  try {
    const parsed: unknown = JSON.parse(String(row.tags ?? '[]'))
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
  } catch {
    // A corrupt tag list reads as none; the message itself stays usable.
  }
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    toKind: row.to_kind === 'group' ? 'group' : 'session',
    toId: String(row.to_id),
    fromSession: String(row.from_session),
    fromGroup: text(row.from_group),
    originPath: String(row.origin_path),
    priority: row.priority === 'urgent' ? 'urgent' : 'normal',
    tags,
    threadId: String(row.thread_id),
    inReplyTo: text(row.in_reply_to),
    hop: Number(row.hop ?? 1),
    body: String(row.body),
    state: String(row.state) as MessageState,
    claimedBy: text(row.claimed_by),
    claimedAt: text(row.claimed_at),
    deliverAt: text(row.deliver_at),
    createdAt: String(row.created_at),
    pushedAt: text(row.pushed_at),
    deliveredAt: text(row.delivered_at),
    reason: text(row.reason),
    possibleDuplicate: Number(row.possible_duplicate ?? 0) === 1,
    attachThread: Number(row.attach_thread ?? 0) === 1,
  }
}
