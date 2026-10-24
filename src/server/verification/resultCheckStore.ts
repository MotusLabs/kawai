// Storage for result checks and coverage maps (independent-verification
// design D4, task 2.1). The one-pending rule is the partial unique index on
// `result_id WHERE status = 'pending'`: a requester whose insert is refused
// reads the standing pending row instead of starting another. A row settles
// exactly once, from `pending`, by an update that matches `status = 'pending'`
// — a settled row never changes again. Coverage maps are append-only; the
// newest map per (result, author session) counts, derived at read time.
// The store is policy-free; ResultCheckService decides when checks run.
import type { Database } from 'bun:sqlite'
import { partyFromRow } from '../team/actorRow'
import type { ActingParty } from '../../shared/team'
import type { ResultCheckFacts, TaskResultCheck } from '../../shared/teamTasks'

export type CheckTrigger = 'submit' | 'recheck'
export type SettledCheckStatus = 'done' | 'unavailable'

export interface PendingCheckInput {
  teamId: string
  taskId: string
  resultId: string
  trigger: CheckTrigger
  requestedBy: ActingParty
}

export interface CoverageMapInput {
  teamId: string
  taskId: string
  resultId: string
  authorSession: string
  /** The map's JSON, validated by the caller (D5's shape rules land in PR C). */
  coverage: string
}

/** A result's checks, newest first, as stored. */
export interface CheckWithSeq extends TaskResultCheck {}

const nowIso = () => new Date().toISOString()

function parseFacts(value: unknown): ResultCheckFacts | null {
  if (value === null || value === undefined) return null
  try {
    const parsed: unknown = JSON.parse(String(value))
    if (typeof parsed !== 'object' || parsed === null) return null
    const facts = parsed as ResultCheckFacts
    return facts.version === 1 ? facts : null
  } catch {
    // A corrupt blob reads as no facts; the row's status and reason stand.
    return null
  }
}

export class ResultCheckStore {
  constructor(private readonly db: Database) {}

  /**
   * Insert a pending check (D4). When a pending row already stands for the
   * result — the partial unique index refuses the insert — the standing row
   * is returned with `existing: true` and nothing else is written, so a
   * recheck made while a check is pending returns it.
   */
  insertPending(input: PendingCheckInput, now = nowIso()): { check: TaskResultCheck; existing: boolean } {
    for (let attempt = 0; attempt < 3; attempt++) {
      const standing = this.pendingForResult(input.resultId)
      if (standing) return { check: standing, existing: true }
      const id = `check-${crypto.randomUUID()}`
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM team_task_result_checks WHERE result_id = ?')
        .get(input.resultId) as { seq: number }).seq + 1
      try {
        this.db.prepare(`INSERT INTO team_task_result_checks
          (id, team_id, task_id, result_id, seq, trigger, requested_by_kind, requested_by_session, status, facts, reason, created_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`).run(
          id, input.teamId, input.taskId, input.resultId, seq, input.trigger,
          input.requestedBy.kind, input.requestedBy.kind === 'agent' ? input.requestedBy.sessionId : null, now,
        )
        return { check: this.get(id)!, existing: false }
      } catch (error) {
        // Either a racer took the pending slot (its row is returned above on
        // the next pass) or a racer took this seq (recompute and retry).
        if (attempt === 2) throw error
      }
    }
    throw new Error('unreachable')
  }

  /**
   * Settle a pending row exactly once (D4): the update matches
   * `status = 'pending'`, so a row already settled (or never pending) changes
   * nothing and this returns false. `facts` must be the serialized versioned
   * JSON for `done`, null for `unavailable`.
   */
  settle(id: string, status: SettledCheckStatus, facts: string | null, reason: string | null, now = nowIso()): boolean {
    if (status === 'done' && facts === null) throw new Error('A done check stores its facts')
    return this.db.prepare(`UPDATE team_task_result_checks
      SET status = ?, facts = ?, reason = ?, finished_at = ?
      WHERE id = ? AND status = 'pending'`).run(status, facts, reason, now, id).changes === 1
  }

  get(id: string): TaskResultCheck | null {
    const row = this.db.prepare('SELECT * FROM team_task_result_checks WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  /** The result's one pending row, or null. */
  pendingForResult(resultId: string): TaskResultCheck | null {
    const row = this.db.prepare(`SELECT * FROM team_task_result_checks WHERE result_id = ? AND status = 'pending'`)
      .get(resultId) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  /** The team's pending checks, oldest first (D1's scheduling order). */
  pendingForTeam(teamId: string): TaskResultCheck[] {
    return (this.db.prepare(`SELECT * FROM team_task_result_checks WHERE team_id = ? AND status = 'pending'
      ORDER BY created_at, rowid`).all(teamId) as Record<string, unknown>[]).map(row => this.map(row))
  }

  /** Every team that has a pending check (startup recovery, D1). */
  teamsWithPending(): string[] {
    return (this.db.prepare(`SELECT DISTINCT team_id FROM team_task_result_checks WHERE status = 'pending'`)
      .all() as Array<{ team_id: string }>).map(row => row.team_id)
  }

  /** A result's checks, newest first (D4: earlier ones stay readable). */
  allForResult(resultId: string): TaskResultCheck[] {
    return (this.db.prepare('SELECT * FROM team_task_result_checks WHERE result_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(resultId) as Record<string, unknown>[]).map(row => this.map(row))
  }

  /** What a result's readers see (D12): the newest check and the earlier count. */
  viewForResult(resultId: string): { newest: TaskResultCheck | null; earlier: number } {
    const checks = this.allForResult(resultId)
    return { newest: checks[0] ?? null, earlier: Math.max(0, checks.length - 1) }
  }

  /** Append a coverage map (D4); append-only — no update or delete exists. */
  insertCoverageMap(input: CoverageMapInput, now = nowIso()): string {
    const id = `covmap-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO team_task_coverage_maps
      (id, team_id, task_id, result_id, author_session, coverage, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.teamId, input.taskId, input.resultId, input.authorSession, input.coverage, now,
    )
    return id
  }

  /** A result's coverage maps, oldest first (raw JSON; PR C adds the shape). */
  coverageMapsFor(resultId: string): Array<{ id: string; authorSession: string; coverage: string; createdAt: string }> {
    return (this.db.prepare('SELECT * FROM team_task_coverage_maps WHERE result_id = ? ORDER BY created_at, rowid')
      .all(resultId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      authorSession: String(row.author_session),
      coverage: String(row.coverage),
      createdAt: String(row.created_at),
    }))
  }

  private map(row: Record<string, unknown>): TaskResultCheck {
    return {
      id: String(row.id),
      teamId: String(row.team_id),
      taskId: String(row.task_id),
      resultId: String(row.result_id),
      seq: Number(row.seq),
      trigger: row.trigger === 'recheck' ? 'recheck' : 'submit',
      requestedBy: partyFromRow(row.requested_by_kind, row.requested_by_session),
      status: row.status === 'done' ? 'done' : row.status === 'unavailable' ? 'unavailable' : 'pending',
      facts: parseFacts(row.facts),
      reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
      createdAt: String(row.created_at),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    }
  }
}

