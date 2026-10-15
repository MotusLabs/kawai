// D4's workflow-stage ladder (team-workspace), a pure projection over the
// task's own status and its outstanding assignment — never a stored value,
// never moved by a finished agent turn. Phase 1 reads only the sources that
// exist (orders 1, 4, 5 of the ladder); the sibling-dependent orders and
// badges (In review / Ready for QA / Fixes requested, Awaiting acceptance,
// Needs re-evaluation, Awaiting acknowledgement) join in Phase 2, from
// `task-results-handoffs` and `task-revision-publication`, by extending this
// same function — there is no runtime feature detection.
import type { TeamTaskStage } from './teamWorkspace'
import type { TaskStatus, TeamTaskAssignment } from './teamTasks'

/**
 * The stage ladder, first match wins (D4's order is the semantics):
 *
 * 1. A closed task (done or cancelled) shows no stage, whatever its
 *    assignment history says.
 * 2-3. (Phase 2) An outstanding review/QA/fix handoff, then an unaccepted
 *    outstanding result.
 * 4. An outstanding assignment the holder is working — `claimed`,
 *    `delivered`, `parked`, `forwarded`, or `uncertain` — is Implementing.
 * 5. Otherwise (no outstanding assignment, or one still queued) Unstarted.
 *    Failed and superseded assignments are never outstanding, so they land
 *    here through their absence.
 */
export function teamTaskStage(
  task: { status: TaskStatus },
  assignment: TeamTaskAssignment | null,
): TeamTaskStage | null {
  if (task.status === 'done' || task.status === 'cancelled') return null
  const state = assignment?.state
  if (state === 'claimed' || state === 'delivered' || state === 'parked' || state === 'forwarded' || state === 'uncertain') {
    return 'implementing'
  }
  return 'unstarted'
}
