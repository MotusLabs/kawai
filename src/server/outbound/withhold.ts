// Withholding, the first line of D8 (execution-safety-recovery, task
// revision 3): text that could carry a credential is never stored at all.
// `withholdReason` answers a fixed reason code when the text has a heredoc
// or here-string, sets a header in any spelling, passes credentials (`-u`,
// a token/password/key option, URL userinfo), or contains a credential-like
// word or a known token shape; `storeText` is the one gate every stored field
// passes — the placeholder for withheld text, else redaction and the
// backed-off 4096 cut. The trigger is generous on purpose: a false positive
// only hides text the row's rule, verdict, and destination still describe.
// Pure and linear: one lowercase copy, fixed substring searches, and one
// forward word pass.
import { redactForStore } from './redact'

export type WithholdReason = 'heredoc' | 'header' | 'credential' | 'token'

export const withheld = (reason: WithholdReason): string => `‹withheld: ${reason}›`

/** Credential-like words, matched case-insensitively anywhere (D8). */
const WORDS = ['authoriz', 'bearer', 'cookie', 'token', 'secret', 'passw', 'api_key', 'apikey', 'api-key', 'private']
/** Option names that carry a credential (`--token`, `--password-stdin`, `--api-key`, `--cookie`, `--cred…`). */
const OPTION_WORDS = ['token', 'pass', 'secret', 'key', 'auth', 'bearer', 'cookie', 'cred']
/** Known token shapes (D8): GitHub, GitLab, npm, PyPI, Hugging Face, Google, OpenAI-style, Slack, AWS, JWT, PEM. */
const SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]|github_pat_|glpat-|gl(?:dt|rt|ptt|cbt)-|npm_[A-Za-z0-9]{6}|pypi-[A-Za-z0-9_-]{6}|hf_[A-Za-z0-9]{6}|AIza[0-9A-Za-z_-]{6}|xox[abprs]-|xapp-|A[KS]IA[0-9A-Z]{12}|eyJ[A-Za-z0-9_-]{6})|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6}|-----BEGIN/
/** Tools whose `-u` is always a credential and whose `Name:value` words are headers. */
const CURL_LIKE = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'xhs', 'aria2c'])
const WORD_BREAK = /[\s;|&()<>]/

/** The quote characters and backslashes dropped: what the shell would read for plain quoting. */
const dequote = (word: string): string => word.replace(/['"\\]/g, '')

/** The words of `text`, split at whitespace and operators (quotes are not honored: generous). */
function wordsOf(text: string): string[] {
  const words: string[] = []
  let start = -1
  for (let i = 0; i <= text.length; i++) {
    const breaks = i === text.length || WORD_BREAK.test(text[i]!)
    if (breaks) {
      if (start !== -1) words.push(text.slice(start, i))
      start = -1
    } else if (start === -1) start = i
  }
  return words
}

/** URL userinfo: an `@` between `://` and the authority's end. */
function hasUserinfo(text: string): boolean {
  let at = text.indexOf('://')
  while (at !== -1) {
    let i = at + 3
    while (i < text.length && !/[/?#\s'"]/.test(text[i]!)) {
      if (text[i] === '@') return true
      i++
    }
    at = text.indexOf('://', i)
  }
  return false
}

/** Why `text` must be withheld, or null when it may be redacted and stored. */
export function withholdReason(text: string): WithholdReason | null {
  if (text.includes('<<')) return 'heredoc'
  const lower = text.toLowerCase()
  if (lower.includes('-header')) return 'header'
  if (WORDS.some(word => lower.includes(word))) return 'credential'
  if (SHAPES.test(text)) return 'token'
  if (hasUserinfo(text)) return 'credential'
  const words = wordsOf(text).map(dequote)
  const curlLike = words.some(word => CURL_LIKE.has(word.split('/').pop()!.toLowerCase()))
  // A login's `-p` is its password (`docker login -p`, `helm registry login -p`).
  const login = words.some(word => word === 'login')
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    // A short option cluster naming H: `-H`, `-sH`, `-HAuthorization:x`.
    const cluster = /^-([A-Za-z]+)/.exec(word)
    if (cluster !== null && !word.startsWith('--') && cluster[1]!.includes('H')) return 'header'
    if (login && /^-[A-Za-z]*p/.test(word) && !word.startsWith('--')) return 'credential'
    if (word.startsWith('-')) {
      const name = word.replace(/^-+/, '').split('=')[0]!.toLowerCase()
      if (word.startsWith('--') && OPTION_WORDS.some(part => name.includes(part))) return 'credential'
      if (word === '-u' || word === '--user' || word.startsWith('--user=') || (word.startsWith('-u') && !word.startsWith('--'))) {
        const value = word.length > 2 && !word.startsWith('--') ? word.slice(2) : word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[i + 1] ?? ''
        if (curlLike || value.includes(':')) return 'credential'
      }
    }
    // An httpie item or a bare header word for a curl-like tool: `Name:value`, `Name: value`.
    // (An empty value, `failed:`, is prose; an `-H` before it is caught above.)
    if (curlLike && /^[A-Za-z][A-Za-z0-9_-]*:(?!\/\/)./.test(word)) return 'header'
  }
  return null
}

/** The one storage gate (D8): the placeholder when withheld, else redacted and clipped. */
export function storeText(text: string, max = 4096): { text: string; truncated: boolean } {
  const reason = withholdReason(text)
  if (reason !== null) return { text: withheld(reason), truncated: false }
  return redactForStore(text, max)
}
