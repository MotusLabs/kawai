// Plan usage read (plan-supervision design D14): selects the
// `chat_turn_usage` rows of one plan — turns pinned to a task whose
// `team_tasks.plan_id` is the plan (execution tasks included) or to one of the
// plan's `plan_fix_tasks` — and hands them to the pure `planUsage`. Read-only:
// the table and its writer belong to team-process-metrics (D1). A turn with a
// null task, or another plan's or team's task, is never counted.
import type { Database } from 'bun:sqlite'
import { planUsage, type PlanUsageTurn, type PlanUsageView } from '../../../shared/planUsage'
import type { FixSourceKind } from '../../../shared/planDecisions'

type Row = Record<string, unknown>
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function planUsageTurns(db: Database, teamId: string, planId: string): PlanUsageTurn[] {
  const rows = db.prepare(`
    SELECT u.task_id, u.group_id, u.profile_id, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
      u.num_turns, t.plan_id AS task_plan, t.plan_change, f.source_kind
    FROM chat_turn_usage u
    LEFT JOIN team_tasks t ON t.id = u.task_id AND t.team_id = ?
    LEFT JOIN plan_fix_tasks f ON f.task_id = u.task_id AND f.team_id = ? AND f.plan_id = ?
    WHERE u.task_id IS NOT NULL AND (t.plan_id = ? OR f.task_id IS NOT NULL)
    ORDER BY u.ended_at, u.rowid`).all(teamId, teamId, planId, planId) as Row[]
  return rows.map(row => ({
    taskId: String(row.task_id),
    groupId: text(row.group_id),
    profileId: text(row.profile_id),
    usage: {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheCreationTokens: Number(row.cache_creation_tokens),
    },
    numTurns: Number(row.num_turns),
    change: row.task_plan === planId ? text(row.plan_change) : null,
    fix: typeof row.source_kind === 'string' ? { sourceKind: row.source_kind as FixSourceKind } : null,
  }))
}

export function readPlanUsage(db: Database, teamId: string, planId: string, changeOrder: readonly string[] = []): PlanUsageView {
  return planUsage(planUsageTurns(db, teamId, planId), changeOrder)
}
