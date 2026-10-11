// Spawned sessions run without a human watching (team-tasks D7): when one
// starts waiting on an approval or question, say so wherever the user is —
// independent of any open task view, beside the existing permission sound.
import type { Session } from '@shared/types'
import { toastManager } from '../components/Toast'

/** A spawned chat waiting on the human (pending approval or question). */
export function spawnedNeedsAttention(session: Pick<Session, 'spawned' | 'status' | 'archivedAt'>): boolean {
  return session.spawned === true && session.status === 'permission' && !session.archivedAt
}

/** Toast on the transition into needing attention only, never on every update. */
export function notifySpawnedAttention(previous: Session | undefined, next: Session): void {
  if (!previous || spawnedNeedsAttention(previous) || !spawnedNeedsAttention(next)) return
  toastManager.add({
    title: 'Spawned session needs attention',
    description: `${next.name}${next.taskTitle ? ` (task: ${next.taskTitle})` : ''} is waiting for your approval or answer.`,
    type: 'warning',
  })
}
