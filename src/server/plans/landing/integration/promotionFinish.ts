// The one way a promotion finishes (integration-candidates D10 step 10 and
// its failure rule): in one transaction it cancels the promotion's pending
// effects, releases the landing slot if the promotion holds it, finishes the
// row with its outcome and detail, queues `close-pr` when a pull request was
// opened and the promotion did not merge, and records `promotion-finished`
// through `PlanService.recordPromotionEvent` under `promo:<id>:finish`, so
// the event is written exactly once whoever finishes it — the runner, a
// Cancel, or a restart repeating the step.
import type { PromotionOutcome } from '../../../../shared/planIntegration'
import type { ExecutionStore } from '../../execution/executionStore'
import { PlanRefusal } from '../../planCommands'
import type { PlanService } from '../../PlanService'
import type { IntegrationStore, PromotionRow } from './integrationStore'

export const PROMOTION_HOLDER_KIND = 'promotion'

export interface PromotionCore {
  integration: IntegrationStore
  executions: ExecutionStore
  plans: PlanService
  /** origin as owner/repo for the team (the effects' `repo`). */
  repoOf: (teamId: string) => string
}

/** The comment a closed promotion pull request carries. */
function closeComment(promotion: PromotionRow, outcome: PromotionOutcome, detail: Record<string, unknown> | null): string {
  const why = typeof detail?.message === 'string' ? ` ${detail.message}` : ''
  return `Kawai closed this pull request: promotion ${promotion.number} of ${promotion.branch} finished as ${outcome}.${why} The branch and this pull request are kept as evidence; nothing was merged.`
}

/**
 * Finish a running promotion. Returns false when it had already finished
 * (the finish replays, or another path finished it first) — never throws for
 * that, so a repeated step settles quietly.
 */
export function finishPromotion(core: PromotionCore, promotion: PromotionRow, outcome: PromotionOutcome, detail: Record<string, unknown> | null = null): boolean {
  const recorded = core.plans.recordPromotionEvent(promotion.planId, { kind: 'promotion-finished', promotionId: promotion.id, outcome }, () => {
    const fresh = core.integration.promotion(promotion.id)
    if (fresh === null || fresh.state !== 'running') throw new PlanRefusal('state', `Promotion ${promotion.number} has already finished.`)
    core.integration.cancelPromotionEffects(fresh.id)
    core.executions.releaseSlotFor(fresh.teamId, PROMOTION_HOLDER_KIND, fresh.id)
    core.integration.finishPromotion(fresh.id, outcome, detail)
    if (outcome !== 'merged' && fresh.prNumber !== null) {
      core.integration.insertEffect({
        promotionId: fresh.id, kind: 'close-pr', effectKey: `promo:${fresh.id}:close-pr`,
        command: { repo: core.repoOf(fresh.teamId), pr: fresh.prNumber, comment: closeComment(fresh, outcome, detail) },
      })
    }
    return true
  })
  return recorded.ok && !recorded.replayed
}
