// The read-only incident advice tools on the per-session `kawai-team` MCP
// server (process-quota-history-and-incident-advice D6, task 4.5): bound to
// the calling session's team — no team argument exists, and another team's
// id reads as unknown (R7) — and returning exactly the stored records the
// Metrics view shows. No tool approves, applies, decides, routes or switches
// anything (R8, X3).
import { z } from 'zod'
import type { ProcessRecommendation, ProcessRecommendationDetail } from '../../../shared/processRecommendations'

export const RECOMMENDATION_TOOL_NAMES = ['process_recommendations_list', 'process_recommendation_get'] as const

export const recommendationSchemas = {
  process_recommendations_list: z.strictObject({ limit: z.number().int().min(1).max(200).optional() }),
  process_recommendation_get: z.strictObject({ id: z.string().min(1) }),
}

export const recommendationDescriptions: Record<(typeof RECOMMENDATION_TOOL_NAMES)[number], string> = {
  process_recommendations_list: 'List your team\'s incident recommendations (quota limits and context exhaustion), newest first, each with its current assessment: advice choice, provisional flag, alternatives frozen at the cutoff with their exclusions and headroom freshness, facts, assumptions, unknowns, and the attention item it attaches to. Optional limit 1–200 (default 50). Read-only: no tool approves or applies advice.',
  process_recommendation_get: 'Read one of your team\'s recommendations by id with every assessment version, oldest first, and each version\'s frozen evidence summaries (an expired link means the detailed observation was pruned; the summary stays). Another team\'s id reads as unknown. Read-only.',
}

export interface RecommendationToolDeps {
  teamOf: (sessionId: string) => string | null
  store: {
    list: (teamId: string, limit?: number) => ProcessRecommendation[]
    get: (teamId: string, id: string) => ProcessRecommendationDetail | null
  }
}

function teamOf(deps: RecommendationToolDeps, sessionId: string): string {
  const teamId = deps.teamOf(sessionId)
  if (!teamId) throw new Error('This session belongs to no team yet, so there are no recommendations to read.')
  return teamId
}

export function recommendationHandlers(deps: RecommendationToolDeps, sessionId: string) {
  return {
    process_recommendations_list: async (input: unknown) => {
      const { limit } = recommendationSchemas.process_recommendations_list.parse(input ?? {})
      return { recommendations: deps.store.list(teamOf(deps, sessionId), limit ?? 50) }
    },
    process_recommendation_get: async (input: unknown) => {
      const { id } = recommendationSchemas.process_recommendation_get.parse(input)
      const found = deps.store.get(teamOf(deps, sessionId), id)
      if (!found) throw new Error(`Unknown recommendation "${id}" in your team.`)
      return found
    },
  }
}
