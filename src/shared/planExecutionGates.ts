// Pure gate evaluation (plan-execution design D10, D11, contract X4): CI over
// a round's commit with the floor map and the one-rerun flaky rule, the
// review verdict that counts, and the extra checks CI decides versus those a
// reviewer attests. The server's planner, `plan_get`, and the Plans view all
// read these, so they agree.
import type { PlanChange, PlanCheck, PlanContent } from './plans'
import type { CiCheck, FloorMap, StopDetail } from './planExecution'

/** No check at all this long after the CI window opened stops as `ci-missing`. */
export const CI_MISSING_AFTER_MS = 30 * 60 * 1000
/** A check still pending this long after the window opened stops as `ci-timeout`. */
export const CI_TIMEOUT_MS = 3 * 60 * 60 * 1000

const PASSING = new Set(['success', 'neutral', 'skipped'])
const PENDING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])

export type CiClass = 'pass' | 'pending' | 'fail'

/** D10: success, neutral, and skipped pass; the waiting states are pending; anything else fails. */
export function ciClass(check: Pick<CiCheck, 'conclusion'>): CiClass {
  const value = check.conclusion.toLowerCase()
  if (PASSING.has(value)) return 'pass'
  return PENDING.has(value) ? 'pending' : 'fail'
}

/** Only an Actions check run with its workflow run id can be rerun by Kawai. */
export const rerunnable = (check: CiCheck): boolean => check.source === 'actions' && typeof check.runId === 'number'

export type CiEvaluation =
  | { kind: 'pending'; pending: string[] }
  | { kind: 'pass'; flaky: string[] }
  | { kind: 'fail'; checks: CiCheck[] }
  | { kind: 'rerun'; runIds: number[] }
  | { kind: 'stop'; reason: 'ci-missing' | 'ci-timeout'; detail: StopDetail }

export interface CiTiming {
  /** When the CI window opened: the push, or a Retry's reopening. */
  windowFrom: string
  now: string
  /** The round's one rerun, once requested: its time and the workflow runs it covered. */
  rerun: { at: string; runIds: number[] } | null
}

const time = (value: string | null): number => (value === null ? Number.POSITIVE_INFINITY : Date.parse(value))

/** Runs grouped by name, oldest first; a run not yet started is the newest. */
function runsByName(checks: readonly CiCheck[]): Map<string, CiCheck[]> {
  const groups = new Map<string, CiCheck[]>()
  for (const check of checks) groups.set(check.name, [...(groups.get(check.name) ?? []), check])
  for (const runs of groups.values()) runs.sort((a, b) => time(a.startedAt) - time(b.startedAt))
  return groups
}

/**
 * D10. Every reported check counts, floor or not, and the newest run of a
 * name decides. A failure Kawai cannot rerun fails at once; rerunnable
 * failures wait for everything to finish and then ask for the one rerun.
 * After it, a failed run of a rerun workflow that completed before the rerun
 * still waits for its new run; a name whose newest run passes after an
 * earlier failure is flaky for this round, and one that fails again fails it.
 */
export function evaluateCi(checks: readonly CiCheck[], floorMap: FloorMap, timing: CiTiming): CiEvaluation {
  const elapsed = Date.parse(timing.now) - Date.parse(timing.windowFrom)
  if (checks.length === 0) {
    return elapsed >= CI_MISSING_AFTER_MS
      ? { kind: 'stop', reason: 'ci-missing', detail: { message: 'No check was reported for the commit within 30 minutes.' } }
      : { kind: 'pending', pending: [] }
  }
  const groups = runsByName(checks)
  const newest = [...groups.values()].map(runs => runs.at(-1)!)
  const rerun = timing.rerun
  const awaitingRerun = (check: CiCheck) => rerun !== null && rerunnable(check)
    && rerun.runIds.includes(check.runId!) && time(check.completedAt) < Date.parse(rerun.at)
  const failed = newest.filter(check => ciClass(check) === 'fail' && !awaitingRerun(check))
  const history = (names: CiCheck[]) => names.flatMap(check => groups.get(check.name)!)
  const final = failed.filter(check => rerun !== null || !rerunnable(check))
  if (final.length > 0) return { kind: 'fail', checks: history(final) }
  const pending = newest.filter(check => ciClass(check) === 'pending' || awaitingRerun(check)).map(check => check.name)
  if (pending.length > 0) {
    return elapsed >= CI_TIMEOUT_MS
      ? { kind: 'stop', reason: 'ci-timeout', detail: { message: 'Checks were still pending 3 hours after the CI window opened.', checks: pending } }
      : { kind: 'pending', pending }
  }
  if (failed.length > 0) return { kind: 'rerun', runIds: [...new Set(failed.map(check => check.runId!))] }
  const passing = new Set(newest.filter(check => ciClass(check) === 'pass').map(check => check.name))
  const uncovered = (Object.keys(floorMap) as Array<keyof FloorMap>)
    .filter(floor => !floorMap[floor].some(name => passing.has(name)))
  if (uncovered.length > 0) {
    return {
      kind: 'stop', reason: 'ci-missing',
      detail: { message: `No reported check covers ${uncovered.join(', ')}.`, checks: uncovered },
    }
  }
  return { kind: 'pass', flaky: flakyChecks(checks) }
}

/** The names that failed and then passed on a newer run: flaky for a passing round (D10). */
export function flakyChecks(checks: readonly CiCheck[]): string[] {
  return [...runsByName(checks).entries()]
    .filter(([, runs]) => runs.length > 1 && runs.some(run => ciClass(run) === 'fail') && ciClass(runs.at(-1)!) === 'pass')
    .map(([name]) => name)
}

/** A findings row as the verdict reads it; `author` is the submitting session, null for the human. */
export interface VerdictFindings {
  id: string
  resultId: string
  /** The handoff assignment the findings answer. */
  handoffId: string | null
  author: string | null
  verdict: 'pass' | 'fail'
  createdAt: string
}

export type ReviewVerdict =
  | { kind: 'pending' }
  | { kind: 'pass' | 'fail'; findingsId: string; reviewer: string }
  | { kind: 'author-claimant'; session: string }

/**
 * D11. `claimants` is the review assignment's claim chain, oldest first: the
 * original claimant, then each forward's successor; the last is current.
 * `authors` are the sessions that submitted the change's results in the
 * execution. A current claimant among them yields `author-claimant` whatever
 * it submitted. Otherwise only that claimant's findings on the round's result
 * recording the review assignment count, the newest deciding.
 */
export function reviewVerdict(
  round: { resultId: string; reviewAssignmentId: string | null },
  findings: readonly VerdictFindings[],
  claimants: readonly string[],
  authors: readonly string[],
): ReviewVerdict {
  const claimant = claimants.at(-1)
  if (!claimant || !round.reviewAssignmentId) return { kind: 'pending' }
  if (authors.includes(claimant)) return { kind: 'author-claimant', session: claimant }
  const counted = findings
    .filter(row => row.resultId === round.resultId && row.handoffId === round.reviewAssignmentId && row.author === claimant)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .at(-1)
  return counted ? { kind: counted.verdict, findingsId: counted.id, reviewer: claimant } : { kind: 'pending' }
}

/** D11: an extra check CI reports is CI's to decide; every other one is attested by the reviewer. */
export function splitExtraChecks(extra: readonly PlanCheck[], reportedNames: readonly string[]): { ci: PlanCheck[]; attested: PlanCheck[] } {
  const reported = new Set(reportedNames)
  return {
    ci: extra.filter(check => reported.has(check.name)),
    attested: extra.filter(check => !reported.has(check.name)),
  }
}

/**
 * A change's effective extra checks (D11, spec "every extra check is
 * satisfied"): the running revision's plan-wide checks, then the change's own,
 * deduped by name with the first kept. planChecks keeps the two lists disjoint;
 * the dedupe is defensive. Every execution reader goes through this one helper.
 */
export function effectiveExtraChecks(content: Pick<PlanContent, 'extraChecks'> | null | undefined, change: Pick<PlanChange, 'extraChecks'> | null | undefined): PlanCheck[] {
  const seen = new Set<string>()
  return [...content?.extraChecks ?? [], ...change?.extraChecks ?? []].filter(check => {
    if (seen.has(check.name)) return false
    seen.add(check.name)
    return true
  })
}
