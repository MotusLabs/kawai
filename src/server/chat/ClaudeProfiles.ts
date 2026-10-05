// Server-owned profiles derived from /usr/local/bin/claude-provider branches.
// Resolution copies inherited/global settings and never changes process.env.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { buildChatOptionsEnv, effectiveChatEnv, type ChatProviderEnv } from './chatProviderEnv'

export const PROFILE_CONTROLLED_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_ATTRIBUTION_HEADER', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
] as const

interface ClaudeProfile {
  id: string
  label: string
  env: ChatProviderEnv
  model?: string
}

const profiles: readonly ClaudeProfile[] = [
  { id: 'default', label: 'Default', env: {} },
  { id: 'glm', label: 'GLM', model: 'sonnet', env: {
    ANTHROPIC_BASE_URL: 'https://zai.ruslan.casa/api/anthropic',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  } },
  { id: 'minimax', label: 'MiniMax', model: 'MiniMax-M3', env: {
    ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_MODEL: 'MiniMax-M3',
  } },
  { id: 'mimo', label: 'MiMo', model: 'mimo-v2.6-pro', env: {
    ANTHROPIC_BASE_URL: 'https://xiaomi.ruslan.casa/anthropic',
    ANTHROPIC_MODEL: 'mimo-v2.6-pro', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.6-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.6-pro',
  } },
  { id: 'kimi', label: 'Kimi', env: { ANTHROPIC_BASE_URL: 'https://kimi.ruslan.casa/' } },
  { id: 'lan', label: 'LAN', env: {
    ANTHROPIC_BASE_URL: 'http://ai.lan:9292', CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  } },
]

/** Only these fields may cross the client boundary. */
export function claudeProfileMetadata(): { id: string; label: string }[] {
  return profiles.map(({ id, label }) => ({ id, label }))
}

export type ClaudeLaunchConfiguration = Pick<Options, 'env' | 'model' | 'settings'>

export function resolveClaudeProfile(
  id: string = 'default',
  globalEnv: ChatProviderEnv = {}
): ClaudeLaunchConfiguration {
  const profile = profiles.find((candidate) => candidate.id === id)
  if (!profile) throw new Error(`Unknown Claude profile "${id}". Restore its catalog entry before resuming.`)
  if (id === 'default') {
    const env = buildChatOptionsEnv(globalEnv)
    return env ? { env } : {}
  }
  const env = effectiveChatEnv(globalEnv)
  const controlled: ChatProviderEnv = {}
  for (const name of PROFILE_CONTROLLED_ENV) {
    delete env[name]
    // Blank flag-layer values neutralize inherited settings for absent fields.
    controlled[name] = profile.env[name] ?? ''
  }
  Object.assign(env, profile.env)
  return { env, settings: { env: controlled }, ...(profile.model ? { model: profile.model } : {}) }
}

/** Stable identity for every launch setting used by an availability probe. */
export function claudeLaunchKey(launch: ClaudeLaunchConfiguration): string {
  const env = Object.entries(launch.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([env, launch.model, launch.settings])
}
