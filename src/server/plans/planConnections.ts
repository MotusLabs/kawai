// Plan subscriptions and human plan commands (durable-plans design D12).
// Like the task and strategy views, every request names the team's
// directory (`teamPath`); the shared team-scope resolver turns it into the
// team that scopes what may be seen or changed, so an unknown path and
// another team's plan id are refused with no data. Snapshots and details are
// authoritative and re-sent whole: the list on every committed plan write of
// the team, a detail on every write to its plan and every change to a task
// linked to it (the manager forwards both through `publish`). Human commands
// run through PlanService as the human caller and answer with
// `team-plan-result`; the changes they cause reach every subscriber.
//
// The boundary is the one `team-task-*` and `strategy-*` human actions
// have: no agent tool surface can approve, withdraw, close, or reopen; a
// local process speaking the UI protocol is trusted like the browser.
import type { ClientMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'
import type { PlanCommandOutcome } from './planCommands'

type PlanClientMessage = Extract<ClientMessage, { type: `team-plan${string}` }>
type PlanCommandMessage = Extract<PlanClientMessage, { requestId: string }>

interface Subscription {
  teamId: string
  list: boolean
  details: Set<string>
}

export class PlanConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /** Latest open/close per connection and target (a team's list, or one plan); only a later one supersedes a pending open. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  /** A committed change of the team's plans: the list, and the named plan's detail (every detail when none is named). */
  publish(teamId: string, planId?: string) {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        if (subscription.teamId !== teamId) continue
        if (subscription.list) this.sendList(connection, teamPath, subscription)
        for (const id of subscription.details) {
          if (planId === undefined || id === planId) this.sendDetail(connection, teamPath, subscription, id)
        }
      }
    }
  }

  private sendList(connection: ChatConnection, teamPath: string, subscription: Subscription) {
    connection.send({ type: 'team-plans-snapshot', teamPath, teamId: subscription.teamId, plans: this.manager.plans.store.list(subscription.teamId) })
  }

  private sendDetail(connection: ChatConnection, teamPath: string, subscription: Subscription, planId: string) {
    const detail = this.manager.plans.store.detail(planId)
    if (detail && detail.plan.teamId === subscription.teamId) {
      connection.send({ type: 'team-plan-detail', teamPath, teamId: subscription.teamId, detail })
    }
  }

  async handle(connection: ChatConnection, message: PlanClientMessage) {
    if ('requestId' in message) return this.act(connection, message)
    const { teamPath } = message
    const planId = 'planId' in message ? message.planId : undefined
    const target = `${teamPath}\0${planId ?? ''}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'team-plans-close' || message.type === 'team-plan-close') {
      const views = this.subscriptions.get(connection)
      const subscription = views?.get(teamPath)
      if (planId !== undefined) subscription?.details.delete(planId)
      else if (subscription) subscription.list = false
      if (subscription && !subscription.list && subscription.details.size === 0) views!.delete(teamPath)
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    if (planId !== undefined && !this.manager.plans.store.forTeam(team.teamId, planId)) {
      connection.send({ type: 'error', message: `Plan not found in this team: ${planId}` })
      return
    }
    // Read the connection's map only now: concurrent opens each awaited the team.
    const views = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, views)
    const current = views.get(teamPath)
    const subscription = current?.teamId === team.teamId ? current : { teamId: team.teamId, list: false, details: new Set<string>() }
    views.set(teamPath, subscription)
    if (planId === undefined) {
      subscription.list = true
      this.sendList(connection, teamPath, subscription)
    } else {
      subscription.details.add(planId)
      this.sendDetail(connection, teamPath, subscription, planId)
    }
  }

  /** A human plan command, as the human caller for the addressed team. */
  private async act(connection: ChatConnection, message: PlanCommandMessage) {
    const { teamPath, requestId } = message
    const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-result', teamPath, requestId, ...payload })
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      answer({ error: unknownTeamError(teamPath) })
      return
    }
    const caller = { kind: 'human' as const, team }
    const plans = this.manager.plans
    try {
      let outcome: PlanCommandOutcome
      switch (message.type) {
        case 'team-plan-approve':
          outcome = await plans.approve(caller, {
            planId: message.planId, revision: message.revision, contentHash: message.contentHash,
            expectedApprovedRevision: message.expectedApprovedRevision, commandId: message.commandId,
          })
          break
        case 'team-plan-withdraw':
          outcome = await plans.withdraw(caller, {
            planId: message.planId, commandId: message.commandId,
            ...(message.revision !== undefined ? { revision: message.revision } : {}),
            ...(message.draftId !== undefined ? { draftId: message.draftId } : {}),
          })
          break
        case 'team-plan-close':
          outcome = await plans.close(caller, { planId: message.planId, outcome: message.outcome, reason: message.reason ?? null, commandId: message.commandId })
          break
        case 'team-plan-reopen':
          outcome = await plans.reopen(caller, { planId: message.planId, commandId: message.commandId })
          break
      }
      if (!outcome.ok) {
        answer({ error: outcome.message, reason: outcome.reason, ...(outcome.failures ? { failures: outcome.failures } : {}) })
        return
      }
      answer({ plan: outcome.plan, event: outcome.event, replayed: outcome.replayed })
    } catch (error) {
      answer({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
