// Validation tools on the per-session `kawai-team` MCP server
// (plan-validation design D10). The registered surface is EXACTLY the three
// tools below — validate, read, assess. None answers a question, accepts a
// warning, resolves a condition, records an exception, authorizes
// exploration, or approves: those are the owner's decisions through the
// Plans view, and no handler for them may be added. Handlers bind the
// calling session id and strip unknown arguments; another team's plan ids
// read as not found.
import { z } from 'zod'
import type { ValidationService } from './ValidationService'
import type { Finding, PlanValidationReport, Readiness } from '../../../shared/planValidation'

export const VALIDATION_TOOL_NAMES = ['plan_validate', 'plan_validation_get', 'plan_assess'] as const

/** Every name an agent might reach for that must NOT exist (D10). */
export const VALIDATION_FORBIDDEN_TOOL_NAMES = [
  'plan_decide', 'plan_validation_decide', 'plan_accept_warning', 'plan_answer', 'plan_answer_question',
  'plan_resolve_condition', 'plan_alignment_exception', 'plan_authorize_exploration', 'plan_approve',
] as const

/** Findings a tool returns, capped with the full count kept (D10). */
export const TOOL_FINDING_CAP = 50

/** A report as `plan_validate` returns it: identity, readiness summary, capped errors and warnings. */
export function summarizeReport(report: PlanValidationReport): {
  report_id: string | null
  revision: number
  seq: number
  input_hash: string
  ready: boolean
  dry_run: boolean
  errors: { items: Finding[]; count: number }
  warnings: { items: Finding[]; count: number }
  readiness: Readiness
} {
  const cap = (findings: Finding[]): { items: Finding[]; count: number } =>
    ({ items: findings.slice(0, TOOL_FINDING_CAP), count: findings.length })
  return {
    report_id: report.dryRun ? null : report.id,
    revision: report.revision,
    seq: report.seq,
    input_hash: report.inputHash,
    ready: report.ready,
    dry_run: report.dryRun,
    errors: cap(report.findings.filter(finding => finding.severity === 'error')),
    warnings: cap(report.findings.filter(finding => finding.severity === 'warning')),
    readiness: report.readiness,
  }
}

export const validationSchemas = {
  plan_validate: z.object({
    plan_id: z.string().min(1),
    revision: z.number().int().optional(),
    /** A dry run of this draft instead of a stored revision. */
    draft_id: z.string().optional(),
  }),
  plan_validation_get: z.object({
    plan_id: z.string().min(1),
    revision: z.number().int().optional(),
    report_id: z.string().min(1).optional(),
  }),
  plan_assess: z.object({
    plan_id: z.string().min(1),
    revision: z.number().int(),
    alignment: z.object({
      assessment: z.enum(['aligned', 'aligned-with-conditions', 'exploratory', 'conflicting', 'insufficient-information']),
      outcomes: z.array(z.string()).optional(),
      conditions: z.array(z.object({ text: z.string(), gate: z.enum(['ready', 'start', 'acceptance']) })).optional(),
      experiment: z.object({ criteria: z.string(), scope: z.string() }).nullable().optional(),
      conflicts: z.array(z.string()).optional(),
      rationale: z.string().optional(),
    }).optional(),
    questions: z.array(z.object({ text: z.string().min(1), mandatory: z.boolean(), subject: z.string().nullable().optional() })).max(20).optional(),
    findings: z.array(z.object({ text: z.string().min(1), subject: z.string().nullable().optional() })).max(20).optional(),
  }),
}

export const validationDescriptions: Record<(typeof VALIDATION_TOOL_NAMES)[number], string> = {
  plan_validate: 'Validate a plan revision of your team (the newest in review by default, else the approved one), or dry-run a draft (draft_id): an immutable report of the technical checks — registration, strict validation, relations, claims, groups, profiles, branch — with readiness. Validation never approves anything; only the human decides and approves. Validating unchanged inputs writes nothing.',
  plan_validation_get: 'Read one validation report (newest by default, or report_id) with its standing computed now (Not validated, Blocked, Ready, Out of date naming what changed), plus the revision\'s assessments and decisions. Read-only; decides nothing.',
  plan_assess: 'Append an assessment to a standing plan revision: one alignment assessment (aligned, aligned-with-conditions, exploratory, conflicting, insufficient-information — outcomes cite refs the pinned strategy defines, conditions gate at ready/start/acceptance), up to 20 questions and 20 warning findings. Assessments accumulate and never clear an error; mandatory questions block until the owner answers them. You never decide or approve.',
}

export function validationHandlers(validation: ValidationService, sessionId: string) {
  // Identity is bound here, never taken from arguments (D10).
  const caller = { kind: 'agent' as const, sessionId }
  return {
    plan_validate: async (input: unknown) => {
      const parsed = validationSchemas.plan_validate.parse(input)
      const revision = await resolveRevision(validation, caller, parsed)
      if (typeof revision !== 'number') return revision
      const outcome = await validation.validate(caller, parsed.draft_id !== undefined
        ? { planId: parsed.plan_id, draftId: parsed.draft_id }
        : { planId: parsed.plan_id, revision })
      return outcome.ok ? summarizeReport(outcome.report) : outcome
    },
    plan_validation_get: async (input: unknown) => {
      const parsed = validationSchemas.plan_validation_get.parse(input)
      return validation.validationGet(caller, {
        planId: parsed.plan_id,
        ...(parsed.revision !== undefined ? { revision: parsed.revision } : {}),
        ...(parsed.report_id !== undefined ? { reportId: parsed.report_id } : {}),
      })
    },
    plan_assess: async (input: unknown) => {
      const parsed = validationSchemas.plan_assess.parse(input)
      return validation.assess(caller, {
        plan_id: parsed.plan_id,
        revision: parsed.revision,
        ...(parsed.alignment !== undefined ? {
          alignment: {
            assessment: parsed.alignment.assessment,
            outcomes: parsed.alignment.outcomes ?? [],
            conditions: parsed.alignment.conditions ?? [],
            experiment: parsed.alignment.experiment ?? null,
            conflicts: parsed.alignment.conflicts ?? [],
            rationale: parsed.alignment.rationale ?? '',
          },
        } : {}),
        ...(parsed.questions !== undefined ? { questions: parsed.questions.map(question => ({ text: question.text, mandatory: question.mandatory, subject: question.subject ?? null })) } : {}),
        ...(parsed.findings !== undefined ? { findings: parsed.findings.map(finding => ({ text: finding.text, subject: finding.subject ?? null })) } : {}),
      })
    },
  }
}

/** The revision a validate call targets: the explicit one, or the newest in review, else the approved one (D10). */
async function resolveRevision(validation: ValidationService, caller: { kind: 'agent'; sessionId: string }, parsed: { plan_id: string; revision?: number; draft_id?: string }): Promise<number | { ok: false; reason: string; message: string }> {
  if (parsed.revision !== undefined) return parsed.revision
  if (parsed.draft_id !== undefined) return -1
  const defaulted = await validation.defaultRevisionFor(caller, parsed.plan_id)
  return defaulted.ok
    ? defaulted.revision!
    : { ok: false, reason: defaulted.reason, message: defaulted.message }
}
