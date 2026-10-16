// The Plans view's Validation section (plan-validation design D11): one
// entry per standing revision — the newest report, its standing computed
// now, the assessments, and the decisions. The standing's file reads make
// building it expensive, and linked-task changes push the plan detail often,
// so `ValidationDetailCache` coalesces to one build per plan every 2 s —
// busted the moment a validation row is written (the store's write stamp)
// or a plan write is announced (`invalidate`, from the plan push path), so a
// push after a validation, assessment, decision, submit, withdraw, or
// approve never shows a snapshot that predates the write. Each build carries
// a per-plan generation: a slower older build that resolves after a newer
// one started rejects as superseded, so its awaiter drops the stale send.
import type { PlanRevisionValidation, PlanValidationStanding } from '../../../shared/planValidation'
import type { ValidationStanding } from './validationStanding'

const COALESCE_MS = 2_000

/** What a view build reads: the service's own surface, structural so tests can stub it. */
export interface ValidationDetailViewSource {
  standingRevisions(planId: string): number[]
  prepareStanding(planId: string, revision: number): Promise<unknown>
  standing(prepared: unknown): ValidationStanding
  store: {
    newestReport(planId: string, revision: number): PlanRevisionValidation['report']
    assessments(planId: string, revision: number): PlanRevisionValidation['assessments']
    decisions(planId: string, revision: number): PlanRevisionValidation['decisions']
  }
}

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
export async function buildValidationDetail(service: ValidationDetailViewSource, planId: string): Promise<PlanRevisionValidation[]> {
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

/** A build that resolved after a newer build started; its awaiter drops the send. */
export class SupersededBuild extends Error {
  override readonly name = 'SupersededBuild'
}

/**
 * Per-plan coalescing of the validation view (D11): at most one build every
 * 2 s, busted by any validation write (the store's stamp) or plan write
 * (`invalidate`), with stale builds rejected as superseded.
 */
export class ValidationDetailCache {
  private readonly entries = new Map<string, { at: number; stamp: number; value: Promise<PlanRevisionValidation[]> }>()
  private readonly generations = new Map<string, number>()

  constructor(private readonly service: ValidationDetailViewSource & { store: { writeStamp: number } }, private readonly now: () => number = Date.now) {}

  /** The plan's validation view, rebuilding at most every 2 s unless a validation or plan write busted it. */
  detail(planId: string): Promise<PlanRevisionValidation[]> {
    const cached = this.entries.get(planId)
    const stamp = this.service.store.writeStamp
    if (cached && cached.stamp === stamp && this.now() - cached.at < COALESCE_MS) return cached.value
    const value = this.build(planId)
    this.entries.set(planId, { at: this.now(), stamp, value })
    return value
  }

  /**
   * A plan write was announced (submit, withdraw, approve — anything that
   * changes which revisions stand): drop the entry, so the next detail build
   * reads fresh revisions. A named plan drops only its entry; no name drops
   * them all.
   */
  invalidate(planId?: string): void {
    if (planId === undefined) {
      for (const plan of this.entries.keys()) this.generations.set(plan, (this.generations.get(plan) ?? 0) + 1)
      this.entries.clear()
      return
    }
    this.generations.set(planId, (this.generations.get(planId) ?? 0) + 1)
    this.entries.delete(planId)
  }

  /** One generation-tagged build: a slower older build rejects as superseded instead of landing late. */
  private build(planId: string): Promise<PlanRevisionValidation[]> {
    const generation = (this.generations.get(planId) ?? 0) + 1
    this.generations.set(planId, generation)
    const value = buildValidationDetail(this.service, planId).then(result => {
      if (this.generations.get(planId) !== generation) throw new SupersededBuild(`a newer validation view for ${planId} started`)
      return result
    })
    // The stored promise may outlive its awaiter; keep an unawaited
    // supersession from surfacing as an unhandled rejection.
    value.catch(() => {})
    return value
  }
}
