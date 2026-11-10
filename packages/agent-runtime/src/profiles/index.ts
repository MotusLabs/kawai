// The ./profiles entry: pure helpers that build complete child environments
// from explicit inputs. Importing it reads nothing and spawns nothing.
export { anthropicOAuthProfile, claudeProxyProfile, CLAUDE_AGENT_SDK_VERSION } from './claude.js'
export type { AnthropicOAuthInput, ClaudeProfile, ClaudeProfileBase, ClaudeProxyInput } from './claude.js'
export { codexProfile } from './codex.js'
export type { CodexProfile, CodexProfileInput } from './codex.js'
export { CLAUDE_FAMILY_NAMES, CLAUDE_FAMILY_PREFIXES, CODEX_FAMILY_NAMES, TRANSPORT_PIN_ENV } from './env.js'
export type { EnvMap } from './env.js'
