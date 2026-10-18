// The metrics core's one load per read (team-process-metrics design D4), in
// one read transaction and two phases:
// 1. cohorts by in-window events over [end − 2w, end) — the window plus its
//    baseline: tasks whose first-ever `done` falls in range (a MIN over each
//    task's `done` transitions, so a task first done earlier never re-enters),
//    status transitions, results and findings created, mail sent or delivered,
//    message events, and turn usage ended in range;
// 2. their history by id with no time bound — each cohort task's row, every
//    transition, result, finding, recorded turn, and task mail of it — plus the
//    agent starts of every session that did attributed work.
// Intervals crossing the range's start load by overlap: limit events from
// `end − 2w − 24 h` (routing's read window, so an earlier event can still cool
// into the range) and park episodes opened before the range. A cohort task
// created before the usage horizon (retention, or the team's first recorded
// turn) has its tokens marked partial.
// Pure reads; the family modules compute everything else.
import type { Database } from 'bun:sqlite'
import type { LimitEvent } from '../../shared/routing'
import { LIMIT_EVENT_READ_WINDOW_MS } from '../team/routing/limitEvents'
import { mapStart, type AgentStartRow } from './provenanceRecorder'
import { mapTurnUsage, TURN_USAGE_RETENTION_MS, type TurnUsageRow } from '../chat/chatTurnUsageStore'

export interface MetricTask {
  id: string
  title: string
  createdAt: string
  status: string
}

export interface MetricStatusEvent {
  taskId: string
  fromStatus: string | null
  toStatus: string
  at: string
}

export interface MetricResult {
  id: string
  taskId: string
  submitterKind: string
  submitterSession: string
  createdAt: string
  acceptedAt: string | null
}

export interface MetricFinding {
  id: string
  taskId: string
  resultId: string
  verdict: string
  authorKind: string
  authorSession: string
  createdAt: string
}

export interface MetricMessage {
  id: string
  threadId: string
  fromKind: string
  fromGroup: string | null
  fromSession: string | null
  priority: string
  taskId: string | null
  createdAt: string
  deliverAt: string | null
  deliveredAt: string | null
  claimedBy: string | null
}

export interface MetricMessageEvent {
  messageId: string
  kind: string
  at: string
  prevClaimedBy: string | null
}

export interface MetricsInputs {
  teamId: string
  /** [loadFrom, end): the window and its baseline. */
  loadFrom: number
  end: number
  tasks: Map<string, MetricTask>
  statusEvents: MetricStatusEvent[]
  results: MetricResult[]
  findings: MetricFinding[]
  messages: Map<string, MetricMessage>
  messageEvents: MetricMessageEvent[]
  usage: TurnUsageRow[]
  /**
   * Before this, turns may be missing — usage retention's `end − 60 d`, or the
   * team's first recorded turn when later (recording began then; `end` with
   * none) — so a cohort task created earlier has its tokens marked partial.
   */
  usageHorizon: number
  starts: AgentStartRow[]
  manifests: Map<string, Record<string, string>>
  /** Per profile, `(at, rowid)` order, from `loadFrom − 24 h`. */
  limitEvents: Map<string, LimitEvent[]>
  /** A session's profile when no start names it (chat_sessions). */
  sessionProfiles: Map<string, string>
}

const iso = (ms: number) => new Date(ms).toISOString()
const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
const CHUNK = 500

/** Rows for `ids` in chunks; `leading` binds the placeholders before the IN list. */
function byIds<T>(
  db: Database, sql: (placeholders: string) => string, ids: Iterable<string>, map: (row: Record<string, unknown>) => T,
  leading: string[] = [],
): T[] {
  const list = [...new Set(ids)]
  const out: T[] = []
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK)
    const rows = db.prepare(sql(chunk.map(() => '?').join(','))).all(...leading, ...chunk) as Record<string, unknown>[]
    for (const row of rows) out.push(map(row))
  }
  return out
}

const mapTask = (row: Record<string, unknown>): MetricTask => ({
  id: String(row.id), title: String(row.title), createdAt: String(row.created_at), status: String(row.status),
})
const mapStatus = (row: Record<string, unknown>): MetricStatusEvent => ({
  taskId: String(row.task_id), fromStatus: text(row.from_status), toStatus: String(row.to_status), at: String(row.at),
})
const mapResult = (row: Record<string, unknown>): MetricResult => ({
  id: String(row.id), taskId: String(row.task_id), submitterKind: String(row.submitted_by_kind),
  submitterSession: String(row.submitted_by_session), createdAt: String(row.created_at), acceptedAt: text(row.accepted_at),
})
const mapFinding = (row: Record<string, unknown>): MetricFinding => ({
  id: String(row.id), taskId: String(row.task_id), resultId: String(row.result_id), verdict: String(row.verdict),
  authorKind: String(row.author_kind), authorSession: String(row.author_session), createdAt: String(row.created_at),
})
const mapMessage = (row: Record<string, unknown>): MetricMessage => ({
  id: String(row.id), threadId: String(row.thread_id), fromKind: String(row.from_kind), fromGroup: text(row.from_group), fromSession: text(row.from_session),
  priority: String(row.priority), taskId: text(row.task_id), createdAt: String(row.created_at), deliverAt: text(row.deliver_at),
  deliveredAt: text(row.delivered_at), claimedBy: text(row.claimed_by),
})
const mapEvent = (row: Record<string, unknown>): MetricMessageEvent => ({
  messageId: String(row.message_id), kind: String(row.kind), at: String(row.created_at), prevClaimedBy: text(row.prev_claimed_by),
})
const mapLimit = (row: Record<string, unknown>): LimitEvent => ({
  id: String(row.id), profileId: String(row.profile_id), sessionId: String(row.session_id), groupId: text(row.group_id),
  at: String(row.at), kind: String(row.kind), final: Number(row.final) === 1, status: row.status === null ? null : Number(row.status),
  message: text(row.message), resetsAt: text(row.resets_at),
  providerId: text(row.provider_id), window: text(row.limit_window),
})

/** Park-episode event kinds: `parked` opens one, the rest close it. */
export const PARK_END_KINDS = ['unparked', 'cancelled', 'forwarded', 'released'] as const

export function loadMetricsInputs(db: Database, teamId: string, loadFrom: number, end: number): MetricsInputs {
  return db.transaction(() => {
    const from = iso(loadFrom)
    const to = iso(end)
    // Phase 1: cohorts by in-window events.
    const firstDone = db.prepare(`SELECT task_id FROM team_task_status_events WHERE team_id = ? AND to_status = 'done'
      GROUP BY task_id HAVING MIN(at) >= ? AND MIN(at) < ?`).all(teamId, from, to) as Array<{ task_id: string }>
    const taskIds = new Set(firstDone.map(row => row.task_id))
    for (const query of [
      'SELECT DISTINCT task_id FROM team_task_status_events WHERE team_id = ? AND at >= ? AND at < ?',
      'SELECT DISTINCT task_id FROM team_task_results WHERE team_id = ? AND created_at >= ? AND created_at < ?',
      'SELECT DISTINCT task_id FROM team_task_findings WHERE team_id = ? AND created_at >= ? AND created_at < ?',
    ]) for (const row of db.prepare(query).all(teamId, from, to) as Array<{ task_id: string }>) taskIds.add(row.task_id)
    const rangeUsage = (db.prepare('SELECT * FROM chat_turn_usage WHERE team_id = ? AND ended_at >= ? AND ended_at < ?')
      .all(teamId, from, to) as Record<string, unknown>[]).map(mapTurnUsage)
    const messages = new Map<string, MetricMessage>()
    for (const row of db.prepare(`SELECT * FROM team_messages WHERE team_id = ?
      AND ((created_at >= ? AND created_at < ?) OR (delivered_at >= ? AND delivered_at < ?))`).all(teamId, from, to, from, to) as Record<string, unknown>[]) {
      messages.set(String(row.id), mapMessage(row))
    }
    const rangeEvents = (db.prepare('SELECT * FROM team_message_events WHERE team_id = ? AND created_at >= ? AND created_at < ?')
      .all(teamId, from, to) as Record<string, unknown>[]).map(mapEvent)

    // Phase 2: their history, by id, with no time bound.
    const tasks = new Map(byIds(db, p => `SELECT * FROM team_tasks WHERE team_id = ? AND id IN (${p})`, taskIds, mapTask, [teamId])
      .map(task => [task.id, task]))
    const statusEvents = byIds(db, p => `SELECT * FROM team_task_status_events WHERE task_id IN (${p}) ORDER BY at, id`, taskIds, mapStatus)
      .sort((a, b) => a.at.localeCompare(b.at))
    const results = byIds(db, p => `SELECT * FROM team_task_results WHERE task_id IN (${p})`, taskIds, mapResult)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const findings = byIds(db, p => `SELECT * FROM team_task_findings WHERE task_id IN (${p})`, taskIds, mapFinding)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const doneIds = firstDone.map(row => row.task_id)
    for (const message of byIds(db, p => `SELECT * FROM team_messages WHERE team_id = ? AND task_id IN (${p})`, doneIds, mapMessage, [teamId])) {
      messages.set(message.id, message)
    }
    const usageByKey = new Map(rangeUsage.map(row => [`${row.sessionId}\0${row.turnId}`, row]))
    for (const row of byIds(db, p => `SELECT * FROM chat_turn_usage WHERE task_id IN (${p})`, taskIds, mapTurnUsage)) {
      usageByKey.set(`${row.sessionId}\0${row.turnId}`, row)
    }
    const usage = [...usageByKey.values()].sort((a, b) => a.endedAt.localeCompare(b.endedAt))

    // Park episodes overlapping the range: every parked event before its end, with its messages' closing events.
    const parkedIds = (db.prepare(`SELECT DISTINCT message_id FROM team_message_events WHERE team_id = ? AND kind = 'parked' AND created_at < ?`)
      .all(teamId, to) as Array<{ message_id: string }>).map(row => row.message_id)
    const eventKey = (event: MetricMessageEvent) => `${event.messageId}\0${event.kind}\0${event.at}`
    const events = new Map(rangeEvents.map(event => [eventKey(event), event]))
    for (const event of byIds(db, p => `SELECT * FROM team_message_events WHERE message_id IN (${p})`, parkedIds, mapEvent)) events.set(eventKey(event), event)
    // Every message an in-range or park event names, so drill-down can open its thread.
    const eventMessageIds = [...parkedIds, ...rangeEvents.map(event => event.messageId)].filter(id => !messages.has(id))
    for (const message of byIds(db, p => `SELECT * FROM team_messages WHERE team_id = ? AND id IN (${p})`, eventMessageIds, mapMessage, [teamId])) {
      messages.set(message.id, message)
    }
    const messageEvents = [...events.values()].sort((a, b) => a.at.localeCompare(b.at))

    // Agent starts of every session that did attributed work, and their memory manifests.
    const sessions = new Set<string>()
    for (const result of results) sessions.add(result.submitterSession)
    for (const finding of findings) sessions.add(finding.authorSession)
    for (const row of usage) sessions.add(row.sessionId)
    for (const message of messages.values()) if (message.claimedBy) sessions.add(message.claimedBy)
    // Holders an event recorded: a release or requeue clears the message's claim, never the event's.
    for (const event of messageEvents) if (event.prevClaimedBy) sessions.add(event.prevClaimedBy)
    const starts = byIds(db, p => `SELECT * FROM agent_starts WHERE session_id IN (${p})`, sessions, mapStart)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
    const manifests = new Map(byIds(db, p => `SELECT * FROM memory_manifests WHERE memory_hash IN (${p})`,
      starts.flatMap(start => (start.memoryHash ? [start.memoryHash] : [])),
      row => [String(row.memory_hash), JSON.parse(String(row.files)) as Record<string, string>] as const))
    const sessionProfiles = new Map(byIds(db, p => `SELECT session_id, profile_id FROM chat_sessions WHERE session_id IN (${p})`, sessions,
      row => [String(row.session_id), text(row.profile_id) ?? 'default'] as const))

    // Limit events of every profile this team's sessions hit, from routing's read window before the range.
    const teamSessions = (db.prepare(`SELECT session_id FROM team_session_directory WHERE team_id = ?
      UNION SELECT session_id FROM agent_starts WHERE team_id = ?`).all(teamId, teamId) as Array<{ session_id: string }>).map(row => row.session_id)
    const profiles = new Set(byIds(db, p => `SELECT DISTINCT profile_id FROM profile_limit_events WHERE session_id IN (${p})`, teamSessions,
      row => String(row.profile_id)))
    const limitFrom = iso(loadFrom - LIMIT_EVENT_READ_WINDOW_MS)
    const limitEvents = new Map<string, LimitEvent[]>()
    for (const profile of profiles) {
      limitEvents.set(profile, (db.prepare('SELECT * FROM profile_limit_events WHERE profile_id = ? AND at >= ? AND at < ? ORDER BY at, rowid')
        .all(profile, limitFrom, to) as Record<string, unknown>[]).map(mapLimit))
    }

    const firstTurn = (db.prepare('SELECT MIN(ended_at) AS at FROM chat_turn_usage WHERE team_id = ?').get(teamId) as { at: string | null }).at
    const usageHorizon = Math.max(end - TURN_USAGE_RETENTION_MS, firstTurn ? Date.parse(firstTurn) : end)

    return {
      teamId, loadFrom, end, tasks, statusEvents, results, findings, messages, messageEvents, usage,
      usageHorizon, starts, manifests, limitEvents, sessionProfiles }
  })()
}
