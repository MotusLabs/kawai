// The `team_capacity` tool on the per-session `kawai-team` MCP server
// (dispatch-worker-choice D6): read-only, bound to the calling session's team
// — a team argument is never accepted — and answering from the same routing
// objects a dispatch pass reads (`TeamCapacity`).
import { z } from 'zod'
import type { TeamCapacity } from './teamCapacity'

export const CAPACITY_TOOL_NAMES = ['team_capacity'] as const

export const capacitySchemas = {
  team_capacity: z.object({ group: z.string().min(1).optional() }),
}

export const capacityDescriptions: Record<(typeof CAPACITY_TOOL_NAMES)[number], string> = {
  team_capacity: 'Read your team\'s capacity now, as group routing sees it: each group (or only the optional group) with its max, live count, strategy, and workers in preference order — model, provider, cap, live members (pending spawns included), and cooldown end — and each listed provider\'s latest usage (windows with percent used and reset time, status, received time, source) and cooldown end. usage null means kawai holds no report for that provider (none since the server started), never zero use. sharesLoginWith names the other team providers detected as drawing on the same login, even ones this answer does not list; an empty list means sharing was not detected, not that the providers are independent. Read-only: nothing is fetched or stored.',
}

export function capacityHandlers(capacity: TeamCapacity, sessionId: string) {
  return {
    team_capacity: async (input: unknown) => capacity.read(sessionId, capacitySchemas.team_capacity.parse(input)),
  }
}
