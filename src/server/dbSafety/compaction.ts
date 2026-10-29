// Startup compaction (compact-observation-detail D7): a database still in
// `auto_vacuum = NONE` is switched to incremental mode with one full VACUUM,
// after the migrations and before the server serves. From then on pages freed
// by pruning return to the file through `PRAGMA incremental_vacuum`, so the
// file and its backups shrink. VACUUM cannot run inside a transaction, so this
// is not a migration. A failure is logged and swallowed: SQLite leaves the
// mode unchanged, the file stays usable, and the next start retries.
import type { Database } from 'bun:sqlite'
import { logger } from '../logger'

/** `PRAGMA auto_vacuum` reads 2 in incremental mode. */
const INCREMENTAL = 2

const pragma = (db: Database, name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0] as number

export function compactDatabase(db: Database): void {
  try {
    if (pragma(db, 'auto_vacuum') === INCREMENTAL) return
    const pagesBefore = pragma(db, 'page_count')
    const freeBefore = pragma(db, 'freelist_count')
    const started = performance.now()
    db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    db.exec('VACUUM')
    logger.info('db_compacted', {
      pagesBefore,
      freeBefore,
      pagesAfter: pragma(db, 'page_count'),
      pageSize: pragma(db, 'page_size'),
      durationMs: Math.round(performance.now() - started),
    })
  } catch (error) {
    logger.warn('db_compaction_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Returns every free page to the file; a no-op outside incremental mode. */
export function releaseFreePages(db: Database): void {
  db.exec('PRAGMA incremental_vacuum')
}
