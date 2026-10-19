// Seeding helpers for the metrics-core tests (team-process-metrics D4): raw
// rows with only the columns the metrics read, at times given as hours
// before a fixed END, on a database with this build's schema.
import type { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'

export const END = Date.parse('2026-10-16T12:00:00.000Z')
export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR
export const TEAM = '/repo/.git'
/** ISO time `hours` before END. */
export const ago = (hours: number) => new Date(END - hours * HOUR).toISOString()

export class Seed {
  readonly db: Database = schemaDb()
  private n = 0

  private id(prefix: string) {
    return `${prefix}-${++this.n}`
  }

  task(id: string, createdHoursAgo: number, status = 'open', team = TEAM): string {
    this.db.prepare(`INSERT INTO team_tasks (id, team_id, title, status, creator_kind, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'human', 1, ?, ?)`).run(id, team, id, status, ago(createdHoursAgo), ago(createdHoursAgo))
    return id
  }

  status(taskId: string, from: string | null, to: string, hoursAgo: number, team = TEAM): void {
    this.db.prepare(`INSERT INTO team_task_status_events (task_id, team_id, from_status, to_status, actor_kind, at)
      VALUES (?, ?, ?, ?, 'human', ?)`).run(taskId, team, from, to, ago(hoursAgo))
  }

  result(taskId: string, session: string, hoursAgo: number, opts: { id?: string; acceptedHoursAgo?: number; team?: string } = {}): string {
    const id = opts.id ?? this.id('result')
    this.db.prepare(`INSERT INTO team_task_results (id, team_id, task_id, summary, tests, task_revision, submitted_by_kind,
      submitted_by_session, accepted_at, created_at) VALUES (?, ?, ?, 's', '[]', 1, 'agent', ?, ?, ?)`)
      .run(id, opts.team ?? TEAM, taskId, session,
        opts.acceptedHoursAgo === undefined ? null : ago(opts.acceptedHoursAgo), ago(hoursAgo))
    return id
  }

  finding(taskId: string, resultId: string, session: string, verdict: 'pass' | 'fail', hoursAgo: number, team = TEAM): string {
    const id = this.id('finding')
    this.db.prepare(`INSERT INTO team_task_findings (id, team_id, task_id, result_id, kind, verdict, findings, author_kind,
      author_session, created_at) VALUES (?, ?, ?, ?, 'review', ?, '[]', 'agent', ?, ?)`)
      .run(id, team, taskId, resultId, verdict, session, ago(hoursAgo))
    return id
  }

  message(opts: {
    id?: string; createdHoursAgo: number; deliveredHoursAgo?: number; fromGroup?: string | null; fromKind?: string
    fromSession?: string | null; priority?: 'normal' | 'urgent'; taskId?: string | null; claimedBy?: string | null
    deliverHoursAgo?: number; state?: string; team?: string
  }): string {
    const id = opts.id ?? this.id('msg')
    this.db.prepare(`INSERT INTO team_messages (id, team_id, to_kind, to_id, from_session, from_kind, from_group, origin_path,
      priority, tags, thread_id, hop, body, state, claimed_by, deliver_at, created_at, delivered_at, possible_duplicate,
      attach_thread, task_id, park_count) VALUES (?, ?, 'group', 'devs', ?, ?, ?, '/repo', ?, '[]', ?, 0, 'b', ?, ?, ?, ?, ?, 0, 0, ?, 0)`)
      .run(id, opts.team ?? TEAM, opts.fromSession ?? null, opts.fromKind ?? 'agent', opts.fromGroup ?? 'lead',
        opts.priority ?? 'normal', id, opts.state ?? (opts.deliveredHoursAgo === undefined ? 'queued' : 'delivered'),
        opts.claimedBy ?? null, opts.deliverHoursAgo === undefined ? null : ago(opts.deliverHoursAgo),
        ago(opts.createdHoursAgo), opts.deliveredHoursAgo === undefined ? null : ago(opts.deliveredHoursAgo), opts.taskId ?? null)
    return id
  }

  private seqs = new Map<string, number>()
  event(messageId: string, kind: string, hoursAgo: number, opts: { prevClaimedBy?: string | null; team?: string } = {}): void {
    const seq = (this.seqs.get(messageId) ?? 0) + 1
    this.seqs.set(messageId, seq)
    this.db.prepare(`INSERT INTO team_message_events (message_id, team_id, seq, created_at, kind, actor, prev_claimed_by)
      VALUES (?, ?, ?, ?, ?, 'system', ?)`).run(messageId, opts.team ?? TEAM, seq, ago(hoursAgo), kind, opts.prevClaimedBy ?? null)
  }

  start(sessionId: string, hoursAgo: number, opts: {
    id?: string; group?: string | null; profile?: string | null; groupFileHash?: string | null; memoryHash?: string | null; team?: string
  } = {}): string {
    const id = opts.id ?? this.id('start')
    this.db.prepare(`INSERT INTO agent_starts (id, session_id, team_id, group_id, profile_id, cwd, group_file_hash, memory_hash, started_at)
      VALUES (?, ?, ?, ?, ?, '/repo', ?, ?, ?)`).run(id, sessionId, opts.team ?? TEAM, opts.group ?? 'devs',
      opts.profile ?? 'default', opts.groupFileHash ?? null, opts.memoryHash ?? null, ago(hoursAgo))
    return id
  }

  manifest(memoryHash: string, files: Record<string, string>): void {
    this.db.prepare('INSERT INTO memory_manifests (memory_hash, files) VALUES (?, ?)').run(memoryHash, JSON.stringify(files))
  }

  usage(sessionId: string, hoursAgo: number, tokens: number, opts: { taskId?: string | null; startId?: string | null; group?: string; profile?: string; team?: string } = {}): void {
    this.db.prepare(`INSERT INTO chat_turn_usage (session_id, turn_id, team_id, group_id, profile_id, task_id, start_id, ok,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, 0, 1, ?)`).run(sessionId, this.id('turn'), opts.team ?? TEAM, opts.group ?? 'devs',
      opts.profile ?? 'default', opts.taskId ?? null, opts.startId ?? null, tokens, ago(hoursAgo))
  }

  member(sessionId: string, team = TEAM): void {
    this.db.prepare(`INSERT INTO team_session_directory (team_id, session_id, name, updated_at) VALUES (?, ?, ?, ?)`)
      .run(team, sessionId, sessionId, ago(0))
  }

  limit(profile: string, sessionId: string, hoursAgo: number, resetHoursAgo: number | null, final = true,
    opts: { provider?: string | null; window?: string | null } = {}): void {
    this.db.prepare(`INSERT INTO profile_limit_events (id, profile_id, session_id, at, kind, final, resets_at, provider_id, limit_window)
      VALUES (?, ?, ?, ?, 'rate_limit', ?, ?, ?, ?)`).run(this.id('limit'), profile, sessionId, ago(hoursAgo), final ? 1 : 0,
      resetHoursAgo === null ? null : ago(resetHoursAgo), opts.provider ?? null, opts.window ?? null)
  }
}
