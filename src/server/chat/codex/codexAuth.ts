// Server-side Codex login gate for Codex chat sessions and the actionable
// refusal shown when it fails (codex-chat-sessions 4.2, spec "Codex sessions
// require a Codex login"). The check is structural: a Codex home is usable
// when its auth.json carries an API key or ChatGPT tokens. Kawai never
// writes into a Codex home and never stores or forwards anything it reads
// here; the file's values stay on the server.
import fs from 'node:fs'
import path from 'node:path'

/** The Codex CLI's credentials file inside a Codex home. */
export const CODEX_AUTH_FILE = 'auth.json'

/** Structural slice of the auth file's two login shapes (SDK-free). */
interface CodexAuthSlice {
  OPENAI_API_KEY?: unknown
  tokens?: { access_token?: unknown } | null
}

/**
 * Whether one resolved Codex home holds a usable login: auth.json parses
 * and names a nonempty API key or nonempty ChatGPT access token. A missing,
 * unreadable, or unparsable file reads as no login — the app-server itself
 * re-verifies whatever this gate passes.
 */
export function hasCodexLogin(codexHome: string): boolean {
  const slice = readCodexAuth(codexHome)
  if (!slice) return false
  if (typeof slice.OPENAI_API_KEY === 'string' && slice.OPENAI_API_KEY.trim()) return true
  return typeof slice.tokens?.access_token === 'string' && !!slice.tokens.access_token.trim()
}

function readCodexAuth(codexHome: string): CodexAuthSlice | null {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(codexHome, CODEX_AUTH_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as CodexAuthSlice
  } catch {
    return null
  }
}

/**
 * Actionable refusal shown when hasCodexLogin() is false (spec: the error
 * names the Codex home and how to sign in).
 */
export function codexLoginErrorMessage(codexHome: string): string {
  return (
    `Codex home ${codexHome} has no usable login. ` +
    'Sign in with `CODEX_HOME=<home> codex login` (ChatGPT plan or API key), ' +
    'then retry.'
  )
}
