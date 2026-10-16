// The Plans view's Validation section (plan-validation design D11): one
// entry per standing revision — the newest report, its standing computed
// now, the assessments, and the decisions. The standing's file reads make
// building it expensive, and linked-task changes push the plan detail often,
// so `ValidationDetailCache` coalesces to one build per plan every 2 s — and
// busts the cache the moment a validation row is written (the store's write
// stamp), so a push after a validation, assessment, or decision never shows
// a snapshot that predates the write.
import type { PlanRevisionValidation, PlanValidationStanding } from '../../../shared/planValidation'
import type { ValidationService } from './ValidationService'
import type { ValidationStanding } from './validationStanding'

const COALESCE_MS = 2_000

/** The lean standing the wire carries (D11): the report rides beside it, not inside. */
function viewStanding(standing: ValidationStanding): PlanValidationStanding {
  if (standing.state === 'not-validated') return { state: 'not-validated' }
  if (standing.state === 'blocked') return { state: 'blocked', reportSeq: standing.report.seq }
  if (standing.state === 'out-of-date') return { state: 'out-of-date', reportSeq: standing.report.seq, changedParts: standing.changedParts }
  return { state: 'current', reportSeq: standing.report.seq }
}

/**
 * One plan's validation view (D11): every `in_review` or `approved`
 * revision, oldest first, with the newest report, the standing computed now,
 * and the revision's assessments and decisions. Read-only.
 */
export async function buildValidationDetail(service: ValidationService, planId: string): Promise<PlanRevisionValidation[]> {
  const views: PlanRevisionValidation[] = []
  for (const revision of service.standingRevisions(planId)) {
    const prepared = await service.prepareStanding(planId, revision)
    const standing = prepared ? service.standing(prepared) : ({ state: 'not-validated' } as ValidationStanding)
    views.push({
      revision,
      standing: viewStanding(standing),
      report: service.store.newestReport(planId, revision),
      assessments: service.store.assessments(planId, revision),
      decisions: service.store.decisions(planId, revision),
    })
  }
  return views
}

/** Per-plan coalescing of the validation view (D11): at most one build every 2 s, busted by any validation write. */
export class ValidationDetailCache {
  private readonly entries = new Map<string, { at: number; stamp: number; value: Promise<PlanRevisionValidation[]> }>()

  constructor(private readonly service: ValidationService, private readonly now: () => number = Date.now) {}

  detail(planId: string): Promise<PlanRevisionValidation[]> {
    const cached = this.entries.get(planId)
    const stamp = this.service.store.writeStamp
    if (cached && cached.stamp === stamp && this.now() - cached.at < COALESCE_MS) return cached.value
    const value = buildValidationDetail(this.service, planId)
    this.entries.set(planId, { at: this.now(), stamp, value })
    return value
  }
}
