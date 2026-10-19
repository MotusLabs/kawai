// Server-side pull of the session provider's own plan usage (usage bar,
// provider pull): the Z.AI coding-plan quota endpoint the plan dashboard
// itself calls — undocumented, so a reply is trusted only when it matches the
// captured shape. HTTP lives here; zaiQuotaLimit.ts stays pure. The request
// goes to the base URL's origin with the same credentials the profile's SDK
// sessions already use, so it creates no new trust boundary, and every
// failure degrades to a no-pull outcome rather than ever disturbing a
// session. Outcomes distinguish a gateway that does not serve the endpoint
// (the host-login SDK pull still applies) from a provider that refused the
// credentials (no usable data at all).
import type { ChatUsageReport } from '../../shared/chat'
import { parseZaiQuotaLimit, type ZaiQuotaLimitSlice } from './zaiQuotaLimit'

/** Origin-relative path of the coding-plan quota endpoint. */
export const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit'

/** Bound the pull so a hanging gateway cannot pin a spawn or a refresh tick. */
const ZAI_QUOTA_TIMEOUT_MS = 10_000

export type ZaiUsagePull =
  | { ok: true; report: ChatUsageReport }
  | {
      ok: false
      /**
       * not-provider: the reply was not the quota shape (unknown path, foreign
       * gateway) — the host-login SDK pull still applies. provider-refused:
       * the Z.AI service answered but rejected the request (bad or missing
       * auth) — no usable data. unreachable: network, timeout, server errors,
       * or an unreadable body — the SDK pull still applies.
       */
      outcome: 'not-provider' | 'provider-refused' | 'unreachable'
      /** Host-only diagnostics; never carries credentials. */
      reason: string
    }

/** The model API path, query, fragment, and URL userinfo never enter the quota URL. */
export function zaiQuotaUrl(baseUrl: string): string {
  return new URL(ZAI_QUOTA_PATH, new URL(baseUrl).origin).toString()
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return 'invalid base URL'
  }
}

/**
 * Pull plan usage from a profile's provider base URL. `ok` carries the parsed
 * report; the failure outcomes above decide whether the SDK usage pull may
 * still answer for this profile.
 */
export async function fetchZaiUsage(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<ZaiUsagePull> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ZAI_QUOTA_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers.Authorization = token
    const response = await fetchImpl(zaiQuotaUrl(baseUrl), {
      headers,
      signal: controller.signal,
    })
    if (!response.ok) {
      // 404/405: the monitor path is not implemented — the host is not
      // serving the endpoint at all, which is different from refusing us.
      // Auth refusals (401/403) and anything else fall to their outcomes
      // below; only a confirmed shape gap preserves the SDK pull.
      if (response.status === 404 || response.status === 405) {
        return {
          ok: false,
          outcome: 'not-provider',
          reason: `no quota endpoint at ${hostOf(baseUrl)} (HTTP ${response.status})`,
        }
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          outcome: 'provider-refused',
          reason: `HTTP ${response.status} from ${hostOf(baseUrl)}`,
        }
      }
      return {
        ok: false,
        outcome: 'unreachable',
        reason: `HTTP ${response.status} from ${hostOf(baseUrl)}`,
      }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return {
        ok: false,
        outcome: 'not-provider',
        reason: `non-JSON reply from ${hostOf(baseUrl)}`,
      }
    }
    // Gateways also wrap missing routes and upstream failures in HTTP 200.
    // Only explicit auth codes establish a refusal; a generic failure keeps
    // the SDK fallback. Match the captured wrapped 404 narrowly, not prose.
    if (
      payload &&
      typeof payload === 'object' &&
      (payload as { success?: unknown }).success === false
    ) {
      const { code, msg } = payload as { code?: unknown; msg?: unknown }
      const auth = code === 401 || code === 403 || code === 1001
      const missing = code === 404 || code === 405 ||
        (code === 500 && typeof msg === 'string' && msg.trim() === '404 NOT_FOUND')
      const outcome = auth ? 'provider-refused' : missing ? 'not-provider' : 'unreachable'
      return {
        ok: false,
        outcome,
        reason: `quota request failed at ${hostOf(baseUrl)} (${outcome})`,
      }
    }
    const report = parseZaiQuotaLimit(payload as ZaiQuotaLimitSlice)
    if (!report) {
      return {
        ok: false,
        outcome: 'not-provider',
        reason: `no quota shape from ${hostOf(baseUrl)}`,
      }
    }
    return { ok: true, report }
  } catch {
    return {
      ok: false,
      outcome: 'unreachable',
      reason: `quota request failed for ${hostOf(baseUrl)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
