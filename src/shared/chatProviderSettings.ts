// Wire contract for /api/settings/chat-provider-env: the provider environment
// applied to chat-session SDK spawns. Secret-looking values are never sent to
// the browser; a PUT names them in `keep` to retain the stored value.

export type ChatProviderEnvSource = 'settings' | 'environment' | 'none'

export interface ChatProviderEnvResponse {
  /** Effective overrides; redacted names carry an empty string. */
  env: Record<string, string>
  /** Names whose values were withheld because they look like credentials. */
  redacted: string[]
  /** Where the effective value came from: a Settings override, AGENTBOARD_CHAT_ENV, or nothing. */
  source: ChatProviderEnvSource
}

export interface ChatProviderEnvUpdate {
  env: Record<string, string>
  /** Redacted names whose currently stored value should be kept as-is. */
  keep?: string[]
}
