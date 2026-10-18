// The payload diffs of task creation and publication
// (task-revision-publication D2/D4), extracted from `taskStore.ts` to keep
// that file within the 500-line rule: which normalized field a replayed
// request changed, so a keyed command's refusal can name it and the journal
// can record it. Pure functions over their arguments — no SQL, no state.
import type { TeamTask, TaskRevision } from '../../shared/teamTasks'
import type { CreateTaskInput, PublishInput } from './taskStore'

/**
 * Which normalized create field differs between a stored task and a replayed
 * intent (D4). Direction and acceptance compare against revision 1 — what
 * this create wrote — so later amendments are never payload differences.
 */
export function createPayloadDiff(existing: TeamTask, firstRevision: TaskRevision | undefined, input: CreateTaskInput): string | null {
  if (existing.title !== input.title) return 'title'
  if ((firstRevision?.direction ?? existing.direction) !== input.direction) return 'direction'
  const acceptance = input.acceptance?.trim() ? input.acceptance.trim() : null
  if ((firstRevision?.acceptance ?? existing.acceptance ?? null) !== acceptance) return 'acceptance'
  if ((existing.parentId ?? null) !== (input.parentId || null)) return 'parent'
  if ((existing.worktree ?? null) !== (input.worktree ?? null)) return 'worktree'
  if ((existing.openspecChange ?? null) !== (input.openspecChange ?? null)) return 'OpenSpec change'
  if ((existing.planId ?? null) !== (input.planId ?? null)) return 'plan'
  if ((existing.planChange ?? null) !== (input.planChange ?? null)) return 'plan change'
  return null
}

/**
 * Which normalized publication field differs between the revision a key
 * published and a replayed request (D2). Base revision compares with the
 * revision it was published over.
 */
export function publishPayloadDiff(revision: TaskRevision, input: PublishInput): string | null {
  if (input.direction !== undefined && input.direction !== revision.direction) return 'direction'
  if (input.acceptance !== undefined && input.acceptance !== revision.acceptance) return 'acceptance'
  if ((input.rationale ?? null) !== (revision.rationale ?? null)) return 'rationale'
  if (input.notify !== (revision.notify === true)) return 'notify'
  if (input.baseRevision !== undefined && input.baseRevision !== revision.revision - 1) return 'base revision'
  return null
}
