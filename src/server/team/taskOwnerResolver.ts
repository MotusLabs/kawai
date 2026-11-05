// A group message's task owner at a routing decision (group-mail-task-affinity
// D1): the current `owner_session` of its affinity task, kept only when that
// session belongs to the message's team and target group. Read each pass, so
// mail queued before a handover or takeover follows the new owner; whether the
// owner is a live, idle member is judged by the eligibility check (D3).
import type { ChatSessionRecord } from '../db'
import type { TeamMessage } from './mailboxStore'
import type { TaskStore } from './taskStore'

export interface TaskOwnerSources {
  tasks: Pick<TaskStore, 'get'>
  getRecord: (sessionId: string) => ChatSessionRecord | null | undefined
  /** The session's team id; undefined when unresolved. */
  teamOf: (sessionId: string) => string | undefined
}

export function taskOwnerResolver(sources: TaskOwnerSources): (message: TeamMessage) => string | null {
  return message => {
    if (message.toKind !== 'group' || !message.affinityTask) return null
    const task = sources.tasks.get(message.affinityTask)
    const owner = task && task.teamId === message.teamId ? task.ownerSession ?? null : null
    if (!owner) return null
    const record = sources.getRecord(owner)
    return record && record.groupId === message.toId && sources.teamOf(owner) === message.teamId ? owner : null
  }
}
