// Codex profile resolution shared by the catalog and the driver (design D4,
// ruling R2): a Codex profile's provider (the account/endpoint sense) derives
// from its resolved Codex home — never from the path. The id hashes the
// resolved absolute home, so the path never lands in an id or a label, and
// two profiles on one home share the cooldown and usage key. Pure: the
// caller injects the environment, so tests never touch process.env.
import { createHash } from 'node:crypto'
import path from 'node:path'

/** The environment a Codex home resolves against; both optional. */
export interface CodexHomeEnv {
  /** The server's CODEX_HOME, when set. */
  CODEX_HOME?: string
  /** The effective HOME for expanding `~`-prefixed homes. */
  HOME?: string
}

/** The Codex home a profile entry names, if any (trusted-tier field only). */
export interface CodexHomeSource {
  codexHome?: string
}

/**
 * The resolved absolute Codex home: the profile's own `codexHome` when the
 * user-level catalog named one, else the server's `CODEX_HOME`, else
 * `~/.codex`. `~` expands against the effective HOME and the result is
 * always absolute.
 */
export function resolveCodexHome(profile: CodexHomeSource, env: CodexHomeEnv): string {
  const named = profile.codexHome?.trim()
  const raw = named || env.CODEX_HOME?.trim() || '~/.codex'
  if (raw === '~') return env.HOME || path.join(path.sep, 'root')
  if (raw.startsWith('~/')) return path.join(env.HOME || path.join(path.sep, 'root'), raw.slice(2))
  return path.resolve(raw)
}

/**
 * The provider id (R2) for a resolved home: `codex-home-` plus the first 12
 * hex characters of its SHA-256. The path is never recoverable from the id,
 * and every profile on one home shares it.
 */
export function codexHomeProviderId(resolvedHome: string): string {
  const hash = createHash('sha256').update(resolvedHome).digest('hex')
  return `codex-home-${hash.slice(0, 12)}`
}

/**
 * The label every home-derived provider carries (R2): the picker and chat
 * header identify the runtime as Codex through it.
 */
export const CODEX_PROVIDER_LABEL = 'Codex'

/**
 * The environment a Codex app-server spawn receives (design D4): the
 * server's own environment with CODEX_HOME set — PATH and HOME survive, so
 * a `#!/usr/bin/env node` codex starts — minus the provider variables:
 * every ANTHROPIC_* and CLAUDE_CODE_* variable (PROFILE_CONTROLLED_ENV is a
 * subset), CLAUDE_CONFIG_DIR (R2-4), and the AGENTBOARD_CHAT_ENV overrides,
 * which must never steer another agent runtime. Configuration travels as
 * `-c` overrides instead (task 5.3's sandbox builds them), and the spawn
 * writes nothing into the home.
 */
export function codexSpawnEnv(
  serverEnv: Record<string, string | undefined>,
  resolvedHome: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(serverEnv)) {
    if (value === undefined) continue
    if (name === 'AGENTBOARD_CHAT_ENV') continue
    if (name === 'CLAUDE_CONFIG_DIR') continue
    if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_')) continue
    env[name] = value
  }
  env.CODEX_HOME = resolvedHome
  return env
}

/**
 * The Codex arm of profile resolution (design D4): a resolved home (the
 * login and usage key live there), the model when the profile names one,
 * and network access (default on, turned off per profile). Configuration
 * travels to the app-server as `-c` overrides built from these, never as
 * catalog env entries.
 */
export interface CodexLaunchConfiguration {
  runtime: 'codex'
  codexHome: string
  network: boolean
  model?: string
}

