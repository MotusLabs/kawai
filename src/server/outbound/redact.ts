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

const SECRET_NAME = /(TOKEN(?!_COUNT)|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH(?!OR))/i
const QUERY_CREDENTIALS = /^(token|access_token|api_key|apikey|key|secret|password|sig|signature)$/i
const HEADERS = 'Authorization|Proxy-Authorization|Cookie|X-Api-Key|PRIVATE-TOKEN'

/** A flag or assignment value: quoted (any content up to its close) or bare. */
// In the template literal below every regex backslash doubles (`\\s`), because
// a template literal collapses a single `\s` to plain `s`.
const VALUE = `\\$'[^']*'|'[^']*'|"([^"\\\\]|\\\\.)*"|[^\\s;|&'"]+`

/**
 * `gh secret set … -b/--body <secret>` (D8): the secret value itself, in
 * every flag order and quoting. The scan is quote-aware — a `;`, `|`, or
 * `&` inside quotes never ends the command, so a body like `-b "SEC;RET"`
 * stays whole — and a backslash-newline continuation is joined before
 * matching, exactly as the shell reads it.
 */
const SECRET_SET = /gh[ \t]+secret[ \t]+set\b/g
const BODY_FLAG = new RegExp(`(^|[ \t])(-b|--body)(=|[ \t]+)?(${VALUE})`, 'g')

function redactSecretBodies(text: string): string {
  let joined = text.replace(/\\\n/g, '')
  SECRET_SET.lastIndex = 0
  for (;;) {
    const found = SECRET_SET.exec(joined)
    if (found === null) return joined
    // Scan to the command's end: the first unquoted ;, |, &, or newline.
    let quote: '' | '\'' | '"' | '$' = ''
    let at = found.index + found[0].length
    let end = joined.length
    while (at < joined.length) {
      const char = joined[at]!
      if (quote !== '') {
        if (quote === '$' ? char === '\'' && joined[at - 1] !== '\\' : char === quote && joined[at - 1] !== '\\') quote = ''
      } else if (char === '\'' || char === '"') quote = char
      else if (char === '$' && joined[at + 1] === '\'') { quote = '$'; at++ }
      else if (char === '\\' && at + 1 < joined.length) at++
      else if (char === ';' || char === '|' || char === '&' || char === '\n') { end = at; break }
      at++
    }
    const segment = joined.slice(found.index, end)
    const rewritten = segment.replace(BODY_FLAG, `$1$2$3${REDACTED}`)
    joined = joined.slice(0, found.index) + rewritten + joined.slice(end)
    SECRET_SET.lastIndex = found.index + rewritten.length
  }
}

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

  // Header values: quoted (the value runs to the closing quote) and bare.
  { pattern: new RegExp(`(["'])(${HEADERS})[ \\t]*:[ \\t]*[^"']*\\1`, 'gi'), replacement: `$1$2: ${REDACTED}$1` },
  { pattern: new RegExp(`\\b(${HEADERS})([ \\t]*:)[ \\t]*[A-Za-z0-9_.+=-]+`, 'gi'), replacement: `$1$2${REDACTED}` },
  // Token, password, and API key flags — quoted values with spaces included.
  // `-u`/`--user` is handled after the loop: whether it is a credential
  // depends on the command (`sort -u` is not `curl -u`).
  { pattern: new RegExp(`(^|[\\s;|&])(--token|--password|--api-key)(=|[ \\t]+)(${VALUE})`, 'g'), replacement: `$1$2$3${REDACTED}` },
  // URL userinfo: from the scheme to the last `@` before the authority's
  // end — `user:pass@`, `token@`, `:token@`, and passwords holding `@` — and
  // never past the first `/`, `?`, or `#`, so an `@scope` path segment stays.
  // The class cannot cross those terminators, which keeps the scan linear.
  { pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s'"/?#]*@/gi, replacement: `$1${REDACTED}@` },
  // A password holding `/` puts its `@` past the authority's end: an
  // authority whose pre-slash part carries a `:` reads as `user:pass`, so an
  // `@` after that slash is still the separator (`user:pa/ss@host`). A path
  // `@scope` never matches — its pre-slash part has no colon.
  { pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s'"?#/:]+:[^\s'"?#/]*\/[^\s'"?#]{0,255}@/gi, replacement: `$1${REDACTED}@` },
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

/** Commands whose `-u` is always a credential, whatever the value's shape. */
const CURL_LIKE = /(?:^|[\s;|&])(?:curl|wget|http|https|httpie|aria2c)(?=[\s;|&])/
/** A `user:pass` shape outside curl-like tools; a bare uid[:gid] is not one. */
const USER_PASS = (value: string): boolean =>
  /^[A-Za-z0-9._%+-]+:[^\s]+$/.test(value) && !/^\d+(?::\d+)?$/.test(value)

/** Redact every secret shape D8 lists; over-redaction beats a leak. */
export function redact(text: string): string {
  // The gh secret set scan joins continuations and returns that text, so
  // every later rule — and the stored field — sees the shell-equivalent form.
  let result = redactSecretBodies(text)
  for (const rule of RULES) {
    result = typeof rule.replacement === 'string'
      ? result.replace(rule.pattern, rule.replacement)
      : result.replace(rule.pattern, rule.replacement)
  }
  // `-u`/`--user`: a credential in a curl-like command whatever the shape,
  // elsewhere only when the value reads as `user:pass` — `sort -u`, `tar
  // -uvf`, `git add -u`, and `docker run -u 1000:1000` stay as written.
  const curlish = CURL_LIKE.test(result)
  return result.replace(
    new RegExp(`(^|[\\s;|&])(-u|--user)(=|[ \\t]+)?(${VALUE})`, 'g'),
    (match: string, pre: string, flag: string, sep: string, value: string) =>
      curlish || USER_PASS(value) ? `${pre}${flag}${sep ?? ''}${REDACTED}` : match,
  )
}

/** Clip for storage, marking the cut (D6): commands cap at 4096 characters. */
export function clip(text: string, max = 4096): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/**
 * Redact, then clip: the one path every stored command takes. Only the first
 * `REDACT_READ_MAX` characters are read — everything past them falls outside
 * the 4096 store cap too, and the bound keeps pathological inputs linear
 * (a 240k-character command redacts in well under a millisecond).
 */
const REDACT_READ_MAX = 16_384
export function redactForStore(text: string, max = 4096): { text: string; truncated: boolean } {
  return clip(redact(text.slice(0, REDACT_READ_MAX)), max)
}
