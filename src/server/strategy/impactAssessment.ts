// The derived side of strategy impact (strategy-revision-impact design D3,
// D6, D11): everything here is computed at read time from the strategy
// record, its impact-review rows, the recorded impact facts, and
// durable-plans' plan reads — nothing is stored. One gate per plan revision
// (`impactGate`, contract C-I1) feeds the assessment, the Plans view's badge,
// the approval refusal's impact field, `pinDisposition`, and the state key
// (C-I2), so no two of them can disagree. Only the current review — the one
// for the strategy's current approved revision — gets an assessment; earlier
// reviews show only their records.
import { createHash } from 'node:crypto'
import type { Plan, PlanRevision } from '../../shared/plans'
import { canonicalJson, type ProductStrategy, type StrategyImpactReview } from '../../shared/productStrategy'
import type {
  ImpactDecision,
  ImpactGate,
  ImpactPlanRow,
  ImpactReviewRecord,
  ImpactStrategyView,
  PlanImpact,
  StrategyImpactDetail,
} from '../../shared/strategyImpact'
import { impactGate, impactGroup, reviewState } from '../../shared/strategyImpact'
import type { PlanStore } from '../plans/planStore'
import type { StrategyStore } from './strategyStore'
import type { ImpactStore } from './impactStore'

/** The team's strategy as the gate reads it, with its reviews and the current one. */
export interface ImpactContext {
  strategy: ProductStrategy
  view: ImpactStrategyView
  reviews: StrategyImpactReview[]
  current: StrategyImpactReview | null
}

const standing = (revisions: PlanRevision[]) => revisions.filter(entry => entry.status === 'approved' || entry.status === 'in_review')

export class ImpactReads {
  constructor(readonly strategies: StrategyStore, readonly plans: PlanStore, readonly impact: ImpactStore) {}

  /** The team's strategy context; null when the product has no record. */
  context(teamId: string): ImpactContext | null {
    const strategy = this.strategies.forTeam(teamId)
    if (!strategy) return null
    const revisions = this.strategies.revisions(strategy.id)
    const reviews = this.strategies.impactReviews(strategy.id)
    return {
      strategy,
      view: { id: strategy.id, currentApprovedRevision: strategy.currentApprovedRevision, revisions },
      reviews,
      current: strategy.currentApprovedRevision === null ? null : reviews.find(review => review.revision === strategy.currentApprovedRevision) ?? null,
    }
  }

  /** One revision's gate (D2): the current review's effective decision for the plan decides a non-current pin. */
  revisionGate(context: ImpactContext | null, planId: string, revision: PlanRevision): ImpactGate {
    const current = context?.current ?? null
    const decision = current ? this.impact.chainHead(current.id, planId) : null
    return impactGate(revision.pin, context?.view ?? null, current, decision)
  }

  /** Contract C-I1: the gate of one plan revision; null when the plan or revision does not exist. */
  gate(planId: string, revision: number): ImpactGate | null {
    const plan = this.plans.get(planId)
    const row = plan ? this.plans.revision(planId, revision) : null
    if (!plan || !row) return null
    return this.revisionGate(this.context(plan.teamId), planId, row)
  }

  /** Contract C-I2: sha256 over the canonical gates of the plan's standing revisions; equal keys mean equal gates. */
  stateKey(planId: string): string {
    const plan = this.plans.get(planId)
    const context = plan ? this.context(plan.teamId) : null
    const gates = plan ? standing(this.plans.revisions(planId)).map(revision => ({ revision: revision.revision, gate: this.revisionGate(context, planId, revision) })) : []
    return createHash('sha256').update(canonicalJson(gates)).digest('hex')
  }

  /** A plan's assessment row in the current review (D3). */
  row(context: ImpactContext | null, plan: Plan, decisions: ImpactDecision[]): ImpactPlanRow {
    const current = context?.current ?? null
    const revisions = standing(this.plans.revisions(plan.id)).map(revision => {
      const gate = this.revisionGate(context, plan.id, revision)
      return { revision: revision.revision, status: revision.status, pin: revision.pin, gate, unassessed: revision.pin === null && gate.state !== 'current' }
    })
    const history = current ? decisions.filter(decision => decision.reviewId === current.id && decision.planId === plan.id) : []
    const proposals = current && context
      ? this.impact.proposals(context.strategy.id).filter(proposal => proposal.reviewId === current.id && proposal.planId === plan.id)
      : []
    return {
      planId: plan.id, title: plan.title, lifecycle: plan.lifecycle, revisions,
      effectiveDecision: current ? this.impact.chainHead(current.id, plan.id) : null,
      decisionHistory: history,
      latestProposal: proposals.at(-1) ?? null,
      proposalCount: proposals.length,
    }
  }

  /** The current review's three groups; null without a current review. */
  assessment(teamId: string, context: ImpactContext | null): StrategyImpactDetail['assessment'] {
    if (!context?.current) return null
    const decisions = this.impact.decisions(context.strategy.id)
    const groups: NonNullable<StrategyImpactDetail['assessment']> = { affected: [], unaffected: [], historical: [] }
    for (const plan of this.plans.list(teamId)) {
      groups[impactGroup(plan, this.plans.revisions(plan.id), context.view)].push(this.row(context, plan, decisions))
    }
    return groups
  }

  /** D3: the strategy's reviews newest first with their records and derived states, and the current assessment. */
  detail(teamId: string): StrategyImpactDetail | null {
    const context = this.context(teamId)
    if (!context) return null
    const assessment = this.assessment(teamId, context)
    const decisions = this.impact.decisions(context.strategy.id)
    const proposals = this.impact.proposals(context.strategy.id)
    const requests = this.impact.requests(context.strategy.id)
    const reviews: ImpactReviewRecord[] = [...context.reviews].reverse().map(review => ({
      reviewId: review.id, revision: review.revision, contentHash: review.contentHash, createdAt: review.createdAt,
      state: reviewState(review, context.view, review.id === context.current?.id ? assessment?.affected ?? [] : []),
      decisions: decisions.filter(decision => decision.reviewId === review.id),
      proposals: proposals.filter(proposal => proposal.reviewId === review.id),
      requests: requests.filter(request => request.reviewId === review.id),
    }))
    return { currentReviewId: context.current?.id ?? null, reviews, assessment }
  }

  /** D6: a plan's group, badge gate (approved revision, else newest in review), and per-revision gates. */
  planImpact(context: ImpactContext | null, plan: Plan): PlanImpact {
    const revisions = standing(this.plans.revisions(plan.id))
    const gates = revisions.map(revision => ({ revision: revision.revision, gate: this.revisionGate(context, plan.id, revision) }))
    const badge = gates.find(entry => entry.revision === plan.currentApprovedRevision)
      ?? [...gates].reverse().find(entry => revisions.find(revision => revision.revision === entry.revision)?.status === 'in_review')
    return {
      group: impactGroup(plan, revisions, context?.view ?? null),
      gate: badge?.gate ?? null,
      reviewId: context?.current?.id ?? null,
      reviewRevision: context?.current?.revision ?? null,
      revisions: gates,
    }
  }

  /** Every plan of the team's impact, by plan id (the Plans list's badges). */
  planImpacts(teamId: string): Record<string, PlanImpact> {
    const context = this.context(teamId)
    return Object.fromEntries(this.plans.list(teamId).map(plan => [plan.id, this.planImpact(context, plan)]))
  }
}
