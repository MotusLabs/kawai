// Codex login detection and failure classification (design §6, task 4.5;
// from Kawai's committed codexAuth.ts and codexLimits.ts).
//
// - hasCodexLogin(codexHome) reads `<codexHome>/auth.json` of an explicit
//   home and reports only whether it carries a non-empty API key or ChatGPT
//   access token (R09). It never reads the host's home or environment, and
//   never returns, logs or keeps a value. A missing, unreadable or malformed
//   file reads as no login.
// - codexErrorCategory() maps the protocol's codexErrorInfo (and an HTTP
//   status where the shape carries one) to the runtime's error categories, so
//   an unauthorized failure is `authentication`, never a generic transport or
//   provider failure (R02).
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AgentErrorCategory } from '../errors.js'

/** The Codex CLI's credentials file inside a Codex home. */
export const CODEX_AUTH_FILE = 'auth.json'

const present = (value: unknown): boolean => typeof value === 'string' && value.length > 0

/** Whether an explicit Codex home holds a usable login (structure only; R09). */
export function hasCodexLogin(codexHome: string): boolean {
  if (typeof codexHome !== 'string' || !isAbsolute(codexHome)) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(codexHome, CODEX_AUTH_FILE), 'utf8'))
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const slice = parsed as { OPENAI_API_KEY?: unknown; tokens?: unknown }
  if (present(slice.OPENAI_API_KEY)) return true
  const tokens = slice.tokens
  return !!tokens && typeof tokens === 'object' && present((tokens as { access_token?: unknown }).access_token)
}

const HTTP_INFO = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']

/** The HTTP status a codexErrorInfo object names, or null. */
function httpStatus(info: unknown): number | null {
  if (!info || typeof info !== 'object') return null
  for (const key of HTTP_INFO) {
    const status = (info as Record<string, { httpStatusCode?: unknown } | undefined>)[key]?.httpStatusCode
    if (typeof status === 'number') return status
  }
  return null
}

/** The codexErrorInfo's kind: the string itself or an object's single key. */
export function codexErrorKind(info: unknown): string | null {
  if (typeof info === 'string') return info
  if (info && typeof info === 'object') return Object.keys(info)[0] ?? null
  return null
}

/**
 * The error category of a Codex failure. `unauthorized` (or an HTTP 401)
 * is authentication; the usage limit is quota; rate limits and overload are
 * rate-limit; connection failures are transport; anything else is
 * `fallback`.
 */
export function codexErrorCategory(info: unknown, fallback: AgentErrorCategory = 'provider'): AgentErrorCategory {
  const kind = codexErrorKind(info)
  const status = httpStatus(info)
  if (kind === 'unauthorized' || status === 401) return 'authentication'
  if (kind === 'usageLimitExceeded') return 'quota'
  if (kind === 'rateLimitExceeded' || kind === 'serverOverloaded' || status === 429) return 'rate-limit'
  if (kind !== null && HTTP_INFO.includes(kind)) return 'transport'
  return fallback
}

/**
 * The codexErrorInfo a JSON-RPC error reply carries in its `data`, or null.
 * The app-server puts it at `data.codexErrorInfo` (or `data` itself).
 */
export function rpcErrorInfo(error: unknown): unknown {
  const data = (error as { data?: unknown } | null)?.data
  if (data && typeof data === 'object' && 'codexErrorInfo' in data) return (data as { codexErrorInfo: unknown }).codexErrorInfo
  return typeof data === 'string' ? data : null
}
