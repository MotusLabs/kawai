// Correction tasks for failed promotions (plan-supervision design D8): which
// stored promotion outcomes get one, and the task's title and direction —
// the promotion, its pull request (already closed by Kawai), its failure
// detail (the conflicting files, or the failing checks with their links), and
// the instruction to resolve the cause through the plan with a change naming
// the task in `fixes`. Pure text; `fixTasks.ts` creates and dispatches it.
import type { CiCheck } from '../../../shared/planExecution'
import type { PromotionOutcome } from '../../../shared/planIntegration'
import type { Plan } from '../../../shared/plans'
import type { PromotionRow } from '../landing/integration/integrationStore'

/** integration-candidates' stored outcomes that get a correction; every other failure, and a cancel, gets none. */
export const CORRECTED_OUTCOMES: readonly PromotionOutcome[] = ['failed:promotion-conflict', 'failed:ci-failed']

export const CORRECTION_ACCEPTANCE = 'A change naming this task in `fixes` has landed and no change of the current approved revision naming it is unlanded, '
  + 'or a later promotion of the plan merged, and Kawai then closes this task; or the owner accepted a no-change result.'

const reasonOf = (outcome: PromotionOutcome | null): string => (outcome ?? '').replace(/^failed:/, '')

export function correctionTitle(promotion: Pick<PromotionRow, 'outcome'>, planTitle: string): string {
  return `Correct failed promotion: ${reasonOf(promotion.outcome)} — ${planTitle}`
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

/** The failing checks the outcome names, each with the newest link the promotion's stored CI holds for it. */
function checkLines(promotion: Pick<PromotionRow, 'outcomeDetail' | 'ci'>): string[] {
  const ci = Array.isArray(promotion.ci) ? (promotion.ci as CiCheck[]) : []
  return strings(promotion.outcomeDetail?.checks).map(name => {
    const link = ci.filter(check => check.name === name && check.link).at(-1)?.link
    return `- ${name}${link ? ` (${link})` : ''}`
  })
}

function evidence(promotion: Pick<PromotionRow, 'outcome' | 'outcomeDetail' | 'ci' | 'headSha'>): string[] {
  const detail = promotion.outcomeDetail ?? {}
  const lines = typeof detail.message === 'string' ? [`Failure: ${detail.message}`] : []
  if (promotion.outcome === 'failed:promotion-conflict') {
    const files = strings(detail.files)
    lines.push('Conflicting files:', ...(files.length ? files.map(file => `- ${file}`) : ['- not recorded']))
  } else {
    const head = typeof detail.head === 'string' ? detail.head : promotion.headSha
    const checks = checkLines(promotion)
    lines.push(`Failing checks${head ? ` on ${head}` : ''}:`, ...(checks.length ? checks : ['- not recorded']))
  }
  return lines
}

/** D8's direction; the instruction names `fixes: ["<taskId>"]`. */
export function correctionDirection(plan: Pick<Plan, 'id' | 'title'>, promotion: PromotionRow, taskId: string): string {
  const pr = promotion.prUrl ?? (promotion.prNumber !== null ? `#${promotion.prNumber}` : null)
  return [
    `Promotion ${promotion.number} (${promotion.id}) of plan "${plan.title}" (${plan.id}) from ${promotion.branch} into ${promotion.targetBranch} failed as ${reasonOf(promotion.outcome)}.`,
    pr ? `Pull request: ${pr}, closed by Kawai and kept as evidence.` : 'Pull request: none was opened.',
    ...evidence(promotion),
    '',
    `Resolve the cause on ${promotion.branch} through the plan: write or amend an OpenSpec change for it, add it to the plan's next revision with `
      + `\`fixes: ["${taskId}"]\`, and call plan_submit_for_review, as for a forward fix, so the owner can promote again. `
      + 'If nothing needs changing (a flaky check, say), submit a result saying so, and the owner accepts it.',
  ].join('\n')
}
