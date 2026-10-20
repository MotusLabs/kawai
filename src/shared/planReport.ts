// The "what stopped and why" report (plan-supervision design D12), pure and
// SDK-free, split from `planSupervision.ts` to keep both files small. It
// names `blockedDependents` (the transitive unlanded dependents of a change)
// and `planReport`: outcome counts (never a percentage), stopped changes with
// their reason label, evidence, blocked dependents, and next action; partial
// delivery as "Landed N of M" (never a claim that the success criteria hold);
// failed and superseded integration candidates beside their change (I1); a
// non-continue strategy impact disposition with its review (C-I3); and the
// M2 and M4 lines from `planDecisions.ts`.
import type { CandidateState, IntegrationCandidate } from './planIntegration'
import { fixDurations, overrideCounts, type DecisionCard, type FixDuration, type FixStatus, type PlanDecision } from './planDecisions'
import type { PlanContent } from './plans'
import type { ImpactDisposition } from './strategyImpact'
import { SUPERVISION_OUTCOMES, stopReasonLabel, type ChangeSupervision, type SupervisionOutcome } from './planSupervision'
import type { StopDetail } from './planExecution'

export const STOP_NEXT_ACTION = 'Retry or stop execution'

/** The unlanded changes that depend on `change`, directly or through other changes, in plan order. */
export function blockedDependents(content: Pick<PlanContent, 'changes'>, change: string, landed: ReadonlySet<string>): string[] {
  const blocked = new Set<string>()
  const queue = [change]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const entry of content.changes) {
      if (blocked.has(entry.change) || landed.has(entry.change) || !entry.dependsOn.includes(current)) continue
      blocked.add(entry.change)
      queue.push(entry.change)
    }
  }
  return content.changes.map(entry => entry.change).filter(name => blocked.has(name))
}

export interface ReportStop {
  change: string
  reason: string
  label: string
  detail: StopDetail | null
  evidence: ChangeSupervision['lastRound']
  blocked: string[]
  nextAction: typeof STOP_NEXT_ACTION
}

export interface PlanReport {
  counts: Record<SupervisionOutcome, number>
  total: number
  landed: number
  /** "Landed N of M" while any change is unlanded, else "All M changes landed". */
  delivery: string
  /** Unlanded changes that hold delivery back: stopped, stalled, or cancelled. */
  blockers: string[]
  stops: ReportStop[]
  /** Listed for the owner to judge; the report never claims them. */
  successCriteria: string[]
  candidates: Array<{ change: string; candidates: IntegrationCandidate[] }>
  disposition: { disposition: ImpactDisposition; reviewId: string; strategyRevision: number } | null
  overrides: { overridden: number; total: number; line: string }
  fixDurations: FixDuration[]
}

const SHOWN_CANDIDATES: ReadonlySet<CandidateState> = new Set(['failed', 'superseded'])

export interface PlanReportInput {
  supervision: readonly ChangeSupervision[]
  content: Pick<PlanContent, 'changes' | 'successCriteria'>
  decisions: ReadonlyArray<{
    card: Pick<DecisionCard, 'addressedGroup'>
    decisions: readonly PlanDecision[]
    fixes: ReadonlyArray<{ decisionId: string; status: FixStatus }>
  }>
  candidates: readonly IntegrationCandidate[]
  impact: { disposition: ImpactDisposition | null; reviewId: string; strategyRevision: number } | null
}

export function planReport(input: PlanReportInput): PlanReport {
  const counts = Object.fromEntries(SUPERVISION_OUTCOMES.map(outcome => [outcome, 0])) as Record<SupervisionOutcome, number>
  for (const entry of input.supervision) counts[entry.outcome] += 1
  const landedSet = new Set(input.supervision.filter(entry => entry.outcome === 'landed').map(entry => entry.change))
  const total = input.content.changes.length
  const landed = input.content.changes.filter(change => landedSet.has(change.change)).length
  const stops = input.supervision.flatMap((entry): ReportStop[] => {
    if (entry.cause.kind !== 'stopped') return []
    return [{
      change: entry.change,
      reason: entry.cause.reason,
      label: stopReasonLabel(entry.cause.reason),
      detail: entry.cause.detail,
      evidence: entry.lastRound,
      blocked: blockedDependents(input.content, entry.change, landedSet),
      nextAction: STOP_NEXT_ACTION,
    }]
  })
  const overrides = overrideCounts(input.decisions)
  const overrideTimes = new Map(input.decisions.flatMap(card => card.decisions.filter(decision => decision.kind === 'override').map(decision => [decision.id, decision.createdAt] as const)))
  return {
    counts,
    total,
    landed,
    delivery: landed === total ? `All ${total} changes landed` : `Landed ${landed} of ${total}`,
    blockers: input.supervision.filter(entry => ['stopped', 'stalled', 'cancelled'].includes(entry.outcome)).map(entry => entry.change),
    stops,
    successCriteria: [...input.content.successCriteria],
    candidates: input.content.changes
      .map(change => ({
        change: change.change,
        candidates: input.candidates.filter(candidate => candidate.change === change.change && SHOWN_CANDIDATES.has(candidate.state)).sort((a, b) => b.seq - a.seq),
      }))
      .filter(entry => entry.candidates.length > 0),
    disposition: input.impact && input.impact.disposition !== null && input.impact.disposition !== 'continue'
      ? { disposition: input.impact.disposition, reviewId: input.impact.reviewId, strategyRevision: input.impact.strategyRevision }
      : null,
    overrides: { ...overrides, line: `${overrides.overridden} of ${overrides.total} Lead decisions overridden` },
    fixDurations: fixDurations(input.decisions.flatMap(card => card.fixes.flatMap(fix => {
      const overriddenAt = overrideTimes.get(fix.decisionId)
      return overriddenAt === undefined ? [] : [{ decisionId: fix.decisionId, overriddenAt, status: fix.status }]
    }))),
  }
}

/** The detail's and `plan_get`'s supervision (D15, D16): each change in plan order, the report, and when it was derived. */
export interface PlanSupervisionView {
  changes: ChangeSupervision[]
  report: PlanReport
  computedAt: string
}

/** The three fields `team-plan-detail` and `plan_get` add to a plan (D15, D16). */
export interface PlanSupervisionDetail {
  decisions: import('./planDecisions').PlanDecisionCardView[]
  supervision: PlanSupervisionView
  usage: import('./planUsage').PlanUsageView
}
