// Handoff wakeups (owner-publication-handoff D6): each `published`,
// `declined`, `stale` and `closed` transition inserts its
// `team_task_handoff_wakeups (handoff_id, transition)` row and enqueues one
// system notification through MailboxStore in the transition's own
// transaction, so the mutation, the key and the mail commit or roll back
// together. The primary key makes a replay or a second sweep a no-op.
//
// The notification carries no task-work attachment (no `task_id`): its body
// names the task, the handoff, the transition and the revision, and the
// wakeup row links the message id. Member release dead-letters a closed
// task's scoped group work mail, so a `closed` wakeup sent as task mail would
// be dropped; as plain system mail it routes like any other. The recipient
// is resolved once, here: the requester session when live, else the
// requester's group as group mail — an archived session is never revived by
// direct mail and no assignment is created.
import type { HandoffWakeupTransition, TaskHandoff } from '../../shared/taskHandoffs'
import type { MailboxStore } from './mailboxStore'
import type { Database } from 'bun:sqlite'

export const HANDOFF_WAKEUP_TAG = 'publication-handoff'

export interface WakeupInput {
  taskTitle: string
  revision: number | null
  originPath: string
  /** Is this session live: its record present, neither archived nor context-exhausted. */
  live: (sessionId: string) => boolean
}

function bodyOf(handoff: TaskHandoff, transition: HandoffWakeupTransition, input: WakeupInput): string {
  const subject = `Publication handoff ${handoff.id} for task "${input.taskTitle}" (${handoff.taskId})`
  switch (transition) {
    case 'published':
      return `${subject} was published as revision ${input.revision}. The holder is notified when the handoff asked for it; follow up from task_get.`
    case 'declined':
      return `${subject} was declined${handoff.stateReason ? `: ${handoff.stateReason}` : ''}. Nothing was published.`
    case 'stale':
      return `${subject} is stale: revision ${input.revision} was published from its base. Re-prepare it on the new revision with task_request_publication, or withdraw it with task_settle_publication.`
    case 'closed':
      return `${subject} closed with its task. Nothing was published.`
  }
}

/** Write the wakeup for one transition; the caller holds the transition's transaction. Null when already written. */
export function writeHandoffWakeup(db: Database, mail: MailboxStore | undefined, handoff: TaskHandoff, transition: HandoffWakeupTransition, input: WakeupInput, now: string): string | null {
  const inserted = db.prepare('INSERT OR IGNORE INTO team_task_handoff_wakeups (handoff_id, transition, created_at) VALUES (?, ?, ?)')
    .run(handoff.id, transition, now)
  if (inserted.changes === 0 || !mail) return null
  const direct = input.live(handoff.requesterSession)
  if (!direct && !handoff.requesterGroup) return null
  const message = mail.enqueue({
    teamId: handoff.teamId, toKind: direct ? 'session' : 'group', toId: direct ? handoff.requesterSession : handoff.requesterGroup!,
    fromKind: 'system', fromSession: null, fromGroup: null, originPath: input.originPath,
    tags: [HANDOFF_WAKEUP_TAG, `handoff-${transition}`], actor: 'system', body: bodyOf(handoff, transition, input),
  }, now)
  db.prepare('UPDATE team_task_handoff_wakeups SET message_id = ? WHERE handoff_id = ? AND transition = ?').run(message.id, handoff.id, transition)
  return message.id
}
