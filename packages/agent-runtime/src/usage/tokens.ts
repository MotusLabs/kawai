// Per-turn token counts (design §6, task 5.2). A field the provider did not
// report is null, never the legacy zero, and a source with no usage at all
// has none.
// - Claude: a result's `usage` (one turn's input, output, cache-read and
//   cache-creation tokens).
// - Codex: thread/tokenUsage/updated carries the thread's running `total`
//   and the latest request's `last`. A turn's requests are the difference
//   between consecutive totals. The first update of a generation counts its
//   `last`: a difference against no total would credit the turn with history
//   it never ran (a new generation, which may restart the totals, starts
//   over). A total below the previous one within a generation is a stale
//   repeat: it adds nothing and leaves the previous total in place, so a
//   request is never counted twice. A counter missing from either total
//   stays null.
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
 * One tokenUsage update: the requests it adds (the difference to the
 * previous total, `last` when there is none, null for a stale repeat) and
 * the total the next update is measured from.
 */
export function codexUpdateRequests(total: CodexTokenBreakdown | null, last: CodexTokenBreakdown | null, previous: CodexTokenBreakdown | null): { requests: CodexTokenBreakdown | null; total: CodexTokenBreakdown | null } {
  if (!previous) return { requests: last, total }
  if (!total) return { requests: last, total: previous }
  const now = total as Record<string, unknown>
  const before = previous as Record<string, unknown>
  if (CODEX_KEYS.some((key) => count(now, key) !== null && count(before, key) !== null && count(now, key)! < count(before, key)!)) return { requests: null, total: previous }
  const delta: Record<string, number | null> = {}
  for (const key of CODEX_KEYS) {
    const a = count(now, key)
    const b = count(before, key)
    delta[key] = a === null || b === null ? null : a - b
  }
  return { requests: delta, total }
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
