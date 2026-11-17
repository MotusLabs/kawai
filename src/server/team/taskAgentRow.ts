// The compact task row both agent readers return (bounded-task-list D1,
// bounded-task-reads D5): `task_list`'s rows and `task_get`'s subtasks. One
// projection, so both derive `assignee` and `result` the same way, through
// `TaskStore.derived`. The columns never include a revision's text, so a
// task's direction and acceptance never reach JavaScript on these paths.
import type { AgentTaskRow, TaskStatus } from '../../shared/teamTasks'
import { partyFromRow } from './actorRow'
import type { TaskStore } from './taskStore'

/** The `team_tasks` columns a row reads. */
export const AGENT_ROW_COLUMNS = `id, title, status, creator_kind, creator_session, owner_session, parent_id, worktree,
  openspec_change, plan_id, plan_change, revision, created_at, updated_at`

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

/** A selected `team_tasks` row as the agent's compact row. */
export function agentTaskRow(store: Pick<TaskStore, 'derived'>, row: Record<string, unknown>): AgentTaskRow {
  const id = String(row.id)
  const { assignment, outstandingResult } = store.derived(id)
  return {
    id,
    title: String(row.title),
    status: String(row.status) as TaskStatus,
    creator: partyFromRow(row.creator_kind, row.creator_session),
    ownerSession: text(row.owner_session),
    parentId: text(row.parent_id),
    worktree: text(row.worktree),
    openspecChange: text(row.openspec_change),
    planId: text(row.plan_id),
    planChange: text(row.plan_change),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    assignee: assignment ? {
      targetKind: assignment.targetKind, targetId: assignment.targetId, role: assignment.role,
      claimedBy: assignment.claimedBy, state: assignment.state,
    } : null,
    result: outstandingResult ? {
      id: outstandingResult.id, reviewVerdict: outstandingResult.reviewVerdict,
      accepted: outstandingResult.accepted, needsReevaluation: outstandingResult.needsReevaluation,
    } : null,
  }
}
