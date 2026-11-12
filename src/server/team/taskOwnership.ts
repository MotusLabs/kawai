// Task ownership transfer (group-mail-task-affinity D7): `task_transfer_owner`.
// The owner hands a task to another live, unflagged session of its group; a
// session of the owner's group takes a task for itself once the owner is gone
// (no record), archived, or context-exhausted — one task by `task_id`, or every
// open, active, and blocked task of a departed owner by `from_session`. A live
// owner is never taken over: two leads would race on one task. Each move
// writes the column and its journal entry in one transaction, conditional on
// the owner still being the one checked, so a concurrent move refuses instead
// of overwriting. Human and Kawai tasks have no owner and never move.
import type { ChatSessionRecord } from '../db'
import type { TeamTask } from '../../shared/teamTasks'
import type { TaskCaller, TaskService } from './TaskService'

export interface TransferInput {
  task_id?: string
  from_session?: string
  to_session?: string
  reason?: string
}

export interface TransferOutcome {
  from: string
  to: string
  /** The tasks that moved, in creation order. */
  taskIds: string[]
}

/** Why a session no longer holds its tasks' rights: gone, archived, or context-exhausted; null while live. */
export function departure(record: ChatSessionRecord | null | undefined): 'gone' | 'archived' | 'context-exhausted' | null {
  if (!record) return 'gone'
  if (record.archivedAt) return 'archived'
  if (record.contextExhausted) return 'context-exhausted'
  return null
}

export class TaskOwnership {
  constructor(private readonly tasks: TaskService, private readonly getSession: (id: string) => ChatSessionRecord | null | undefined) {}

  async transfer(caller: TaskCaller, input: TransferInput): Promise<TransferOutcome> {
    if (caller.kind !== 'agent') throw new Error('task_transfer_owner is an agent tool; the human reassigns from the task view')
    if ((input.task_id === undefined) === (input.from_session === undefined)) {
      throw new Error('Give exactly one of task_id (one task) or from_session (every open task of a departed owner)')
    }
    const { team, canCreate } = await this.tasks.context(caller)
    const me = this.getSession(caller.sessionId)!
    const reason = input.reason?.trim() || null
    if (input.task_id !== undefined) {
      const task = this.tasks.sameTeamTask(team, input.task_id)
      const owner = task.ownerSession ?? null
      if (!owner) throw new Error(`Task ${task.id} has no owner (the human or Kawai created it); only the human changes it`)
      const to = owner === caller.sessionId ? await this.handoverTarget(team.teamId, owner, input.to_session) : this.takeover(caller.sessionId, me, owner, input.to_session, canCreate)
      return this.move([task], owner, to, caller.sessionId, reason)
    }
    const from = input.from_session!.trim()
    this.takeover(caller.sessionId, me, from, input.to_session, canCreate)
    const owned = this.tasks.store.openTasksOwnedBy(team.teamId, from)
    return this.move(owned, from, caller.sessionId, caller.sessionId, reason)
  }

  /** The owner's handover: a named, live, unflagged session of the owner's group. */
  private async handoverTarget(teamId: string, owner: string, toSession: string | undefined): Promise<string> {
    const to = toSession?.trim()
    if (!to || to === owner) throw new Error('You already own this task; name to_session to hand it to another session of your group')
    const ownerRecord = this.getSession(owner)!
    const target = this.getSession(to)
    const gone = departure(target)
    if (gone) throw new Error(`Session ${to} cannot take the task: it is ${gone === 'gone' ? 'not a session of this team' : gone}`)
    const sameTeam = (await this.tasks.context({ kind: 'agent', sessionId: to })).team.teamId === teamId
    if (!sameTeam || target!.groupId == null || target!.groupId !== ownerRecord.groupId) {
      throw new Error(`Session ${to} is not in your group (${ownerRecord.groupId ?? 'none'}); hand the task only to a member of it`)
    }
    return to
  }

  /**
   * A takeover's checks: the caller takes for itself, only from a departed
   * owner of its own group. An owner with no record left is matched by the
   * caller's right to own tasks (its group may create them).
   */
  private takeover(caller: string, me: ChatSessionRecord, owner: string, toSession: string | undefined, canCreate: boolean): string {
    const to = toSession?.trim()
    if (to && to !== caller) throw new Error('A takeover moves tasks only to yourself; the owner hands a task to someone else')
    const ownerRecord = this.getSession(owner)
    const gone = departure(ownerRecord)
    if (!gone) {
      throw new Error(`Session ${owner} owns this and is still live; message it to hand the task over with task_transfer_owner`)
    }
    const sameGroup = ownerRecord ? (ownerRecord.groupId ?? null) === (me.groupId ?? null) && me.groupId != null : canCreate
    if (!sameGroup) {
      throw new Error(`Only a session of ${ownerRecord?.groupId ? `group ${ownerRecord.groupId}` : "the owner's group"} can take over ${owner}'s tasks`)
    }
    return caller
  }

  private move(tasks: TeamTask[], from: string, to: string, by: string, reason: string | null): TransferOutcome {
    const store = this.tasks.store
    const entry = `owner: ${from} -> ${to} by ${by}${reason ? ` (${reason})` : ''}`
    store.atomically(() => {
      for (const task of tasks) {
        if (!store.setOwner(task.id, from, to)) {
          throw new Error(`Task ${task.id}'s owner changed while this transfer ran; nothing moved. Read it again with task_get.`)
        }
        store.appendJournal(task.id, { kind: 'agent', sessionId: by }, entry)
      }
    })
    return { from, to, taskIds: tasks.map(task => task.id) }
  }
}
