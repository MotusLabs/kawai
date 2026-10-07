// Launch configuration for chat sessions, resolved from the layered profile
// catalog (see profileCatalog.ts). Resolution copies inherited/global settings
// and never changes process.env.
import fs from 'node:fs'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { buildChatOptionsEnv, effectiveChatEnv, type ChatProviderEnv } from './chatProviderEnv'
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
  profiles: { id: string; label: string }[]
  /** Catalog file failures; the rest of the catalog remains usable. */
  errors: string[]
}

/**
 * Catalog identifiers and labels for a project path — the only fields that
 * may cross the client boundary — together with catalog file failures, so
 * invalid files are reported instead of silently skipped. `default` always
 * leads the list.
 */
export function claudeProfileCatalog(
  ctx: ProfileCatalogContext = {}
): ClaudeProfileCatalogView {
  const { profiles, errors } = resolveProfileCatalog(ctx)
  const metadata = [...profiles.entries()].map(({ 0: id, 1: profile }) => ({ id, label: profile.label }))
  const defaultIndex = metadata.findIndex(profile => profile.id === 'default')
  if (defaultIndex > 0) metadata.unshift(...metadata.splice(defaultIndex, 1))
  return { profiles: metadata, errors }
}

/** Identifier/label list only; see claudeProfileCatalog for the full view. */
export function claudeProfileMetadata(
  ctx: ProfileCatalogContext = {}
): { id: string; label: string }[] {
  return claudeProfileCatalog(ctx).profiles
}

export function resolveClaudeProfile(
  id: string = 'default',
  globalEnv: ChatProviderEnv = {},
  ctx: ProfileCatalogContext = {},
  onCatalogErrors?: (errors: string[]) => void
): ClaudeLaunchConfiguration {
  const { profiles, errors } = resolveProfileCatalog(ctx)
  // A failed file skips silently otherwise; report it (the rest resolves).
  if (errors.length > 0) onCatalogErrors?.(errors)
  const profile = profiles.get(id)
  if (!profile) {
    throw new Error(`Unknown Claude profile "${id}". Restore its catalog file entry before resuming.`)
  }
  const hasOverrides =
    Object.keys(profile.env).length > 0 || profile.model !== undefined || profile.executable !== undefined
  // A file entry that sets nothing inherits the global environment entirely,
  // exactly like an implicit default.
  if (!hasOverrides) {
    const env = buildChatOptionsEnv(globalEnv)
    return env ? { env } : {}
  }
  if (profile.executable) {
    // The wrapper owns provider configuration: the base environment (with
    // credentials) passes through, entry values are pre-applied, and no
    // inline controlled settings are injected — those would override the
    // wrapper's own exports and defeat the delegation.
    return {
      env: { ...effectiveChatEnv(globalEnv), ...profile.env },
      executable: profile.executable,
      ...(profile.model !== undefined ? { model: profile.model } : {}),
    }
  }
  const env = effectiveChatEnv(globalEnv)
  const controlled: ChatProviderEnv = {}
  for (const name of PROFILE_CONTROLLED_ENV) {
    delete env[name]
    // Blank file-layer values neutralize inherited settings for absent fields.
    controlled[name] = profile.env[name] ?? ''
  }
  Object.assign(env, profile.env)
  return {
    env,
    settings: { env: controlled },
    ...(profile.model !== undefined ? { model: profile.model } : {}),
  }
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
