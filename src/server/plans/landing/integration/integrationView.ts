// The integration branches of one plan as `plan_get` and the Plans view show
// them (integration-candidates D11–D13): each branch with its target, the head
// Kawai last recorded, the candidate chain newest first, the promotions newest
// first with their CI, and the promoted `seq`. Pure over stored rows — no git or gh call —
// so the agent tool, the detail push, and the client agree.
import { candidateChain, promotedThrough, referenceCommit, type PlanIntegrationView, type PromotionRecord, type PromotionView } from '../../../../shared/planIntegration'
import { flakyChecks } from '../../../../shared/planExecutionGates'
import type { CiCheck } from '../../../../shared/planExecution'
import type { IntegrationStore } from './integrationStore'

/** The internal fields a promotion row carries beyond the view (floor snapshot, timers) never leave the server; CI shows with its flaky names. */
function promotionView(row: PromotionRecord & { ci?: unknown }): PromotionView {
  const checks = Array.isArray(row.ci) ? row.ci as CiCheck[] : null
  return {
    id: row.id, teamId: row.teamId, planId: row.planId, branch: row.branch, number: row.number, commandId: row.commandId,
    fromSha: row.fromSha, throughSeq: row.throughSeq, targetBranch: row.targetBranch, promotionBranch: row.promotionBranch,
    prNumber: row.prNumber, prUrl: row.prUrl, headSha: row.headSha, step: row.step, moves: row.moves, state: row.state,
    outcome: row.outcome, outcomeDetail: row.outcomeDetail, mergeSha: row.mergeSha, treeVerified: row.treeVerified,
    fastForwarded: row.fastForwarded, fastForwardNote: row.fastForwardNote, cancelReason: row.cancelReason,
    startedAt: row.startedAt, finishedAt: row.finishedAt,
    ci: checks === null ? null : { checks, flaky: flakyChecks(checks) },
  }
}

/** The plan's integration branches in creation order; empty for a plan that never landed on one. */
export function integrationViews(store: IntegrationStore, planId: string): PlanIntegrationView[] {
  const promotions = store.promotionsOf(planId).map(promotionView)
  const through = promotedThrough(promotions)
  return store.branchesOfPlan(planId).map(branch => {
    const candidates = candidateChain(store.candidates(branch.teamId, branch.branch))
    return {
      branch: branch.branch,
      targetBranch: branch.targetBranch,
      // The head Kawai last wrote or recorded: the last landed candidate, else the creation commit (D4).
      head: referenceCommit(branch, candidates),
      createdSha: branch.createdSha,
      candidates,
      promotions: promotions.filter(promotion => promotion.branch === branch.branch).sort((a, b) => b.number - a.number),
      promotedThroughSeq: through.get(branch.branch) ?? 0,
    }
  })
}
