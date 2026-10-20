// Plan tools on the per-session `kawai-team` MCP server (durable-plans design
// D11). The registered surface is EXACTLY the five tools below — read,
// create, draft, submit. There is no plan_approve, plan_withdraw, plan_close,
// or plan_reopen handler, and none may be added: approval and the lifecycle
// belong to the human (the plan's owner) in the Plans view, and PlanService
// refuses an agent caller on those paths as well. Handlers bind the calling
// session id and strip unknown arguments, so a forged actor or team in the
// input never reaches the service; `plan_create` reads `canCreatePlans` from
// the caller's current group file at each call.
import { z } from 'zod'
import type { PlanService } from './PlanService'

export const PLAN_TOOL_NAMES = ['plan_list', 'plan_get', 'plan_create', 'plan_save_draft', 'plan_submit_for_review'] as const

/** Every name an agent might reach for that must NOT exist (D11). */
export const PLAN_FORBIDDEN_TOOL_NAMES = ['plan_approve', 'plan_withdraw', 'plan_close', 'plan_reopen', 'plan_complete', 'plan_cancel', 'plan_discard_draft'] as const

export const planSchemas = {
  plan_list: z.object({ status: z.string().optional() }),
  plan_get: z.object({ plan_id: z.string().min(1) }),
  plan_create: z.object({ title: z.string().min(1), content: z.record(z.string(), z.unknown()).optional() }),
  plan_save_draft: z.object({
    plan_id: z.string().min(1),
    /** The template's content object; normalized server-side. */
    content: z.record(z.string(), z.unknown()),
    draft_id: z.string().optional(),
    expected_base_revision: z.number().int().nullable().optional(),
    expected_draft_hash: z.string().nullable().optional(),
  }),
  plan_submit_for_review: z.object({ plan_id: z.string().min(1), draft_id: z.string().optional() }),
}

export const planDescriptions: Record<(typeof PLAN_TOOL_NAMES)[number], string> = {
  plan_list: "List this team's plans with lifecycle (open/completed/cancelled), displayed state, approved revision, strategy pin, and linked-task count. Optional status filters by lifecycle or state (draft, ready, in-progress, completed, cancelled).",
  plan_get: 'Read one plan in full: the record, every revision with content, hash, and strategy pin, the drafts, the event history, linked tasks, and per-change progress of the approved revision.',
  plan_create: 'Create a plan (only if your group sets canCreatePlans: true): a title and optional template content (goal, success criteria, non-goals, approach, alignment, changes, acceptance, checks, landing, roles, review group). Your draft holds the content; nothing is approved.',
  plan_save_draft: 'Save a plan draft (template content; structural faults are refused with every violation). Optional content.leadGroup names the plan\'s Lead role, one of its roles; unset, questions and fixes go to the owner. A change\'s optional fixes lists the fix or correction task ids (task-<uuid>, no repeats) it answers; one task may span several changes, and an id that is no fix or correction task of the plan only warns. Pass expected_draft_hash (and optionally expected_base_revision) from your last read: a mismatch writes nothing and returns the stored draft — reconcile, do not overwrite. Never changes an approved revision.',
  plan_submit_for_review: 'Submit your draft (or draft_id) as the next numbered revision in review, pinned to the team\'s current approved strategy revision. Only the human approves, withdraws, completes, cancels, or reopens a plan — no tool of yours can.',
}

export function planHandlers(plans: PlanService, sessionId: string) {
  // Identity is bound here, never taken from arguments (D11).
  const caller = { kind: 'agent' as const, sessionId }
  return {
    plan_list: async (input: unknown) => plans.list(caller, planSchemas.plan_list.parse(input).status),
    plan_get: async (input: unknown) => plans.get(caller, planSchemas.plan_get.parse(input).plan_id),
    plan_create: async (input: unknown) => {
      const { title, content } = planSchemas.plan_create.parse(input)
      return plans.create(caller, { title, ...(content !== undefined ? { content } : {}) })
    },
    plan_save_draft: async (input: unknown) => {
      const parsed = planSchemas.plan_save_draft.parse(input)
      return plans.saveDraft(caller, {
        plan_id: parsed.plan_id,
        content: parsed.content,
        ...(parsed.draft_id !== undefined ? { draft_id: parsed.draft_id } : {}),
        ...(parsed.expected_base_revision !== undefined ? { expected_base_revision: parsed.expected_base_revision } : {}),
        ...(parsed.expected_draft_hash !== undefined ? { expected_draft_hash: parsed.expected_draft_hash } : {}),
      })
    },
    plan_submit_for_review: async (input: unknown) => {
      const { plan_id, draft_id } = planSchemas.plan_submit_for_review.parse(input)
      return plans.submit(caller, { plan_id, ...(draft_id !== undefined ? { draft_id } : {}) })
    },
  }
}
