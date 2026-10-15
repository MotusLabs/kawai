// Strategy tools on the per-session `kawai-team` MCP server (product-
// strategy design D3). The registered surface is EXACTLY the four tools
// below — read and propose. There is no strategy_approve, strategy_publish,
// strategy_withdraw, or strategy_delete handler, and none may be added "for
// convenience": the spec's guarantee (S05/S09) is that no agent tool surface
// can approve, publish, withdraw, or delete a revision, and StrategyService
// refuses an agent caller on those paths as well. Handlers bind the calling
// session id and strip unknown arguments, so a forged actor kind or team in
// the input is never seen by the service.
import { z } from 'zod'
import type { StrategyService } from './StrategyService'

export const STRATEGY_TOOL_NAMES = ['strategy_list', 'strategy_get', 'strategy_save_draft', 'strategy_submit_for_review'] as const

/** Every name an agent might reach for that must NOT exist (S05/S09). */
export const STRATEGY_FORBIDDEN_TOOL_NAMES = ['strategy_approve', 'strategy_publish', 'strategy_withdraw', 'strategy_delete'] as const

export const strategySchemas = {
  strategy_list: z.object({}),
  strategy_get: z.object({ product_id: z.string().optional() }),
  strategy_save_draft: z.object({
    /** The template's content object; normalized server-side. */
    content: z.record(z.string(), z.unknown()),
    impact_proposal: z.string().optional(),
    draft_id: z.string().optional(),
    expected_base_revision: z.number().int().nullable().optional(),
    expected_draft_hash: z.string().nullable().optional(),
  }),
  strategy_submit_for_review: z.object({ draft_id: z.string().optional() }),
}

export const strategyDescriptions: Record<(typeof STRATEGY_TOOL_NAMES)[number], string> = {
  strategy_list: "List this team's product strategies (one per product). Read-only.",
  strategy_get: 'Read the product strategy in full: the record, every revision with content and hash, existing drafts, evidence, and decisions. Returns null when the product has no strategy yet.',
  strategy_save_draft: 'Save a working draft of the product strategy (template content; optional impact_proposal for a material direction change). Concurrent saves are refused with the stored draft — reconcile, do not overwrite. Never changes the approved strategy.',
  strategy_submit_for_review: 'Submit your draft for review; it becomes a numbered InReview revision. Only the human approves, publishes, or withdraws — no tool of yours can.',
}

export function strategyHandlers(strategies: StrategyService, sessionId: string) {
  // Identity is bound here, never taken from arguments (D3).
  const caller = { kind: 'agent' as const, sessionId }
  return {
    strategy_list: async (_input: unknown) => strategies.list(caller),
    strategy_get: async (input: unknown) => strategies.get(caller, strategySchemas.strategy_get.parse(input).product_id),
    strategy_save_draft: async (input: unknown) => {
      const parsed = strategySchemas.strategy_save_draft.parse(input)
      return strategies.saveDraft(caller, {
        content: parsed.content,
        ...(parsed.impact_proposal !== undefined ? { impact_proposal: parsed.impact_proposal } : {}),
        ...(parsed.draft_id !== undefined ? { draft_id: parsed.draft_id } : {}),
        ...(parsed.expected_base_revision !== undefined ? { expected_base_revision: parsed.expected_base_revision } : {}),
        ...(parsed.expected_draft_hash !== undefined ? { expected_draft_hash: parsed.expected_draft_hash } : {}),
      })
    },
    strategy_submit_for_review: async (input: unknown) => {
      const parsed = strategySchemas.strategy_submit_for_review.parse(input)
      return strategies.submitForReview(caller, parsed.draft_id !== undefined ? { draft_id: parsed.draft_id } : {})
    },
  }
}
