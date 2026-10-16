// Per-turn token usage (team-process-metrics D1): one row per completed turn
// of every chat session — task-bound or not, with or without a group — keyed
// by (session, turn) and written `INSERT OR IGNORE`, so a duplicate
// completion writes once. Tokens and steps only, never currency; usage spent
// by Task subagents and by turns that never completed is not counted. The
// task is the one pinned when the turn started (TurnUsageTracker below): the
// delivered mail's task (or none) for a mail-started turn, else the session's
// task at that moment; nothing that happens mid-turn moves it. Rows outlive
// kill/archive and age out after 60 days, pruned at startup and at most
// hourly on write. The DDL is schema migration 6 `chat-turn-usage`
// (`dbSafety/migrations.ts`), frozen like every applied migration.
import type { Database } from 'bun:sqlite'
import type { ChatEvent, ChatTurnUsage } from '../../shared/chat'

export const CREATE_TURN_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS chat_turn_usage (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  team_id TEXT,
  group_id TEXT,
  profile_id TEXT,
  model TEXT,
  task_id TEXT,
  start_id TEXT,
  ok INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  num_turns INTEGER NOT NULL,
  ended_at TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS chat_turn_usage_team ON chat_turn_usage (team_id, ended_at);
CREATE INDEX IF NOT EXISTS chat_turn_usage_task ON chat_turn_usage (task_id);
`

export const TURN_USAGE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

export interface TurnUsageRow {
  sessionId: string
  turnId: string
  teamId: string | null
  groupId: string | null
  profileId: string | null
  model: string | null
  taskId: string | null
  startId: string | null
  ok: boolean
  usage: ChatTurnUsage
  numTurns: number
  endedAt: string
}

const text = (value: unknown) => (value === null || value === undefined ? null : String(value))

export function mapTurnUsage(row: Record<string, unknown>): TurnUsageRow {
  return {
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    teamId: text(row.team_id),
    groupId: text(row.group_id),
    profileId: text(row.profile_id),
    model: text(row.model),
    taskId: text(row.task_id),
    startId: text(row.start_id),
    ok: Number(row.ok) === 1,
    usage: {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheCreationTokens: Number(row.cache_creation_tokens),
    },
    numTurns: Number(row.num_turns),
    endedAt: String(row.ended_at),
  }
}

export class ChatTurnUsageStore {
  private lastPruneAt: number

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    this.lastPruneAt = this.now()
    this.prune()
  }

  /** Record one completed turn; a second record of the same turn is ignored. */
  record(row: TurnUsageRow): void {
    this.db.prepare(`INSERT OR IGNORE INTO chat_turn_usage (session_id, turn_id, team_id, group_id, profile_id, model, task_id, start_id,
      ok, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.sessionId, row.turnId, row.teamId, row.groupId, row.profileId, row.model, row.taskId, row.startId,
      row.ok ? 1 : 0, row.usage.inputTokens, row.usage.outputTokens, row.usage.cacheReadTokens, row.usage.cacheCreationTokens,
      row.numTurns, row.endedAt,
    )
    if (this.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.lastPruneAt = this.now()
      this.prune()
    }
  }

  forSession(sessionId: string): TurnUsageRow[] {
    return (this.db.prepare('SELECT * FROM chat_turn_usage WHERE session_id = ? ORDER BY ended_at, rowid').all(sessionId) as Record<string, unknown>[])
      .map(mapTurnUsage)
  }

  private prune(): void {
    const cutoff = new Date(this.now() - TURN_USAGE_RETENTION_MS).toISOString()
    this.db.prepare('DELETE FROM chat_turn_usage WHERE ended_at < ?').run(cutoff)
  }
}

/** What a session looks like when its turn's row is written. */
export interface TurnUsageContext {
  teamId: string | null
  groupId: string | null
  profileId: string | null
  model: string | null
}

interface Pin {
  turnId: string
  taskId: string | null
  startId: string | null
}

const ZERO: ChatTurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

/**
 * Pins each turn's task and agent start at `turn_started` (D1) and writes the
 * row at `turn_completed`. A mail-started turn is recognised by the
 * `peer_message` the driver emits right after `turn_started` in the same
 * turn — the dispatcher delivers only to idle sessions, so delivered mail
 * always opens its own turn — and takes that mail's task, or none. Any other
 * turn keeps the session's task at its start. An interrupted turn writes
 * nothing; a completion with no pin (a turn begun before a restart) falls
 * back to the session's task and latest start at completion.
 */
export class TurnUsageTracker {
  private readonly pins = new Map<string, Pin>()

  constructor(
    private readonly store: ChatTurnUsageStore,
    private readonly deps: {
      sessionTask: (sessionId: string) => string | null
      latestStart: (sessionId: string) => string | null
      context: (sessionId: string) => TurnUsageContext
    },
  ) {}

  onEvent(sessionId: string, event: ChatEvent): void {
    if (event.type === 'turn_started') {
      this.pins.set(sessionId, { turnId: event.turnId, taskId: this.deps.sessionTask(sessionId), startId: this.deps.latestStart(sessionId) })
    } else if (event.type === 'peer_message') {
      const pin = this.pins.get(sessionId)
      if (pin && pin.turnId === event.turnId) pin.taskId = event.task?.id ?? null
    } else if (event.type === 'turn_interrupted') {
      if (this.pins.get(sessionId)?.turnId === event.turnId) this.pins.delete(sessionId)
    } else if (event.type === 'turn_completed') {
      const pinned = this.pins.get(sessionId)
      const pin = pinned?.turnId === event.turnId ? pinned : null
      if (pin) this.pins.delete(sessionId)
      this.store.record({
        sessionId,
        turnId: event.turnId,
        ...this.deps.context(sessionId),
        taskId: pin ? pin.taskId : this.deps.sessionTask(sessionId),
        startId: pin ? pin.startId : this.deps.latestStart(sessionId),
        ok: event.subtype === 'success',
        usage: event.usage ?? ZERO,
        numTurns: event.numTurns ?? 0,
        endedAt: event.at,
      })
    }
  }

  forget(sessionId: string): void {
    this.pins.delete(sessionId)
  }
}
