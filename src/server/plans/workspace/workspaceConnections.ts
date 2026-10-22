// Plan workspace subscriptions and the human bind and reference commands
// (plan-workspace tasks 1.3, design D1, D4, D6). Like the plan view, every
// request names the team's directory (`teamPath`); the shared team-scope
// resolver turns it into the team that scopes what may be seen or changed,
// so an unknown path and another team's plan id are refused with no data.
// The snapshot is authoritative and re-sent whole after every committed
// workspace write of the team — never on a replay or a refusal (the
// runPlanCommand rule); a bind is team-level, so it re-pushes every
// subscribed plan of the team.
//
// Invariant I6: open, close, and every read never start an agent or attach
// a worker. The snapshot reads only the manager's record facts (`has`,
// `isArchived`, `teams.teamOf`), the session directory, and the plan store.
import type { ClientMessage } from '../../../shared/types'
import { unknownTeamError } from '../../../shared/team'
import type { PlanWorkspaceRole, WorkspaceBindingView, WorkspaceDisplayedVersion, WorkspaceSnapshot, WorkspaceVersionSelector } from '../../../shared/planWorkspace'
import { parseVersionSelector } from '../../../shared/planWorkspace'
import type { PlanWorkspaceClientMessage } from '../../../shared/planWorkspaceMessages'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'
import { defaultDisplayedVersion, selectedDisplayedVersion, type PlanVersionInputs } from './displayedVersion'

const namedSelector = (selector: WorkspaceVersionSelector): string =>
  selector.kind === 'revision' ? `Revision ${selector.revision}` : `Draft "${selector.draftId}"`

/** The plan identity and the version inputs one snapshot is built from. */
interface ResolvedPlanInputs {
  plan: WorkspaceSnapshot['plan']
  inputs: PlanVersionInputs
}

type WorkspaceClientMessage = Extract<ClientMessage, { type: `team-plan-workspace-${string}` }>
type WorkspaceBindMessage = Extract<PlanWorkspaceClientMessage, { type: 'team-plan-workspace-bind' }>
type WorkspaceOpenMessage = Extract<PlanWorkspaceClientMessage, { type: 'team-plan-workspace-open' }>
type WorkspaceRefAddMessage = Extract<PlanWorkspaceClientMessage, { type: 'team-plan-workspace-ref-add' }>
type WorkspaceRefRemoveMessage = Extract<PlanWorkspaceClientMessage, { type: 'team-plan-workspace-ref-remove' }>

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

  /** Retire an open/close reservation, but only while it is still the latest one for its target. */
  private dropPending(connection: ChatConnection, target: string, token: object) {
    const pending = this.pending.get(connection)
    if (pending?.get(target) === token) pending.delete(target)
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
    if (message.type === 'team-plan-workspace-ref-add') return this.refAdd(connection, message as WorkspaceRefAddMessage)
    if (message.type === 'team-plan-workspace-ref-remove') return this.refRemove(connection, message as WorkspaceRefRemoveMessage)
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
      this.dropPending(connection, target, token)
      return
    }
    // The selector is parsed before anything else, so a malformed one is
    // refused without resolving a team (fail closed, with no data).
    const open = message as WorkspaceOpenMessage
    const selector = parseVersionSelector(open.version)
    if (open.version !== undefined && selector === null) {
      // A refused open leaves nothing behind (F3): drop the token it
      // reserved — no await has run, so it is still the latest one.
      this.dropPending(connection, target, token)
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
    // Resolve the selector against the plan before anything is stored: a
    // refused open must not subscribe, or every later committed bind of the
    // team would re-push its refusal to this connection.
    const resolved = this.planInputs(team.teamId, planId)
    if (!resolved) {
      connection.send({ type: 'error', message: `Plan not found in this team: ${planId}` })
      return
    }
    const displayedVersion = selector ? selectedDisplayedVersion(resolved.inputs, selector) : defaultDisplayedVersion(resolved.inputs)
    if (selector && displayedVersion === null) {
      connection.send({ type: 'error', message: `${namedSelector(selector)} not found in this plan: ${planId}` })
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
    this.emitSnapshot(connection, teamPath, team.teamId, resolved, displayedVersion)
  }

  /** The plan identity and version inputs a snapshot is built from; null when the plan row is gone. */
  private planInputs(teamId: string, planId: string): ResolvedPlanInputs | null {
    const plan = this.manager.plans.store.forTeam(teamId, planId)
    if (!plan) return null
    return {
      plan: { id: plan.id, title: plan.title, lifecycle: plan.lifecycle },
      inputs: {
        approved: this.manager.plans.store.approvedRevision(planId),
        revisions: this.manager.plans.store.revisions(planId),
        drafts: this.manager.plans.store.drafts(planId),
      },
    }
  }

  private emitSnapshot(connection: ChatConnection, teamPath: string, teamId: string, resolved: ResolvedPlanInputs, displayedVersion: WorkspaceDisplayedVersion | null) {
    connection.send({
      type: 'team-plan-workspace-snapshot', teamPath, teamId, planId: resolved.plan.id,
      workspace: {
        plan: resolved.plan,
        displayedVersion,
        bindings: this.bindingViews(teamId),
        references: this.manager.planWorkspaceRefs.refsOf(teamId, resolved.plan.id),
      },
    })
  }

  private async sendSnapshot(connection: ChatConnection, teamPath: string, teamId: string, planId: string, selector: WorkspaceVersionSelector | null) {
    try {
      const resolved = this.planInputs(teamId, planId)
      if (!resolved) return
      const displayedVersion = selector ? selectedDisplayedVersion(resolved.inputs, selector) : defaultDisplayedVersion(resolved.inputs)
      // A stored subscription's selector resolved at open; if it no longer
      // does, the refresh is dropped — never an error on a push.
      if (selector && displayedVersion === null) return
      this.emitSnapshot(connection, teamPath, teamId, resolved, displayedVersion)
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

  /** The change names valid at insert: the union over the approved revision, every in-review revision and every draft (Q3). */
  private changeNames(planId: string): ReadonlySet<string> {
    const names = new Set<string>()
    const collect = (content: { changes: ReadonlyArray<{ change: string }> }) => {
      for (const change of content.changes) names.add(change.change)
    }
    const approved = this.manager.plans.store.approvedRevision(planId)
    if (approved) collect(approved.content)
    for (const revision of this.manager.plans.store.revisions(planId)) {
      if (revision.status === 'in_review') collect(revision.content)
    }
    for (const draft of this.manager.plans.store.drafts(planId)) collect(draft.content)
    return names
  }

  /** A human ref-add, as the human caller for the addressed team (design D4). */
  private async refAdd(connection: ChatConnection, message: WorkspaceRefAddMessage) {
    const { teamPath, requestId } = message
    const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-workspace-result', teamPath, requestId, ...payload })
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      answer({ error: unknownTeamError(teamPath) })
      return
    }
    // Insert-time validation against the resolved facts; a refusal writes
    // nothing, so a resend under the same command id is evaluated afresh.
    const outcome = await this.manager.planWorkspaceRefs.add(team.teamId, message.commandId, {
      planId: message.planId, label: message.label, kind: message.kind,
      changeName: message.changeName, worktreeId: message.worktreeId,
      relativePath: message.relativePath, url: message.url,
    }, {
      planInTeam: planId => this.manager.plans.store.forTeam(team.teamId, planId) !== null,
      changeNames: planId => this.changeNames(planId),
      worktreeTarget: async worktreeId => (await this.manager.tasks.worktrees.list(team.teamId)).includes(worktreeId),
    })
    if (!outcome.ok) {
      answer({ error: outcome.message, ...(outcome.field ? { field: outcome.field } : {}) })
      return
    }
    answer({ ref: outcome.ref, replayed: outcome.replayed })
    if (!outcome.replayed) this.publish(team.teamId)
  }

  /** A human ref-remove: team-scoped, one not-found message for a gone or foreign reference (Q3). */
  private async refRemove(connection: ChatConnection, message: WorkspaceRefRemoveMessage) {
    const { teamPath, requestId } = message
    const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-workspace-result', teamPath, requestId, ...payload })
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      answer({ error: unknownTeamError(teamPath) })
      return
    }
    const outcome = this.manager.planWorkspaceRefs.remove(team.teamId, message.commandId, { refId: message.refId })
    if (!outcome.ok) {
      answer({ error: outcome.message, ...(outcome.field ? { field: outcome.field } : {}) })
      return
    }
    answer({ removedRefId: outcome.removedRefId, replayed: outcome.replayed })
    if (!outcome.replayed) this.publish(team.teamId)
  }
}
