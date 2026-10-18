// Provider quota replies for the Z.AI coding plan (usage bar, provider
// pull): the payload the quota endpoint returns, normalized into the same
// Kawai-owned ChatUsageReport the other parsers produce. Pure like
// usageLimits.ts — HTTP lives in zaiUsage.ts. The payload's unit/number
// semantics are undocumented and are not assumed: no row is ever labeled
// with a Claude-plan window name, and no row carries a period.
import type {
  ChatUsageReport,
  ChatUsageWindow,
} from '../../shared/chat'
import { percentValue, toIsoResetsAt } from './usageLimits'

/** Structural slice of a provider quota-limit reply (Z.AI coding plan, SDK-free). */
export interface ZaiQuotaLimitSlice {
  success?: boolean
  data?: {
    limits?: ZaiQuotaLimitRowSlice[] | null
  } | null
}

export interface ZaiQuotaLimitRowSlice {
  /** The server's row kind, e.g. 'TIME_LIMIT' | 'TOKENS_LIMIT'. */
  type?: string
  /** Share of the row's window used, 0-100. */
  percentage?: number | null
  /** Epoch-milliseconds reset time of the row's window. */
  nextResetTime?: number | string | null
}

/**
 * Provider row kinds → display labels; unknown kinds label as their raw type.
 * The payload's unit/number semantics are undocumented and are not assumed:
 * the observed TIME_LIMIT row resets on a multi-week horizon, so no row is
 * ever labeled with a Claude-plan window name.
 */
const ZAI_ROW_LABELS: Record<string, string> = {
  time_limit: 'Prompts',
  tokens_limit: 'Weekly tokens',
}

/** ISO reset time from an epoch-milliseconds number, else like toIsoResetsAt. */
function toIsoResetsAtMs(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return toIsoResetsAt(value)
}

/**
 * Parse a provider quota-limit reply (2026-10-12 capture). The endpoint is
 * undocumented: accept only success === true with a data.limits array and
 * ignore every other field; anything else returns null. Each usable row
 * becomes a window keyed `zai:<type>` so provider kinds never collide with
 * Claude plan kinds (a repeated type gets a #n suffix — every row is its own
 * meter), labeled by the row's own type, percent from percentage (already
 * 0-100), reset from the epoch-millisecond nextResetTime. A row without a
 * usable percentage drops rather than renders wrong. Status is always
 * allowed: the payload carries no severity.
 */
export function parseZaiQuotaLimit(
  payload: ZaiQuotaLimitSlice | null | undefined,
  receivedAt: string = new Date().toISOString()
): ChatUsageReport | null {
  if (payload?.success !== true) return null
  const rows = payload.data?.limits
  if (!Array.isArray(rows)) return null
  const windows: ChatUsageWindow[] = []
  const seen = new Map<string, number>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.type !== 'string' || row.type === '') continue
    const percentUsed = percentValue(row.percentage)
    if (percentUsed === null) continue
    const kind = row.type.toLowerCase()
    const count = (seen.get(kind) ?? 0) + 1
    seen.set(kind, count)
    windows.push({
      key: count === 1 ? `zai:${kind}` : `zai:${kind}#${count}`,
      label: ZAI_ROW_LABELS[kind] ?? row.type,
      percentUsed,
      resetsAt: toIsoResetsAtMs(row.nextResetTime),
    })
  }
  return { status: 'allowed', windows, receivedAt, source: 'provider' }
}
