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
// have: no agent tool surface can approve, withdraw, finish, or reopen; a
// local process speaking the UI protocol is trusted like the browser.
import type { ClientMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'
import type { PlanCommandOutcome } from './planCommands'

type PlanClientMessage = Extract<ClientMessage, { type: `team-plan${string}` }>
type PlanCommandMessage = Extract<PlanClientMessage, { type: (typeof PLAN_COMMAND_TYPES)[number] }>
/** plan-validation D11's human actions (team-plan-result answers them too). */
type PlanValidationCommandMessage = Extract<PlanClientMessage, { type: (typeof VALIDATION_COMMAND_TYPES)[number] }>

/** The human plan lifecycle commands. */
const PLAN_COMMAND_TYPES = ['team-plan-approve', 'team-plan-withdraw', 'team-plan-finish', 'team-plan-reopen'] as const
/** The plan-validation human actions; every other plan type opens or closes a subscription. */
const VALIDATION_COMMAND_TYPES = ['team-plan-validate', 'team-plan-assess', 'team-plan-validation-decide'] as const
const isCommand = (message: PlanClientMessage): message is PlanCommandMessage =>
  (PLAN_COMMAND_TYPES as readonly string[]).includes(message.type)
const isValidationCommand = (message: PlanClientMessage): message is PlanValidationCommandMessage =>
  (VALIDATION_COMMAND_TYPES as readonly string[]).includes(message.type)

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
          // Fire and forget: pushes are a view refresh, and a build racing a
          // shutdown (the bench's closed database) must not surface anywhere.
          if (planId === undefined || id === planId) void this.sendDetail(connection, teamPath, subscription, id).catch(() => {})
        }
      }
    }
  }

  private sendList(connection: ChatConnection, teamPath: string, subscription: Subscription) {
    connection.send({
      type: 'team-plans-snapshot', teamPath, teamId: subscription.teamId, plans: this.manager.plans.store.list(subscription.teamId),
      impact: this.manager.impact.planImpacts(subscription.teamId),
    })
  }

  private async sendDetail(connection: ChatConnection, teamPath: string, subscription: Subscription, planId: string) {
    try {
      const detail = this.manager.plans.store.detail(planId)
      if (detail && detail.plan.teamId === subscription.teamId) {
        const impact = this.manager.impact.planImpact(subscription.teamId, planId)
        // plan-validation D11: the Validation section rides the detail, built
        // through the coalesced cache so bursts of task changes pay once.
        const validation = await this.manager.validationDetail.detail(planId)
        connection.send({
          type: 'team-plan-detail', teamPath, teamId: subscription.teamId, detail,
          ...(impact ? { impact } : {}), ...(validation.length > 0 ? { validation } : {}),
        })
      }
    } catch {
      // A view refresh that raced a shutdown or a vanished row is dropped.
    }
  }

  async handle(connection: ChatConnection, message: PlanClientMessage) {
    if (isCommand(message)) return this.act(connection, message)
    if (isValidationCommand(message)) return this.actValidation(connection, message)
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
      // The open's first detail is authoritative: awaited, not pushed.
      await this.sendDetail(connection, teamPath, subscription, planId)
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
        case 'team-plan-finish':
          outcome = await plans.close(caller, { planId: message.planId, outcome: message.outcome, reason: message.reason ?? null, commandId: message.commandId })
          break
        case 'team-plan-reopen':
          outcome = await plans.reopen(caller, { planId: message.planId, commandId: message.commandId })
          break
      }
      if (!outcome.ok) {
        // A pin refusal names its impact gate (strategy-revision-impact D6); the precondition message stays as shipped.
        const pinRefused = message.type === 'team-plan-approve' && outcome.failures?.some(failure => failure.name === 'strategy-pin-current')
        const impact = pinRefused ? this.manager.impact.gate(message.planId, message.revision) : null
        answer({ error: outcome.message, reason: outcome.reason, ...(outcome.failures ? { failures: outcome.failures } : {}), ...(impact ? { impact } : {}) })
        return
      }
      answer({ plan: outcome.plan, event: outcome.event, replayed: outcome.replayed })
      return
    } catch (error) {
      answer({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The plan-validation human actions (D11), answered by `team-plan-result` too. */
  private async actValidation(connection: ChatConnection, message: PlanValidationCommandMessage) {
    const { teamPath, requestId } = message
    const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-result', teamPath, requestId, ...payload })
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      answer({ error: unknownTeamError(teamPath) })
      return
    }
    const caller = { kind: 'human' as const, team }
    const validation = this.manager.validation
    try {
      switch (message.type) {
        case 'team-plan-validate': {
          const outcome = await validation.validate(caller, { planId: message.planId, revision: message.revision })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason })
            return
          }
          answer({ validation: { report: outcome.report, stored: outcome.stored, dryRun: outcome.dryRun } })
          return
        }
        case 'team-plan-assess': {
          const outcome = await validation.assess(caller, {
            plan_id: message.planId, revision: message.revision, alignment: message.alignment, command_id: message.commandId,
          })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason })
            return
          }
          answer({ assessment: { ids: outcome.ids, replayed: outcome.replayed } })
          return
        }
        case 'team-plan-validation-decide': {
          const outcome = await validation.decide(caller, {
            planId: message.planId, revision: message.revision, kind: message.kind, target: message.target,
            text: message.text, ...(message.scope !== undefined ? { scope: message.scope } : {}), commandId: message.commandId,
          })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason })
            return
          }
          answer({ replayed: outcome.replayed })
          return
        }
      }
    } catch (error) {
      answer({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
