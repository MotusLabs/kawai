// A list row's assignment line: target and state, or Unassigned (5.5).
import type { Session } from '@shared/types'
import type { TeamTaskAssignment } from '@shared/teamTasks'
import { sessionLabel } from './teamTaskLabels'

export function assignmentLabel(assignment: TeamTaskAssignment | null, sessions: Session[]): string {
  if (!assignment) return 'Unassigned'
  const target = assignment.targetKind === 'group'
    ? `group ${assignment.targetId}`
    : sessionLabel(assignment.targetId, sessions)
  const owner = assignment.claimedBy ? ` (claimed by ${sessionLabel(assignment.claimedBy, sessions)})` : ''
  return `Assigned: ${target} · ${assignment.state}${owner}`
}
