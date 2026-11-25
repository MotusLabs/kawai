// Credential material a provider echoes back never reaches the live usage
// store (process-quota-history-and-incident-advice I2/P4; Sol re-check
// note-d5b9f0e9 item 1). The live parser keeps unknown window kinds and
// labels as the wire sends them — compatible, non-secret values stay
// readable — so every pull the reader returns has each occurrence of the
// target's own credentials replaced in every string it carries before any
// caller sees it. Durable history normalizes its fields separately
// (observations/durableWindows.ts).
import type { QuotaPull } from './QuotaReaderService'
import type { QuotaTarget } from './quotaTarget'

export const REDACTED = '[redacted]'

/** Shorter values could match ordinary text; no real credential is this short. */
const MIN_SECRET_LENGTH = 8

function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let out = value
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED)
    return out
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]))
  }
  return value
}

/** The pull with every string occurrence of the target's credentials replaced. */
export function redactPull(pull: QuotaPull, target: QuotaTarget): QuotaPull {
  const secrets = [target.token, target.balanceKey]
    .filter((secret): secret is string => typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH)
  return secrets.length === 0 ? pull : redactValue(pull, secrets) as QuotaPull
}
