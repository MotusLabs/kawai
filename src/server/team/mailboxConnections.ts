// Team mailbox subscriptions and human actions. Every request names the
// team's directory (`teamPath`, team-workspace-pages D1); its resolved team
// scopes the view, each action checks the target row, and an unknown path is
// refused. Snapshots carry the team's routing state (rule load status,
// decisions); the human reloads routing rules and hands parked work off here.
import type { ClientMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'
import type { TeamIdentity } from './teamIdentity'

export class MailboxConnections {
  private pendingOpen = new Map<ChatConnection, Map<string, object>>()
  /** Per connection: each open view's `teamPath` and the team it resolved to. */
  private subscriptions = new Map<ChatConnection, Map<string, string>>()
  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) { this.subscriptions.delete(connection); this.pendingOpen.delete(connection) }

  publish(teamId: string) {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscribedTeam] of views) {
        if (subscribedTeam === teamId) this.snapshot(connection, teamPath, teamId)
      }
    }
  }

  /** Every open mailbox view (rule status is user-level, shared by all teams). */
  publishAll() {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, teamId] of views) this.snapshot(connection, teamPath, teamId)
    }
  }

  private snapshot(connection: ChatConnection, teamPath: string, teamId: string) {
    connection.send({
      type: 'team-mailbox-snapshot', teamPath, teamId, messages: this.manager.mailbox.store.listForTeam(teamId),
      routing: this.manager.routingState(teamId),
      // Worktree occupancy read model (team-waiting-reasons D3/D4): additive,
      // carried on every snapshot, empty for a team with no live sessions.
      worktrees: this.manager.teamRoster(teamId),
      // Per-message waiting reasons (D3): additive; absent until the first
      // dispatch pass after a restart rebuilds them (in-memory only).
      waiting: this.manager.waitingFor(teamId),
    })
  }

  private async reloadRules(connection: ChatConnection, teamPath: string) {
    try {
      const report = await this.manager.reloadRoutingRules()
      connection.send({ type: 'team-mailbox-rules-result', teamPath, ok: true, report })
    } catch (error) {
      connection.send({ type: 'team-mailbox-rules-result', teamPath, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    this.manager.dispatcher.notify()
  }

  private handOff(connection: ChatConnection, teamPath: string, team: TeamIdentity, messageId: string, target: { kind: 'group' | 'session'; id: string }) {
    const fail = (error: string) => connection.send({ type: 'team-mailbox-hand-off-result', teamPath, messageId, ok: false, error })
    const valid = target.kind === 'group'
      ? this.manager.teams.catalogForTeam(team).groups.has(target.id)
      : target.kind === 'session' && this.manager.has(target.id) && this.manager.teams.teamOf(target.id)?.teamId === team.teamId
    if (!valid) return fail(`Unknown ${target.kind === 'group' ? 'group' : 'session'} in this team: ${target.id}`)
    try {
      const forwarded = this.manager.handOff(messageId, target)
      connection.send({ type: 'team-mailbox-hand-off-result', teamPath, messageId, ok: true, forwardedId: forwarded.id })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    this.publish(team.teamId)
  }

  async handle(connection: ChatConnection, message: ClientMessage) {
    if (!message.type.startsWith('team-mailbox-') || !('teamPath' in message)) return
    const teamPath = message.teamPath
    if (message.type === 'team-mailbox-close') {
      this.pendingOpen.get(connection)?.delete(teamPath)
      this.subscriptions.get(connection)?.delete(teamPath)
      return
    }
    const token = {}
    if (message.type === 'team-mailbox-open') {
      const pending = this.pendingOpen.get(connection) ?? new Map()
      pending.set(teamPath, token)
      this.pendingOpen.set(connection, pending)
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (message.type === 'team-mailbox-open') {
      if (this.pendingOpen.get(connection)?.get(teamPath) !== token) return
      this.pendingOpen.get(connection)?.delete(teamPath)
    }
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    if (message.type === 'team-mailbox-open') {
      const views = this.subscriptions.get(connection) ?? new Map()
      views.set(teamPath, team.teamId)
      this.subscriptions.set(connection, views)
      this.snapshot(connection, teamPath, team.teamId)
      return
    }
    if (message.type === 'team-mailbox-reload-rules') return this.reloadRules(connection, teamPath)
    if (!('messageId' in message)) return
    const row = this.manager.mailbox.store.get(message.messageId)
    if (!row || row.teamId !== team.teamId) {
      connection.send({ type: 'error', message: 'Message does not belong to this team' })
      return
    }
    if (message.type === 'team-mailbox-hand-off') return this.handOff(connection, teamPath, team, row.id, message.target)
    const action = message.type === 'team-mailbox-cancel' ? 'cancel'
      : message.type === 'team-mailbox-retry' ? 'retry' : message.type === 'team-mailbox-discard' ? 'discard' : null
    if (!action) return
    if (!this.manager.mailbox.store[action](row.id, { kind: 'human' })) {
      connection.send({ type: 'error', message: action === 'retry' && this.manager.mailbox.store.get(row.id)?.reason === 'killed-recipient' ? 'Cannot retry: the recipient session no longer exists' : 'Message state changed; this action is no longer available' })
    }
    this.manager.dispatcher.notify()
    this.publish(team.teamId)
  }
}
