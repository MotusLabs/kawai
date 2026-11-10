// Per-turn token counts (design §6, task 5.2). A field the provider did not
// report is null, never the legacy zero, and a source with no usage at all
// has none.
// - Claude: a result's `usage` (one turn's input, output, cache-read and
//   cache-creation tokens).
// - Codex: thread/tokenUsage/updated carries the thread's running `total`
//   and the latest request's `last`. A turn's requests are the difference
//   between consecutive totals. The first update of a generation, or one
//   whose total went down (a counter reset), counts its `last` instead: a
//   difference against a missing or reset total would credit the turn with
//   history it never ran. A counter missing from either total stays null.
//   Codex input includes the cached input, so input is reported without it.
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

/** The counters of one Codex ThreadTokenUsage breakdown. */
export interface CodexTokenBreakdown {
  totalTokens?: unknown
  inputTokens?: unknown
  cachedInputTokens?: unknown
  outputTokens?: unknown
  cacheWriteInputTokens?: unknown
}

const CODEX_KEYS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'cacheWriteInputTokens'] as const

/** Codex request tokens as a turn's TokenUsage (input without the cached part); null without a breakdown. */
export function codexRequestUsage(requests: CodexTokenBreakdown | null): TokenUsage | null {
  if (!requests) return null
  const slice = requests as Record<string, unknown>
  const input = count(slice, 'inputTokens')
  const cached = count(slice, 'cachedInputTokens')
  return {
    inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
    outputTokens: count(slice, 'outputTokens'),
    cacheReadTokens: cached,
    cacheCreationTokens: count(slice, 'cacheWriteInputTokens'),
  }
}

/**
 * The requests one tokenUsage update adds: the difference to the previous
 * total, or `last` when there is no previous total or a counter went down.
 */
export function codexUpdateRequests(total: CodexTokenBreakdown | null, last: CodexTokenBreakdown | null, previous: CodexTokenBreakdown | null): CodexTokenBreakdown | null {
  if (!total || !previous) return last
  const now = total as Record<string, unknown>
  const before = previous as Record<string, unknown>
  if (CODEX_KEYS.some((key) => count(now, key) !== null && count(before, key) !== null && count(now, key)! < count(before, key)!)) return last
  const delta: Record<string, number | null> = {}
  for (const key of CODEX_KEYS) {
    const a = count(now, key)
    const b = count(before, key)
    delta[key] = a === null || b === null ? null : a - b
  }
  return delta
}

/** Two usages of one turn summed; a field stays null only when both are. */
export function addTokenUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a || !b) return a ?? b
  const add = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0))
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: add(a.cacheCreationTokens, b.cacheCreationTokens),
  }
}
