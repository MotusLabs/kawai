// One validation run (plan-validation design D8), split from the service so
// each file stays small: the file phase (no transaction, one CLI call pair
// per registered change through the adapter's pool) and the pure assembly of
// the report's parts for the record phase. The service owns scope, single
// flight, the transaction, and the push; nothing here reads the validation
// tables.
import type { PlanContent, PlanLifecycle, PlanRevisionStatus, PlanStrategyPin } from '../../../shared/plans'
import type { ImpactGate } from '../../../shared/strategyImpact'
import type {
  AssessmentRow,
  DecisionRecord,
  Finding,
  PlanRelation,
  PlanValidationReport,
  Readiness,
  ValidationCapacityEvidence,
  ValidationEvidence,
  ValidationInputs,
} from '../../../shared/planValidation'
import { deriveRelations, validationReadiness, VALIDATION_CHECKS_VERSION } from '../../../shared/planValidation'
import { computeClaims, runValidationChecks, type ResolvedChange, type ValidationCheckContext } from './validationChecks'
import { hashValidationInputs, readValidationFileInputs, type ValidationFileInputs } from './validationInputs'
import type { OpenspecAdapter, ShowDeltasOutcome, ValidateOutcome } from './openspecAdapter'

/** Another plan as the record phase reads it for claims (D2). */
export type ClaimedPlan = { planId: string; lifecycle: PlanLifecycle; revisions: ReadonlyArray<{ status: PlanRevisionStatus; content: PlanContent }> }

/** What the file phase gathered: file inputs, CLI outcomes, resolution, capacity. */
export interface ValidationFilePhase {
  file: ValidationFileInputs
  cli: Record<string, { validate: ValidateOutcome; deltas: ShowDeltasOutcome }>
  resolved: Record<string, ResolvedChange>
  capacity: ValidationCapacityEvidence[]
}

/** The file phase (D8 step 3): resolution, digests, CLI verdicts, catalogs, capacity. */
export async function runFilePhase(options: {
  adapter: OpenspecAdapter
  commonDir: string
  groupsRoot: string
  homeDir?: string
  content: PlanContent
  capacity: (group: string) => ValidationCapacityEvidence | null
}): Promise<ValidationFilePhase> {
  const named = [...new Set([
    ...options.content.roles.map(role => role.group),
    ...options.content.changes.flatMap(change => [change.group, change.reviewGroup].filter((group): group is string => group !== null)),
    ...(options.content.reviewGroup ? [options.content.reviewGroup] : []),
  ])]
  const file = await readValidationFileInputs({
    adapter: options.adapter, commonDir: options.commonDir, changeNames: options.content.changes.map(change => change.change),
    groupNames: named, groupsRoot: options.groupsRoot,
    branch: options.content.landing.mode === 'integration-branch' ? options.content.landing.branch : null,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  })
  const cli: ValidationFilePhase['cli'] = {}
  const resolved: Record<string, ResolvedChange> = {}
  await Promise.all(file.changes.map(async change => {
    const located = file.evidence.changes[change.change] ?? { root: null, dir: null, head: null }
    resolved[change.change] = { change: change.change, status: change.status, dir: located.dir, root: located.root, head: located.head }
    if (change.status !== 'registered' || !located.root) return
    const [validate, deltas] = await Promise.all([
      options.adapter.validate(located.root, change.change),
      options.adapter.showDeltas(located.root, change.change),
    ])
    cli[change.change] = { validate, deltas }
  }))
  const capacity = [...new Set(options.content.roles.map(role => role.group))]
    .map(group => options.capacity(group))
    .filter((entry): entry is ValidationCapacityEvidence => entry !== null)
  return { file, cli, resolved, capacity }
}

/** Everything the record phase computed for one report (D8 step 4). */
export interface ValidationRecordPhase {
  inputs: ValidationInputs
  inputHash: string
  findings: Finding[]
  relations: PlanRelation[]
  evidence: ValidationEvidence
  readiness: Readiness
  ready: boolean
}

/**
 * Assemble the report's parts from the file phase and the record phase's
 * fresh reads (impact gate and state key, claims, records). Pure: the
 * service calls it inside its transaction. `pin` is the revision's pin, or
 * the pin a submission would take for a dry run.
 */
export function buildRecordPhase(parts: {
  file: ValidationFilePhase
  content: PlanContent
  pin: PlanStrategyPin | null
  plan: { planId: string; revision: number; contentHash: string }
  gate: ImpactGate
  impactStateKey: string
  claimedPlans: readonly ClaimedPlan[]
  assessments: readonly AssessmentRow[]
  decisions: readonly DecisionRecord[]
}): ValidationRecordPhase {
  const branch = parts.content.landing.mode === 'integration-branch' ? parts.content.landing.branch : null
  const claims = computeClaims(parts.plan.planId, parts.claimedPlans, branch, parts.content.changes.map(change => change.change))
  const ctx: ValidationCheckContext = {
    content: parts.content,
    pin: parts.pin,
    adapter: { tool: 'openspec', version: parts.file.file.adapter.version, capabilities: parts.file.file.adapter.capabilities, ok: parts.file.file.probe.ok, error: parts.file.file.probe.error },
    resolved: parts.file.resolved,
    cli: parts.file.cli,
    gate: parts.gate,
    claims,
    groups: parts.file.file.catalogs.groups,
    knownProfiles: parts.file.file.catalogs.profiles,
    capacity: parts.file.capacity,
    branch: parts.file.file.evidence.branch,
  }
  const findings = runValidationChecks(ctx)
  const relations = deriveRelations(
    parts.content.changes.map(change => change.change).filter(name => parts.file.resolved[name]?.status === 'registered'),
    Object.fromEntries(parts.content.changes.map(change => [change.change, parts.file.cli[change.change]?.deltas.touches ?? []])),
    Object.fromEntries(parts.content.changes.map(change => [change.change, change.dependsOn])),
  )
  const evidence: ValidationEvidence = {
    changes: Object.fromEntries(Object.entries(parts.file.resolved).map(([change, located]) => {
      const cli = parts.file.cli[change]
      return [change, { root: located.root, dir: located.dir, head: located.head, issues: cli && !cli.validate.ok ? null : cli?.validate.issues ?? null }]
    })),
    branch: parts.file.file.evidence.branch,
    capacity: parts.file.capacity,
  }
  const inputs: ValidationInputs = {
    checksVersion: VALIDATION_CHECKS_VERSION,
    plan: parts.plan,
    impactStateKey: parts.impactStateKey,
    adapter: parts.file.file.adapter,
    changes: parts.file.file.changes,
    catalog: parts.file.file.catalog,
    claims,
    records: {
      assessments: parts.assessments.map(row => row.id).sort(),
      decisions: parts.decisions.map(row => row.id).sort(),
    },
  }
  const readiness = validationReadiness(findings, parts.pin, parts.assessments, parts.decisions)
  return { inputs, inputHash: hashValidationInputs(inputs), findings, relations, evidence, readiness, ready: readiness.ready }
}

/** A dry run's report row: returned only, never stored, satisfying no gate (D8). */
export function dryRunReport(record: ValidationRecordPhase, planId: string, requestedBy: PlanValidationReport['requestedBy'], now: string): PlanValidationReport {
  return {
    id: '', planId, revision: record.inputs.plan.revision, seq: 0, inputHash: record.inputHash, inputs: record.inputs,
    findings: record.findings, relations: record.relations, evidence: record.evidence, readiness: record.readiness,
    ready: record.ready, requestedBy, createdAt: now, dryRun: true,
  }
}
