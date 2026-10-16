// The validation service (plan-validation design D5, D6, D8): rights and
// single flight over the store. Agents and the owner append assessments —
// alignment with its five values, questions, warning findings — bound to an
// `in_review` or `approved` revision of their own team; only the human
// decides (answers, acceptances, condition resolutions, exceptions,
// explorations), each decision idempotent under a command id with the
// strategy-revision-impact replay pattern. Every write runs in one
// transaction, writes only the three validation tables, and pushes the plan
// detail after commit through `PlanStore.announce`. Nothing here approves,
// grants, or clears a mechanical error.
import type { ChatSessionRecord } from '../../db'
import type { TeamIdentity } from '../../team/teamIdentity'
import { loadTeamGroups } from '../../team/teamGroups'
import type { StrategyStore } from '../../strategy/strategyStore'
import { strategyAlignmentRefs } from '../../../shared/planChecks'
import type { Plan, PlanContent, PlanRevision, PlanStrategyPin } from '../../../shared/plans'
import { hashPlanRevision } from '../planHash'
import type { ImpactGate } from '../../../shared/strategyImpact'
import { impactGate } from '../../../shared/strategyImpact'
import type { AlignmentAssessment, AssessmentFinding, AssessmentRow, DecisionRecord, PlanValidationReport, Question, ValidationCapacityEvidence } from '../../../shared/planValidation'
import type { PlanStore } from '../planStore'
import { payloadDifference } from '../planCommands'
import type { ImpactService } from '../../strategy/ImpactService'
import type { OpenspecAdapter } from './openspecAdapter'
import { buildRecordPhase, dryRunReport, runFilePhase } from './validationRun'
import { ValidationCommandRaceError, type ValidationStore } from './validationStore'

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
  | { ok: false; reason: 'not-found' | 'target'; message: string }

export const ASSESS_TEXT_LIMIT = 2_000
export const DECISION_SCOPE_LIMIT = 500
export const AGENT_RECORD_LIMIT = 20

const trimmed = (value: string): string => value.trim()
const overLimit = (value: string, limit: number): boolean => trimmed(value).length > limit

/** An assessment or decision refused inside its transaction; nothing is written. */
class ValidationRefusal extends Error {
  constructor(readonly outcome: { ok: false; reason: string; message: string }) { super(outcome.message) }
}

export class ValidationService {
  constructor(readonly store: ValidationStore, private readonly options: {
    plans: PlanStore
    strategies: StrategyStore
    impact: ImpactService
    adapter: OpenspecAdapter
    getSession: (id: string) => ChatSessionRecord | null | undefined
    /** Capacity evidence per role group (D3's `capacity` row); absent here means no evidence row. */
    capacity?: (teamId: string, group: string) => ValidationCapacityEvidence | null
    homeDir?: string
  }) {}

  /** The caller's team, bound like PlanService's context. */
  private async context(caller: ValidationCaller): Promise<TeamIdentity> {
    if (caller.kind === 'human') return caller.team
    const session = this.options.getSession(caller.sessionId)
    if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
    const { team } = await loadTeamGroups(session.projectPath, this.options.homeDir)
    return team
  }

  /** The plan and revision an assessment or decision targets; refuses by throwing otherwise. */
  private target(team: TeamIdentity, planId: string, revision: number): { plan: Plan; revision: PlanRevision } {
    const plan = this.options.plans.forTeam(team.teamId, planId)
    if (!plan) throw new ValidationRefusal({ ok: false, reason: 'not-found', message: `Plan not found in this team: ${planId}` })
    if (plan.lifecycle !== 'open') {
      throw new ValidationRefusal({ ok: false, reason: 'target', message: `The plan is ${plan.lifecycle}; only an open plan's revisions can be assessed or decided.` })
    }
    const row = this.options.plans.revision(plan.id, revision)
    if (!row || (row.status !== 'in_review' && row.status !== 'approved')) {
      const status = row ? row.status : 'missing'
      throw new ValidationRefusal({ ok: false, reason: 'target', message: `Revision ${revision} is ${status}, not in review or approved; validation binds to a standing revision.` })
    }
    return { plan, revision: row }
  }

  /**
   * D5: append assessments in one transaction. The owner's form (a command
   * id) records exactly one alignment assessment and replays by payload;
   * agent calls carry no command id, so a retry appends.
   */
  async assess(caller: ValidationCaller, input: AssessInput): Promise<AssessOutcome> {
    const team = await this.context(caller)
    const commandId = caller.kind === 'human' ? trimmed(input.command_id ?? '') : ''
    if (caller.kind === 'human') {
      if (!commandId) {
        return { ok: false, reason: 'payload', message: 'The assessment form needs a stable command id so a resend replays instead of repeating.' }
      }
      // D5: the owner's form records exactly one alignment assessment;
      // questions and findings come only from agents.
      if (!input.alignment) {
        return { ok: false, reason: 'payload', message: 'The assessment form records one alignment assessment; questions and findings come from agents.' }
      }
      if ((input.questions?.length ?? 0) > 0 || (input.findings?.length ?? 0) > 0) {
        return { ok: false, reason: 'payload', message: 'The assessment form records only an alignment assessment; questions and findings come from agents.' }
      }
    }
    try {
      const outcome = this.store.atomically((): AssessOutcome => {
        const { revision: row } = this.target(team, input.plan_id, input.revision)
        if (input.alignment) this.checkAlignment(team.teamId, row, input.alignment)
        const questions = input.questions ?? []
        const findings = input.findings ?? []
        if (caller.kind === 'agent' && (questions.length > AGENT_RECORD_LIMIT || findings.length > AGENT_RECORD_LIMIT)) {
          throw new ValidationRefusal({ ok: false, reason: 'limit', message: `An assessment call carries at most ${AGENT_RECORD_LIMIT} questions and ${AGENT_RECORD_LIMIT} findings (got ${questions.length} and ${findings.length}).` })
        }
        for (const question of questions) {
          if (!trimmed(question.text)) throw new ValidationRefusal({ ok: false, reason: 'shape', message: 'Every question needs its text.' })
          if (overLimit(question.text, ASSESS_TEXT_LIMIT)) throw new ValidationRefusal({ ok: false, reason: 'limit', message: 'Question text is over the 2,000-character limit; refused, never cut.' })
        }
        for (const finding of findings) {
          if (!trimmed(finding.text)) throw new ValidationRefusal({ ok: false, reason: 'shape', message: 'Every finding needs its text.' })
          if (overLimit(finding.text, ASSESS_TEXT_LIMIT)) throw new ValidationRefusal({ ok: false, reason: 'limit', message: 'Finding text is over the 2,000-character limit; refused, never cut.' })
        }
        if (commandId && input.alignment) {
          const recorded = this.store.assessmentByCommand(input.plan_id, commandId)
          if (recorded) {
            // The row's own payload_json is the assessment itself, so the
            // compared payload is rebuilt from the row (D5 replay).
            const stored: Record<string, unknown> = { revision: recorded.row.revision, alignment: recorded.row.payload }
            const payload: Record<string, unknown> = { revision: input.revision, alignment: input.alignment }
            const field = payloadDifference(stored as never, payload as never)
            if (field) {
              throw new ValidationRefusal({ ok: false, reason: 'payload', message: `command_id ${commandId} was already used with a different ${field}; the recorded assessment stands and nothing was written.` })
            }
            return { ok: true, replayed: true, ids: { alignment: recorded.row.id, questions: [], findings: [] } }
          }
        }
        if (!input.alignment && questions.length === 0 && findings.length === 0) {
          throw new ValidationRefusal({ ok: false, reason: 'shape', message: 'The assessment carries nothing: an alignment, questions, or findings are required.' })
        }
        const ids = { alignment: null as string | null, questions: [] as string[], findings: [] as string[] }
        const author = caller.kind === 'human' ? { kind: 'human' as const, sessionId: null } : { kind: 'agent' as const, sessionId: caller.sessionId }
        if (input.alignment) {
          const row = this.store.insertAssessment({
            planId: input.plan_id, revision: input.revision, kind: 'alignment', payload: input.alignment as unknown as Record<string, unknown>,
            author, commandId: commandId || null,
          })
          ids.alignment = row.id
        }
        for (const question of questions) {
          ids.questions.push(this.store.insertAssessment({ planId: input.plan_id, revision: input.revision, kind: 'question', payload: question as unknown as Record<string, unknown>, author, commandId: null }).id)
        }
        for (const finding of findings) {
          ids.findings.push(this.store.insertAssessment({ planId: input.plan_id, revision: input.revision, kind: 'finding', payload: finding as unknown as Record<string, unknown>, author, commandId: null }).id)
        }
        return { ok: true, replayed: false, ids }
      })
      if (outcome.ok && !outcome.replayed) this.options.plans.announce(input.plan_id)
      return outcome
    } catch (error) {
      if (error instanceof ValidationRefusal) return error.outcome as AssessOutcome
      if (error instanceof ValidationCommandRaceError && commandId) {
        const recorded = this.store.assessmentByCommand(input.plan_id, commandId)
        if (recorded && input.alignment) {
          const stored: Record<string, unknown> = { revision: recorded.row.revision, alignment: recorded.row.payload }
          const payload: Record<string, unknown> = { revision: input.revision, alignment: input.alignment }
          const field = payloadDifference(stored as never, payload as never)
          if (!field) return { ok: true, replayed: true, ids: { alignment: recorded.row.id, questions: [], findings: [] } }
        }
      }
      throw error
    }
  }

  /** The pinned revision's ref set, or null when the revision has no pin (D5). */
  private pinnedRefs(teamId: string, row: PlanRevision): Set<string> | null {
    if (!row.pin) return null
    const strategy = this.options.strategies.forTeam(teamId)
    const revision = strategy ? this.options.strategies.revision(row.pin.strategyId, row.pin.revision) : null
    return revision ? strategyAlignmentRefs(revision.content) : null
  }

  /** D5's shape and limit rules for one alignment assessment. */
  private checkAlignment(teamId: string, row: PlanRevision, alignment: AlignmentAssessment): void {
    if (!row.pin) {
      throw new ValidationRefusal({ ok: false, reason: 'target', message: 'no approved strategy: alignment is unassessed' })
    }
    if (!trimmed(alignment.rationale)) {
      throw new ValidationRefusal({ ok: false, reason: 'shape', message: 'An alignment assessment needs its rationale.' })
    }
    if (overLimit(alignment.rationale, ASSESS_TEXT_LIMIT)) {
      throw new ValidationRefusal({ ok: false, reason: 'limit', message: 'The rationale is over the 2,000-character limit; refused, never cut.' })
    }
    const value = alignment.assessment
    if (value === 'aligned-with-conditions' && alignment.conditions.length === 0) {
      throw new ValidationRefusal({ ok: false, reason: 'shape', message: 'An aligned-with-conditions assessment needs at least one condition.' })
    }
    if (value === 'exploratory' && (!alignment.experiment || !trimmed(alignment.experiment.criteria) || !trimmed(alignment.experiment.scope))) {
      throw new ValidationRefusal({ ok: false, reason: 'shape', message: 'An exploratory assessment needs experiment criteria and scope.' })
    }
    if (value === 'conflicting' && alignment.conflicts.length === 0) {
      throw new ValidationRefusal({ ok: false, reason: 'shape', message: 'A conflicting assessment needs at least one conflict.' })
    }
    for (const [index, condition] of alignment.conditions.entries()) {
      if (!trimmed(condition.text)) throw new ValidationRefusal({ ok: false, reason: 'shape', message: `Condition ${index + 1} needs its text.` })
      if (!['ready', 'start', 'acceptance'].includes(condition.gate)) throw new ValidationRefusal({ ok: false, reason: 'shape', message: `Condition ${index + 1} gates at ready, start, or acceptance.` })
      if (overLimit(condition.text, ASSESS_TEXT_LIMIT)) throw new ValidationRefusal({ ok: false, reason: 'limit', message: `Condition ${index + 1} is over the 2,000-character limit; refused, never cut.` })
    }
    for (const conflict of alignment.conflicts) {
      if (!trimmed(conflict)) throw new ValidationRefusal({ ok: false, reason: 'shape', message: 'Every conflict needs its text.' })
      if (overLimit(conflict, ASSESS_TEXT_LIMIT)) throw new ValidationRefusal({ ok: false, reason: 'limit', message: 'A conflict is over the 2,000-character limit; refused, never cut.' })
    }
    const defined = this.pinnedRefs(teamId, row)
    if (defined) {
      const unknown = alignment.outcomes.filter(ref => !defined.has(ref))
      if (unknown.length > 0) {
        throw new ValidationRefusal({ ok: false, reason: 'shape', message: `Alignment reference "${unknown[0]}" is not defined by strategy revision ${row.pin.revision}.` })
      }
    }
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
      const { revision: row } = this.target(team, input.planId, input.revision)
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
      const raised = new Set([...newest.findings.filter(finding => finding.severity === 'warning').map(finding => finding.key), ...newest.readiness.unacceptedWarnings])
      if (!raised.has(target)) refuse(`Warning key "${target}" is not raised by revision ${revision}'s newest report (report ${newest.seq}).`)
      return
    }
    const alignments = assessments.filter((row): row is Extract<AssessmentRow, { kind: 'alignment' }> => row.kind === 'alignment')
    if (kind === 'resolve-condition') {
      const [id, index] = target.split('#')
      const assessed = alignments.find(row => row.id === id)
      const position = Number(index)
      if (!assessed || !Number.isInteger(position) || position < 0 || position >= assessed.payload.conditions.length) {
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
    const team = await this.context(caller)
    const plan = this.options.plans.forTeam(team.teamId, input.planId)
    if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${input.planId}` }
    const key = 'revision' in input && input.revision !== undefined
      ? `${plan.id}:r${input.revision}`
      : `${plan.id}:d${'draftId' in input && input.draftId !== undefined ? input.draftId : ''}`
    const running = this.running.get(key)
    if (running) return running
    const outcome = (async (): Promise<ValidateOutcome> => {
      try {
        const dryRun = !('revision' in input && input.revision !== undefined)
        if (dryRun) {
          const checked = await this.dryRunScope(team, plan.id, 'draftId' in input ? input.draftId : undefined, caller)
          if ('refused' in checked) return checked.refused
          return { ok: true, report: checked.report, reportId: null, stored: false, dryRun: true }
        }
        const revision = input.revision as number
        const checked = await this.revisionScope(team, plan.id, revision)
        if ('refused' in checked) return checked.refused
        const { plan: open, revision: row, groupsRoot } = checked
        const file = await this.filePhase(team, row.content, groupsRoot)
        const record = this.store.atomically(() => {
          const fresh = this.target(team, plan.id, revision)
          const gate = this.options.impact.gate(plan.id, revision)
          if (!gate) throw new ValidationRefusal({ ok: false, reason: 'target', message: `Revision ${revision} lost its impact gate mid-run; validate again.` })
          const assessments = this.store.assessments(plan.id, revision)
          const decisions = this.store.decisions(plan.id, revision)
          return buildRecordPhase({
            file, content: row.content, pin: row.pin,
            plan: { planId: plan.id, revision, contentHash: fresh.revision.contentHash },
            gate, impactStateKey: this.options.impact.stateKey(plan.id),
            claimedPlans: this.options.plans.openPlans(team.teamId).map(other => ({
              planId: other.id, lifecycle: other.lifecycle,
              revisions: this.options.plans.revisions(other.id).map(entry => ({ status: entry.status, content: entry.content })),
            })),
            assessments, decisions,
          })
        })
        const newest = this.store.newestReport(plan.id, revision)
        if (newest && newest.inputHash === record.inputHash) {
          return { ok: true, report: newest, reportId: newest.id, stored: false, dryRun: false }
        }
        const report = this.store.atomically(() => this.store.insertReport({
          planId: plan.id, revision, inputHash: record.inputHash, inputs: record.inputs,
          findings: record.findings, relations: record.relations, evidence: record.evidence,
          readiness: record.readiness, ready: record.ready,
          requestedBy: caller.kind === 'human' ? { kind: 'human', sessionId: null } : { kind: 'agent', sessionId: caller.sessionId },
        }))
        this.options.plans.announce(plan.id)
        return { ok: true, report, reportId: report.id, stored: true, dryRun: false }
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
      content, capacity: group => this.options.capacity?.(team.teamId, group) ?? null,
    })
  }
}
