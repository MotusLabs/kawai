// Which team providers draw on one login (dispatch-worker-choice D6), for
// team_capacity's `sharesLoginWith`. Pure: the caller resolves each worker's
// launch (catalog resolution, never a spawn) and this module decides from it.
// Only a Claude launch that authenticates through the CLI's stored login has
// a key: no API key, auth token, or OAuth token variable present (a blank
// one counts — a credentialed provider whose variable is missing launches
// with an empty token), no base URL other than Anthropic's API, no wrapper
// executable (kawai cannot see how it authenticates), and an absolute
// config directory. The key is that directory as a path string — nothing
// under it is read — and it never leaves the capacity reader. Everything
// else has no key and is never marked: unmarked means not detected.
import path from 'node:path'
import { claudeConfigDir } from '../../chat/chatAuth'
import type { ChatLaunchConfiguration } from '../../chat/ClaudeProfiles'

const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com'

/** The stored-login key of one launch, or null when it is not provably the stored login. */
export function storedLoginKey(launch: ChatLaunchConfiguration, inherited: Record<string, string | undefined>): string | null {
  if (launch.runtime !== 'claude' || launch.executable !== undefined) return null
  // An unset SDK env inherits the server's; the flag settings layer counts too.
  // A settings file path cannot be judged without reading it: unresolved.
  if (typeof launch.settings === 'string') return null
  const env = launch.env ?? inherited
  const layers: Array<Record<string, string | undefined>> = [env, launch.settings?.env ?? {}]
  // Present means set, even blank; an undefined hole is never passed to the child.
  if (layers.some(layer => CREDENTIAL_ENV.some(name => layer[name] !== undefined))) return null
  if (!layers.every(layer => isAnthropicApi(layer.ANTHROPIC_BASE_URL))) return null
  const dir = claudeConfigDir(env)
  return path.isAbsolute(dir) ? path.resolve(dir) : null
}

/** Unset or blank, or exactly Anthropic's API origin (an optional trailing slash). */
function isAnthropicApi(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) return true
  try {
    const url = new URL(trimmed)
    return url.origin === ANTHROPIC_API_ORIGIN && (url.pathname === '/' || url.pathname === '') &&
      url.search === '' && url.hash === '' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/**
 * Each provider's other providers on its login. A provider has a login only
 * when every one of its workers has the same non-null key — a provider
 * mixing a stored login with anything else is never marked. Symmetric, and
 * each list sorted; a provider with no login maps to an empty list.
 */
export function sharedLogins(workers: ReadonlyArray<{ provider: string; key: string | null }>): Map<string, string[]> {
  const keys = new Map<string, string | null>()
  for (const { provider, key } of workers) {
    if (!keys.has(provider)) keys.set(provider, key)
    else if (keys.get(provider) !== key) keys.set(provider, null)
  }
  const result = new Map<string, string[]>()
  for (const [provider, key] of keys) {
    result.set(provider, key === null ? [] : [...keys]
      .filter(([other, otherKey]) => other !== provider && otherKey === key).map(([other]) => other).sort())
  }
  return result
}
