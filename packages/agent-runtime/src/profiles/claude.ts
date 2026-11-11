// Claude profile helpers (design §4, task 3.1): Anthropic OAuth and an
// Anthropic-compatible proxy (Z.AI style). Each returns the child's complete
// environment and the non-secret flag-layer settings that pin it.
//
// - The base map loses every withheld name, every Claude/Anthropic family
//   variable and every Codex credential; nothing with authority is inherited.
// - The selected credential is set; its alternatives are blanked, in the
//   environment and in settings, so no settings file can supply them.
// - Transport variables are pinned to the base map's value or empty.
// - The protocol variables the SDK would add (and the owned spawner drops)
//   are set: CLAUDE_CODE_ENTRYPOINT and CLAUDE_AGENT_SDK_VERSION.
//
// Settings travel to the CLI as `--settings` JSON in argv, so they never
// hold a token or custom header value.
import {
  CODEX_FAMILY_NAMES,
  TRANSPORT_PIN_ENV,
  configurationError,
  freeze,
  isClaudeFamily,
  readBase,
  readWithheld,
  refuseWithheldCollisions,
  requireValue,
  type EnvMap,
} from './env.js'

/** The pinned peer SDK version; a test fails when the installed SDK differs. */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.289'

export interface ClaudeProfileBase {
  /** The caller's approved non-credential map (PATH, LANG, TZ, …). */
  base: EnvMap
  /** Names the caller registered as credentials elsewhere; removed from the result. */
  withheld?: readonly string[]
}

export interface AnthropicOAuthInput extends ClaudeProfileBase {
  oauthToken: string
}

export interface ClaudeProxyInput extends ClaudeProfileBase {
  /** Absolute http(s) URL of the Anthropic-compatible endpoint. */
  baseUrl: string
  /** The token the proxy expects; often a placeholder when a header carries the key. */
  authToken: string
  /** ANTHROPIC_CUSTOM_HEADERS value (newline-separated `Name: value`); secret. */
  customHeaders?: string
}

export interface ClaudeProfile {
  /** The complete child environment: pass it as LaunchConfiguration.childEnv. */
  childEnv: EnvMap
  /** Non-secret settings for the SDK's `settings` option (the `--settings` flag layer). */
  settings: { env: EnvMap }
}

const CREDENTIAL_NAMES = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS'] as const

function compose(
  input: ClaudeProfileBase,
  profile: string,
  selected: Record<string, string>,
  secret: ReadonlySet<string>,
): ClaudeProfile {
  const base = readBase(input.base)
  const withheld = readWithheld(input.withheld)
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (withheld.has(name) || isClaudeFamily(name) || (CODEX_FAMILY_NAMES as readonly string[]).includes(name)) continue
    env[name] = value
  }
  const pins: Record<string, string> = {}
  for (const name of TRANSPORT_PIN_ENV) pins[name] = withheld.has(name) ? '' : (base[name] ?? '')
  const blanks: Record<string, string> = {}
  for (const name of CREDENTIAL_NAMES) if (!(name in selected)) blanks[name] = ''
  const protocol = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION }
  const routed = { ANTHROPIC_BASE_URL: '', ...selected }
  // Only names set to a value would deliver something; a blanked name delivers nothing.
  const delivered = Object.entries({ ...protocol, ...routed }).filter(([, value]) => value !== '').map(([name]) => name)
  refuseWithheldCollisions(withheld, delivered, profile)
  const childEnv = { ...env, ...pins, ...blanks, ...protocol, ...routed }
  const settingsEnv: Record<string, string> = { ...pins, ...blanks }
  for (const [name, value] of Object.entries(routed)) if (!secret.has(name)) settingsEnv[name] = value
  return { childEnv: freeze(childEnv), settings: Object.freeze({ env: freeze(settingsEnv) }) }
}

/** Anthropic subscription login through an OAuth token. */
export function anthropicOAuthProfile(input: AnthropicOAuthInput): ClaudeProfile {
  const token = requireValue('oauthToken', input.oauthToken)
  return compose(input, 'Anthropic OAuth', { CLAUDE_CODE_OAUTH_TOKEN: token }, new Set(['CLAUDE_CODE_OAUTH_TOKEN']))
}

/** An Anthropic-compatible proxy: base URL, auth token and optional custom headers survive unchanged. */
export function claudeProxyProfile(input: ClaudeProxyInput): ClaudeProfile {
  const baseUrl = requireValue('baseUrl', input.baseUrl)
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw configurationError('baseUrl must be an absolute http(s) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw configurationError('baseUrl must be an absolute http(s) URL')
  const authToken = requireValue('authToken', input.authToken)
  const selected: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: authToken }
  if (input.customHeaders !== undefined) selected.ANTHROPIC_CUSTOM_HEADERS = requireValue('customHeaders', input.customHeaders)
  return compose(input, 'Claude proxy', selected, new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']))
}
