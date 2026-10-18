// Provider quota replies for the Z.AI coding plan (usage bar, provider
// pull): the payload the quota endpoint returns, normalized into the same
// Kawai-owned ChatUsageReport the other parsers produce. Pure like
// usageLimits.ts — HTTP lives in zaiUsage.ts. Each usable row states its own
// window length as unit + number: the observed codes (usageWindowPeriods.ts)
// give the row its periodMs and a label naming what it counts and its
// window; anything else labels without a length and carries no period — no
// marker beats a wrong one.
import type {
  ChatUsageReport,
  ChatUsageWindow,
} from '../../shared/chat'
import { percentValue, toIsoResetsAt } from './usageLimits'
import { providerRowPeriodMs, providerRowUnitWord } from './usageWindowPeriods'

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
  /** The row's window length: the unit code (3 = hours, 5 = months, observed). */
  unit?: number | null
  /** The row's window length: how many units. */
  number?: number | null
}

/** Provider row kinds → the thing the row counts; unknown kinds label as their raw type. */
const ZAI_ROW_WORDS: Record<string, string> = {
  time_limit: 'tool calls',
  tokens_limit: 'tokens',
}

/**
 * Own-key lookup of a row's counted-thing word. A wire string indexes the
 * table, so inherited names must not resolve: `ZAI_ROW_WORDS[kind]` alone
 * would answer for Object.prototype keys like 'constructor' or '__proto__'
 * and dress an unknown kind in a garbage word and a period.
 */
function zaiRowWord(kind: string): string | undefined {
  return Object.hasOwn(ZAI_ROW_WORDS, kind) ? ZAI_ROW_WORDS[kind] : undefined
}

/**
 * Length prefix from the row's own unit and count (design D4): hours give
 * "<n>-hour", months "Monthly" for one and "<n>-month" otherwise; null when
 * the unit is unknown or the count is not a positive integer. The count is
 * never coerced: a string stays unusable.
 */
function zaiRowLengthPrefix(unit: unknown, count: unknown): string | null {
  const unitWord = providerRowUnitWord(unit)
  if (unitWord === undefined) return null
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return null
  return unitWord === 'hour' ? `${count}-hour` : count === 1 ? 'Monthly' : `${count}-month`
}

/**
 * The row's label from its counted-thing word: the word prefixed by its
 * stated length ("5-hour tokens", "Monthly tool calls"), or the capitalised
 * word alone without a usable length ("Tokens", "Tool calls").
 */
function zaiRowLabelFrom(word: string, unit: unknown, count: unknown): string {
  const prefix = zaiRowLengthPrefix(unit, count)
  if (prefix !== null) return `${prefix} ${word}`
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** ISO reset time from an epoch-milliseconds number, else like toIsoResetsAt. */
function toIsoResetsAtMs(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return toIsoResetsAt(value)
}

/** Epoch milliseconds of the wire's reset (a number, or an ISO string); undefined when unusable. */
function resetMsOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))) {
    return Date.parse(value)
  }
  return undefined
}

/**
 * Parse a provider quota-limit reply (2026-10-12 capture). The endpoint is
 * undocumented: accept only success === true with a data.limits array and
 * ignore every other field; anything else returns null. Each usable row
 * becomes a window keyed `zai:<type>` so provider kinds never collide with
 * Claude plan kinds (a repeated type gets a #n suffix — every row is its own
 * meter), labeled by what the row counts and the window it states ("5-hour
 * tokens", "Monthly tool calls"; "Tokens"/"Tool calls" without a usable
 * length; the raw type for an unknown kind), percent from percentage (already
 * 0-100), reset from the epoch-millisecond nextResetTime, and — for a known
 * kind — periodMs from the row's own unit/number when both and the reset are
 * usable. A kind the server does not know states nothing about a window: it
 * labels as its raw type and never carries a period, even with a unit/count
 * the table knows. A row without a usable percentage drops rather than
 * renders wrong. Status is always allowed: the payload carries no severity.
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
    const word = zaiRowWord(kind)
    const window: ChatUsageWindow = {
      key: count === 1 ? `zai:${kind}` : `zai:${kind}#${count}`,
      label: word === undefined ? row.type : zaiRowLabelFrom(word, row.unit, row.number),
      percentUsed,
      resetsAt: toIsoResetsAtMs(row.nextResetTime),
    }
    // Only a known kind has a known length; the key stays unset rather than
    // undefined: the wire field is optional.
    if (word !== undefined) {
      const periodMs = providerRowPeriodMs(row.unit, row.number, resetMsOf(row.nextResetTime))
      if (periodMs !== undefined) window.periodMs = periodMs
    }
    windows.push(window)
  }
  return { status: 'allowed', windows, receivedAt, source: 'provider' }
}
