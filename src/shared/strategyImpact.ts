// SDK-free strategy impact model (strategy-revision-impact design D2/D3)
// shared by server and client. A strategy approval creates one impact-review
// row; everything this change adds on top is either a recorded fact (owner
// decisions, agent proposals, assessment requests) or derived here at read
// time and never stored: the plan groups, every plan revision's gate, and the
// review's state. One gate function serves every plan gate — plan approval
// now, the Plans view's badge, and the later validation and Start gates — so
// they can never disagree (contract C-I1).
import type { PlanLifecycle, PlanRevisionStatus, PlanStrategyPin } from './plans'
import { samePin } from './plans'
import type { StrategyRevisionStatus } from './productStrategy'

export type ImpactDisposition = 'continue' | 'adapt' | 'reconsider'
export const IMPACT_DISPOSITIONS: readonly ImpactDisposition[] = ['continue', 'adapt', 'reconsider']

export type ImpactGateState = 'current' | 'continue' | 'decision-required' | 'adapt' | 'reconsider' | 'withdrawn-direction'
export type ImpactGroup = 'affected' | 'unaffected' | 'historical'
export type ImpactReviewState = 'needs-decisions' | 'reviewed' | 'superseded' | 'withdrawn'

/** The owner's words are the record: longer text is refused, never cut (D4 step 4). */
export const IMPACT_RATIONALE_MAX = 2000

export interface ImpactGate {
  state: ImpactGateState
  /** True only for `current` and `continue`. */
  pass: boolean
  /** The current review, when a decision state applies. */
  reviewId: string | null
  /** The effective decision the state rests on. */
  decisionId: string | null
  pin: PlanStrategyPin | null
}

/** What the gate reads of the team's strategy record. */
export interface ImpactStrategyView {
  id: string
  currentApprovedRevision: number | null
  revisions: ReadonlyArray<{ revision: number; status: StrategyRevisionStatus; contentHash: string }>
}

/** The team's current approved pin; null without a record or an approved revision. */
export function currentStrategyPin(strategy: ImpactStrategyView | null): PlanStrategyPin | null {
  if (!strategy || strategy.currentApprovedRevision === null) return null
  const approved = strategy.revisions.find(entry => entry.revision === strategy.currentApprovedRevision)
  return approved ? { strategyId: strategy.id, revision: approved.revision, hash: approved.contentHash } : null
}

/** Whether a pin names a superseded revision of this record with that revision's stored hash (D2 rule 2). */
function namesSupersededDirection(pin: PlanStrategyPin, strategy: ImpactStrategyView): boolean {
  if (pin.strategyId !== strategy.id) return false
  const named = strategy.revisions.find(entry => entry.revision === pin.revision)
  return named?.status === 'superseded' && named.contentHash === pin.hash
}

/**
 * The impact gate (D2), its rules in order:
 * 1. the pin equals the current approved `{strategyId, revision, hash}` as a
 *    whole (both empty while none is approved) → `current`;
 * 2. a non-empty pin while no revision is approved, or one that does not name
 *    a superseded revision of this record with its stored hash →
 *    `withdrawn-direction`, whatever decision exists;
 * 3. otherwise (an older pin, or empty while a revision is approved) the
 *    effective decision of the current review decides; none → `decision-required`.
 */
export function impactGate(
  pin: PlanStrategyPin | null,
  strategy: ImpactStrategyView | null,
  currentReview: { id: string } | null,
  effectiveDecision: { id: string; disposition: ImpactDisposition } | null,
): ImpactGate {
  const gate = (state: ImpactGateState, reviewId: string | null = null, decisionId: string | null = null): ImpactGate =>
    ({ state, pass: state === 'current' || state === 'continue', reviewId, decisionId, pin })
  if (samePin(pin, currentStrategyPin(strategy))) return gate('current')
  if (pin && (!strategy || strategy.currentApprovedRevision === null || !namesSupersededDirection(pin, strategy))) {
    return gate('withdrawn-direction')
  }
  const reviewId = currentReview?.id ?? null
  if (!reviewId || !effectiveDecision) return gate('decision-required', reviewId)
  return gate(effectiveDecision.disposition, reviewId, effectiveDecision.id)
}

/** D2: closed plans are historical; an open plan with a standing revision that is not current is affected. */
export function impactGroup(
  plan: { lifecycle: PlanLifecycle },
  revisions: ReadonlyArray<{ status: PlanRevisionStatus; pin: PlanStrategyPin | null }>,
  strategy: ImpactStrategyView | null,
): ImpactGroup {
  if (plan.lifecycle !== 'open') return 'historical'
  const current = currentStrategyPin(strategy)
  const standing = revisions.filter(entry => entry.status === 'approved' || entry.status === 'in_review')
  return standing.some(entry => !samePin(entry.pin, current)) ? 'affected' : 'unaffected'
}

/** D2: a current review needs decisions until every affected plan has one; others take their revision's status. */
export function reviewState(
  review: { revision: number },
  strategy: ImpactStrategyView,
  affectedRows: ReadonlyArray<{ effectiveDecision: unknown | null }>,
): ImpactReviewState {
  if (review.revision === strategy.currentApprovedRevision) {
    return affectedRows.some(row => row.effectiveDecision === null) ? 'needs-decisions' : 'reviewed'
  }
  const status = strategy.revisions.find(entry => entry.revision === review.revision)?.status
  return status === 'withdrawn' ? 'withdrawn' : 'superseded'
}

/** A rationale's refusal message, or null when it is acceptable (D4 step 4). */
export function impactRationaleError(rationale: string): string | null {
  if (!rationale.trim()) return 'A rationale is required: say why this plan should continue, adapt, or be reconsidered.'
  if (rationale.trim().length > IMPACT_RATIONALE_MAX) {
    return `The rationale is ${rationale.trim().length} characters; at most ${IMPACT_RATIONALE_MAX} are accepted. Shorten it — it is never cut.`
  }
  return null
}

/** A plan revision as a decision snapshot records it: the non-current revisions it rests on. */
export interface ImpactRevisionPin {
  revision: number
  status: PlanRevisionStatus
  pin: PlanStrategyPin | null
}

/** An owner decision (D1/D4): human-only, append-only; a later one supersedes it through the chain. */
export interface ImpactDecision {
  id: string
  reviewId: string
  planId: string
  disposition: ImpactDisposition
  rationale: string
  /** The proposal the owner recorded, if any. */
  proposalId: string | null
  /** The effective decision it replaced; null for the first. */
  supersedesDecisionId: string | null
  /** The plan's non-current revisions and pins at decision time. */
  planSnapshot: ImpactRevisionPin[]
  actor: { kind: 'human'; sessionId: null }
  commandId: string
  createdAt: string
}

/** An agent's proposal (D5): kept with its author and time, and never a gate input. */
export interface ImpactProposal {
  id: string
  reviewId: string
  planId: string
  disposition: ImpactDisposition
  rationale: string
  author: { kind: 'agent'; sessionId: string }
  createdAt: string
}

/** One assessment request (D8): the human message it sent. */
export interface ImpactRequest {
  id: string
  reviewId: string
  targetGroup: string
  messageId: string
  commandId: string
  createdAt: string
}

/** One plan in the current review's assessment (D3). */
export interface ImpactPlanRow {
  planId: string
  title: string
  lifecycle: PlanLifecycle
  /** The plan's approved and in-review revisions, oldest first. */
  revisions: Array<ImpactRevisionPin & { gate: ImpactGate; unassessed: boolean }>
  effectiveDecision: ImpactDecision | null
  /** Every decision for the plan in this review, oldest first; all but the effective one are superseded. */
  decisionHistory: ImpactDecision[]
  latestProposal: ImpactProposal | null
  proposalCount: number
}

/** One review with its records and derived state; earlier reviews show only these. */
export interface ImpactReviewRecord {
  reviewId: string
  revision: number
  contentHash: string
  createdAt: string
  state: ImpactReviewState
  /** Oldest first. */
  decisions: ImpactDecision[]
  proposals: ImpactProposal[]
  requests: ImpactRequest[]
}

/** The strategy's impact detail (D3): only the current review carries an assessment. */
export interface StrategyImpactDetail {
  currentReviewId: string | null
  /** Newest first. */
  reviews: ImpactReviewRecord[]
  assessment: { affected: ImpactPlanRow[]; unaffected: ImpactPlanRow[]; historical: ImpactPlanRow[] } | null
}

/** A plan's impact as the Plans view shows it (D6): the badge gate, and one gate per standing revision. */
export interface PlanImpact {
  group: ImpactGroup
  /** The approved revision's gate, else the newest in-review revision's; null without either. */
  gate: ImpactGate | null
  /** The current review and its strategy revision, for the link; null when none exists. */
  reviewId: string | null
  reviewRevision: number | null
  revisions: Array<{ revision: number; gate: ImpactGate }>
}

export const IMPACT_DISPOSITION_LABELS: Record<ImpactDisposition, string> = {
  continue: 'Continue',
  adapt: 'Adapt',
  reconsider: 'Reconsider',
}

export const IMPACT_DISPOSITION_HINTS: Record<ImpactDisposition, string> = {
  continue: 'Keep the plan on its older pin; its existing revisions pass.',
  adapt: 'The plan proceeds only through a new revision pinned to the current strategy.',
  reconsider: 'Keep its existing revisions refused until you decide again.',
}

export const IMPACT_GATE_LABELS: Record<ImpactGateState, string> = {
  current: 'Current',
  continue: 'Continues on its pin',
  'decision-required': 'Decision required',
  adapt: 'Adapt',
  reconsider: 'Reconsider',
  'withdrawn-direction': 'Withdrawn direction',
}

export const IMPACT_GROUP_LABELS: Record<ImpactGroup, string> = {
  affected: 'Affected',
  unaffected: 'Unaffected',
  historical: 'Historical',
}

export const IMPACT_REVIEW_STATE_LABELS: Record<ImpactReviewState, string> = {
  'needs-decisions': 'Needs decisions',
  reviewed: 'Reviewed',
  superseded: 'Superseded',
  withdrawn: 'Withdrawn',
}
