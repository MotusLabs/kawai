// Team mailbox subscriptions and human actions. Every action resolves its
// team's scope from an existing chat session and checks the target row.
import type { ClientMessage } from '../../shared/types'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'

export class MailboxConnections {
  private pendingOpen = new Map<ChatConnection, Map<string, object>>()
  private subscriptions = new Map<ChatConnection, Map<string, string>>()
  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) { this.subscriptions.delete(connection); this.pendingOpen.delete(connection) }

  publish(teamId: string) {
    for (const [connection, sessions] of this.subscriptions) {
      for (const [sessionId, subscribedTeam] of sessions) {
        if (subscribedTeam === teamId) this.snapshot(connection, sessionId, teamId)
      }
    }
  }

  private snapshot(connection: ChatConnection, sessionId: string, teamId: string) {
    connection.send({ type: 'team-mailbox-snapshot', sessionId, teamId, messages: this.manager.mailbox.store.listForTeam(teamId) })
  }

  async handle(connection: ChatConnection, message: ClientMessage) {
    if (!message.type.startsWith('team-mailbox-') || !('sessionId' in message)) return
    const sessionId = message.sessionId
    if (message.type === 'team-mailbox-close') {
      this.pendingOpen.get(connection)?.delete(sessionId)
      this.subscriptions.get(connection)?.delete(sessionId)
      return
    }
    const token = {}
    if (message.type === 'team-mailbox-open') {
      const pending = this.pendingOpen.get(connection) ?? new Map()
      pending.set(sessionId, token)
      this.pendingOpen.set(connection, pending)
    }
    const team = await this.manager.teams.resolvedTeamOf(sessionId)
    if (message.type === 'team-mailbox-open') {
      if (this.pendingOpen.get(connection)?.get(sessionId) !== token) return
      this.pendingOpen.get(connection)?.delete(sessionId)
    }
    if (!this.manager.has(sessionId) || !team) {
      connection.send({ type: 'error', message: 'Chat team is unavailable' })
      return
    }
    if (message.type === 'team-mailbox-open') {
      const sessions = this.subscriptions.get(connection) ?? new Map()
      sessions.set(sessionId, team.teamId)
      this.subscriptions.set(connection, sessions)
      this.snapshot(connection, sessionId, team.teamId)
      return
    }
    if (!('messageId' in message)) return
    const row = this.manager.mailbox.store.get(message.messageId)
    if (!row || row.teamId !== team.teamId) {
      connection.send({ type: 'error', message: 'Message does not belong to this team' })
      return
    }
    const action = message.type === 'team-mailbox-cancel' ? 'cancel'
      : message.type === 'team-mailbox-retry' ? 'retry' : message.type === 'team-mailbox-discard' ? 'discard' : null
    if (!action) return
    if (!this.manager.mailbox.store[action](row.id)) {
      connection.send({ type: 'error', message: action === 'retry' && this.manager.mailbox.store.get(row.id)?.reason === 'killed-recipient' ? 'Cannot retry: the recipient session no longer exists' : 'Message state changed; this action is no longer available' })
    }
    this.manager.dispatcher.notify()
    this.publish(team.teamId)
  }
}
