// Launch configuration for chat sessions, resolved from the layered profile
// catalog (see profileCatalog.ts). Resolution copies inherited/global settings
// and never changes process.env. Every variable the catalog names as a
// credential is withheld from every launch; a credentialed provider's session
// receives its own token as ANTHROPIC_AUTH_TOKEN instead (openrouter-provider
// D3).
import fs from 'node:fs'
import os from 'node:os'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeProfileMetadata } from '../../shared/chat'
import {
  effectiveChatEnv,
  withheldCredentialNames,
  withoutCredentials,
  type ChatProviderEnv,
} from './chatProviderEnv'
import { CODEX_PROVIDER_LABEL, resolveCodexHome, type CodexLaunchConfiguration } from './codexProfiles'
import {
  PROFILE_CONTROLLED_ENV,
  resolveProfileCatalog,
  type CatalogProfile,
  type ProfileCatalogContext,
} from './profileCatalog'

export { PROFILE_CONTROLLED_ENV } from './profileCatalog'
export type { CodexLaunchConfiguration } from './codexProfiles'
export type { ProfileCatalogContext } from './profileCatalog'

export type ClaudeLaunchConfiguration = Pick<Options, 'env' | 'model' | 'settings'> & {
  /** Operator-trusted wrapper launched in place of the standard binary. */
  executable?: string
  /** The runtime discriminant (design D4); always `claude` here. */
  runtime: 'claude'
}

/** What one profile resolves to: the Claude SDK launch or the Codex launch. */
export type ChatLaunchConfiguration = ClaudeLaunchConfiguration | CodexLaunchConfiguration

/** Public catalog view: picker metadata plus per-file validation failures. */
export interface ClaudeProfileCatalogView {
  profiles: ClaudeProfileMetadata[]
  /** Catalog file failures; the rest of the catalog remains usable. */
  errors: string[]
}

/**
 * Catalog identifiers, labels, providers, and runtimes for a project path —
 * the only fields that may cross the client boundary — together with catalog
 * file failures, so invalid files are reported instead of silently skipped.
 * Catalog order (D13): the provider holding `default` first, then providers
 * in file order, each with its models in order — so `default` always leads
 * the list — then Codex entries in file order, each its own home-derived
 * provider under the fixed Codex label (R2).
 */
export function claudeProfileCatalog(
  ctx: ProfileCatalogContext = {}
): ClaudeProfileCatalogView {
  const { profiles, providers, errors } = resolveProfileCatalog(ctx)
  const metadata: ClaudeProfileCatalogView['profiles'] = []
  for (const [providerId, provider] of providers) {
    for (const modelKey of provider.models) {
      const profile = profiles.get(modelKey)
      if (!profile) continue
      metadata.push({ id: modelKey, label: profile.label, providerId, providerLabel: provider.label, runtime: 'claude' })
    }
  }
  for (const [id, profile] of profiles) {
    if (profile.runtime !== 'codex') continue
    metadata.push({ id, label: profile.label, providerId: profile.providerId, providerLabel: CODEX_PROVIDER_LABEL, runtime: 'codex' })
  }
  return { profiles: metadata, errors }
}

/** Identifier/label list only; see claudeProfileCatalog for the full view. */
export function claudeProfileMetadata(
  ctx: ProfileCatalogContext = {}
): ClaudeProfileMetadata[] {
  return claudeProfileCatalog(ctx).profiles
}

export function resolveClaudeProfile(
  id: string = 'default',
  globalEnv: ChatProviderEnv = {},
  ctx: ProfileCatalogContext = {},
  onCatalogErrors?: (errors: string[]) => void
): ChatLaunchConfiguration {
  const catalog = resolveProfileCatalog(ctx)
  // A failed file skips silently otherwise; report it (the rest resolves).
  if (catalog.errors.length > 0) onCatalogErrors?.(catalog.errors)
  const profile = catalog.profiles.get(id)
  if (!profile) {
    throw new Error(`Unknown Claude profile "${id}". Restore its catalog file entry before resuming.`)
  }
  // Codex entries (design D4) resolve to the launch the app-server spawn
  // needs: the home resolved exactly as the catalog's own home-provider id
  // is (R2), so stamp and provider id can never disagree. Codex entries
  // carry no catalog env — configuration travels as `-c` overrides. They
  // never touch credentials: withholding covers Claude launches only, and a
  // Codex launch's environment is the server's own (codex-chat-sessions D4).
  if (profile.runtime === 'codex') {
    return {
      runtime: 'codex',
      codexHome: resolveCodexHome(
        { codexHome: profile.codexHome },
        {
          CODEX_HOME: ctx.serverCodexHome ?? process.env.CODEX_HOME,
          HOME: ctx.homeDir ?? process.env.HOME ?? os.homedir(),
        },
      ),
      network: profile.network ?? true,
      ...(profile.model !== undefined ? { model: profile.model } : {}),
    }
  }
  const withheld = withheldCredentialNames(catalog)
  const serverEnv = effectiveChatEnv(globalEnv)
  // Every launch passes an explicit, filtered environment (openrouter-provider
  // D3): never a bare inheritance of process.env, so the catalog-named
  // credentials stay out of default and executable-backed launches too.
  const base = withoutCredentials(serverEnv, withheld)
  return buildClaudeLaunch(profile, base, serverEnv)
}

/**
 * The launch configuration for one resolved Claude catalog profile
 * (openrouter-provider D3): an explicit env always, the provider's own token
 * injected for credentialed profiles, and — for every launch that receives a
 * token — the base URL and transport variables pinned in both the env and the
 * flag-layer settings.env, so no user or project Claude settings file can
 * redirect or intercept the key. Exported for tests; resolveClaudeProfile is
 * the only production caller.
 */
export function buildClaudeLaunch(
  profile: CatalogProfile,
  base: Record<string, string | undefined>,
  serverEnv: Record<string, string | undefined>
): ClaudeLaunchConfiguration {
  // The provider's own token, read before the names are withheld (D3/D4).
  const credential = profile.authTokenEnv !== undefined
    ? { ANTHROPIC_AUTH_TOKEN: serverEnv[profile.authTokenEnv] ?? '', ...BLANK_OTHER_CREDENTIALS }
    : undefined
  const hasOverrides =
    Object.keys(profile.env).length > 0 || profile.model !== undefined || profile.executable !== undefined
  // A file entry that sets nothing inherits the (filtered) global environment.
  if (!hasOverrides && !credential) {
    return { env: base, runtime: 'claude' }
  }
  if (profile.executable) {
    // The wrapper owns provider configuration: the base environment (minus
    // withheld ones) passes through, entry values are pre-applied, and no
    // inline controlled settings are injected — those would override the
    // wrapper's own exports and defeat the delegation. It never receives a
    // named credential (D2): the parser refuses credentialed executables, and
    // a catalog that bypassed the parser must not hand the key to a wrapper
    // that can send it anywhere. A wrapper that needs a key sets its own.
    return {
      env: { ...base, ...profile.env },
      executable: profile.executable,
      runtime: 'claude',
      ...(profile.model !== undefined ? { model: profile.model } : {}),
    }
  }
  const env = base
  const controlled: ChatProviderEnv = {}
  for (const name of PROFILE_CONTROLLED_ENV) {
    delete env[name]
    // Blank file-layer values neutralize inherited settings for absent fields.
    controlled[name] = profile.env[name] ?? ''
  }
  Object.assign(env, profile.env, credential)
  if (!credential) {
    return {
      env,
      settings: { env: controlled },
      runtime: 'claude',
      ...(profile.model !== undefined ? { model: profile.model } : {}),
    }
  }
  // A launch that carries the key pins its route (D3): the provider's trusted
  // base URL and the transport variables, in the process env and the flag
  // layer alike, each to the server environment's own value or empty. The
  // token itself never rides in settings (argv).
  const pinned: ChatProviderEnv = { ANTHROPIC_BASE_URL: profile.env.ANTHROPIC_BASE_URL ?? '' }
  for (const name of TRANSPORT_PIN_ENV) {
    pinned[name] = serverEnv[name] ?? ''
  }
  Object.assign(env, pinned)
  return {
    env,
    settings: { env: { ...controlled, ...pinned, ...BLANK_OTHER_CREDENTIALS } },
    runtime: 'claude',
    ...(profile.model !== undefined ? { model: profile.model } : {}),
  }
}

/** Credentials a credentialed provider's session must not fall back to (D3). */
const BLANK_OTHER_CREDENTIALS = { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } as const

/**
 * The route variables a settings file could otherwise use to redirect or
 * intercept a credentialed launch (openrouter-provider D3): pinned on every
 * launch that carries a key, to the server environment's own value or empty.
 */
export const TRANSPORT_PIN_ENV = [
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS',
] as const

/**
 * The provider and token variable a profile must authenticate with, when its
 * provider names one (openrouter-provider D4); undefined otherwise.
 */
export function profileCredential(
  id: string = 'default',
  ctx: ProfileCatalogContext = {}
): { providerLabel: string; authTokenEnv: string } | undefined {
  const catalog = resolveProfileCatalog(ctx)
  const profile = catalog.profiles.get(id)
  if (profile?.authTokenEnv === undefined) return undefined
  const providerLabel = catalog.providers.get(profile.providerId)?.label ?? profile.providerId
  return { providerLabel, authTokenEnv: profile.authTokenEnv }
}

/** The zone a profile's provider writes zone-less reset times in, if configured. */
export function profileLimitResetTimeZone(id: string = 'default', ctx: ProfileCatalogContext = {}): string | undefined {
  return resolveProfileCatalog(ctx).profiles.get(id)?.limitResetTimeZone
}

/**
 * Verify an operator-named executable before any spawn. Errors are actionable
 * by construction: they name the profile, the path, and what is wrong.
 */
export function verifyProfileExecutable(profileId: string, executablePath: string): void {
  const fail = (reason: string): never => {
    throw new Error(`Profile "${profileId}" executable ${reason}: ${executablePath}`)
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(executablePath)
  } catch {
    throw new Error(`Profile "${profileId}" executable was not found: ${executablePath}`)
  }
  if (!stat.isFile()) fail('is not a file')
  try {
    fs.accessSync(executablePath, fs.constants.X_OK)
  } catch {
    fail('is not executable')
  }
}

/** Stable identity for every launch setting used by an availability probe. */
export function claudeLaunchKey(launch: ClaudeLaunchConfiguration): string {
  const env = Object.entries(launch.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([env, launch.model, launch.settings, launch.executable])
}
