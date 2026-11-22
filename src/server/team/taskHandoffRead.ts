// `task_get`'s publication handoffs (owner-publication-handoff D10): the
// task's newest 20 handoffs as bounded rows, newest first — identity, state,
// base revision, requester, the payload hash's first 12 hex digits, the
// disposition and published revision — and one handoff whole by
// `handoff_id`, with its prepared fields and transition events. A pending
// row names its next actor and a published row its follow-up phase, through
// the same `pendingHandoffActor` and `handoffPhase` that attention and the
// supervision loader call (contract I5). Reads are scoped to the task the
// caller may already read, so another team's handoff is not found.
import type { HandoffActor, HandoffNextActor, HandoffPhase, HandoffState, TaskHandoff } from '../../shared/taskHandoffs'
import { handoffPhase, pendingHandoffActor } from '../../shared/taskHandoffs'
import type { TeamTask } from '../../shared/teamTasks'
import type { TaskService } from './TaskService'
import { followUpFacts } from './taskHandoffFacts'
import { taskOwner } from './taskStatusRights'

export const HANDOFF_WINDOW = 20

export interface AgentHandoffRow {
  id: string
  state: HandoffState
  baseRevision: number
  requesterSession: string
  requesterGroup: string | null
  /** The first 12 hex digits of the prepared payload's SHA-256. */
  payloadHash: string
  publishedRevision: number | null
  /** True when the published payload differs from the prepared one (published as edited). */
  publishedAsEdited: boolean | null
  /** Who ended it and why (declined, withdrawn, superseded, stale, closed); null while open. */
  disposition: { actor: HandoffActor | null; reason: string | null } | null
  /** A pending handoff's next actor (W1–W4, S1). */
  nextActor?: HandoffNextActor
  /** A published handoff's follow-up phase (D5). */
  phase?: HandoffPhase
  createdAt: string
  updatedAt: string
}

export interface AgentHandoffRead {
  handoffs: AgentHandoffRow[]
  handoffBounds: { total: number; returned: number; truncated: boolean }
  /** `handoff_id`: one handoff whole, with its transition events. */
  handoff?: TaskHandoff & { events: ReturnType<TaskService['handoffs']['store']['events']> }
}

export function handoffRead(tasks: TaskService, task: TeamTask, handoffId?: string): AgentHandoffRead {
  const service = tasks.handoffs
  const store = tasks.store
  const ids = store.db.prepare('SELECT id FROM team_task_handoffs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(task.id, HANDOFF_WINDOW + 1) as Array<{ id: string }>
  const { n: total } = store.db.prepare('SELECT COUNT(*) AS n FROM team_task_handoffs WHERE task_id = ?').get(task.id) as { n: number }
  const owner = taskOwner(task)
  const rows = ids.slice(0, HANDOFF_WINDOW).map(({ id }): AgentHandoffRow => {
    const handoff = service.store.get(id)!
    const pending = handoff.state === 'open' || handoff.state === 'stale'
    return {
      id: handoff.id, state: handoff.state, baseRevision: handoff.baseRevision,
      requesterSession: handoff.requesterSession, requesterGroup: handoff.requesterGroup, payloadHash: handoff.payloadHash.slice(0, 12),
      publishedRevision: handoff.publishedRevision,
      publishedAsEdited: handoff.state === 'published' ? handoff.publishedPayloadHash !== handoff.payloadHash : null,
      disposition: handoff.state === 'open' ? null : { actor: handoff.stateActor, reason: handoff.stateReason },
      ...(pending ? { nextActor: pendingHandoffActor(handoff, owner !== null && service.live(owner) ? owner : null, service.live(handoff.requesterSession)) } : {}),
      ...(handoff.state === 'published' && store.notices && store.mail ? {
        phase: handoffPhase(followUpFacts({ db: store.db, mail: store.mail, notices: store.notices, acknowledgements: store.acknowledgements, live: service.live }, handoff, task)),
      } : {}),
      createdAt: handoff.createdAt, updatedAt: handoff.updatedAt,
    }
  })
  const read: AgentHandoffRead = { handoffs: rows, handoffBounds: { total, returned: rows.length, truncated: ids.length > HANDOFF_WINDOW } }
  if (handoffId === undefined) return read
  const whole = service.store.get(handoffId)
  if (!whole || whole.taskId !== task.id || whole.teamId !== task.teamId) throw new Error(`Publication handoff not found for this task: ${handoffId}`)
  return { ...read, handoff: { ...whole, events: service.store.events(whole.id) } }
}
