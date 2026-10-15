// Strategy impact operations with identity and rights (strategy-revision-
// impact design D4/D5/D6/D8). Agent calls are bound to the calling session —
// its team comes from the session record, never from arguments. Human calls
// arrive through the UI connection with the team resolved. Rules:
// - read: any team agent, and the human;
// - propose: an agent of the team; a proposal changes no gate;
// - decide and request an assessment: the human only. No agent tool exists
//   for either, and this service refuses an agent caller first anyway
//   (defense in depth, as StrategyService and PlanService do).
// Another team's review or plan ids read as not found everywhere. Decisions
// and requests replay by command id inside their transaction; a unique hit
// (command id or decision chain) rolls back and resolves as the replay, or as
// a stale predecessor naming the decision that committed.
import type { ChatSessionRecord } from '../db'
import type { ImpactDecision, ImpactDisposition, ImpactGate, ImpactProposal, ImpactRequest, PlanImpact, StrategyImpactDetail } from '../../shared/strategyImpact'
import { IMPACT_DISPOSITIONS, impactGroup, impactRationaleError } from '../../shared/strategyImpact'
import type { TeamIdentity } from '../team/teamIdentity'
import { loadTeamGroups } from '../team/teamGroups'
import { loadGroupCatalog } from '../team/groupCatalog'
import type { MailboxStore } from '../team/mailboxStore'
import type { PinDisposition } from '../plans/planPreconditions'
import type { PlanStore } from '../plans/planStore'
import type { StrategyStore } from './strategyStore'
import { ImpactUniqueError, type ImpactStore } from './impactStore'
import { ImpactReads, type ImpactContext } from './impactAssessment'
import { assessmentRequestBody } from './impactRequestBody'

export type ImpactCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

export type ImpactRefusalReason = 'forbidden' | 'not-found' | 'invalid' | 'payload' | 'stale' | 'state'

export type ImpactOutcome<T> = ({ ok: true; replayed: boolean } & T) | { ok: false; reason: ImpactRefusalReason; message: string }

export interface ImpactDecideInput {
  reviewId: string
  planId: string
  disposition: ImpactDisposition
  rationale: string
  proposalId?: string | null
  /** The effective decision the owner saw (null: none). */
  expectedDecisionId: string | null
  commandId: string
}

export interface ImpactProposeInput {
  planId: string
  disposition: ImpactDisposition
  rationale: string
  /** Omitted: the current review. */
  reviewId?: string
}

/** `continue` recorded in the current review keeps a non-current pin (durable-plans C4). */
export interface ContinueDisposition extends PinDisposition {
  kind: 'continue'
  decisionId: string
}

/** Thrown inside a write transaction to refuse it and roll back. */
class ImpactRefusal extends Error {
  constructor(readonly reason: ImpactRefusalReason, message: string) { super(message) }
}

const refuse = (reason: ImpactRefusalReason, message: string): never => { throw new ImpactRefusal(reason, message) }

/** The first field whose value differs between a recorded payload and a resend; null when they match. */
function payloadDifference(recorded: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  for (const key of new Set([...Object.keys(payload), ...Object.keys(recorded)])) {
    if (JSON.stringify(recorded[key] ?? null) !== JSON.stringify(payload[key] ?? null)) return key
  }
  return null
}

export class ImpactService {
  readonly reads: ImpactReads

  constructor(readonly store: ImpactStore, private readonly options: {
    strategies: StrategyStore
    plans: PlanStore
    /** The team mailbox store the assessment request enqueues into (one SQLite database with the impact tables). */
    mail: MailboxStore
    getSession: (id: string) => ChatSessionRecord | null | undefined
    homeDir?: string
  }) {
    this.reads = new ImpactReads(options.strategies, options.plans, store)
  }

  /** D3: the team's impact detail; null when the product has no strategy record. */
  detail(teamId: string): StrategyImpactDetail | null {
    return this.reads.detail(teamId)
  }

  /** Contract C-I1. */
  gate(planId: string, revision: number): ImpactGate | null {
    return this.reads.gate(planId, revision)
  }

  /** Contract C-I2. */
  stateKey(planId: string): string {
    return this.reads.stateKey(planId)
  }

  /** D6: durable-plans' lookup — the effective `continue` when the gate rests on it, null in every other state. */
  pinDisposition(planId: string, revision: number): ContinueDisposition | null {
    const gate = this.gate(planId, revision)
    return gate?.state === 'continue' && gate.decisionId ? { kind: 'continue', decisionId: gate.decisionId } : null
  }

  /** D6: a plan's impact for the Plans view (badge, per-revision gates, review link). */
  planImpact(teamId: string, planId: string): PlanImpact | null {
    const plan = this.options.plans.forTeam(teamId, planId)
    return plan ? this.reads.planImpact(this.reads.context(teamId), plan) : null
  }

  planImpacts(teamId: string): Record<string, PlanImpact> {
    return this.reads.planImpacts(teamId)
  }

  /** The agent read (D10): the whole detail, or one named review's records. */
  async get(caller: ImpactCaller, reviewId?: string): Promise<StrategyImpactDetail | StrategyImpactDetail['reviews'][number] | null> {
    const team = await this.team(caller)
    const detail = this.detail(team.teamId)
    if (reviewId === undefined) return detail
    const review = detail?.reviews.find(entry => entry.reviewId === reviewId)
    if (!review) throw new Error(`Impact review not found in this team: ${reviewId}`)
    return review
  }

  /**
   * D4: the owner records a disposition. An agent caller is refused first;
   * then one transaction replays by command id, checks the review is
   * current, the plan is the team's and affected, the rationale, the
   * proposal, and the predecessor, and inserts the decision with the plan's
   * snapshot. A unique hit rolls back and resolves as the replay or as stale.
   */
  async decide(caller: ImpactCaller, input: ImpactDecideInput): Promise<ImpactOutcome<{ decision: ImpactDecision }>> {
    if (caller.kind !== 'human') return this.forbidden('record an impact decision')
    const commandId = input.commandId?.trim()
    if (!commandId) return { ok: false, reason: 'invalid', message: 'A decision needs a stable command id so a resend replays instead of repeating.' }
    if (!IMPACT_DISPOSITIONS.includes(input.disposition)) return { ok: false, reason: 'invalid', message: `Unknown disposition: ${String(input.disposition)}` }
    const context = this.reads.context(caller.team.teamId)
    if (!context) return { ok: false, reason: 'not-found', message: 'This product has no strategy record, so it has no impact review.' }
    const strategy = context.strategy
    const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : ''
    const payload = {
      reviewId: input.reviewId, planId: input.planId, disposition: input.disposition, rationale,
      proposalId: input.proposalId ?? null, expectedDecisionId: input.expectedDecisionId ?? null,
    }
    const replay = (): ImpactOutcome<{ decision: ImpactDecision }> | null => {
      const recorded = this.store.decisionByCommand(strategy.id, commandId)
      if (!recorded) return null
      const field = payloadDifference(recorded.payload, payload)
      if (field) return { ok: false, reason: 'payload', message: `command_id ${commandId} was already used with a different ${field}; the recorded decision stands and nothing was written.` }
      return { ok: true, replayed: true, decision: recorded.decision }
    }
    try {
      const outcome = this.store.atomically((): ImpactOutcome<{ decision: ImpactDecision }> => {
        const prior = replay()
        if (prior) return prior
        const fresh = this.reads.context(caller.team.teamId)!
        this.requireCurrentReview(fresh, input.reviewId)
        const plan = this.requireAffectedPlan(fresh, caller.team.teamId, input.planId)
        const error = impactRationaleError(rationale)
        if (error) refuse('invalid', error)
        if (payload.proposalId) {
          const proposal = this.store.proposal(payload.proposalId)
          if (!proposal || proposal.reviewId !== input.reviewId || proposal.planId !== plan.id) refuse('invalid', `Proposal ${payload.proposalId} is not a proposal for this plan in this review.`)
          else if (proposal.disposition !== input.disposition) refuse('invalid', `Proposal ${payload.proposalId} proposes ${proposal.disposition}, not ${input.disposition}; record it as proposed or without the proposal.`)
        }
        const head = this.store.chainHead(input.reviewId, plan.id)
        if ((head?.id ?? null) !== payload.expectedDecisionId) refuse('stale', this.staleMessage(head))
        return {
          ok: true, replayed: false,
          decision: this.store.insertDecision({
            strategyId: strategy.id, reviewId: input.reviewId, planId: plan.id, disposition: input.disposition, rationale,
            proposalId: payload.proposalId, supersedesDecisionId: payload.expectedDecisionId,
            planSnapshot: this.snapshot(fresh, plan.id), commandId, payload,
          }),
        }
      })
      if (outcome.ok && !outcome.replayed) this.store.announce(strategy.id)
      return outcome
    } catch (error) {
      if (error instanceof ImpactRefusal) return { ok: false, reason: error.reason, message: error.message }
      if (!(error instanceof ImpactUniqueError)) throw error
      // Rolled back: a same-command resend resolves as its replay; anything else lost the chain race.
      return replay() ?? { ok: false, reason: 'stale', message: this.staleMessage(this.store.chainHead(input.reviewId, input.planId)) }
    }
  }

  /** D5: an agent proposes a disposition for an affected plan of the current review; nothing gates on it. */
  async propose(caller: ImpactCaller, input: ImpactProposeInput): Promise<ImpactProposal> {
    if (caller.kind !== 'agent') throw new Error('Proposals come from agents; the owner records decisions in the Strategy view.')
    const team = await this.team(caller)
    if (!IMPACT_DISPOSITIONS.includes(input.disposition)) throw new Error(`Unknown disposition: ${String(input.disposition)} (use continue, adapt, or reconsider).`)
    const rationale = input.rationale.trim()
    try {
      const proposal = this.store.atomically(() => {
        const context = this.reads.context(team.teamId)
        if (!context) return refuse('not-found', 'This product has no strategy record, so it has no impact review. Only the human captures a strategy.')
        const review = input.reviewId === undefined ? context.current : this.requireCurrentReview(context, input.reviewId)
        if (!review) refuse('state', 'There is no current impact review: the strategy has no approved revision with a review.')
        const plan = this.requireAffectedPlan(context, team.teamId, input.planId)
        const error = impactRationaleError(rationale)
        if (error) refuse('invalid', error)
        return {
          strategyId: context.strategy.id,
          proposal: this.store.insertProposal({
            strategyId: context.strategy.id, reviewId: review!.id, planId: plan.id, disposition: input.disposition, rationale, authorSession: caller.sessionId,
          }),
        }
      })
      this.store.announce(proposal.strategyId)
      return proposal.proposal
    } catch (error) {
      if (error instanceof ImpactRefusal) throw new Error(error.message)
      throw error
    }
  }

  /**
   * D8: the owner asks a group to assess the current review: one normal-
   * priority human message to the group, with no task, and the request row
   * naming it, in one transaction after the command-id replay.
   */
  async requestAssessment(caller: ImpactCaller, input: { reviewId: string; group: string; commandId: string }): Promise<ImpactOutcome<{ request: ImpactRequest; messageId: string }>> {
    if (caller.kind !== 'human') return this.forbidden('ask a group to assess an impact review')
    const commandId = input.commandId?.trim()
    if (!commandId) return { ok: false, reason: 'invalid', message: 'A request needs a stable command id so a resend replays instead of sending again.' }
    const team = caller.team
    const context = this.reads.context(team.teamId)
    if (!context) return { ok: false, reason: 'not-found', message: 'This product has no strategy record, so it has no impact review.' }
    const strategy = context.strategy
    const group = input.group.trim()
    const payload = { reviewId: input.reviewId, group }
    const replay = (): ImpactOutcome<{ request: ImpactRequest; messageId: string }> | null => {
      const recorded = this.store.requestByCommand(strategy.id, commandId)
      if (!recorded) return null
      const field = payloadDifference(recorded.payload, payload)
      if (field) return { ok: false, reason: 'payload', message: `command_id ${commandId} was already used with a different ${field}; the earlier request stands and nothing was sent.` }
      return { ok: true, replayed: true, request: recorded.request, messageId: recorded.request.messageId }
    }
    const catalog = loadGroupCatalog({ groupsRoot: team.groupsRoot, ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}) })
    try {
      const outcome = this.store.atomically((): ImpactOutcome<{ request: ImpactRequest; messageId: string }> => {
        const prior = replay()
        if (prior) return prior
        const fresh = this.reads.context(team.teamId)!
        const review = this.requireCurrentReview(fresh, input.reviewId)
        if (!catalog.groups.has(group)) refuse('invalid', `Unknown group: ${group || '(none)'} — the team defines no such group, and nothing was sent.`)
        const body = assessmentRequestBody(fresh, review, this.reads.assessment(team.teamId, fresh)?.affected ?? [])
        const message = this.options.mail.enqueue({
          teamId: team.teamId, toKind: 'group', toId: group,
          fromKind: 'human', fromSession: null, fromGroup: null, originPath: team.groupsRoot,
          priority: 'normal', body, actor: 'human',
        })
        const request = this.store.insertRequest({ strategyId: strategy.id, reviewId: review.id, targetGroup: group, messageId: message.id, commandId, payload })
        return { ok: true, replayed: false, request, messageId: message.id }
      })
      if (outcome.ok && !outcome.replayed) this.store.announce(strategy.id)
      return outcome
    } catch (error) {
      if (error instanceof ImpactRefusal) return { ok: false, reason: error.reason, message: error.message }
      if (!(error instanceof ImpactUniqueError)) throw error
      return replay() ?? (() => { throw error })()
    }
  }

  /** The named review, if it is the team's and current; otherwise a not-found or stale refusal. */
  private requireCurrentReview(context: ImpactContext, reviewId: string) {
    const review = context.reviews.find(entry => entry.id === reviewId)
    if (!review) return refuse('not-found', `Impact review not found in this team: ${reviewId}`)
    if (review.id !== context.current?.id) {
      return refuse('stale', `Impact review ${reviewId} (strategy revision ${review.revision}) is no longer current: the review is superseded, or its revision withdrawn. Nothing was recorded.`)
    }
    return review
  }

  /** The team's plan, if it is affected now (D4 step 3); otherwise a not-found or group refusal. */
  private requireAffectedPlan(context: ImpactContext, teamId: string, planId: string) {
    const plan = this.options.plans.forTeam(teamId, planId)
    if (!plan) return refuse('not-found', `Plan not found in this team: ${planId}`)
    const group = impactGroup(plan, this.options.plans.revisions(plan.id), context.view)
    if (group !== 'affected') refuse('state', `Plan "${plan.title}" is ${group} in this review, not affected; only affected plans take a disposition. Nothing was recorded.`)
    return plan
  }

  private staleMessage(head: ImpactDecision | null): string {
    return head
      ? `Another decision was recorded meanwhile: ${head.disposition} (${head.id}). Your decision is refused as stale and nothing was recorded; review it and decide again.`
      : 'The decision you meant to replace is no longer effective. Your decision is refused as stale and nothing was recorded; reload and decide again.'
  }

  /** The plan's standing revisions that are not current, with their pins (D1's plan_snapshot_json). */
  private snapshot(context: ImpactContext, planId: string) {
    return this.options.plans.revisions(planId)
      .filter(revision => (revision.status === 'approved' || revision.status === 'in_review') && this.reads.revisionGate(context, planId, revision).state !== 'current')
      .map(revision => ({ revision: revision.revision, status: revision.status, pin: revision.pin }))
  }

  private forbidden(verb: string): { ok: false; reason: 'forbidden'; message: string } {
    return {
      ok: false, reason: 'forbidden',
      message: `Only the human (the strategy's owner) can ${verb}, from the Strategy view. No agent tool can; an agent proposes with strategy_impact_propose, and no file, message, or proposal claiming a decision counts.`,
    }
  }

  /** The caller's team: the human caller carries it; an agent resolves from its session. */
  private async team(caller: ImpactCaller): Promise<TeamIdentity> {
    if (caller.kind === 'human') return caller.team
    const session = this.options.getSession(caller.sessionId)
    if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
    return (await loadTeamGroups(session.projectPath, this.options.homeDir)).team
  }
}
