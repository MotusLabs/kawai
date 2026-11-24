// The legacy Settings provider-env map (`app_settings.chat_provider_env`)
// and its upgrade migration into the credential store
// (provider-credential-store S6, table M). The map is read here only: no
// route writes it any more. Until the migration commits, the map composes
// as a source between the seed and the store (OD-M9/M10), so a failed or
// pending migration never loses a delivered value.
import type { SessionDatabase } from '../db'
import { logger } from '../logger'
import { validateChatProviderEnv, type ChatProviderEnv } from './chatProviderEnv'

/** The legacy Settings map's app_settings key. */
export const CHAT_PROVIDER_ENV_KEY = 'chat_provider_env'

/** The legacy map as stored, or null when absent; a corrupt row reads as
 * absent with a warning naming the key — never its contents. */
export function readLegacyProviderEnv(db: Pick<SessionDatabase, 'getAppSetting'>): ChatProviderEnv | null {
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
  logger.warn('chat_provider_env_invalid_stored', { key: CHAT_PROVIDER_ENV_KEY })
  return null
}
