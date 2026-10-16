// The validation service (plan-validation design D5, D6, D8, D9): rights and
// single flight over the store, the approval standing's gather and compare,
// and the tools' reads. Agents and the owner append assessments —
// alignment with its five values, questions, warning findings — bound to an
// `in_review` or `approved` revision of their own team; only the human
// decides (answers, acceptances, condition resolutions, exceptions,
// explorations), each decision idempotent under a command id with the
// strategy-revision-impact replay pattern. Every write runs in one
// transaction, writes only the three validation tables, and pushes the plan
// detail after commit through `PlanStore.announce`. Nothing here approves,
// grants, or clears a mechanical error.
import path from 'node:path'
import type { ChatSessionRecord } from '../../db'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { Plan, PlanContent, PlanRevision, PlanStrategyPin } from '../../../shared/plans'
import { hashPlanRevision } from '../planHash'
import type { ImpactGate } from '../../../shared/strategyImpact'
import { impactGate } from '../../../shared/strategyImpact'
import type { AlignmentAssessment, AssessmentFinding, AssessmentRow, DecisionRecord, PlanValidationReport, Question, ValidationCapacityEvidence } from '../../../shared/planValidation'
import type { PlanStore } from '../planStore'
import { payloadDifference } from '../planCommands'
import type { ImpactService } from '../../strategy/ImpactService'
import type { OpenspecAdapter } from './openspecAdapter'
import { buildRecordPhase, dryRunReport, runFilePhase, type ClaimedPlan } from './validationRun'
import { computeStanding, validationCurrentPrecondition, type PreparedValidation, type ValidationStanding } from './validationStanding'
import { ValidationCommandRaceError, type ValidationStore } from './validationStore'
import {
  ASSESS_TEXT_LIMIT,
  ValidationRefusal,
  assessValidation,
  trimmed,
  validationContext,
  validationTarget,
  type ValidationDeps,
} from './validationAssess'
import { resolveTeam } from '../../team/teamIdentity'
import { computeClaims } from './validationChecks'
import { readValidationFileInputs } from './validationInputs'

export type ValidationCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

export interface AssessInput {
  plan_id: string
  revision: number
  /** One alignment assessment (the owner's form records exactly one, by command id; agent calls append). */
  alignment?: AlignmentAssessment
  questions?: Question[]
  findings?: AssessmentFinding[]
  /** The owner's form only; agent tool calls carry none. */
  command_id?: string
}

export type AssessOutcome =
  | { ok: true; replayed: boolean; ids: { alignment: string | null; questions: string[]; findings: string[] } }
  | { ok: false; reason: 'not-found' | 'target' | 'shape' | 'limit' | 'payload'; message: string }

export interface DecideInput {
  planId: string
  revision: number
  kind: DecisionRecord['kind']
  target: string
  text: string
  scope?: string | null
  commandId: string
}

export type DecideOutcome =
  | { ok: true; replayed: boolean; decision: DecisionRecord }
  | { ok: false; reason: 'forbidden' | 'not-found' | 'target' | 'limit' | 'payload'; message: string }

/** D8: a standing revision to validate, or a draft to dry-run. */
export type ValidateInput =
  | { planId: string; revision: number }
  | { planId: string; draftId?: string; revision?: never }

export type ValidateOutcome =
  | { ok: true; report: PlanValidationReport; reportId: string | null; stored: boolean; dryRun: boolean }
  | { ok: false; reason: 'not-found' | 'target' | 'payload'; message: string }

export { ASSESS_TEXT_LIMIT, AGENT_RECORD_LIMIT } from './validationAssess'

const DECISION_SCOPE_LIMIT = 500

export class ValidationService {
  constructor(readonly store: ValidationStore, private readonly options: {
    plans: PlanStore
    strategies: import('../../strategy/strategyStore').StrategyStore
    impact: ImpactService
    adapter: OpenspecAdapter
    getSession: (id: string) => ChatSessionRecord | null | undefined
    /** Capacity evidence per role group from the team's own identity (D3's `capacity` row); absent means no evidence row. */
    capacity?: (team: TeamIdentity, group: string) => Promise<ValidationCapacityEvidence | null> | ValidationCapacityEvidence | null
    homeDir?: string
  }) {}

  /** The assessment-path deps: this service's own options plus its store. */
  private deps(): ValidationDeps {
    return { store: this.store, plans: this.options.plans, strategies: this.options.strategies, getSession: this.options.getSession, ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}) }
  }

  private async context(caller: ValidationCaller): Promise<TeamIdentity> {
    return validationContext(this.deps(), caller)
  }

  private target(team: TeamIdentity, planId: string, revision: number): { plan: Plan; revision: PlanRevision } {
    return validationTarget(this.deps(), team, planId, revision)
  }

  /** D5: assessments (validationAssess.ts), one transaction per call. */
  assess(caller: ValidationCaller, input: AssessInput): Promise<AssessOutcome> {
    return assessValidation(this.deps(), caller, input)
  }

  /**
   * D6: an owner decision, idempotent under its command id. An agent actor
   * is refused before any read; then one transaction replays by payload,
   * checks the target against the revision's records, and inserts. A
   * unique-constraint hit rolls back and resolves as the replay.
   */
  async decide(caller: ValidationCaller, input: DecideInput): Promise<DecideOutcome> {
    if (caller.kind !== 'human') {
      return { ok: false, reason: 'forbidden', message: 'Only the human (the owner) records validation decisions. No agent tool can, and nothing an agent writes grants it.' }
    }
    const commandId = trimmed(input.commandId)
    if (!commandId) return { ok: false, reason: 'payload', message: 'A decision needs a stable command id so a resend replays instead of repeating.' }
    const team = await this.context(caller)
    const payload = { revision: input.revision, kind: input.kind, target: input.target, text: input.text, scope: input.scope ?? null }
    const run = (): DecideOutcome => {
      const recorded = this.store.decisionByCommand(input.planId, commandId)
      if (recorded) {
        const field = payloadDifference(recorded.payload as never, payload as never)
        if (field) {
          return { ok: false, reason: 'payload', message: `command_id ${commandId} was already used with a different ${field}; the recorded decision stands and nothing was written.` }
        }
        return { ok: true, replayed: true, decision: recorded.decision }
      }
      this.target(team, input.planId, input.revision)
      const text = trimmed(input.text)
      if (!text) return { ok: false, reason: 'limit', message: 'The decision needs its answer or rationale; an empty rationale is refused and nothing is written.' }
      if (text.length > ASSESS_TEXT_LIMIT) return { ok: false, reason: 'limit', message: 'The text is over the 2,000-character limit; refused, never cut.' }
      const scope = input.scope == null ? null : trimmed(input.scope)
      if (scope && scope.length > DECISION_SCOPE_LIMIT) return { ok: false, reason: 'limit', message: 'The scope is over the 500-character limit; refused, never cut.' }
      this.checkDecisionTarget(input.planId, input.revision, input.kind, input.target, scope)
      const decision = this.store.insertDecision({ planId: input.planId, revision: input.revision, kind: input.kind, target: input.target, text, scope, commandId, payload })
      return { ok: true, replayed: false, decision }
    }
    let outcome: DecideOutcome
    try {
      outcome = this.store.atomically(run)
    } catch (error) {
      if (error instanceof ValidationCommandRaceError) {
        // A concurrent resend committed first; resolve as its replay.
        try {
          outcome = this.store.atomically(run)
        } catch (rerun) {
          if (rerun instanceof ValidationRefusal) return rerun.outcome as DecideOutcome
          throw rerun
        }
      } else if (error instanceof ValidationRefusal) {
        return error.outcome as DecideOutcome
      } else {
        throw error
      }
    }
    if (outcome.ok && !outcome.replayed) this.options.plans.announce(input.planId)
    return outcome
  }

  /** D6 step 3: the target must suit the kind, against the revision's records. */
  private checkDecisionTarget(planId: string, revision: number, kind: DecideInput['kind'], target: string, scope: string | null): void {
    const refuse = (message: string): never => { throw new ValidationRefusal({ ok: false, reason: 'target', message }) }
    const assessments = this.store.assessments(planId, revision)
    if (kind === 'answer') {
      const question = assessments.find(row => row.id === target)
      if (!question || question.kind !== 'question') refuse(`Answer targets a question of revision ${revision}; "${target}" is not one.`)
      return
    }
    if (kind === 'accept-warning') {
      const report = this.store.newestReport(planId, revision)
      if (!report) {
        refuse(`Revision ${revision} has no report to accept warnings from; validate it first.`)
      }
      const newest = report!
      // Every warning the report raised, plus every finding assessment of
      // the revision — an already-accepted finding stays acceptable, so a
      // later decision on it supersedes the earlier one (D6).
      const raised = new Set([
        ...newest.findings.filter(finding => finding.severity === 'warning').map(finding => finding.key),
        ...newest.readiness.unacceptedWarnings,
        ...assessments.filter((row): row is Extract<AssessmentRow, { kind: 'finding' }> => row.kind === 'finding').map(row => `finding:${row.id}`),
      ])
      if (!raised.has(target)) refuse(`Warning key "${target}" is not raised by revision ${revision}'s newest report (report ${newest.seq}).`)
      return
    }
    const alignments = assessments.filter((row): row is Extract<AssessmentRow, { kind: 'alignment' }> => row.kind === 'alignment')
    if (kind === 'resolve-condition') {
      const match = /^(.+)#(0|[1-9]\d*)$/.exec(target)
      const assessed = match ? alignments.find(row => row.id === match[1]) : undefined
      const position = match ? Number(match[2]) : NaN
      if (!assessed || !Number.isInteger(position) || position >= assessed.payload.conditions.length) {
        refuse(`Resolve-condition targets "<assessment id>#<n>" of revision ${revision}'s alignment conditions; "${target}" is not one.`)
      }
      return
    }
    if (kind === 'alignment-exception') {
      const conflicting = alignments.find(row => row.id === target && row.payload.assessment === 'conflicting')
      if (!conflicting) refuse(`An alignment exception targets a conflicting assessment of revision ${revision}; "${target}" is not one.`)
      if (!scope) refuse('An alignment exception needs its scope.')
      return
    }
    if (kind === 'authorize-exploration') {
      const exploratory = alignments.find(row => row.id === target && (row.payload.assessment === 'exploratory' || row.payload.assessment === 'insufficient-information'))
      if (!exploratory) refuse(`An exploration authorization targets an exploratory or insufficient-information assessment of revision ${revision}; "${target}" is not one.`)
      if (!scope) refuse('An exploration authorization needs its scope.')
      return
    }
    refuse(`Unknown decision kind "${kind}"; nothing was written.`)
  }

  /** The plan's standing revisions (`in_review` or `approved`), oldest first (D11's view input). */
  standingRevisions(planId: string): number[] {
    const plan = this.options.plans.get(planId)
    if (!plan) return []
    return this.options.plans.revisions(planId)
      .filter(row => row.status === 'in_review' || row.status === 'approved')
      .map(row => row.revision)
  }

  /** D10: the revision a tool call defaults to — the newest in review, else the approved one. */
  async defaultRevisionFor(caller: ValidationCaller, planId: string): Promise<{ ok: true; revision: number | null } | { ok: false; reason: 'not-found'; message: string }> {
    const team = await this.context(caller)
    const plan = this.options.plans.forTeam(team.teamId, planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${planId}` }
    const inReview = [...this.options.plans.revisions(plan.id)].reverse().find(row => row.status === 'in_review')
    const approved = this.options.plans.approvedRevision(plan.id)
    return { ok: true, revision: inReview?.revision ?? approved?.revision ?? null }
  }

  /**
   * D10's read: one report of the caller's team's plan — the newest of a
   * standing revision (the default revision when none is named), or the
   * named report row — with its standing computed now and the revision's
   * assessments and decisions. Read-only.
   */
  async validationGet(caller: ValidationCaller, input: { planId: string; revision?: number; reportId?: string }): Promise<
    | { ok: true; report: PlanValidationReport; standing: ReturnType<ValidationService['standing']>; assessments: AssessmentRow[]; decisions: DecisionRecord[] }
    | { ok: false; reason: 'not-found'; message: string }
  > {
    const team = await this.context(caller)
    const plan = this.options.plans.forTeam(team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${input.planId}` }
    const defaulted = input.revision !== undefined
      ? { ok: true as const, revision: input.revision }
      : await this.defaultRevisionFor(caller, input.planId)
    const report = input.reportId
      ? (() => {
        const row = this.store.report(input.reportId!)
        return row && row.planId === plan.id ? row : null
      })()
      : defaulted.ok && defaulted.revision !== null ? this.store.newestReport(plan.id, defaulted.revision) : null
    if (!report) return { ok: false, reason: 'not-found', message: input.reportId ? `Report not found for this plan: ${input.reportId}` : 'No validation report for that revision; run plan_validate first.' }
    const prepared = await this.prepareStanding(plan.id, report.revision)
    const standing = prepared ? this.standing(prepared) : { state: 'not-validated' as const }
    return {
      ok: true, report, standing,
      assessments: this.store.assessments(plan.id, report.revision),
      decisions: this.store.decisions(plan.id, report.revision),
    }
  }

  // --- D8: running a validation ---

  private readonly running = new Map<string, Promise<ValidateOutcome>>()

  /**
   * D8: validate a standing revision, or dry-run a draft. One run per plan
   * and revision (or draft) — a concurrent request joins the running one.
   * The file phase reads outside any transaction; the record phase runs in
   * one, recomputes the DB-held parts, dedupes on an unchanged input hash,
   * and otherwise inserts `seq = max + 1`. After a commit, the plan detail
   * is pushed. A dry run is computed as if submitted and never stored.
   */
  async validate(caller: ValidationCaller, input: ValidateInput): Promise<ValidateOutcome> {
    if ('revision' in input && input.revision !== undefined && 'draftId' in input && input.draftId !== undefined) {
      return { ok: false, reason: 'payload', message: 'Pass revision or draft_id, not both: a revision validates what was submitted, a draft dry-runs it.' }
    }
    const team = await this.context(caller)
    const plan = this.options.plans.forTeam(team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${input.planId}` }
    const revisionInput = 'revision' in input && input.revision !== undefined ? input.revision : undefined
    // The draft id defaults to the caller's BEFORE the single-flight key is
    // built, so two agents' concurrent dry runs never share one run (N5).
    const draftId = revisionInput === undefined
      ? ('draftId' in input && input.draftId !== undefined ? input.draftId : caller.kind === 'agent' ? caller.sessionId : 'human')
      : undefined
    const key = revisionInput !== undefined ? `${plan.id}:r${revisionInput}` : `${plan.id}:d${draftId}`
    const running = this.running.get(key)
    if (running) return running
    const outcome = (async (): Promise<ValidateOutcome> => {
      try {
        if (revisionInput === undefined) {
          const checked = await this.dryRunScope(team, plan.id, draftId, caller)
          if ('refused' in checked) return checked.refused
          return { ok: true, report: checked.report, reportId: null, stored: false, dryRun: true }
        }
        const revision = revisionInput
        const checked = await this.revisionScope(team, plan.id, revision)
        if ('refused' in checked) return checked.refused
        const { revision: row, groupsRoot } = checked
        const file = await this.filePhase(team, row.content, groupsRoot)
        // D8 step 4 in one transaction: compute, dedupe on an unchanged
        // input hash, and insert — no window between the check and the write.
        const stored = this.store.atomically((): { ok: true; report: PlanValidationReport; stored: boolean } => {
          const fresh = this.target(team, plan.id, revision)
          const gate = this.options.impact.gate(plan.id, revision)
          if (!gate) throw new ValidationRefusal({ ok: false, reason: 'target', message: `Revision ${revision} lost its impact gate mid-run; validate again.` })
          const record = buildRecordPhase({
            file, content: row.content, pin: row.pin,
            plan: { planId: plan.id, revision, contentHash: fresh.revision.contentHash },
            gate, impactStateKey: this.options.impact.stateKey(plan.id),
            claimedPlans: this.options.plans.openPlans(team.teamId).map(other => ({
              planId: other.id, lifecycle: other.lifecycle,
              revisions: this.options.plans.revisions(other.id).map(entry => ({ status: entry.status, content: entry.content })),
            })),
            assessments: this.store.assessments(plan.id, revision),
            decisions: this.store.decisions(plan.id, revision),
          })
          const newest = this.store.newestReport(plan.id, revision)
          if (newest && newest.inputHash === record.inputHash) {
            return { ok: true, report: newest, stored: false }
          }
          return {
            ok: true, stored: true,
            report: this.store.insertReport({
              planId: plan.id, revision, inputHash: record.inputHash, inputs: record.inputs,
              findings: record.findings, relations: record.relations, evidence: record.evidence,
              readiness: record.readiness, ready: record.ready,
              requestedBy: caller.kind === 'human' ? { kind: 'human', sessionId: null } : { kind: 'agent', sessionId: caller.sessionId },
            }),
          }
        })
        if (stored.stored) this.options.plans.announce(plan.id)
        return { ok: true, report: stored.report, reportId: stored.report.id, stored: stored.stored, dryRun: false }
      } catch (error) {
        if (error instanceof ValidationRefusal) return error.outcome as ValidateOutcome
        throw error
      }
    })()
    this.running.set(key, outcome)
    try {
      return await outcome
    } finally {
      this.running.delete(key)
    }
  }

  /** D8 step 1 for a revision: the plan is open and the revision stands; the file phase needs the team's groups root. */
  private async revisionScope(team: TeamIdentity, planId: string, revision: number): Promise<{ plan: Plan; revision: PlanRevision; groupsRoot: string } | { refused: ValidateOutcome }> {
    try {
      const { plan, revision: row } = this.target(team, planId, revision)
      return { plan, revision: row, groupsRoot: team.groupsRoot }
    } catch (error) {
      if (error instanceof ValidationRefusal) return { refused: error.outcome as ValidateOutcome }
      throw error
    }
  }

  /** D8 step 1 for a dry run: the plan is open and the draft exists; computed as if submitted. */
  private async dryRunScope(team: TeamIdentity, planId: string, draftId: string | undefined, caller: ValidationCaller): Promise<{ report: PlanValidationReport } | { refused: ValidateOutcome }> {
    const plan = this.options.plans.forTeam(team.teamId, planId)!
    if (plan.lifecycle !== 'open') {
      return { refused: { ok: false, reason: 'target', message: `The plan is ${plan.lifecycle}; the human must reopen it before a revision can be validated.` } }
    }
    const author = caller.kind === 'agent' ? caller.sessionId : 'human'
    const draft = this.options.plans.getDraft(planId, draftId ?? author)
    if (!draft) {
      return { refused: { ok: false, reason: 'not-found', message: `No draft "${draftId ?? author}" on this plan. Save one first with plan_save_draft.` } }
    }
    // As if submitted: the pin submission would take, and the content hash it would record.
    const strategy = this.options.strategies.forTeam(team.teamId)
    const approved = strategy && strategy.currentApprovedRevision !== null ? this.options.strategies.revision(strategy.id, strategy.currentApprovedRevision) : null
    const pin = approved ? { strategyId: strategy!.id, revision: approved.revision, hash: approved.contentHash } : null
    const max = this.options.plans.revisions(planId).at(-1)?.revision ?? 0
    const file = await this.filePhase(team, draft.content, team.groupsRoot)
    const record = this.store.atomically(() => buildRecordPhase({
      file, content: draft.content, pin,
      plan: { planId, revision: max + 1, contentHash: hashPlanRevision(draft.content, pin) },
      gate: this.dryRunGate(team.teamId, planId, pin),
      impactStateKey: this.options.impact.stateKey(planId),
      claimedPlans: this.options.plans.openPlans(team.teamId).map(other => ({
        planId: other.id, lifecycle: other.lifecycle,
        revisions: this.options.plans.revisions(other.id).map(entry => ({ status: entry.status, content: entry.content })),
      })),
      assessments: [], decisions: [],
    }))
    return { report: dryRunReport(record, planId, caller.kind === 'human' ? { kind: 'human', sessionId: null } : { kind: 'agent', sessionId: caller.sessionId }, new Date().toISOString()) }
  }

  /** The gate of the pin a submission would take (C-I1's rules on the current review's decision for this plan). */
  private dryRunGate(teamId: string, planId: string, pin: PlanStrategyPin | null): ImpactGate {
    const context = this.options.impact.reads.context(teamId)
    const current = context?.current ?? null
    const decision = current ? this.options.impact.store.chainHead(current.id, planId) : null
    return impactGate(pin, context?.view ?? null, current, decision)
  }

  /** The file phase (D8 step 3) over the team's repository. */
  private async filePhase(team: TeamIdentity, content: PlanContent, groupsRoot: string) {
    return runFilePhase({
      adapter: this.options.adapter, commonDir: team.teamId, groupsRoot,
      ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
      content, capacity: group => this.options.capacity?.(team, group) ?? null,
    })
  }

  /** The other open plans as claims read them (D2), for the identity and the checks. */
  private claimedPlans(teamId: string, planId: string): ClaimedPlan[] {
    return this.options.plans.openPlans(teamId)
      .filter(other => other.id !== planId)
      .map(other => ({
        planId: other.id, lifecycle: other.lifecycle,
        revisions: this.options.plans.revisions(other.id).map(entry => ({ status: entry.status, content: entry.content })),
      }))
  }

  // --- D9: the `validation-current` approval precondition ---

  /**
   * The file-held identity parts of one revision, gathered before the
   * approval transaction: hashes and the adapter's cached probe — after the
   * probe cache expires (ten minutes) this spawns `openspec --version` and
   * nothing else; no validate or show runs. Null when the plan or revision
   * does not exist.
   */
  async prepareStanding(planId: string, revision: number): Promise<PreparedValidation | null> {
    const plan = this.options.plans.get(planId)
    const row = plan ? this.options.plans.revision(planId, revision) : null
    if (!plan || !row) return null
    // `plan.teamId` is the common git dir; the groups live in the main tree
    // (teamIdentity's own rule), so resolve from there.
    const identity = await resolveTeam(path.basename(plan.teamId) === '.git' ? path.dirname(plan.teamId) : plan.teamId)
    const branch = row.content.landing.mode === 'integration-branch' ? row.content.landing.branch : null
    const file = await readValidationFileInputs({
      adapter: this.options.adapter, commonDir: plan.teamId,
      changeNames: row.content.changes.map(change => change.change),
      groupNames: [...new Set([
        ...row.content.roles.map(role => role.group),
        ...row.content.changes.flatMap(change => [change.group, change.reviewGroup].filter((group): group is string => group !== null)),
        ...(row.content.reviewGroup ? [row.content.reviewGroup] : []),
      ])],
      groupsRoot: identity.groupsRoot, branch,
      ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
    })
    return { planId, revision, file }
  }

  /**
   * The revision's standing from the prepared file parts and the DB parts
   * read now (D9). Called inside the approval transaction; also the read-only
   * standing for the view and the tools.
   */
  standing(prepared: PreparedValidation): ValidationStanding {
    const row = this.options.plans.revision(prepared.planId, prepared.revision)
    if (!row) return { state: 'not-validated' }
    const branch = row.content.landing.mode === 'integration-branch' ? row.content.landing.branch : null
    const claims = computeClaims(
      prepared.planId,
      this.claimedPlans(this.options.plans.get(prepared.planId)!.teamId, prepared.planId),
      branch,
      row.content.changes.map(change => change.change),
    )
    return computeStanding(
      prepared,
      {
        contentHash: row.contentHash,
        impactStateKey: this.options.impact.stateKey(prepared.planId),
        assessments: this.store.assessments(prepared.planId, prepared.revision),
        decisions: this.store.decisions(prepared.planId, prepared.revision),
      },
      claims,
      this.store.newestReport(prepared.planId, prepared.revision),
    )
  }

  /** D9's precondition entry, appended after the shipped entries (V5). */
  static validationCurrentPrecondition = validationCurrentPrecondition
}
