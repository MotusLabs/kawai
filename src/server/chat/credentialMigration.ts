// The legacy Settings provider-env map (`app_settings.chat_provider_env`)
// and its startup migration into the credential store
// (provider-credential-store S6, the bound table M, decision-0c2937c6).
//
// The map is never a composition source (OD-M9/M10 = b): it is read here
// only, for the migration and for names-only diagnostics. One startup step:
//   - a stamp already present: no write; a residual map beside it is
//     ignored and listed by name (M1, M2, M13);
//   - no stamp and an absent or empty map: nothing to do, no write (M3);
//   - no stamp, a non-empty map, a usable store: the core's per-file owner
//     imports it (importLaunchEnv, file first), and only a durable outcome
//     commits the map deletion and the names-only stamp in one SQLite
//     transaction (M4-M7, M14, M15); an unconfirmed or refused write, an
//     unusable store, or a failed transaction leaves the map and no stamp,
//     so the next start retries (M8-M12).
// Values never leave the store write: the stamp, the status, and every log
// line carry names and fixed text only.
import type { CredentialMigrationState } from '../../shared/credentials'
import type { SessionDatabase } from '../db'
import { logger } from '../logger'
import { validateChatProviderEnv, type ChatProviderEnv } from './chatProviderEnv'
import { CredentialStoreError, type CredentialStore } from './credentialStore'

/** The legacy Settings map's app_settings key. */
export const CHAT_PROVIDER_ENV_KEY = 'chat_provider_env'
/** The migration's names-only stamp. */
export const MIGRATION_STAMP_KEY = 'credential_store_migration'

/** Fixed listing sentences; a reason never carries a value or an error. */
export const MIGRATION_TEXT = {
  ignored: 'Legacy Settings values found after the migration are not used.',
  notDurable: 'The legacy Settings migration is pending: the store write could not be confirmed on disk. It retries at the next start.',
  writeFailed: 'The legacy Settings migration is pending: the store could not be written. It retries at the next start.',
  storeUnusable: 'The legacy Settings migration is pending until the credential store can be read. It retries at the next start.',
  commitFailed: 'The legacy Settings migration is pending: the database step did not complete. It retries at the next start.',
  unreadableMap: 'The legacy Settings map cannot be read, so nothing was migrated. It stays in the database.',
  running: 'The legacy Settings migration is running.',
} as const

interface Stamp { version: 1; skipped: string[] }

type MigrationDb = Pick<SessionDatabase, 'getAppSetting' | 'setAppSetting' | 'deleteAppSetting'> & {
  db: { transaction: <T>(fn: () => T) => () => T }
}

export interface MigrationOptions {
  db: MigrationDb
  store: CredentialStore
  /** Test seam: runs inside the commit transaction before it ends (a throw
   * aborts it, as a crash before the commit would). */
  beforeCommit?: () => void
}

type MapRead = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'map'; env: ChatProviderEnv }

function readMap(db: Pick<SessionDatabase, 'getAppSetting'>): MapRead {
  const stored = db.getAppSetting(CHAT_PROVIDER_ENV_KEY)
  if (stored === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    parsed = undefined
  }
  const validated = validateChatProviderEnv(parsed)
  return validated.ok ? { kind: 'map', env: validated.env } : { kind: 'unreadable' }
}

function readStamp(db: Pick<SessionDatabase, 'getAppSetting'>): Stamp | null {
  const stored = db.getAppSetting(MIGRATION_STAMP_KEY)
  if (stored === null) return null
  try {
    const parsed = JSON.parse(stored) as Partial<Stamp>
    const skipped = Array.isArray(parsed.skipped) ? parsed.skipped.filter((n): n is string => typeof n === 'string') : []
    return { version: 1, skipped }
  } catch {
    // A present but unreadable stamp still means "migrated": never re-run.
    return { version: 1, skipped: [] }
  }
}

const pending = (text: string, skipped: string[] = []): CredentialMigrationState => ({ state: 'pending', text, skipped, ignored: [] })

/** The status from the database alone, before or without a run: a stamp
 * (complete, with residual names ignored), nothing to migrate, or a map
 * still waiting for this start's run. */
export function migrationStatus(db: Pick<SessionDatabase, 'getAppSetting'>): CredentialMigrationState {
  const stamp = readStamp(db)
  const map = readMap(db)
  if (stamp) {
    const ignored = map.kind === 'map' ? Object.keys(map.env).sort() : []
    return { state: 'complete', text: ignored.length > 0 ? MIGRATION_TEXT.ignored : null, skipped: [...stamp.skipped].sort(), ignored }
  }
  if (map.kind === 'absent' || (map.kind === 'map' && Object.keys(map.env).length === 0)) {
    return { state: 'none', text: null, skipped: [], ignored: [] }
  }
  return pending(map.kind === 'unreadable' ? MIGRATION_TEXT.unreadableMap : MIGRATION_TEXT.running)
}

/** Run the startup migration once; resolves with the listing's state and
 * never throws (a failure is a pending state that the next start retries). */
export async function migrateLegacyProviderEnv(options: MigrationOptions): Promise<CredentialMigrationState> {
  const { db, store } = options
  if (readStamp(db)) return migrationStatus(db)
  const map = readMap(db)
  if (map.kind === 'absent') return migrationStatus(db)
  if (map.kind === 'unreadable') {
    logger.warn('credential_migration_map_unreadable', { key: CHAT_PROVIDER_ENV_KEY })
    return pending(MIGRATION_TEXT.unreadableMap)
  }
  if (Object.keys(map.env).length === 0) return migrationStatus(db)
  const status = store.list().status
  if (!status.ok && status.reason !== 'missing') {
    logger.warn('credential_migration_pending', { reason: status.reason })
    return pending(MIGRATION_TEXT.storeUnusable)
  }
  let outcome: Awaited<ReturnType<CredentialStore['importLaunchEnv']>>
  try {
    outcome = await store.importLaunchEnv(map.env)
  } catch (error) {
    const code = error instanceof CredentialStoreError ? error.code : 'unknown'
    logger.warn('credential_migration_pending', { reason: code })
    return pending(code === 'write-failed' ? MIGRATION_TEXT.writeFailed : MIGRATION_TEXT.storeUnusable)
  }
  if (!outcome.durable) {
    logger.warn('credential_migration_pending', { reason: 'not-durable', skipped: outcome.skipped })
    return pending(MIGRATION_TEXT.notDurable, outcome.skipped)
  }
  // Every validated name must have a durable disposition before the map
  // goes: stored by the core, or a names-only skip (I2, PM1). A name the
  // import lost keeps the map for the next start instead of vanishing.
  const resolved = store.list()
  const stored = new Set(resolved.status.ok ? resolved.entries.map(entry => entry.name) : [])
  const skipped = new Set(outcome.skipped)
  if (Object.keys(map.env).some(name => !stored.has(name) && !skipped.has(name))) {
    logger.warn('credential_migration_pending', { reason: 'name-not-stored', skipped: outcome.skipped })
    return pending(MIGRATION_TEXT.writeFailed, outcome.skipped)
  }
  const stamp: Stamp = { version: 1, skipped: outcome.skipped }
  try {
    db.db.transaction(() => {
      db.deleteAppSetting(CHAT_PROVIDER_ENV_KEY)
      db.setAppSetting(MIGRATION_STAMP_KEY, JSON.stringify(stamp))
      options.beforeCommit?.()
    })()
  } catch {
    logger.warn('credential_migration_pending', { reason: 'commit-failed' })
    return pending(MIGRATION_TEXT.commitFailed, outcome.skipped)
  }
  logger.info('credential_migration_complete', { imported: Object.keys(map.env).length, skipped: outcome.skipped })
  return migrationStatus(db)
}
