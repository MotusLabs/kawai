// The assessment request's message body (strategy-revision-impact design D8
// step 4), built from the current assessment when the owner asks: the
// product and strategy revision, the review id, each affected plan with its
// revisions' pins, impact states, effective decision, and newest proposal,
// and the instruction to propose one disposition per plan. It says plainly
// that only the owner records decisions, so no reader takes it as one.
import type { PlanStrategyPin } from '../../shared/plans'
import type { StrategyImpactReview } from '../../shared/productStrategy'
import type { ImpactPlanRow } from '../../shared/strategyImpact'
import { IMPACT_GATE_LABELS } from '../../shared/strategyImpact'
import type { ImpactContext } from './impactAssessment'

const pinText = (pin: PlanStrategyPin | null, strategyId: string): string => {
  if (!pin) return 'no strategy pin (unassessed)'
  return pin.strategyId === strategyId ? `strategy revision ${pin.revision}` : `revision ${pin.revision} of another strategy record`
}

function planLines(row: ImpactPlanRow, strategyId: string): string[] {
  const decision = row.effectiveDecision
    ? `${row.effectiveDecision.disposition} (${row.effectiveDecision.id}): ${row.effectiveDecision.rationale}`
    : 'none recorded'
  const proposal = row.latestProposal
    ? `${row.latestProposal.disposition} by ${row.latestProposal.author.sessionId} (${row.proposalCount} in total): ${row.latestProposal.rationale}`
    : 'none'
  return [
    `- ${row.title} (plan_id ${row.planId})`,
    ...row.revisions.map(revision =>
      `  - revision ${revision.revision} (${revision.status === 'in_review' ? 'in review' : revision.status}): ${pinText(revision.pin, strategyId)} — ${IMPACT_GATE_LABELS[revision.gate.state]}`),
    `  - effective decision: ${decision}`,
    `  - newest proposal: ${proposal}`,
  ]
}

export function assessmentRequestBody(context: ImpactContext, review: StrategyImpactReview, affected: ImpactPlanRow[]): string {
  const { strategy } = context
  return [
    `Please assess the strategy impact review for ${strategy.title} (${strategy.productId}): strategy revision ${review.revision} is now the approved direction.`,
    `Review id: ${review.id}`,
    '',
    affected.length > 0 ? `Affected plans (${affected.length}):` : 'No plan is affected right now.',
    ...affected.flatMap(row => planLines(row, strategy.id)),
    '',
    `For each affected plan, compare what changed between its pinned strategy revision and revision ${review.revision} (strategy_get, plan_get, strategy_impact_get), then propose one disposition with strategy_impact_propose — continue, adapt, or reconsider — with a rationale grounded in that change.`,
    'Only the owner records decisions, in the Strategy view; a proposal changes nothing until they do.',
  ].join('\n')
}
