// Shared rules for the pure profile helpers (design §4, task 3.1). A helper
// reads only its arguments: the caller's approved base map, the selected
// provider values and the names it registered as credentials elsewhere. It
// never reads process.env, a home directory or a catalog, never mutates an
// input, and returns a frozen map. Validation failures are configuration
// errors raised before anything could spawn (P01).
import { AgentRuntimeError } from '../errors.js'

export type EnvMap = Readonly<Record<string, string>>

/**
 * Route variables a settings file or the host could use to redirect or
 * intercept a credentialed launch. Every Claude profile pins them, in the
 * environment and the flag-layer settings, to the base map's value or empty.
 */
export const TRANSPORT_PIN_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS'] as const

/** Name families that carry Claude/Anthropic authority; never inherited from the base map. */
export const CLAUDE_FAMILY_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_'] as const

/** Single names with Claude authority outside those families. */
export const CLAUDE_FAMILY_NAMES = ['CLAUDE_CONFIG_DIR'] as const

/** Codex authority names; a Claude launch never inherits them. */
export const CODEX_FAMILY_NAMES = ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const

export function configurationError(message: string): AgentRuntimeError {
  return new AgentRuntimeError({ category: 'configuration', message })
}

export function isClaudeFamily(name: string): boolean {
  return CLAUDE_FAMILY_PREFIXES.some((prefix) => name.startsWith(prefix)) || (CLAUDE_FAMILY_NAMES as readonly string[]).includes(name)
}

/** A copy of `base` with only string values; anything else is a configuration error. */
export function readBase(base: unknown): Record<string, string> {
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    throw configurationError('the base environment must be an object of string values')
  }
  const copy: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== 'string') throw configurationError(`base environment variable ${name} is not a string`)
    copy[name] = value
  }
  return copy
}

export function readWithheld(withheld: unknown): ReadonlySet<string> {
  if (withheld === undefined) return new Set()
  if (!Array.isArray(withheld) || withheld.some((name) => typeof name !== 'string')) {
    throw configurationError('withheld credential names must be an array of strings')
  }
  return new Set(withheld as string[])
}

export function requireValue(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw configurationError(`${name} is required`)
  return value
}

/**
 * A withheld name the helper itself must set cannot be withheld by absence:
 * delivering it would hand over a registered credential, and dropping it
 * would break the selected profile. The helper refuses instead.
 */
export function refuseWithheldCollisions(withheld: ReadonlySet<string>, sets: readonly string[], profile: string): void {
  const collisions = sets.filter((name) => withheld.has(name)).sort()
  if (collisions.length > 0) {
    throw configurationError(`the ${profile} profile must set withheld name(s): ${collisions.join(', ')}`)
  }
}

export function freeze(env: Record<string, string>): EnvMap {
  return Object.freeze({ ...env })
}
