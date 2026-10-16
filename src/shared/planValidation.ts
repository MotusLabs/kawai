// SDK-free plan validation model (plan-validation design D2–D7), shared by
// the server (which stores reports) and the client (which derives labels
// from the same pure functions). Validation pins its inputs: the plan
// revision, the strategy impact state, each change's resolution and artifact
// digests, the catalogs, other open plans' claims, the adapter's version and
// capabilities, the checks version, and the revision's assessment and
// decision ids — hashed canonically so a report's verdicts stay tied to what
// they read. Relations and readiness are pure derivations over what a report
// holds; mechanical errors are never cleared by judgment, and only the
// owner's decisions answer, accept, resolve, except, or authorize.
import { canonicalJson } from './productStrategy'
import type { PlanStrategyPin } from './plans'

/** Bumped whenever a check's logic changes, so every stored report goes stale (D2). */
export const VALIDATION_CHECKS_VERSION = 1

// --- D2: inputs and identity ---

/** How a plan's change resolves in the repository (D3 `change-registered`). */
export type ValidationChangeStatus = 'registered' | 'unregistered' | 'archived' | 'missing'

export interface ValidationChangeInput {
  change: string
  status: ValidationChangeStatus
  /** Relative artifact path → sha256, read in the change's canonical root. */
  artifacts: Record<string, string>
  /** Capability path → sha256 of `openspec/specs/<path>/spec.md`; null when absent. */
  baseSpecs: Record<string, string | null>
  /** sha256 of the canonical root's `openspec/config.yaml` (else `config.yml`); null when absent. */
  config: string | null
}

/** Everything a report's identity covers (D2). Location and baselines are evidence, never identity. */
export interface ValidationInputs {
  checksVersion: number
  plan: { planId: string; revision: number; contentHash: string }
  /** `strategy-revision-impact` C-I2. */
  impactStateKey: string
  adapter: { tool: 'openspec'; version: string | null; capabilities: string[] }
  /** In plan order, which the revision's content fixes. */
  changes: ValidationChangeInput[]
  catalog: { groups: Record<string, string | null>; profiles: string }
  /** Other open plans' ids, by claim. */
  claims: { branch: string[]; changes: Record<string, string[]> }
  /** This revision's record ids. */
  records: { assessments: string[]; decisions: string[] }
}

/**
 * The canonical hash input (D2): `canonicalJson` sorts object keys but keeps
 * array order, so every array except `changes` is sorted first —
 * `adapter.capabilities`, `claims.branch`, each `claims.changes` list, and
 * both `records` lists. The same claims and records therefore hash the same
 * whatever order `openPlans` or the store returned them in.
 */
export function validationInputsHashInput(inputs: ValidationInputs): string {
  return canonicalJson({
    ...inputs,
    adapter: { ...inputs.adapter, capabilities: [...inputs.adapter.capabilities].sort() },
    claims: {
      branch: [...inputs.claims.branch].sort(),
      changes: Object.fromEntries(Object.entries(inputs.claims.changes).map(([change, plans]) => [change, [...plans].sort()])),
    },
    records: {
      assessments: [...inputs.records.assessments].sort(),
      decisions: [...inputs.records.decisions].sort(),
    },
  })
}

// --- D3: findings and keys ---

/** The UX report row a finding reports under. */
export type ValidationRow = 'alignment' | 'intent' | 'scope' | 'readiness'

export type FindingSeverity = 'error' | 'warning' | 'evidence'

export interface Finding {
  check: string
  /**
   * Stable within a revision: `${check}:${subject}` for most checks, with
   * the relation keys embedding their parts (`relations:conflict:a+b:cap/R`,
   * `relations:overlap:a+b+c:cap`) and findings keyed `finding:<id>`.
   */
  key: string
  severity: FindingSeverity
  row: ValidationRow
  /** A change, group, profile, branch, pair, or capability. */
  subject: string
  message: string
  /** Bounded; CLI issues are capped at 50 per change. */
  detail?: unknown
}

/** `${check}:${subject}` (D3), the shape most finding keys take. */
export const findingKey = (check: string, subject: string): string => `${check}:${subject}`

/** D4's conflict error key: `relations:conflict:<a>+<b>:<capability>/<requirement>`. */
export const conflictKey = (pair: readonly [string, string], capability: string, requirement: string): string =>
  `relations:conflict:${[...pair].sort().join('+')}:${capability}/${requirement}`

/**
 * D4's overlap warning key: one per capability, `<changes>` the sorted set of
 * changes in that capability's unordered overlap pairs. A grown or shrunk
 * set is a new key, so an earlier acceptance never covers a change it did
 * not name.
 */
export const overlapKey = (changes: readonly string[], capability: string): string =>
  `relations:overlap:${[...changes].sort().join('+')}:${capability}`

/** An assessment finding's warning key (D5). */
export const findingWarningKey = (id: string): string => `finding:${id}`

// --- D1/D3: evidence and the report row ---

/** One CLI issue; a change's issues are capped at 50, with a count (D3). */
export interface CliIssue {
  level: string
  message: string
}

/** What a run read outside its identity (D2): evidence only — never hashed. */
export interface ValidationEvidence {
  /** Per change: its canonical root (null when unresolved), that root's `HEAD`, and its capped CLI issues when validate ran. */
  changes: Record<string, { root: string | null; head: string | null; issues: CliIssue[] | null }>
  /** Landing-branch facts, when the plan lands on an integration branch. */
  branch: { exists: boolean; head: string | null; worktree: string | null } | null
  /** Per role group (D3's `capacity` row); never a blocker. */
  capacity: ValidationCapacityEvidence[]
}

/** Capacity facts as evidence (D3): caps, live members, and cooling profiles. */
export interface ValidationCapacityEvidence {
  group: string
  /** The group's `max`, null when unset. */
  max: number | null
  /** Live members plus pending reservations. */
  live: number
  /** The group's declared profiles with cap and live count. */
  profiles: Array<{ profile: string; cap: number | null; live: number }>
  /** Profiles cooling, with their cooldown end. */
  cooling: Array<{ profile: string; until: string }>
}

/** Who requested a run. */
export type ValidationRequester = { kind: 'human' | 'agent'; sessionId: string | null }

/** A stored validation report (D1): immutable; the newest per revision is `max(seq)`. */
export interface PlanValidationReport {
  id: string
  planId: string
  revision: number
  seq: number
  inputHash: string
  inputs: ValidationInputs
  findings: Finding[]
  relations: PlanRelation[]
  evidence: ValidationEvidence
  readiness: Readiness
  ready: boolean
  requestedBy: ValidationRequester
  createdAt: string
  /** True only for a returned dry run, which is never stored and satisfies no gate (D8). */
  dryRun: boolean
}

// --- D5: assessments ---

export type AlignmentValue = 'aligned' | 'aligned-with-conditions' | 'exploratory' | 'conflicting' | 'insufficient-information'

export type ConditionGate = 'ready' | 'start' | 'acceptance'

export interface AlignmentCondition {
  text: string
  gate: ConditionGate
}

export interface AlignmentAssessment {
  assessment: AlignmentValue
  /** Refs the pinned strategy revision defines. */
  outcomes: string[]
  conditions: AlignmentCondition[]
  /** Required by `exploratory`. */
  experiment: { criteria: string; scope: string } | null
  /** What the plan violates, in prose; required by `conflicting`. */
  conflicts: string[]
  rationale: string
}

/** An agent's question; keyed by its record id, mandatory ones block (D5/D7). */
export interface Question {
  text: string
  mandatory: boolean
  /** A change, or null. */
  subject: string | null
}

/** An agent's warning finding; keyed `finding:<record id>` (D5). */
export interface AssessmentFinding {
  text: string
  subject: string | null
}

export type AssessmentAuthor = { kind: 'human' | 'agent'; sessionId: string | null }

/** An assessment row as readiness and the view read it: identity, kind, payload, author. */
export type AssessmentRow =
  | { id: string; kind: 'alignment'; payload: AlignmentAssessment; author: AssessmentAuthor; createdAt: string }
  | { id: string; kind: 'question'; payload: Question; author: AssessmentAuthor; createdAt: string }
  | { id: string; kind: 'finding'; payload: AssessmentFinding; author: AssessmentAuthor; createdAt: string }

// --- D6/D7: decisions and readiness ---

export type DecisionKind = 'answer' | 'accept-warning' | 'resolve-condition' | 'alignment-exception' | 'authorize-exploration'

/** An owner decision as readiness reads it; append-only, and a later one on the same target supersedes. */
export interface DecisionRecord {
  id: string
  kind: DecisionKind
  /** Question id, warning key, `<assessment id>#<n>`, or assessment id. */
  target: string
  /** The answer or the rationale. */
  text: string
  /** The bounds of an exception or exploration. */
  scope: string | null
  createdAt: string
}

export interface Readiness {
  ready: boolean
  /** Finding keys. */
  errors: string[]
  /** Mandatory question ids. */
  unansweredQuestions: string[]
  /** Check-warning and finding warning keys. */
  unacceptedWarnings: string[]
  alignment: { state: 'unassessed' | 'passes' | 'blocked'; reason: string | null; effective: string | null }
  carriedConditions: Array<{ target: string; text: string; gate: 'start' | 'acceptance'; resolved: boolean }>
}

const answered = (decisions: readonly DecisionRecord[], questionId: string): boolean =>
  decisions.some(decision => decision.kind === 'answer' && decision.target === questionId)
const accepted = (decisions: readonly DecisionRecord[], key: string): boolean =>
  decisions.some(decision => decision.kind === 'accept-warning' && decision.target === key)
const targeted = (decisions: readonly DecisionRecord[], kind: DecisionKind, target: string): boolean =>
  decisions.some(decision => decision.kind === kind && decision.target === target)

/**
 * Readiness, a pure function of what a report holds (D7). A report is ready
 * exactly when it has no errors, no unanswered mandatory questions, no
 * unaccepted warnings, and its alignment is unassessed (empty pin, S11) or
 * passes. Alignment rules, in order: an empty pin is unassessed and passes;
 * any `conflicting` assessment without the owner's exception blocks
 * ("conflict unresolved"), whatever later assessments say (S06); no
 * assessment blocks ("not assessed"); otherwise the newest decides —
 * `aligned` passes, `aligned-with-conditions` passes once every `ready`
 * condition is resolved (its `start` and `acceptance` conditions are
 * carried), `exploratory` and `insufficient-information` pass only with the
 * owner's exploration authorization, and `conflicting` passes once its
 * exception is recorded.
 */
export function validationReadiness(
  findings: readonly Finding[],
  pin: PlanStrategyPin | null,
  assessments: readonly AssessmentRow[],
  decisions: readonly DecisionRecord[],
): Readiness {
  const errors = findings.filter(finding => finding.severity === 'error').map(finding => finding.key)
  const unansweredQuestions = assessments
    .filter((row): row is Extract<AssessmentRow, { kind: 'question' }> => row.kind === 'question' && row.payload.mandatory)
    .filter(row => !answered(decisions, row.id))
    .map(row => row.id)
  const warningKeys = [
    ...findings.filter(finding => finding.severity === 'warning').map(finding => finding.key),
    ...assessments
      .filter((row): row is Extract<AssessmentRow, { kind: 'finding' }> => row.kind === 'finding')
      .map(row => findingWarningKey(row.id)),
  ]
  const unacceptedWarnings = warningKeys.filter(key => !accepted(decisions, key))
  const alignments = assessments
    .filter((row): row is Extract<AssessmentRow, { kind: 'alignment' }> => row.kind === 'alignment')
    // Stable sort: ties keep store order (created_at, rowid), which is insert order.
    .sort((x, y) => byCodePoint(x.createdAt, y.createdAt))
  const newest = alignments.at(-1) ?? null
  const alignment = validationAlignment(pin, alignments, newest, decisions)
  const ready = errors.length === 0 && unansweredQuestions.length === 0 && unacceptedWarnings.length === 0
    && (alignment.state === 'unassessed' || alignment.state === 'passes')
  return { ready, errors, unansweredQuestions, unacceptedWarnings, alignment, carriedConditions: validationCarried(newest, decisions) }
}

/** The alignment standing (D7's ordered rules); `effective` names the newest assessment. */
function validationAlignment(
  pin: PlanStrategyPin | null,
  alignments: readonly Extract<AssessmentRow, { kind: 'alignment' }>[],
  newest: Extract<AssessmentRow, { kind: 'alignment' }> | null,
  decisions: readonly DecisionRecord[],
): Readiness['alignment'] {
  if (pin === null) return { state: 'unassessed', reason: null, effective: null }
  const unresolvedConflict = alignments.find(row => row.payload.assessment === 'conflicting' && !targeted(decisions, 'alignment-exception', row.id))
  if (unresolvedConflict) {
    return { state: 'blocked', reason: 'conflict unresolved', effective: unresolvedConflict.id }
  }
  if (!newest) return { state: 'blocked', reason: 'not assessed', effective: null }
  const value = newest.payload.assessment
  if (value === 'aligned' || value === 'conflicting') return { state: 'passes', reason: null, effective: newest.id }
  if (value === 'aligned-with-conditions') {
    const open = newest.payload.conditions.find((condition, index) =>
      condition.gate === 'ready' && !targeted(decisions, 'resolve-condition', `${newest.id}#${index}`))
    return open
      ? { state: 'blocked', reason: `unresolved condition: ${open.text}`, effective: newest.id }
      : { state: 'passes', reason: null, effective: newest.id }
  }
  return targeted(decisions, 'authorize-exploration', newest.id)
    ? { state: 'passes', reason: null, effective: newest.id }
    : { state: 'blocked', reason: 'exploration not authorized', effective: newest.id }
}

/** The effective assessment's `start` and `acceptance` conditions, with their resolution (D7). */
function validationCarried(
  newest: Extract<AssessmentRow, { kind: 'alignment' }> | null,
  decisions: readonly DecisionRecord[],
): Readiness['carriedConditions'] {
  if (!newest || newest.payload.assessment !== 'aligned-with-conditions') return []
  return newest.payload.conditions
    .map((condition, index) => ({ condition, index }))
    .filter(({ condition }) => condition.gate !== 'ready')
    .map(({ condition, index }) => ({
      target: `${newest.id}#${index}`,
      text: condition.text,
      gate: condition.gate as 'start' | 'acceptance',
      resolved: targeted(decisions, 'resolve-condition', `${newest.id}#${index}`),
    }))
}


// --- D4: typed relations from spec deltas ---

export type PlanRelationKind = 'conflict' | 'overlap' | 'serialized'

export interface PlanRelation {
  kind: PlanRelationKind
  /** Sorted pair. */
  changes: [string, string]
  capability: string
  /** Shared requirement names; empty for an overlap. */
  requirements: string[]
  /** `[earlier, later]` when serialized. */
  order: [string, string] | null
}

/** One `(capability, operation, requirement)` touch; a RENAMED delta yields two, one per name. */
export interface SpecTouch {
  capability: string
  operation: string
  requirement: string
}

/** Code-point comparison, so keys and pairs sort identically on every ICU. */
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Whether `earlier` reaches `later` through `dependsOn`, transitively. */
function reaches(dependsOn: Readonly<Record<string, readonly string[]>>, earlier: string, later: string): boolean {
  const seen = new Set<string>()
  const queue = [...(dependsOn[later] ?? [])]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === earlier) return true
    if (seen.has(current)) continue
    seen.add(current)
    queue.push(...(dependsOn[current] ?? []))
  }
  return false
}

/**
 * The relations of the plan's changes (D4), one per pair and capability,
 * sorted by pair then capability. `deltas` maps a change to its touches; a
 * change with none relates to nothing. Two changes touching the same
 * requirement conflict — an error unless `dependsOn` orders them (directly
 * or transitively), which records a `serialized` relation with its order.
 * Same capability without a shared requirement is an `overlap`.
 */
export function deriveRelations(
  changes: readonly string[],
  deltas: Readonly<Record<string, readonly SpecTouch[]>>,
  dependsOn: Readonly<Record<string, readonly string[]>>,
): PlanRelation[] {
  const relations: PlanRelation[] = []
  const names = changes.filter(change => (deltas[change] ?? []).length > 0)
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const [a, b] = [names[i]!, names[j]!]
      const pair: [string, string] = [a, b].sort() as [string, string]
      const order = reaches(dependsOn, a, b) ? [a, b] as [string, string] : reaches(dependsOn, b, a) ? [b, a] as [string, string] : null
      const capabilities = new Map<string, { a: Set<string>; b: Set<string> }>()
      for (const touch of deltas[a] ?? []) {
        const entry = capabilities.get(touch.capability) ?? { a: new Set<string>(), b: new Set<string>() }
        entry.a.add(touch.requirement)
        capabilities.set(touch.capability, entry)
      }
      for (const touch of deltas[b] ?? []) {
        const entry = capabilities.get(touch.capability)
        if (entry) entry.b.add(touch.requirement)
      }
      for (const [capability, { a: requirementsA, b: requirementsB }] of capabilities) {
        if (requirementsB.size === 0) continue
        const shared = [...requirementsA].filter(requirement => requirementsB.has(requirement)).sort()
        relations.push(shared.length > 0
          ? { kind: order ? 'serialized' : 'conflict', changes: pair, capability, requirements: shared, order }
          : { kind: order ? 'serialized' : 'overlap', changes: pair, capability, requirements: [], order })
      }
    }
  }
  return relations.sort((x, y) => (x.changes.join('+') === y.changes.join('+')
    ? byCodePoint(x.capability, y.capability)
    : byCodePoint(x.changes.join('+'), y.changes.join('+'))))
}

/**
 * The `relations` check's findings (D3/D4): one error per shared requirement
 * of an unordered conflicting pair, one warning per capability for its
 * unordered overlap pairs (the sorted change set in the key, the pairs in
 * the detail), and the serialized pairs as evidence. Sorted by key.
 */
export function relationFindings(relations: readonly PlanRelation[]): Finding[] {
  const findings: Finding[] = []
  const overlaps = new Map<string, { changes: Set<string>; pairs: Array<[string, string]> }>()
  for (const relation of relations) {
    const subject = `${relation.changes.join('+')}:${relation.capability}`
    if (relation.kind === 'conflict') {
      for (const requirement of relation.requirements) {
        findings.push({
          check: 'relations', key: conflictKey(relation.changes, relation.capability, requirement), severity: 'error', row: 'scope',
          subject, message: `${relation.changes[0]} and ${relation.changes[1]} both touch ${relation.capability}/${requirement}; add a dependsOn edge ordering them, or rename one requirement.`,
        })
      }
    } else if (relation.kind === 'overlap') {
      const entry = overlaps.get(relation.capability) ?? { changes: new Set<string>(), pairs: [] }
      entry.changes.add(relation.changes[0]!)
      entry.changes.add(relation.changes[1]!)
      entry.pairs.push(relation.changes)
      overlaps.set(relation.capability, entry)
    } else {
      findings.push({
        check: 'relations', key: findingKey('relations', `serialized:${subject}`), severity: 'evidence', row: 'scope',
        subject, message: `${relation.order![0]} lands before ${relation.order![1]} on ${relation.capability} (dependsOn).`,
        detail: { order: relation.order, requirements: relation.requirements },
      })
    }
  }
  for (const [capability, { changes, pairs }] of overlaps) {
    const list = [...changes].sort()
    findings.push({
      check: 'relations', key: overlapKey(list, capability), severity: 'warning', row: 'scope',
      subject: capability, message: `${list.join(' and ')} touch ${capability} without a shared requirement or an order between them; confirm they stay independent.`,
      detail: { changes: list, pairs: pairs.map(pair => [...pair].sort()).sort((x, y) => byCodePoint(x.join('+'), y.join('+'))) },
    })
  }
  return findings.sort((x, y) => byCodePoint(x.key, y.key))
}

