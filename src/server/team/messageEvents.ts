// Append-only history of team message state changes (team-message-threads
// D2). Rows are written from inside the mailbox transitions, so a state
// change cannot escape logging, and they keep the facts a later update
// overwrites — the claimant and reason `retry`/`requeue`/`release` clear.
// Events are durable: they survive restart with the messages they describe.
import type { Database } from 'bun:sqlite'
import type {
  MessageEvent,
  MessageEventKind,
  MessageState,
} from '../../shared/team'

export const CREATE_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS team_message_events (
  message_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  prev_state TEXT,
  prev_claimed_by TEXT,
  prev_recipient TEXT,
  prev_reason TEXT,
  reason TEXT,
  actor_session TEXT,
  PRIMARY KEY (message_id, seq)
);
CREATE INDEX IF NOT EXISTS team_message_events_team ON team_message_events (team_id, created_at);
`

/** Who ran a store transition; `agent` carries the acting session. */
export type StoreActor = { kind: 'system' } | { kind: 'human' } | { kind: 'agent'; sessionId: string }

/** An event-log actor from the composer's plain vocabulary; an agent actor must carry its session, so only `StoreActor` can name one. */
export const storeActor = (actor: 'system' | 'human' | StoreActor | undefined): StoreActor =>
  typeof actor === 'object' ? actor : actor === 'human' ? { kind: 'human' } : { kind: 'system' }

/** The facts a transition overwrote, taken from the row before it ran. */
export interface EventFacts {
  prevState: MessageState | null
  prevClaimedBy: string | null
  prevRecipient: string | null
  prevReason: string | null
  /** Reason the transition wrote; null when it writes none. */
  reason: string | null
}

/** Create the table; part of the frozen baseline step (execution-safety-recovery D13): the baseline step calls this, never the store. */
export function ensureMessageEventSchema(db: Database): void {
  db.exec(CREATE_EVENTS_SQL)
  // Additive column (team-mailbox-management D3): old rows keep it null.
  const columns = db.prepare('PRAGMA table_info(team_message_events)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'actor_session')) {
    db.exec('ALTER TABLE team_message_events ADD COLUMN actor_session TEXT')
  }
}

export class MessageEventLog {
  constructor(private readonly db: Database) {}

  record(input: {
    messageId: string
    teamId: string
    kind: MessageEventKind
    actor: StoreActor
    at: string
    facts: EventFacts
  }): void {
    this.db.prepare(`INSERT INTO team_message_events
      (message_id, team_id, seq, created_at, kind, actor, prev_state, prev_claimed_by, prev_recipient, prev_reason, reason, actor_session)
      VALUES ($messageId, $teamId,
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM team_message_events WHERE message_id = $messageId),
        $createdAt, $kind, $actor, $prevState, $prevClaimedBy, $prevRecipient, $prevReason, $reason, $actorSession)`).run({
      $messageId: input.messageId,
      $teamId: input.teamId,
      $createdAt: input.at,
      $kind: input.kind,
      $actor: input.actor.kind,
      $actorSession: input.actor.kind === 'agent' ? input.actor.sessionId : null,
      $prevState: input.facts.prevState,
      $prevClaimedBy: input.facts.prevClaimedBy,
      $prevRecipient: input.facts.prevRecipient,
      $prevReason: input.facts.prevReason,
      $reason: input.facts.reason,
    })
  }

  /** One message's history, oldest first. */
  forMessage(messageId: string): MessageEvent[] {
    return (this.db.prepare(
      'SELECT * FROM team_message_events WHERE message_id = ? ORDER BY seq'
    ).all(messageId) as Record<string, unknown>[]).map(mapEvent)
  }

  /** Every event of every message in a thread, ordered per message. */
  forThread(threadId: string): MessageEvent[] {
    return (this.db.prepare(`SELECT e.* FROM team_message_events e
      JOIN team_messages m ON m.id = e.message_id
      WHERE m.thread_id = ? ORDER BY m.created_at, m.rowid, e.seq`)
      .all(threadId) as Record<string, unknown>[]).map(mapEvent)
  }
}

function mapEvent(row: Record<string, unknown>): MessageEvent {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
  return {
    messageId: String(row.message_id),
    teamId: String(row.team_id),
    seq: Number(row.seq),
    createdAt: String(row.created_at),
    kind: String(row.kind) as MessageEventKind,
    actor: row.actor === 'human' ? 'human' : row.actor === 'agent' && text(row.actor_session) ? 'agent' : 'system',
    actorSession: row.actor === 'agent' ? text(row.actor_session) : null,
    prevState: text(row.prev_state) as MessageState | null,
    prevClaimedBy: text(row.prev_claimed_by),
    prevRecipient: text(row.prev_recipient),
    prevReason: text(row.prev_reason),
    reason: text(row.reason),
  }
}
