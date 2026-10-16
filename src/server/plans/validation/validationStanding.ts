// The `validation-current` approval precondition (plan-validation design
// D9), the third extension point beside `durable-plans` D7's precondition
// list and `pinDisposition`. `prepareStanding` gathers the file-held parts
// of the identity before the approval transaction — hashes only, the cached
// adapter probe, no CLI; `computeStanding` recomputes the DB-held parts and
// compares the current input hash with the newest report's, inside the
// transaction. Only the precondition entry decides; the shipped entries
// never read `ctx.validation`.
import type { AssessmentRow, DecisionRecord, PlanValidationReport, ValidationInputs } from '../../../shared/planValidation'
import { VALIDATION_CHECKS_VERSION } from '../../../shared/planValidation'
import { hashValidationInputs, type ValidationFileInputs } from './validationInputs'
import type { ClaimedPlan } from './validationRun'
import type { ApprovalPrecondition } from '../planPreconditions'

/** What `prepareStanding` gathered (D9): the file-held parts, bound to one revision. */
export interface PreparedValidation {
  planId: string
  revision: number
  file: ValidationFileInputs
}

/**
 * A revision's validation standing at read time: no report, a report that is
 * not ready, a report whose inputs changed, or a current report. Derived,
 * never stored.
 */
export type ValidationStanding =
  | { state: 'not-validated' }
  | { state: 'blocked'; report: PlanValidationReport }
  | { state: 'out-of-date'; report: PlanValidationReport; changedParts: string[] }
  | { state: 'current'; report: PlanValidationReport }

/** The DB-held parts of the identity recomputed inside a transaction (D9). */
export interface StandingRecordParts {
  contentHash: string
  impactStateKey: string
  claimedPlans: readonly ClaimedPlan[]
  assessments: readonly AssessmentRow[]
  decisions: readonly DecisionRecord[]
}

const partNames = {
  checksVersion: 'the checks version',
  plan: 'the plan revision',
  impactStateKey: 'the strategy impact state',
  adapter: 'the OpenSpec adapter',
  profiles: 'the known profiles',
  claims: 'claims by other open plans',
  records: 'assessments or decisions',
} as const

/** Name each differing part between a report's inputs and the recomputed ones (D9's refusal wording). */
export function changedInputParts(before: ValidationInputs, now: ValidationInputs): string[] {
  const parts: string[] = []
  if (before.checksVersion !== now.checksVersion) parts.push(partNames.checksVersion)
  if (before.plan.contentHash !== now.plan.contentHash) parts.push(partNames.plan)
  if (before.impactStateKey !== now.impactStateKey) parts.push(partNames.impactStateKey)
  if (JSON.stringify(before.adapter) !== JSON.stringify(now.adapter)) parts.push(partNames.adapter)
  if (before.catalog.profiles !== now.catalog.profiles) parts.push(partNames.profiles)
  for (const [group, digest] of Object.entries(now.catalog.groups)) {
    if (before.catalog.groups[group] !== digest) parts.push(`the group ${group}`)
  }
  for (const group of Object.keys(before.catalog.groups)) {
    if (now.catalog.groups[group] === undefined && !parts.includes(`the group ${group}`)) parts.push(`the group ${group}`)
  }
  const beforeChanges = new Map(before.changes.map(change => [change.change, change]))
  const nowChanges = new Map(now.changes.map(change => [change.change, change]))
  for (const [change, entry] of nowChanges) {
    const prior = beforeChanges.get(change)
    if (!prior) {
      parts.push(`${change}'s artifacts`)
      continue
    }
    if (JSON.stringify(prior.artifacts) !== JSON.stringify(entry.artifacts)) parts.push(`${change}'s artifacts`)
    if (JSON.stringify(prior.baseSpecs) !== JSON.stringify(entry.baseSpecs)) {
      parts.push(`the base spec ${changedKeys(prior.baseSpecs, entry.baseSpecs).map(key => key).join(', ')}`)
    }
    if (prior.config !== entry.config) parts.push(`${change}'s OpenSpec config`)
    if (prior.status !== entry.status) parts.push(`${change}'s registration`)
  }
  for (const change of beforeChanges.keys()) {
    if (!nowChanges.has(change)) parts.push(`${change}'s artifacts`)
  }
  if (JSON.stringify(before.claims) !== JSON.stringify(now.claims) && !parts.includes(partNames.claims)) parts.push(partNames.claims)
  if (JSON.stringify(before.records) !== JSON.stringify(now.records)) parts.push(partNames.records)
  return parts.length > 0 ? parts : ['unspecified inputs']
}

const changedKeys = (before: Record<string, string | null>, now: Record<string, string | null>): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(key => before[key] !== now[key])

/** Assemble the full inputs from the prepared file parts and the record parts read now. */
export function standingInputs(prepared: PreparedValidation, records: StandingRecordParts, claims: ValidationInputs['claims']): ValidationInputs {
  return {
    checksVersion: VALIDATION_CHECKS_VERSION,
    plan: { planId: prepared.planId, revision: prepared.revision, contentHash: records.contentHash },
    impactStateKey: records.impactStateKey,
    adapter: prepared.file.adapter,
    changes: prepared.file.changes,
    catalog: prepared.file.catalog,
    claims,
    records: {
      assessments: records.assessments.map(row => row.id).sort(),
      decisions: records.decisions.map(row => row.id).sort(),
    },
  }
}

/**
 * The standing of one revision given its newest report and the inputs
 * recomputed now (D9). Pure: the caller reads the DB parts inside its own
 * transaction.
 */
export function computeStanding(prepared: PreparedValidation, records: StandingRecordParts, claims: ValidationInputs['claims'], newest: PlanValidationReport | null): ValidationStanding {
  if (!newest) return { state: 'not-validated' }
  const inputs = standingInputs(prepared, records, claims)
  const hash = hashValidationInputs(inputs)
  if (hash !== newest.inputHash) {
    return { state: 'out-of-date', report: newest, changedParts: changedInputParts(newest.inputs, inputs) }
  }
  return newest.ready ? { state: 'current', report: newest } : { state: 'blocked', report: newest }
}


/** D9's precondition entry: appended after the shipped entries, reading only `ctx.validation`. */
export function validationCurrentPrecondition(): ApprovalPrecondition {
  return {
    name: 'validation-current',
    check: ({ validation }) => {
      // Absent means no validation service is wired (durable-plans alone);
      // the production wiring always provides one.
      if (!validation) return null
      return validationCurrentMessage(validation as ValidationStanding)
    },
  }
}

/** D9's refusal messages; null when the standing passes. */
export function validationCurrentMessage(standing: ValidationStanding): string | null {
  if (standing.state === 'current') return null
  if (standing.state === 'not-validated') {
    return 'not validated: run Validate'
  }
  const { report } = standing
  if (standing.state === 'blocked') {
    const { readiness } = report
    return `report ${report.seq} not ready: ${readiness.errors.length} errors, ${readiness.unansweredQuestions.length} unanswered questions, ${readiness.unacceptedWarnings.length} unaccepted warnings, alignment ${readiness.alignment.reason ?? readiness.alignment.state}`
  }
  return `inputs changed since report ${report.seq}: ${standing.changedParts.join(', ')}`
}
