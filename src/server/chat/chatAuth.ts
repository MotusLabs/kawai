// Server-side Claude authentication gate for chat sessions and the actionable
// refusal shown when it fails. Evaluated against the same effective
// environment the SDK process receives.
import fs from 'node:fs'
import path from 'node:path'
import { effectiveChatEnv, type ChatProviderEnv } from './chatProviderEnv'

/** The Claude CLI's credentials file inside the config dir (Linux/Windows). */
const CLI_CREDENTIALS_FILE = '.credentials.json'

function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  if (override) return override
  const home = env.HOME || env.USERPROFILE || ''
  return path.join(home, '.claude')
}

/**
 * Server-side auth gate (design D9): chat sessions can only run when the SDK
 * can authenticate — via ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, an OAuth
 * token, or the CLI's stored login under CLAUDE_CONFIG_DIR (~/.claude by
 * default). Evaluated against the same effective environment the SDK process
 * receives (server env plus provider overrides), so the gate and the spawn
 * never disagree. Credentials never leave the server.
 */
export function hasClaudeAuth(providerEnv: ChatProviderEnv = {}): boolean {
  const env = effectiveChatEnv(providerEnv)
  if (env.ANTHROPIC_API_KEY?.trim()) return true
  if (env.ANTHROPIC_AUTH_TOKEN?.trim()) return true
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true
  try {
    return fs.existsSync(path.join(claudeConfigDir(env), CLI_CREDENTIALS_FILE))
  } catch {
    return false
  }
}

/** Actionable refusal shown when hasClaudeAuth() is false. */
export function chatAuthErrorMessage(): string {
  return (
    'Chat sessions need Claude authentication on the server. ' +
    'Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN in the server environment ' +
    '(or the chat provider environment in Settings), or log in with the ' +
    `Claude CLI (\`claude login\`) so credentials exist at ${path.join(
      claudeConfigDir(),
      CLI_CREDENTIALS_FILE
    )} — or point CLAUDE_CONFIG_DIR at an authenticated config directory.`
  )
}
