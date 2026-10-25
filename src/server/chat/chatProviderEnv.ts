// Provider environment for chat sessions: KEY=VALUE overrides (base URL,
// model names, gateway token) applied only to the Claude Agent SDK processes
// spawned for chat — never to tmux terminal sessions. Seeded from
// AGENTBOARD_CHAT_ENV, overridable from Settings. The SDK's `env` option
// REPLACES the subprocess environment rather than merging it, so the merge
// with process.env happens here, in one place. Credential variables a
// trusted catalog names are withheld from every launch here too.
import { registeredSecretNames } from './secretNameRegistry'

export type ChatProviderEnv = Record<string, string>

/** Upper bounds so a Settings PUT cannot store an unbounded blob. */
export const CHAT_PROVIDER_ENV_MAX_ENTRIES = 32
export const CHAT_PROVIDER_ENV_MAX_VALUE_LENGTH = 4096

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate an untrusted value (a Settings PUT body or stored JSON) as a
 * provider environment. Returns a human-readable refusal instead of dropping
 * bad entries, so the operator sees why their setting was not applied.
 */
export function validateChatProviderEnv(
  value: unknown
): { ok: true; env: ChatProviderEnv } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Provider environment must be an object of NAME: value pairs.' }
  }
  const entries = Object.entries(value)
  if (entries.length > CHAT_PROVIDER_ENV_MAX_ENTRIES) {
    return { ok: false, error: `At most ${CHAT_PROVIDER_ENV_MAX_ENTRIES} variables are allowed.` }
  }
  const env: ChatProviderEnv = {}
  for (const [name, raw] of entries) {
    if (!ENV_NAME.test(name)) {
      return { ok: false, error: `"${name}" is not a valid environment variable name.` }
    }
    if (typeof raw !== 'string') {
      return { ok: false, error: `${name} must be a string.` }
    }
    if (raw.length > CHAT_PROVIDER_ENV_MAX_VALUE_LENGTH) {
      return { ok: false, error: `${name} is longer than ${CHAT_PROVIDER_ENV_MAX_VALUE_LENGTH} characters.` }
    }
    if (raw.includes('\0')) {
      return { ok: false, error: `${name} contains a NUL character.` }
    }
    env[name] = raw
  }
  return { ok: true, env }
}

/**
 * Parse AGENTBOARD_CHAT_ENV ("KEY=VALUE;KEY=VALUE"). Values may contain "="
 * (only the first splits). Malformed pairs are skipped with a warning: a typo
 * in a service file must not stop the server from starting.
 */
export function parseChatProviderEnv(raw: string | undefined): ChatProviderEnv {
  const env: ChatProviderEnv = {}
  for (const pair of (raw ?? '').split(';')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const name = eq === -1 ? trimmed : trimmed.slice(0, eq).trim()
    if (eq === -1 || !ENV_NAME.test(name)) {
      console.warn(`[agentboard] Ignoring malformed AGENTBOARD_CHAT_ENV entry: "${trimmed}"`)
      continue
    }
    env[name] = trimmed.slice(eq + 1).trim()
  }
  return env
}

/** Server env plus overrides — what the spawned SDK process will see. */
export function effectiveChatEnv(
  providerEnv: ChatProviderEnv
): Record<string, string | undefined> {
  return { ...process.env, ...providerEnv }
}

/**
 * The SDK `env` option for a chat spawn: omitted when there are no overrides,
 * so an unconfigured server spawns exactly as before.
 */
export function buildChatOptionsEnv(
  providerEnv: ChatProviderEnv
): Record<string, string | undefined> | undefined {
  return Object.keys(providerEnv).length > 0 ? effectiveChatEnv(providerEnv) : undefined
}

/**
 * The registered catalog names a resolved catalog carries (provider-relay-setup
 * D2): every credential variable named at any parsed catalog layer, in any
 * entry state — collected by `resolveProfileCatalog` before the merge, so
 * removing a provider's entry, dropping it, or (§3) disabling it never stops
 * withholding. Retained names, header variables and store keys join through
 * the registry (secretNameRegistry.ts); this is the catalog's contribution.
 */
export function withheldCredentialNames(catalog: {
  credentialNames: ReadonlySet<string>
}): Set<string> {
  return registeredSecretNames({ catalogNames: catalog.credentialNames })
}

/** A copy of `env` without the withheld names. */
export function withoutCredentials(
  env: Record<string, string | undefined>,
  names: ReadonlySet<string>
): Record<string, string | undefined> {
  const filtered = { ...env }
  for (const name of names) delete filtered[name]
  return filtered
}
