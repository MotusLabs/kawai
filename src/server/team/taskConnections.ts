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
  /**
   * Latest open/close per connection and subscription target — a session's
   * list, or one task detail of it. Only a later open/close of the same
   * target supersedes a pending open: the list and a detail opened together
   * (header link, reconnect) must both stand.
   */
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
      if (detail) connection.send({
        type: 'team-task-detail', sessionId, teamId: subscription.teamId, detail,
        // Its messages name participants; the directory keeps a killed one's.
        directory: this.manager.directory.list(subscription.teamId),
      })
    }
  }

  async handle(connection: ChatConnection, message: TaskClientMessage) {
    if ('requestId' in message) return this.act(connection, message)
    // Opens and closes of one target order against each other: the latest
    // wins, even when an earlier open is still resolving its team.
    const { sessionId } = message
    const target = `${sessionId}\0${'taskId' in message ? message.taskId : ''}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'team-tasks-close' || message.type === 'team-task-close') {
      const sessions = this.subscriptions.get(connection)
      const subscription = sessions?.get(sessionId)
      if ('taskId' in message) subscription?.details.delete(message.taskId)
      else if (subscription) subscription.list = false
      if (subscription && !subscription.list && subscription.details.size === 0) sessions!.delete(sessionId)
      return
    }
    const team = await this.manager.teams.resolvedTeamOf(sessionId)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!this.manager.has(sessionId) || !team) {
      connection.send({ type: 'error', message: 'Chat team is unavailable' })
      return
    }
    const taskId = 'taskId' in message ? message.taskId : undefined
    if (taskId !== undefined && this.manager.tasks.store.get(taskId)?.teamId !== team.teamId) {
      connection.send({ type: 'error', message: 'Task does not belong to this team' })
      return
    }
    // Read the connection's map only now: concurrent opens each awaited the
    // team, and a map captured before that would overwrite the others'.
    const sessions = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, sessions)
    const current = sessions.get(sessionId)
    const subscription = current?.teamId === team.teamId ? current : { teamId: team.teamId, list: false, details: new Set<string>() }
    if (taskId === undefined) subscription.list = true
    else subscription.details.add(taskId)
    sessions.set(sessionId, subscription)
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
    const result = (payload: Record<string, unknown>) => connection.send({ type: 'team-task-result', sessionId, requestId, ...payload })
    let task: TeamTask | undefined
    try {
      switch (message.type) {
        case 'team-task-create':
          task = await tasks.create(caller, {
            title: message.title, direction: message.direction, acceptance: message.acceptance ?? null,
            parent_id: message.parentId || null, worktree: message.worktree || null, openspec_change: message.openspecChange || null,
            ...(message.requestKey ? { requestKey: message.requestKey } : {}),
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
        case 'team-task-assign': {
          const outcome = await this.manager.assignments.dispatch(caller, {
            taskId: message.taskId, target: message.target, instruction: message.instruction,
            requestKey: message.requestKey, ...(message.handling ? { handling: message.handling } : {}),
          })
          result({ assignment: outcome.assignment, ...(outcome.message?.taskId ? { task: tasks.store.get(outcome.message.taskId) ?? undefined } : {}) })
          return
        }
        case 'team-task-preview': {
          const preview = await this.manager.assignments.preview(caller, {
            ...(message.taskId ? { taskId: message.taskId } : {}),
            ...(message.worktree ? { worktree: message.worktree } : {}),
            target: message.target,
          })
          connection.send({ type: 'team-task-preview-result', sessionId, requestId, preview })
          return
        }
        case 'team-task-targets': {
          const targets = await this.manager.assignments.targets(caller, message.worktree)
          connection.send({ type: 'team-task-targets-result', sessionId, requestId, targets })
          return
        }
      }
      result(task ? { task } : {})
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (message.type === 'team-task-preview') {
        connection.send({ type: 'team-task-preview-result', sessionId, requestId, error: text })
        return
      }
      if (message.type === 'team-task-targets') {
        connection.send({ type: 'team-task-targets-result', sessionId, requestId, error: text })
        return
      }
      result({ error: text })
    }
  }
}
