// Plan workspace subscriptions and the human bind command (plan-workspace
// tasks 1.3, design D1, D6). Like the plan view, every request names the
// team's directory (`teamPath`); the shared team-scope resolver turns it
// into the team that scopes what may be seen or changed, so an unknown path
// and another team's plan id are refused with no data. The snapshot is
// authoritative and re-sent whole after every committed workspace write of
// the team — never on a replay or a refusal (the runPlanCommand rule); a
// bind is team-level, so it re-pushes every subscribed plan of the team.
//
// Invariant I6: open, close, and every read never start an agent or attach
// a worker. The snapshot reads only the manager's record facts (`has`,
// `isArchived`, `teams.teamOf`), the session directory, and the plan store.
import type { ClientMessage } from '../../../shared/types'
import { unknownTeamError } from '../../../shared/team'
import type { PlanWorkspaceRole, WorkspaceBindingView, WorkspaceVersionSelector } from '../../../shared/planWorkspace'
import { parseVersionSelector } from '../../../shared/planWorkspace'
import type { PlanWorkspaceClientMessage } from '../../../shared/planWorkspaceMessages'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'
import { defaultDisplayedVersion, selectedDisplayedVersion } from './displayedVersion'

type WorkspaceClientMessage = Extract<ClientMessage, { type: `team-plan-workspace-${string}` }>
type WorkspaceBindMessage = Extract<PlanWorkspaceClientMessage, { type: 'team-plan-workspace-bind' }>
type WorkspaceOpenMessage = Extract<PlanWorkspaceClientMessage, { type: 'team-plan-workspace-open' }>

interface WorkspaceSubscription {
  teamId: string
  plans: Map<string, WorkspaceVersionSelector | null>
}

export class PlanWorkspaceConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, WorkspaceSubscription>>()
  /** Latest open/close per connection and target; only a later one supersedes a pending open. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  /** A committed workspace write of the team: re-push every subscribed plan of it. */
  publish(teamId: string) {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        if (subscription.teamId !== teamId) continue
        for (const [planId, selector] of subscription.plans) {
          // Fire and forget: a push is a view refresh, and one racing a
          // shutdown must not surface anywhere (planConnections' rule).
          void this.sendSnapshot(connection, teamPath, teamId, planId, selector).catch(() => {})
        }
      }
    }
  }

  async handle(connection: ChatConnection, message: WorkspaceClientMessage) {
    if (message.type === 'team-plan-workspace-bind') return this.bind(connection, message as WorkspaceBindMessage)
    const { teamPath, planId } = message
    const target = `${teamPath}\0${planId}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'team-plan-workspace-close') {
      const views = this.subscriptions.get(connection)
      const subscription = views?.get(teamPath)
      subscription?.plans.delete(planId)
      if (subscription && subscription.plans.size === 0) views!.delete(teamPath)
      return
    }
    // The selector is parsed before anything else, so a malformed one is
    // refused without resolving a team (fail closed, with no data).
    const open = message as WorkspaceOpenMessage
    const selector = parseVersionSelector(open.version)
    if (open.version !== undefined && selector === null) {
      connection.send({ type: 'error', message: 'Malformed version selector: use { kind: "revision", revision } or { kind: "draft", draftId }.' })
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    if (!this.manager.plans.store.forTeam(team.teamId, planId)) {
      connection.send({ type: 'error', message: `Plan not found in this team: ${planId}` })
      return
    }
    // Read the connection's map only now: concurrent opens each awaited the team.
    const views = this.subscriptions.get(connection) ?? new Map<string, WorkspaceSubscription>()
    this.subscriptions.set(connection, views)
    const current = views.get(teamPath)
    const subscription = current?.teamId === team.teamId ? current : { teamId: team.teamId, plans: new Map() }
    views.set(teamPath, subscription)
    subscription.plans.set(planId, selector)
    // The open's first snapshot is authoritative: awaited, not pushed.
    await this.sendSnapshot(connection, teamPath, team.teamId, planId, selector)
  }

  private async sendSnapshot(connection: ChatConnection, teamPath: string, teamId: string, planId: string, selector: WorkspaceVersionSelector | null) {
    try {
      const plan = this.manager.plans.store.forTeam(teamId, planId)
      if (!plan) return
      const inputs = {
        approved: this.manager.plans.store.approvedRevision(planId),
        revisions: this.manager.plans.store.revisions(planId),
        drafts: this.manager.plans.store.drafts(planId),
      }
      const displayedVersion = selector ? selectedDisplayedVersion(inputs, selector) : defaultDisplayedVersion(inputs)
      if (selector && displayedVersion === null) {
        const named = selector.kind === 'revision' ? `Revision ${selector.revision}` : `Draft "${selector.draftId}"`
        connection.send({ type: 'error', message: `${named} not found in this plan: ${planId}` })
        return
      }
      connection.send({
        type: 'team-plan-workspace-snapshot', teamPath, teamId, planId,
        workspace: {
          plan: { id: plan.id, title: plan.title, lifecycle: plan.lifecycle },
          displayedVersion,
          bindings: this.bindingViews(teamId),
          references: [],
        },
      })
    } catch {
      // A view refresh that raced a shutdown or a vanished row is dropped.
    }
  }

  /** The team's bound roles with their current availability (D6): a killed binding, or one whose session moved teams, reads unavailable. */
  private bindingViews(teamId: string): WorkspaceBindingView[] {
    return this.manager.planWorkspace.bindings(teamId).map(binding => {
      const id = binding.sessionId
      const availability = !this.manager.has(id) || this.manager.teams.teamOf(id)?.teamId !== teamId
        ? 'unavailable' as const
        : this.manager.isArchived(id) ? 'archived' as const : 'live' as const
      return {
        role: binding.role as PlanWorkspaceRole, sessionId: id, version: binding.version, availability,
        name: this.manager.directory.get(teamId, id)?.name ?? null,
      }
    })
  }

  /** A human bind, as the human caller for the addressed team. */
  private async bind(connection: ChatConnection, message: WorkspaceBindMessage) {
    const { teamPath, requestId } = message
    const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-workspace-result', teamPath, requestId, ...payload })
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      answer({ error: unknownTeamError(teamPath) })
      return
    }
    // Recorded, same-team session (D6): has() refuses killed and terminal
    // ids — they have no record. Archived sessions bind (D6: read-only until
    // ordinary Restore). A refusal writes nothing, so the same command id
    // resent after the state changes is evaluated afresh.
    if (!this.manager.has(message.sessionId) || this.manager.teams.teamOf(message.sessionId)?.teamId !== team.teamId) {
      answer({ error: `Session not found in this team: ${message.sessionId}`, field: 'sessionId' })
      return
    }
    const outcome = this.manager.planWorkspace.bind(team.teamId, message.commandId, {
      role: message.role, sessionId: message.sessionId, expectedVersion: message.expectedVersion,
    })
    if (!outcome.ok) {
      answer({ error: outcome.message, ...(outcome.field ? { field: outcome.field } : {}) })
      return
    }
    answer({ binding: { role: outcome.role, sessionId: outcome.sessionId, version: outcome.version }, replayed: outcome.replayed })
    // Only a commit re-pushes — never a replay or a refusal.
    if (!outcome.replayed) this.publish(team.teamId)
  }
}
