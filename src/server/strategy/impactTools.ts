// Strategy impact tools on the per-session `kawai-team` MCP server
// (strategy-revision-impact design D10): exactly the two tools below — read
// the impact review and propose a disposition. There is no
// strategy_impact_decide or strategy_impact_record handler, and none may be
// added: only the owner records a decision, in the Strategy view, and
// ImpactService refuses an agent caller on the decide and request paths as
// well. Handlers bind the calling session id and strip unknown arguments, so
// a forged actor or team in the input never reaches the service.
import { z } from 'zod'
import type { ImpactService } from './ImpactService'

export const IMPACT_TOOL_NAMES = ['strategy_impact_get', 'strategy_impact_propose'] as const

export const impactSchemas = {
  strategy_impact_get: z.object({ review_id: z.string().min(1).optional() }),
  strategy_impact_propose: z.object({
    plan_id: z.string().min(1),
    disposition: z.enum(['continue', 'adapt', 'reconsider']),
    rationale: z.string(),
    review_id: z.string().min(1).optional(),
  }),
}

export const impactDescriptions: Record<(typeof IMPACT_TOOL_NAMES)[number], string> = {
  strategy_impact_get: "Read the team's strategy impact reviews: the current review's affected, unaffected, and historical plans with each revision's strategy pin and gate, the owner's effective decision and history, and the newest proposal; earlier reviews with their records. Pass review_id for one review's records. Null when the product has no strategy record.",
  strategy_impact_propose: 'Propose one disposition for an affected plan in the current review — continue (keep working on its pinned strategy revision), adapt, or reconsider — with a rationale grounded in what changed between the pinned and the current revision (at most 2,000 characters). A proposal changes nothing: only the owner records decisions, in the Strategy view.',
}

export function impactHandlers(impact: ImpactService, sessionId: string) {
  // Identity is bound here, never taken from arguments (D10).
  const caller = { kind: 'agent' as const, sessionId }
  return {
    strategy_impact_get: async (input: unknown) => impact.get(caller, impactSchemas.strategy_impact_get.parse(input).review_id),
    strategy_impact_propose: async (input: unknown) => {
      const parsed = impactSchemas.strategy_impact_propose.parse(input)
      return impact.propose(caller, {
        planId: parsed.plan_id, disposition: parsed.disposition, rationale: parsed.rationale,
        ...(parsed.review_id !== undefined ? { reviewId: parsed.review_id } : {}),
      })
    },
  }
}
