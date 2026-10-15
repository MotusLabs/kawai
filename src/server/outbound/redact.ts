// Redaction before any write (execution-safety-recovery D8): every field
// built from a command or a tool's output — the command, each match segment,
// the destination, and outcome details — passes `redact` before it reaches
// the store, the log, or a view, and the store clips commands to 4096
// characters with truncation marked. Pure, and deliberately eager: known
// token shapes, authorization and cookie header values, `-u` credentials,
// URL userinfo, token and password flag values, credential query parameters,
// and secret-named inline assignments, JSON members, and form fields all
// collapse to `‹redacted›`. The classifier sees the unredacted command in
// memory only; nothing unredacted is ever written.
export const REDACTED = '‹redacted›'

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)/i
const QUERY_CREDENTIALS = /^(token|access_token|api_key|apikey|key|secret|password|sig|signature)$/i
const HEADERS = 'Authorization|Proxy-Authorization|Cookie|X-Api-Key|PRIVATE-TOKEN'

/** Ordered, eager replaces; each is inert on text already redacted. */
const RULES: Array<{ pattern: RegExp; replacement: string | ((substring: string, ...groups: string[]) => string) }> = [
  // Private key blocks, header to footer.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: REDACTED },
  // Known token shapes: GitHub, OpenAI-style, Slack, AWS, JWTs.
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, replacement: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, replacement: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: REDACTED },
  { pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, replacement: REDACTED },
  // Header values: quoted (the value runs to the closing quote) and bare.
  { pattern: new RegExp(`(["'])(${HEADERS})[ \\t]*:[ \\t]*[^"']*\\1`, 'gi'), replacement: `$1$2: ${REDACTED}$1` },
  { pattern: new RegExp(`\\b(${HEADERS})([ \\t]*:)[ \\t]*[A-Za-z0-9_.+=-]+`, 'gi'), replacement: `$1$2${REDACTED}` },
  // `-u user:pass` and `--user`, plus token, password, and API key flags.
  { pattern: /(^|[\s;|&])(-u|--user|--token|--password|--api-key)(=|[ \t]+)([^\s'";|&]+)/g, replacement: `$1$2$3${REDACTED}` },
  // URL userinfo: `https://user:pass@` and `https://token@`.
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/'":@]+:[^\s/'":@]+@/gi, replacement: `$1${REDACTED}@` },
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/'":@]+@/gi, replacement: `$1${REDACTED}@` },
  // Credential query parameters.
  { pattern: /([?&])([a-z0-9_]+)=([^&\s'"]+)/gi, replacement: (match: string, sep: string, name: string) =>
    QUERY_CREDENTIALS.test(name) ? `${sep}${name}=${REDACTED}` : match },
  // Secret-named JSON members.
  { pattern: /(["'])([A-Za-z_][A-Za-z0-9_-]*)\1([ \t]*:[ \t]*)(["'])[^"']*\4/g, replacement: (match: string, _open: string, name: string, colon: string, _valueOpen: string) =>
    SECRET_NAME.test(name) ? `"${name}"${colon}"${REDACTED}"` : match },
  // Secret-named inline and form assignments.
  { pattern: /\b([A-Za-z_][A-Za-z0-9_-]*)=(?!=)([^\s'";|&]+)/g, replacement: (match: string, name: string) =>
    SECRET_NAME.test(name) ? `${name}=${REDACTED}` : match },
]

/** Redact every secret shape D8 lists; over-redaction beats a leak. */
export function redact(text: string): string {
  let result = text
  for (const rule of RULES) {
    result = typeof rule.replacement === 'string'
      ? result.replace(rule.pattern, rule.replacement)
      : result.replace(rule.pattern, rule.replacement)
  }
  return result
}

/** Clip for storage, marking the cut (D6): commands cap at 4096 characters. */
export function clip(text: string, max = 4096): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/** Redact, then clip: the one path every stored command takes. */
export function redactForStore(text: string, max = 4096): { text: string; truncated: boolean } {
  return clip(redact(text), max)
}
