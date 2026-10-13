// Team mailbox subscriptions and human actions. Every action resolves its
// team's scope from an existing chat session and checks the target row.
// Snapshots carry the team's routing state (rule load status, decisions);
// the human reloads routing rules and hands parked work off from here.
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

  /** Every open mailbox view (rule status is user-level, shared by all teams). */
  publishAll() {
    for (const [connection, sessions] of this.subscriptions) {
      for (const [sessionId, teamId] of sessions) this.snapshot(connection, sessionId, teamId)
    }
  }

  private snapshot(connection: ChatConnection, sessionId: string, teamId: string) {
    connection.send({
      type: 'team-mailbox-snapshot', sessionId, teamId, messages: this.manager.mailbox.store.listForTeam(teamId),
      routing: this.manager.routingState(teamId),
      // Worktree occupancy read model (team-waiting-reasons D3/D4): additive,
      // carried on every snapshot, empty for a team with no live sessions.
      worktrees: this.manager.teamRoster(teamId),
    })
  }

  private async reloadRules(connection: ChatConnection, sessionId: string) {
    try {
      const report = await this.manager.reloadRoutingRules()
      connection.send({ type: 'team-mailbox-rules-result', sessionId, ok: true, report })
    } catch (error) {
      connection.send({ type: 'team-mailbox-rules-result', sessionId, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    this.manager.dispatcher.notify()
  }

  private handOff(connection: ChatConnection, sessionId: string, teamId: string, messageId: string, target: { kind: 'group' | 'session'; id: string }) {
    const fail = (error: string) => connection.send({ type: 'team-mailbox-hand-off-result', sessionId, messageId, ok: false, error })
    const valid = target.kind === 'group'
      ? this.manager.teams.catalogOf(sessionId)?.groups.has(target.id)
      : target.kind === 'session' && this.manager.has(target.id) && this.manager.teams.teamOf(target.id)?.teamId === teamId
    if (!valid) return fail(`Unknown ${target.kind === 'group' ? 'group' : 'session'} in this team: ${target.id}`)
    try {
      const forwarded = this.manager.handOff(messageId, target)
      connection.send({ type: 'team-mailbox-hand-off-result', sessionId, messageId, ok: true, forwardedId: forwarded.id })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    this.publish(teamId)
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
    if (message.type === 'team-mailbox-reload-rules') return this.reloadRules(connection, sessionId)
    if (!('messageId' in message)) return
    const row = this.manager.mailbox.store.get(message.messageId)
    if (!row || row.teamId !== team.teamId) {
      connection.send({ type: 'error', message: 'Message does not belong to this team' })
      return
    }
    if (message.type === 'team-mailbox-hand-off') return this.handOff(connection, sessionId, team.teamId, row.id, message.target)
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
