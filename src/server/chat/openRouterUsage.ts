// Server-side pull of an OpenRouter provider's own usage (openrouter-provider
// D6): the key endpoint (/api/v1/key) reports the session key's cap and
// budgets, the credits endpoint (/api/v1/credits) the account balance, and
// both merge into one ChatUsageReport held in the provider's slot. HTTP lives
// here; the parsers are pure and check the spike's captured shapes strictly —
// the budget fields are undocumented, so anything malformed records no data
// rather than guessing. The key pull authenticates with the session's
// effective token, the credits pull with the server-side balance key, which
// never enters an agent environment. Every failure degrades to a no-data
// outcome without disturbing a session, and no failure of these pulls ever
// enables the host-login usage pull — the caller suppresses it outright.
import type { ChatUsageReport, ChatUsageStatus, ChatUsageWindow } from '../../shared/chat'
import { toIsoResetsAt } from './usageLimits'

/** Origin-relative paths of the two usage endpoints. */
export const OPENROUTER_KEY_PATH = '/api/v1/key'
export const OPENROUTER_CREDITS_PATH = '/api/v1/credits'

/** Bound each pull so a hanging endpoint cannot pin a spawn or a refresh tick. */
const OPENROUTER_TIMEOUT_MS = 10_000

const HOUR_MS = 60 * 60 * 1000

/**
 * Whether a base URL host selects the OpenRouter usage endpoint: the host is
 * `openrouter.ai` or one of its subdomains. Hostnames match by name, like
 * every other catalog rule — DNS is never resolved.
 */
export function isOpenRouterHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === 'openrouter.ai' || name.endsWith('.openrouter.ai')
}

/** Whether a provider's base URL selects its own usage endpoint (D6). */
export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    return isOpenRouterHost(new URL(baseUrl).host)
  } catch {
    return false
  }
}

/** The endpoint URL at the base URL's origin: scheme, host and port kept, every model path, query and fragment dropped. */
export function openRouterUrl(baseUrl: string, path: string): string {
  return new URL(path, new URL(baseUrl).origin).toString()
}

/** USD rounded to cents: the adapter's comparisons and labels agree. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function formatUsd(value: number): string {
  return `$${round2(value).toFixed(2)}`
}

/** Percent 0-100 spent of a positive limit, clamped; null when unusable. */
function spentPercent(spend: unknown, limit: unknown): number | null {
  if (typeof spend !== 'number' || !Number.isFinite(spend) || spend < 0) return null
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null
  return Math.min(100, Math.max(0, round2((spend / limit) * 100)))
}

/**
 * A budget's meter label: the scope's words, or the raw scope value when the
 * server does not know it (an unknown scope renders verbatim, so a new scope
 * needs no release).
 */
const SCOPE_LABELS: Record<string, string> = {
  key_limit: 'Key cap',
  daily: 'Daily budget',
  weekly: 'Weekly budget',
  monthly: 'Monthly budget',
  workspace: 'Workspace budget',
}

/** Period lengths for the reset intervals whose length is known; monthly and null carry none, never a guess. */
const INTERVAL_PERIODS_MS: Record<string, number> = {
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
}

// ------------------------------------------------------------------- shapes

/** Structural slice of a /api/v1/key body (SDK-free; fields undocumented). */
export interface OpenRouterKeySlice {
  /** The key's overall cap, when it has one. */
  limit?: unknown
  limit_remaining?: unknown
  limit_reset?: unknown
  /** One row per cap or budget on the key; absent on a management key. */
  budgets?: OpenRouterBudgetSlice[] | null
  /** Captures carry these; the parser ignores them. */
  effective_budget?: unknown
  is_management_key?: unknown
  expires_at?: unknown
  /** The documented body wraps these fields in `data`, like /credits; the parser accepts the wrapper and the bare body. */
  data?: OpenRouterKeySlice | null
}

export interface OpenRouterBudgetSlice {
  /** key_limit | daily | weekly | monthly | workspace | anything new. */
  scope?: unknown
  budget_id?: unknown
  guardrail_id?: unknown
  limit_usd?: unknown
  spend_usd?: unknown
  remaining_usd?: unknown
  /** daily | weekly | monthly | null — daily and weekly have a known length. */
  reset_interval?: unknown
  resets_at?: unknown
}

/** Structural slice of a /api/v1/credits body (SDK-free). */
export interface OpenRouterCreditsSlice {
  data?: {
    total_credits?: unknown
    total_usage?: unknown
  } | null
}

/** One parsed meter with the dollars left behind it (D8 reads the minimum). */
interface ParsedMeter {
  window: ChatUsageWindow
  remainingUsd: number
}

/** One budget → one meter, or null when its numbers are unusable. */
function budgetMeter(budget: OpenRouterBudgetSlice): ParsedMeter | null {
  if (!budget || typeof budget !== 'object') return null
  const scope = budget.scope
  if (typeof scope !== 'string' || scope === '') return null
  const percent = spentPercent(budget.spend_usd, budget.limit_usd)
  if (percent === null) return null
  const limit = budget.limit_usd
  const spend = budget.spend_usd
  const remaining =
    typeof budget.remaining_usd === 'number' && Number.isFinite(budget.remaining_usd)
      ? round2(budget.remaining_usd)
      : round2((limit as number) - (spend as number))
  if (!Number.isFinite(remaining)) return null
  const scopeLabel = Object.hasOwn(SCOPE_LABELS, scope) ? SCOPE_LABELS[scope] : scope
  const id = [budget.budget_id, budget.guardrail_id].find(
    (value) => typeof value === 'string' && value !== ''
  )
  const interval = budget.reset_interval
  const periodMs =
    typeof interval === 'string' && Object.hasOwn(INTERVAL_PERIODS_MS, interval)
      ? INTERVAL_PERIODS_MS[interval]
      : undefined
  return {
    window: {
      key: id !== undefined ? `openrouter:${scope}:${id}` : `openrouter:${scope}`,
      label: `${scopeLabel} · ${formatUsd(remaining)} left`,
      percentUsed: percent,
      resetsAt: toIsoResetsAt(budget.resets_at),
      ...(periodMs !== undefined ? { periodMs } : {}),
    },
    remainingUsd: remaining,
  }
}

/** A bare key cap (no budget rows) → one "Key cap" meter, or null when uncapped. */
function capMeter(body: OpenRouterKeySlice): ParsedMeter | null {
  const limit = body.limit
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null
  const remaining = body.limit_remaining
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null
  const percent = spentPercent(limit - remaining, limit)
  if (percent === null) return null
  return {
    window: {
      key: 'openrouter:key_limit',
      label: `Key cap · ${formatUsd(remaining)} left`,
      percentUsed: percent,
      resetsAt: null,
    },
    remainingUsd: round2(remaining),
  }
}

/** The report status over meters: limited when any meter has no dollars left. */
function metersStatus(remainings: readonly number[]): ChatUsageStatus {
  return remainings.some((remaining) => remaining <= 0) ? 'limited' : 'allowed'
}

/**
 * Parse a /api/v1/key body. Each budget renders as one meter; without usable
 * budget rows a set `limit` renders as one bare key cap; a key with neither
 * renders nothing (an uncapped key). Returns null when the body is not the
 * key shape at all — the caller records no data rather than guessing.
 */
export function parseOpenRouterKey(
  payload: OpenRouterKeySlice | null | undefined,
  receivedAt: string = new Date().toISOString()
): { report: ChatUsageReport; remainingUsd: number | null } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  // OpenRouter's docs declare the key fields under a `data` wrapper, like
  // /credits; it is unwrapped when present, and the bare body accepted as
  // captured (openrouter-provider F1). Either way a body carrying none of
  // the key fields is not the key endpoint's shape (a foreign reply, a
  // wrapped error).
  const data = payload.data
  const body =
    data !== null && typeof data === 'object' && !Array.isArray(data) ? data : payload
  if (body.budgets === undefined && body.limit === undefined && body.limit_remaining === undefined) {
    return null
  }
  const budgets = body.budgets
  if (budgets !== undefined && budgets !== null && !Array.isArray(budgets)) return null
  const windows: ChatUsageWindow[] = []
  const remainings: number[] = []
  if (Array.isArray(budgets)) {
    for (const budget of budgets) {
      // A non-object entry is a shape violation: the body records no data
      // rather than rendering the rows around it.
      if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return null
      const meter = budgetMeter(budget)
      if (meter) {
        windows.push(meter.window)
        remainings.push(meter.remainingUsd)
      }
    }
  }
  if (windows.length === 0) {
    const cap = capMeter(body)
    if (cap) {
      windows.push(cap.window)
      remainings.push(cap.remainingUsd)
    }
  }
  return {
    report: { status: metersStatus(remainings), windows, receivedAt, source: 'provider' },
    remainingUsd: remainings.length > 0 ? Math.min(...remainings) : null,
  }
}

/**
 * Parse a /api/v1/credits body: one "Credits" meter with the dollars left of
 * the credits purchased and the share of them used — no reset, no period.
 * Returns null when the body is not the credits shape.
 */
export function parseOpenRouterCredits(
  payload: OpenRouterCreditsSlice | null | undefined
): ParsedMeter | null {
  const data = payload?.data
  if (!data || typeof data !== 'object') return null
  const total = data.total_credits
  const used = data.total_usage
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  const remaining = round2(total - used)
  return {
    window: {
      key: 'openrouter:credits',
      label: `Credits · ${formatUsd(remaining)} left`,
      percentUsed: spentPercent(used, total) ?? 100,
      resetsAt: null,
    },
    remainingUsd: remaining,
  }
}

// --------------------------------------------------------------------- pulls

/** How the credits pull ended: merged, refused (401/403), failed, or not configured. */
export type OpenRouterCreditsOutcome = 'ok' | 'refused' | 'failed' | 'skipped'

export type OpenRouterUsagePull =
  | {
      ok: true
      report: ChatUsageReport
      /** The smallest remaining amount over the pull's meters; null without meters (D8's feed). */
      remainingUsd: number | null
      credits: { outcome: OpenRouterCreditsOutcome; reason?: string }
    }
  | {
      ok: false
      /** refused: the endpoint answered 401/403; failed: anything else. */
      outcome: 'refused' | 'failed'
      /** Host-only diagnostics; never carries a key. */
      reason: string
    }

interface FetchedBody {
  ok: boolean
  status?: number
  payload?: unknown
  reason: string
}

async function fetchJson(
  url: string,
  bearer: string,
  fetchImpl: typeof fetch
): Promise<FetchedBody> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', Authorization: bearer },
      signal: controller.signal,
    })
    const host = new URL(url).host
    if (!response.ok) {
      return { ok: false, status: response.status, reason: `HTTP ${response.status} from ${host}` }
    }
    try {
      return { ok: true, payload: await response.json(), reason: '' }
    } catch {
      return { ok: false, status: response.status, reason: `non-JSON reply from ${host}` }
    }
  } catch {
    return { ok: false, reason: `request failed for ${new URL(url).host}` }
  } finally {
    clearTimeout(timer)
  }
}

const bearerOf = (key: string): string => `Bearer ${key}`

const isAuthRefusal = (status: number | undefined): boolean => status === 401 || status === 403

/**
 * Pull one OpenRouter provider's usage: the key endpoint with the session's
 * effective token, and — when a balance key is configured — the credits
 * endpoint with that value, merged into one report. A key-pull failure fails
 * the whole pull (the caller records no data and keeps the host-login pull
 * suppressed whatever happened); a credits failure only drops the credits
 * meter, its refusal reported for a once-per-value log. Meters carry the
 * smallest remaining amount over them for the credit-cooldown overlay.
 */
export async function fetchOpenRouterUsage(
  baseUrl: string,
  token: string | undefined,
  balanceKey: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<OpenRouterUsagePull> {
  const receivedAt = new Date().toISOString()
  const key = await fetchJson(openRouterUrl(baseUrl, OPENROUTER_KEY_PATH), bearerOf(token ?? ''), fetchImpl)
  if (!key.ok) {
    return {
      ok: false,
      outcome: isAuthRefusal(key.status) ? 'refused' : 'failed',
      reason: key.reason,
    }
  }
  const parsed = parseOpenRouterKey(key.payload as OpenRouterKeySlice, receivedAt)
  if (!parsed) {
    return { ok: false, outcome: 'failed', reason: `no key shape from ${new URL(baseUrl).host}` }
  }
  const windows = [...parsed.report.windows]
  const remainings = parsed.remainingUsd !== null ? [parsed.remainingUsd] : []
  let credits: { outcome: OpenRouterCreditsOutcome; reason?: string } = { outcome: 'skipped' }
  if (balanceKey) {
    const fetched = await fetchJson(
      openRouterUrl(baseUrl, OPENROUTER_CREDITS_PATH),
      bearerOf(balanceKey),
      fetchImpl
    )
    if (!fetched.ok && isAuthRefusal(fetched.status)) {
      credits = { outcome: 'refused', reason: fetched.reason }
    } else if (!fetched.ok) {
      credits = { outcome: 'failed', reason: fetched.reason }
    } else {
      const meter = parseOpenRouterCredits(fetched.payload as OpenRouterCreditsSlice)
      if (!meter) credits = { outcome: 'failed', reason: `no credits shape from ${new URL(baseUrl).host}` }
      else {
        windows.push(meter.window)
        remainings.push(meter.remainingUsd)
        credits = { outcome: 'ok' }
      }
    }
  }
  return {
    ok: true,
    report: {
      status: metersStatus(remainings),
      windows,
      receivedAt: parsed.report.receivedAt,
      source: 'provider',
    },
    remainingUsd: remainings.length > 0 ? Math.min(...remainings) : null,
    credits,
  }
}
