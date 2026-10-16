// Assessment writes (plan-validation design D5), split from the service so
// each file stays small: the refusal type and target rules shared with
// decisions, and `assessValidation` — one transaction appending an alignment
// assessment, questions, and findings to a standing revision of the caller's
// team. The owner's form records exactly one alignment per command id and
// replays by the row's own payload; agent calls carry no command id, so a
// retry appends. Nothing here decides, accepts, or approves.
import type { ChatSessionRecord } from '../../db'
import type { TeamIdentity } from '../../team/teamIdentity'
import { loadTeamGroups } from '../../team/teamGroups'
import type { StrategyStore } from '../../strategy/strategyStore'
import { strategyAlignmentRefs } from '../../../shared/planChecks'
import type { Plan, PlanRevision } from '../../../shared/plans'
import type { AlignmentAssessment } from '../../../shared/planValidation'
import type { PlanStore } from '../planStore'
import { payloadDifference } from '../planCommands'
import type { ValidationCaller, AssessInput, AssessOutcome } from './ValidationService'
import { ValidationCommandRaceError, type ValidationStore } from './validationStore'

export const ASSESS_TEXT_LIMIT = 2_000
export const AGENT_RECORD_LIMIT = 20

export const trimmed = (value: string): string => value.trim()
export const overLimit = (value: string, limit: number): boolean => trimmed(value).length > limit

/** An assessment or decision refused inside its transaction; nothing is written. */
export class ValidationRefusal extends Error {
  constructor(readonly outcome: { ok: false; reason: string; message: string }) { super(outcome.message) }
}

/** What the assessment path reads: the same options the service holds. */
export interface ValidationDeps {
  store: ValidationStore
  plans: PlanStore
  strategies: StrategyStore
  getSession: (id: string) => ChatSessionRecord | null | undefined
  homeDir?: string
}

/** The caller's team, bound like PlanService's context. */
export async function validationContext(deps: ValidationDeps, caller: ValidationCaller): Promise<TeamIdentity> {
  if (caller.kind === 'human') return caller.team
  const session = deps.getSession(caller.sessionId)
  if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
  const { team } = await loadTeamGroups(session.projectPath, deps.homeDir)
  return team
}

/** The plan and revision an assessment or decision targets; refuses by throwing otherwise. */
export function validationTarget(deps: ValidationDeps, team: TeamIdentity, planId: string, revision: number): { plan: Plan; revision: PlanRevision } {
  const plan = deps.plans.forTeam(team.teamId, planId)
  if (!plan) throw new ValidationRefusal({ ok: false, reason: 'not-found', message: `Plan not found in this team: ${planId}` })
  if (plan.lifecycle !== 'open') {
    throw new ValidationRefusal({ ok: false, reason: 'target', message: `The plan is ${plan.lifecycle}; only an open plan's revisions can be assessed or decided.` })
  }
  const row = deps.plans.revision(plan.id, revision)
  if (!row || (row.status !== 'in_review' && row.status !== 'approved')) {
    const status = row ? row.status : 'missing'
    throw new ValidationRefusal({ ok: false, reason: 'target', message: `Revision ${revision} is ${status}, not in review or approved; validation binds to a standing revision.` })
  }
  return { plan, revision: row }
}

/**
 * D5: append assessments in one transaction. The owner's form (a command
 * id) records exactly one alignment assessment and replays by payload;
 * agent calls carry no command id, so a retry appends. Questions and
 * findings come only from agents.
 */
export async function assessValidation(deps: ValidationDeps, caller: ValidationCaller, input: AssessInput): Promise<AssessOutcome> {
  const team = await validationContext(deps, caller)
  const commandId = caller.kind === 'human' ? trimmed(input.command_id ?? '') : ''
  if (caller.kind === 'human') {
    if (!commandId) {
      return { ok: false, reason: 'payload', message: 'The assessment form needs a stable command id so a resend replays instead of repeating.' }
    }
    if (!input.alignment) {
      return { ok: false, reason: 'payload', message: 'The assessment form records one alignment assessment; questions and findings come from agents.' }
    }
    if ((input.questions?.length ?? 0) > 0 || (input.findings?.length ?? 0) > 0) {
      return { ok: false, reason: 'payload', message: 'The assessment form records only an alignment assessment; questions and findings come from agents.' }
    }
  }
  try {
    const outcome = deps.store.atomically((): AssessOutcome => {
      const { revision: row } = validationTarget(deps, team, input.plan_id, input.revision)
      if (input.alignment) checkAlignment(deps, team.teamId, row, input.alignment)
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
        const recorded = deps.store.assessmentByCommand(input.plan_id, commandId)
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
        const row = deps.store.insertAssessment({
          planId: input.plan_id, revision: input.revision, kind: 'alignment', payload: input.alignment as unknown as Record<string, unknown>,
          author, commandId: commandId || null,
        })
        ids.alignment = row.id
      }
      for (const question of questions) {
        ids.questions.push(deps.store.insertAssessment({ planId: input.plan_id, revision: input.revision, kind: 'question', payload: question as unknown as Record<string, unknown>, author, commandId: null }).id)
      }
      for (const finding of findings) {
        ids.findings.push(deps.store.insertAssessment({ planId: input.plan_id, revision: input.revision, kind: 'finding', payload: finding as unknown as Record<string, unknown>, author, commandId: null }).id)
      }
      return { ok: true, replayed: false, ids }
    })
    if (outcome.ok && !outcome.replayed) deps.plans.announce(input.plan_id)
    return outcome
  } catch (error) {
    if (error instanceof ValidationRefusal) return error.outcome as AssessOutcome
    if (error instanceof ValidationCommandRaceError && commandId) {
      const recorded = deps.store.assessmentByCommand(input.plan_id, commandId)
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
function pinnedRefs(deps: ValidationDeps, teamId: string, row: PlanRevision): Set<string> | null {
  if (!row.pin) return null
  const strategy = deps.strategies.forTeam(teamId)
  const revision = strategy ? deps.strategies.revision(row.pin.strategyId, row.pin.revision) : null
  return revision ? strategyAlignmentRefs(revision.content) : null
}

/** D5's shape and limit rules for one alignment assessment. */
function checkAlignment(deps: ValidationDeps, teamId: string, row: PlanRevision, alignment: AlignmentAssessment): void {
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
  const defined = pinnedRefs(deps, teamId, row)
  if (defined) {
    const unknown = alignment.outcomes.filter(ref => !defined.has(ref))
    if (unknown.length > 0) {
      throw new ValidationRefusal({ ok: false, reason: 'shape', message: `Alignment reference "${unknown[0]}" is not defined by strategy revision ${row.pin.revision}.` })
    }
  }
}
