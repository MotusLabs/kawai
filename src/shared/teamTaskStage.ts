// D4's workflow-stage ladder (team-workspace), a pure projection over the
// task's own status, its outstanding assignment (and the handoff it may
// carry), and its outstanding result — never a stored value, never moved by
// a finished agent turn. The badges (Needs re-evaluation, Awaiting
// acknowledgement) are not stages and are projected beside it.
import type { TeamTaskStage } from './teamWorkspace'
import type { TaskStatus, TeamTaskAssignment } from './teamTasks'

/**
 * The stage ladder, first match wins (D4's order is the semantics):
 *
 * 1. A closed task (done or cancelled) shows no stage, whatever its
 *    assignment history says.
 * 2. An outstanding review/QA/fix handoff — In review, Ready for QA, Fixes
 *    requested — even while still queued and even over an unaccepted result.
 * 3. An unaccepted outstanding result whose newest findings fail is Fixes
 *    requested: the work goes back to its submitter, not to acceptance.
 * 4. Any other unaccepted outstanding result is Awaiting acceptance.
 * 5. An outstanding assignment the holder is working — `claimed`,
 *    `delivered`, `parked`, `forwarded`, or `uncertain` — is Implementing.
 * 6. Otherwise (no outstanding assignment, or one still queued) Unstarted.
 *    Failed and superseded assignments are never outstanding, so they land
 *    here through their absence.
 */
export function teamTaskStage(
  task: { status: TaskStatus },
  assignment: TeamTaskAssignment | null,
  result: { accepted: boolean; reviewVerdict?: 'pass' | 'fail' | null } | null = null,
): TeamTaskStage | null {
  if (task.status === 'done' || task.status === 'cancelled') return null
  if (assignment?.handoffKind === 'review') return 'in-review'
  if (assignment?.handoffKind === 'qa') return 'ready-for-qa'
  if (assignment?.handoffKind === 'fix') return 'fixes-requested'
  if (result && !result.accepted && result.reviewVerdict === 'fail') return 'fixes-requested'
  if (result && !result.accepted) return 'awaiting-acceptance'
  const state = assignment?.state
  if (state === 'claimed' || state === 'delivered' || state === 'parked' || state === 'forwarded' || state === 'uncertain') {
    return 'implementing'
  }
  return 'unstarted'
}
