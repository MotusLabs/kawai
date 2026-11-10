// Per-turn token counts (design §6, task 5.2). A Claude result's `usage` (one
// turn's input, output, cache-read and cache-creation tokens) becomes a
// TokenUsage. A field the provider did not report is null, never the legacy
// zero, and a result with no usage object at all has none.
import type { TokenUsage } from './types.js'

const count = (usage: Record<string, unknown>, key: string): number | null => {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** A Claude result frame's `usage` as the turn's tokens; null when it carries none. */
export function claudeResultUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const slice = usage as Record<string, unknown>
  return {
    inputTokens: count(slice, 'input_tokens'),
    outputTokens: count(slice, 'output_tokens'),
    cacheReadTokens: count(slice, 'cache_read_input_tokens'),
    cacheCreationTokens: count(slice, 'cache_creation_input_tokens'),
  }
}
