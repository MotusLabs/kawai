// Team workspace subscriptions (team-workspace 5.1). Like every human team
// view, the workspace names the team's directory (`teamPath`,
// team-workspace-pages D1) rather than a chat; the resolved team scopes the
// whole read, so an unknown path is refused with no data and a second
// repository's workspace never sees this team's facts — every id in the
// snapshot comes from the addressed team's own stores, and Phase 1 has no
// action that could name a foreign one (links resolve through the task,
// message, and chat views, which keep their own refusals). Open answers with
// one authoritative snapshot; later pushes are full-set replaces the client
// applies, diffed before sending so an unchanged read stays quiet.
import type { ClientMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'
import type { TeamIdentity } from './teamIdentity'
import { WorkspaceRead } from './workspaceRead'

type WorkspaceClientMessage = Extract<ClientMessage, { type: `team-workspace-${string}` }>

export class WorkspaceConnections {
  /** Per connection: each open view's `teamPath` and the team it resolved to. */
  private readonly subscriptions = new Map<ChatConnection, Map<string, TeamIdentity>>()
  /** Latest open per connection and teamPath, so a close beats a slow open. */
  private readonly pendingOpen = new Map<ChatConnection, Map<string, object>>()
  /** Last payload sent per connection and teamPath; an equal read is not re-sent. */
  private readonly lastSent = new Map<ChatConnection, Map<string, string>>()
  private readonly read: WorkspaceRead

  constructor(private readonly manager: ChatSessionManager) {
    this.read = new WorkspaceRead(manager)
  }

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pendingOpen.delete(connection)
    this.lastSent.delete(connection)
  }

  /** A committed change of the team's tasks, mail, or waiting reasons. */
  publish(teamId: string) {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, team] of views) {
        if (team.teamId === teamId) this.send(connection, teamPath, team, 'team-workspace')
      }
    }
  }

  private send(
    connection: ChatConnection,
    teamPath: string,
    team: TeamIdentity,
    type: 'team-workspace-snapshot' | 'team-workspace',
  ) {
    const payload = this.read.snapshot(team)
    // Diff before pushing (design's churn risk): the read recomputes on the
    // mailbox and task triggers, and an unchanged team must stay quiet. An
    // open always sends — the snapshot is authoritative, never assumed.
    const key = JSON.stringify(payload)
    const sent = this.lastSent.get(connection)
    if (sent) {
      if (type === 'team-workspace' && sent.get(teamPath) === key) return
      sent.set(teamPath, key)
    } else {
      this.lastSent.set(connection, new Map([[teamPath, key]]))
    }
    connection.send({ type, teamPath, teamId: team.teamId, ...payload })
  }

  async handle(connection: ChatConnection, message: WorkspaceClientMessage) {
    const { teamPath } = message
    if (message.type === 'team-workspace-close') {
      this.pendingOpen.get(connection)?.delete(teamPath)
      this.subscriptions.get(connection)?.delete(teamPath)
      this.lastSent.get(connection)?.delete(teamPath)
      return
    }
    const token = {}
    const pending = this.pendingOpen.get(connection) ?? new Map<string, object>()
    pending.set(teamPath, token)
    this.pendingOpen.set(connection, pending)
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pendingOpen.get(connection)?.get(teamPath) !== token) return
    this.pendingOpen.get(connection)?.delete(teamPath)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    const views = this.subscriptions.get(connection) ?? new Map<string, TeamIdentity>()
    views.set(teamPath, team)
    this.subscriptions.set(connection, views)
    this.send(connection, teamPath, team, 'team-workspace-snapshot')
  }
}
