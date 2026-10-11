// Team task subscriptions and human task actions (team-tasks 6.1/6.2). Like
// the mailbox view, every request names a chat session; its resolved team
// scopes what may be seen or changed, so a task of another team is refused.
// Snapshots are authoritative and re-sent whole on every change of the
// team's tasks (and of task mail), so a reconnecting client needs no deltas.
// Human actions run through TaskService as the human caller and answer with
// `team-task-result`; the changes they cause reach every subscriber.
import type { ClientMessage } from '../../shared/types'
import type { TeamTask } from '../../shared/teamTasks'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'

type TaskClientMessage = Extract<ClientMessage, { type: `team-task${string}` }>

interface Subscription {
  teamId: string
  list: boolean
  details: Set<string>
}

export class TaskConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /** Latest open/close per connection and session; a superseded open is dropped. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  publish(teamId: string) {
    for (const [connection, sessions] of this.subscriptions) {
      for (const [sessionId, subscription] of sessions) {
        if (subscription.teamId === teamId) this.send(connection, sessionId, subscription)
      }
    }
  }

  private send(connection: ChatConnection, sessionId: string, subscription: Subscription, only?: string) {
    const store = this.manager.tasks.store
    if (subscription.list && !only) {
      connection.send({ type: 'team-tasks-snapshot', sessionId, teamId: subscription.teamId, tasks: store.list(subscription.teamId) })
    }
    for (const taskId of subscription.details) {
      if (only && taskId !== only) continue
      const detail = store.detail(taskId)
      if (detail) connection.send({ type: 'team-task-detail', sessionId, teamId: subscription.teamId, detail })
    }
  }

  async handle(connection: ChatConnection, message: TaskClientMessage) {
    if ('requestId' in message) return this.act(connection, message)
    // Subscription changes order against each other: the latest open/close
    // for a session wins, even when an earlier open is still resolving.
    const { sessionId } = message
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(sessionId, token)
    this.pending.set(connection, pending)
    const sessions = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    if (message.type === 'team-tasks-close' || message.type === 'team-task-close') {
      const subscription = sessions.get(sessionId)
      if ('taskId' in message) subscription?.details.delete(message.taskId)
      else if (subscription) subscription.list = false
      if (subscription && !subscription.list && subscription.details.size === 0) sessions.delete(sessionId)
      return
    }
    const team = await this.manager.teams.resolvedTeamOf(sessionId)
    if (this.pending.get(connection)?.get(sessionId) !== token) return
    if (!this.manager.has(sessionId) || !team) {
      connection.send({ type: 'error', message: 'Chat team is unavailable' })
      return
    }
    const taskId = 'taskId' in message ? message.taskId : undefined
    if (taskId !== undefined && this.manager.tasks.store.get(taskId)?.teamId !== team.teamId) {
      connection.send({ type: 'error', message: 'Task does not belong to this team' })
      return
    }
    const current = sessions.get(sessionId)
    const subscription = current?.teamId === team.teamId ? current : { teamId: team.teamId, list: false, details: new Set<string>() }
    if (taskId === undefined) subscription.list = true
    else subscription.details.add(taskId)
    sessions.set(sessionId, subscription)
    this.subscriptions.set(connection, sessions)
    this.send(connection, sessionId, subscription, taskId)
  }

  /** A human task action, as the human caller for the session's team. */
  private async act(connection: ChatConnection, message: Extract<TaskClientMessage, { requestId: string }>) {
    const { sessionId, requestId } = message
    const team = await this.manager.teams.resolvedTeamOf(sessionId)
    if (!this.manager.has(sessionId) || !team) {
      connection.send({ type: 'team-task-result', sessionId, requestId, error: 'Chat team is unavailable' })
      return
    }
    const caller = { kind: 'human' as const, team }
    const tasks = this.manager.tasks
    let task: TeamTask | undefined
    try {
      switch (message.type) {
        case 'team-task-create':
          task = await tasks.create(caller, {
            title: message.title, direction: message.direction, acceptance: message.acceptance ?? null,
            parent_id: message.parentId || null, worktree: message.worktree || null, openspec_change: message.openspecChange || null,
          })
          break
        case 'team-task-amend':
          task = await tasks.amend(caller, message.taskId, {
            ...(message.direction !== undefined ? { direction: message.direction } : {}),
            ...(message.acceptance !== undefined ? { acceptance: message.acceptance } : {}),
          })
          break
        case 'team-task-note':
          await tasks.note(caller, message.taskId, message.text)
          task = tasks.store.get(message.taskId) ?? undefined
          break
        case 'team-task-status':
          task = await tasks.setStatus(caller, message.taskId, message.status)
          break
      }
      connection.send({ type: 'team-task-result', sessionId, requestId, ...(task ? { task } : {}) })
    } catch (error) {
      connection.send({ type: 'team-task-result', sessionId, requestId, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
