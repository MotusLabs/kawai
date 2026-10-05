// Settings override for the chat provider environment (see
// chat/chatProviderEnv.ts). Holds the live value that ChatSessionManager reads
// at each SDK spawn: the persisted Settings override when present, otherwise
// AGENTBOARD_CHAT_ENV. GET redacts credential-looking values; PUT stores an
// override (an empty map is a deliberate "no overrides"); DELETE drops the
// override and falls back to the environment default.
import { Hono } from 'hono'
import type {
  ChatProviderEnvResponse,
  ChatProviderEnvSource,
} from '../../shared/chatProviderSettings'
import {
  validateChatProviderEnv,
  type ChatProviderEnv,
} from '../chat/chatProviderEnv'
import type { SessionDatabase } from '../db'
import { logger } from '../logger'

export const CHAT_PROVIDER_ENV_KEY = 'chat_provider_env'

const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name)
}

type SettingsDb = Pick<SessionDatabase, 'getAppSetting' | 'setAppSetting' | 'deleteAppSetting'>

export interface ChatProviderEnvStore {
  /** The overrides the next chat SDK spawn should use. */
  current: () => ChatProviderEnv
  routes: Hono
}

export function createChatProviderEnvStore(
  db: SettingsDb,
  defaultEnv: ChatProviderEnv
): ChatProviderEnvStore {
  let override = loadOverride(db)

  const current = (): ChatProviderEnv => override ?? defaultEnv
  const source = (): ChatProviderEnvSource =>
    override ? 'settings' : Object.keys(defaultEnv).length > 0 ? 'environment' : 'none'

  const respond = (): ChatProviderEnvResponse => {
    const env: Record<string, string> = {}
    const redacted: string[] = []
    for (const [name, value] of Object.entries(current())) {
      if (isSecretEnvName(name) && value !== '') {
        env[name] = ''
        redacted.push(name)
      } else {
        env[name] = value
      }
    }
    return { env, redacted, source: source() }
  }

  const routes = new Hono()
  routes.get('/', (c) => c.json(respond()))

  routes.put('/', async (c) => {
    let body: { env?: unknown; keep?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }
    const validated = validateChatProviderEnv(body.env)
    if (!validated.ok) return c.json({ error: validated.error }, 400)
    const keep = body.keep ?? []
    if (!Array.isArray(keep) || !keep.every((name) => typeof name === 'string')) {
      return c.json({ error: 'keep must be a list of variable names' }, 400)
    }
    const next = { ...validated.env }
    const stored = current()
    for (const name of keep) {
      // Only a value the client never saw may be kept; anything else would let
      // a stale form silently resurrect a variable the user removed.
      if (!(name in next) || !isSecretEnvName(name) || stored[name] === undefined) {
        return c.json({ error: `Cannot keep ${name}: re-enter its value.` }, 400)
      }
      next[name] = stored[name]
    }
    try {
      db.setAppSetting(CHAT_PROVIDER_ENV_KEY, JSON.stringify(next))
    } catch (error) {
      // Never let the runtime value diverge from what a restart would restore.
      logger.warn('chat_provider_env_persist_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Unable to persist chat provider environment' }, 500)
    }
    override = next
    return c.json(respond())
  })

  routes.delete('/', (c) => {
    try {
      db.deleteAppSetting(CHAT_PROVIDER_ENV_KEY)
    } catch (error) {
      logger.warn('chat_provider_env_persist_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Unable to reset chat provider environment' }, 500)
    }
    override = null
    return c.json(respond())
  })

  return { current, routes }
}

/** A corrupt stored row is ignored (with a warning) rather than fatal. */
function loadOverride(db: SettingsDb): ChatProviderEnv | null {
  const stored = db.getAppSetting(CHAT_PROVIDER_ENV_KEY)
  if (stored === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    parsed = undefined
  }
  const validated = validateChatProviderEnv(parsed)
  if (validated.ok) return validated.env
  logger.warn('chat_provider_env_invalid_stored', {
    message: validated.error,
  })
  return null
}
