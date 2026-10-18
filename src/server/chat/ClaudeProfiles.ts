// Launch configuration for chat sessions, resolved from the layered profile
// catalog (see profileCatalog.ts). Resolution copies inherited/global settings
// and never changes process.env. Every variable the catalog names as a
// credential is withheld from every launch; a credentialed provider's session
// receives its own token as ANTHROPIC_AUTH_TOKEN instead (openrouter-provider
// D3).
import fs from 'node:fs'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import {
  buildChatOptionsEnv,
  effectiveChatEnv,
  withheldCredentialNames,
  withoutCredentials,
  type ChatProviderEnv,
} from './chatProviderEnv'
import {
  PROFILE_CONTROLLED_ENV,
  resolveProfileCatalog,
  type ProfileCatalogContext,
} from './profileCatalog'

export { PROFILE_CONTROLLED_ENV } from './profileCatalog'
export type { ProfileCatalogContext } from './profileCatalog'

export type ClaudeLaunchConfiguration = Pick<Options, 'env' | 'model' | 'settings'> & {
  /** Operator-trusted wrapper launched in place of the standard binary. */
  executable?: string
}

/** Public catalog view: picker metadata plus per-file validation failures. */
export interface ClaudeProfileCatalogView {
  profiles: { id: string; label: string; providerId: string; providerLabel: string }[]
  /** Catalog file failures; the rest of the catalog remains usable. */
  errors: string[]
}

/**
 * Catalog identifiers, labels, and providers for a project path — the only
 * fields that may cross the client boundary — together with catalog file
 * failures, so invalid files are reported instead of silently skipped.
 * Catalog order (D13): the provider holding `default` first, then providers
 * in file order, each with its models in order — so `default` always leads
 * the list.
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
      metadata.push({ id: modelKey, label: profile.label, providerId, providerLabel: provider.label })
    }
  }
  return { profiles: metadata, errors }
}

/** Identifier/label list only; see claudeProfileCatalog for the full view. */
export function claudeProfileMetadata(
  ctx: ProfileCatalogContext = {}
): { id: string; label: string; providerId: string; providerLabel: string }[] {
  return claudeProfileCatalog(ctx).profiles
}

export function resolveClaudeProfile(
  id: string = 'default',
  globalEnv: ChatProviderEnv = {},
  ctx: ProfileCatalogContext = {},
  onCatalogErrors?: (errors: string[]) => void
): ClaudeLaunchConfiguration {
  const catalog = resolveProfileCatalog(ctx)
  // A failed file skips silently otherwise; report it (the rest resolves).
  if (catalog.errors.length > 0) onCatalogErrors?.(catalog.errors)
  const profile = catalog.profiles.get(id)
  if (!profile) {
    throw new Error(`Unknown Claude profile "${id}". Restore its catalog file entry before resuming.`)
  }
  const withheld = withheldCredentialNames(catalog)
  const serverEnv = effectiveChatEnv(globalEnv)
  // The provider's own token, read before the names are withheld (D3/D4).
  const credential = profile.authTokenEnv !== undefined
    ? { ANTHROPIC_AUTH_TOKEN: serverEnv[profile.authTokenEnv] ?? '', ...BLANK_OTHER_CREDENTIALS }
    : undefined
  const base = withoutCredentials(serverEnv, withheld)
  const hasOverrides =
    Object.keys(profile.env).length > 0 || profile.model !== undefined || profile.executable !== undefined
  // A file entry that sets nothing inherits the global environment entirely,
  // exactly like an implicit default — filtered whenever the catalog names
  // credentials, so a default launch never sees them either.
  if (!hasOverrides && !credential) {
    if (withheld.size > 0) return { env: base }
    const env = buildChatOptionsEnv(globalEnv)
    return env ? { env } : {}
  }
  if (profile.executable) {
    // The wrapper owns provider configuration: the base environment (with
    // credentials, minus withheld ones) passes through, entry values are
    // pre-applied, and no inline controlled settings are injected — those
    // would override the wrapper's own exports and defeat the delegation.
    return {
      env: { ...base, ...profile.env, ...credential },
      executable: profile.executable,
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
  return {
    env,
    // The blanks also go in the flag layer, so no settings file can restore
    // another credential; the token itself never rides in settings (argv).
    settings: { env: credential ? { ...controlled, ...BLANK_OTHER_CREDENTIALS } : controlled },
    ...(profile.model !== undefined ? { model: profile.model } : {}),
  }
}

/** Credentials a credentialed provider's session must not fall back to (D3). */
const BLANK_OTHER_CREDENTIALS = { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } as const

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
