// One quota reader's target and identity (process-quota-history-and-incident-
// advice D1). A target is the effective provider configuration a pull uses:
// the provider, its base URL, and the credential the profile's spawns get.
// The account key — provider, base URL origin, and a hash of the credential —
// exists in memory only and groups every subscription that would make the
// same request, so one account is polled once whatever reasons hold it. The
// persisted alias names the provider and host, never the credential (I2).
import { createHash, createHmac } from 'node:crypto'
import { isOpenRouterBaseUrl } from '../openRouterUsage'

export interface QuotaTarget {
  providerId: string
  /** The effective `ANTHROPIC_BASE_URL`, or null when the profile has none. */
  baseUrl: string | null
  token?: string | undefined
  /** OpenRouter's credits key value (session pulls only). */
  balanceKey?: string | undefined
}

/**
 * How a target's usage can be read: `standalone` — Kawai calls the quota
 * endpoint itself; `agent-only` — only a running agent reports it (host-login
 * SDK pulls, Codex homes); `openrouter` — its own endpoint, pulled for live
 * sessions only (X2: no background reader).
 */
export type QuotaReaderKind = 'standalone' | 'agent-only' | 'openrouter'

export function readerKindOf(target: QuotaTarget): QuotaReaderKind {
  if (!target.baseUrl) return 'agent-only'
  return isOpenRouterBaseUrl(target.baseUrl) ? 'openrouter' : 'standalone'
}

function originOf(baseUrl: string | null): string {
  if (!baseUrl) return 'host-login'
  try {
    return new URL(baseUrl).origin
  } catch {
    return 'invalid'
  }
}

/** The in-memory account key; the credential enters only as a hash. */
export function accountKeyOf(target: QuotaTarget): string {
  const credential = createHash('sha256').update(target.token ?? '').digest('hex')
  return `${target.providerId}\0${originOf(target.baseUrl)}\0${credential}`
}

/** The persisted account alias: `provider@host`, or `provider@host-login`. */
export function accountAliasOf(target: QuotaTarget): string {
  if (!target.baseUrl) return `${target.providerId}@host-login`
  try {
    return `${target.providerId}@${new URL(target.baseUrl).host}`
  } catch {
    return `${target.providerId}@invalid`
  }
}

/**
 * The persisted account scope (binding B12): an HMAC of the account key under
 * a salt that lives only in this process's memory. Equal scopes mean "the
 * same effective account, as this process observed it"; nothing outside the
 * process can link a scope to a credential, and a restart starts new scopes.
 */
export function accountScopeOf(target: QuotaTarget, salt: Buffer): string {
  return createHmac('sha256', salt).update(accountKeyOf(target)).digest('hex').slice(0, 24)
}
