// Redaction before any write (execution-safety-recovery D8): every field
// built from a command or a tool's output — the command, each match segment,
// the destination, and outcome details — passes `redact` before it reaches
// the store, the log, or a view, and the observer then clips commands to
// 4096 characters with truncation marked (`redactForStore`). Pure, and
// deliberately eager: known token shapes, authorization and cookie header
// values, `-u` credentials, URL userinfo, token and password flag values,
// credential query parameters, and secret-named inline assignments, JSON
// members, and form fields — quoted values included, spaces and all — all
// collapse to `‹redacted›`. The classifier sees the unredacted command in
// memory only; nothing unredacted is ever written.
export const REDACTED = '‹redacted›'

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)/i
const QUERY_CREDENTIALS = /^(token|access_token|api_key|apikey|key|secret|password|sig|signature)$/i
const HEADERS = 'Authorization|Proxy-Authorization|Cookie|X-Api-Key|PRIVATE-TOKEN'

/** A flag or assignment value: quoted (any content up to its close) or bare. */
// In the template literal below every regex backslash doubles (`\\s`), because
// a template literal collapses a single `\s` to plain `s`.
const VALUE = `'[^']*'|"([^"\\\\]|\\\\.)*"|[^\\s;|&'"]+`

/** Ordered, eager replaces; each is inert on text already redacted. */
const RULES: Array<{ pattern: RegExp; replacement: string | ((substring: string, ...groups: string[]) => string) }> = [
  // Private key blocks, header to footer — or to the end of input when the
  // footer never came (an unterminated block is a secret all the same).
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replacement: REDACTED },
  // Known token shapes: GitHub, OpenAI-style, Slack, AWS, JWTs.
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, replacement: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, replacement: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: REDACTED },
  { pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, replacement: REDACTED },
  // `gh secret set NAME --body <secret>`: the secret value itself (D8).
  { pattern: new RegExp(`(gh[ \t]+secret[ \t]+set[ \t]+\\S+(?:[ \t]+-{2}[a-z-]+[= ][^ \t]+)*[ \t]+)(-b|--body)(=|[ \t]+)(${VALUE})`, 'g'), replacement: `$1$2$3${REDACTED}` },
  // Header values: quoted (the value runs to the closing quote) and bare.
  { pattern: new RegExp(`(["'])(${HEADERS})[ \\t]*:[ \\t]*[^"']*\\1`, 'gi'), replacement: `$1$2: ${REDACTED}$1` },
  { pattern: new RegExp(`\\b(${HEADERS})([ \\t]*:)[ \\t]*[A-Za-z0-9_.+=-]+`, 'gi'), replacement: `$1$2${REDACTED}` },
  // `-u user:pass` (attached or separate), `--user`, token, password, and
  // API key flags — quoted values with spaces included.
  { pattern: new RegExp(`(^|[\\s;|&])(-u|--user|--token|--password|--api-key)(=|[ \\t]+)(${VALUE})`, 'g'), replacement: `$1$2$3${REDACTED}` },
  { pattern: new RegExp(`(^|[\\s;|&])-u(${VALUE})`, 'g'), replacement: `$1-u${REDACTED}` },
  // URL userinfo: everything from the scheme to the last `@` of the token
  // run — `user:pass@`, `token@`, `:token@`, and passwords holding `@` or `/`.
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s'"]+@/gi, replacement: `$1${REDACTED}@` },
  // Credential query parameters.
  { pattern: /([?&])([a-z0-9_]+)=([^&\s'"]+)/gi, replacement: (match: string, sep: string, name: string) =>
    QUERY_CREDENTIALS.test(name) ? `${sep}${name}=${REDACTED}` : match },
  // Secret-named JSON members: string values (escaped quotes included),
  // numbers, and literals.
  { pattern: /(["'])([A-Za-z_][A-Za-z0-9_-]*)\1([ \t]*:[ \t]*)(?:"([^"\\]|\\.)*"|'[^']*'|[0-9eE.+-]+|true|false|null)/g,
    replacement: (match: string, open: string, name: string, colon: string) =>
      SECRET_NAME.test(name) ? `${open}${name}${open}${colon}"${REDACTED}"` : match },
  // Secret-named assignments inside a quoted region: the value runs to the
  // region's close, so `--data-urlencode "api_key=a b"` loses the whole pair.
  { pattern: /(["'])([A-Za-z_][A-Za-z0-9_-]*)=([^"']*)\1/g, replacement: (match: string, quote: string, name: string) =>
    SECRET_NAME.test(name) ? `${quote}${name}=${REDACTED}${quote}` : match },
  // Secret-named inline and form assignments, quoted values included.
  { pattern: new RegExp(`\\b([A-Za-z_][A-Za-z0-9_-]*)=(?!=)(${VALUE})`, 'g'), replacement: (match: string, name: string) =>
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
