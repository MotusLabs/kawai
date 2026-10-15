// Online database backups (execution-safety-recovery D15). A snapshot runs on
// the server's own connection, never inside a transaction: `serialize()`
// copies the database under SQLite's shared lock for a few milliseconds (bun:
// sqlite is synchronous, so none of the server's own statements can run
// meanwhile, and an outside writer waits within its busy timeout), then the
// bytes go to `<name>.partial`, are fsynced, and are renamed into place. The
// copy is integrity-checked over a separate read-only connection; a copy that
// fails is renamed `.corrupt`, logged, recorded for the status, and kept out
// of rotation. Nothing is attached to the live connection and the live file
// is never copied. Backups stay in the directory given here and are never
// sent anywhere.
//
// Schedule: `startup` and `pre-migration-<n>` are taken synchronously by
// `migrateSchema` (nothing else runs yet, and a migration must wait for its
// checked backup); `interval` runs hourly and asynchronously, skipped when the
// connection's `total_changes()` still equals the value stored by the last
// snapshot of this process (the counter restarts with each process, and the
// startup snapshot stores the first value).
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { logger } from '../logger'
import {
  backupFileName,
  formatStamp,
  newestBackup,
  parseBackupFile,
  rotationVictims,
  type BackupFile,
  type BackupReason,
} from './backupFiles'

export const BACKUP_INTERVAL_MS = 60 * 60 * 1000

export type BackupOutcome =
  | { ok: true; reason: BackupReason; path: string; bytes: number; changes: number }
  | { ok: false; reason: BackupReason; path: string | null; error: string }

/** The read-only status the audit footer shows (D9): server-wide, newest per reason. */
export interface BackupStatus {
  dir: string
  newest: Array<{ reason: BackupReason; name: string; bytes: number; checked: 'ok' }>
  failures: Array<{ reason: BackupReason; path: string | null; error: string; at: string }>
}

export interface DatabaseBackupsOptions {
  db: Database
  /** The live database file; its stem names the backups. */
  dbPath: string
  /** Defaults to `backups/` beside the database. */
  dir?: string
  now?: () => number
  /** The copy step; tests substitute a torn copy. Defaults to `db.serialize()`. */
  serialize?: () => Uint8Array
}

const MAX_FAILURES = 20
const SERIALIZE_ATTEMPTS = 3

export class DatabaseBackups {
  readonly dir: string
  private readonly stem: string
  private readonly now: () => number
  private lastStamp = ''
  /** `total_changes()` stored by this process's last good snapshot. */
  private lastChanges: number | null = null
  private inFlight: Promise<BackupOutcome> | null = null
  /** The `.partial` an asynchronous snapshot is writing; rotation never deletes it. */
  private writing: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly failures: BackupStatus['failures'] = []

  constructor(private readonly options: DatabaseBackupsOptions) {
    this.dir = options.dir ?? path.join(path.dirname(options.dbPath), 'backups')
    this.stem = path.basename(options.dbPath).replace(/\.[^.]*$/, '')
    this.now = options.now ?? Date.now
  }

  /** Take one backup, writing synchronously; returns once it is renamed and checked. */
  snapshotSync(reason: BackupReason): BackupOutcome {
    const taken = this.take(reason)
    if ('error' in taken) return this.fail(reason, null, taken.error)
    try {
      const fd = fs.openSync(taken.partial, 'w', 0o600)
      try {
        fs.writeSync(fd, taken.bytes)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(taken.partial, taken.final)
    } catch (error) {
      return this.fail(reason, taken.partial, errorText(error))
    }
    return this.finish(reason, taken)
  }

  /** Take one backup, writing the bytes asynchronously (the interval path). */
  snapshot(reason: BackupReason): Promise<BackupOutcome> {
    const taken = this.take(reason)
    if ('error' in taken) return Promise.resolve(this.fail(reason, null, taken.error))
    this.writing = path.basename(taken.partial)
    const run = (async (): Promise<BackupOutcome> => {
      try {
        const handle = await fs.promises.open(taken.partial, 'w', 0o600)
        try {
          await handle.writeFile(taken.bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fs.promises.rename(taken.partial, taken.final)
      } catch (error) {
        return this.fail(reason, taken.partial, errorText(error))
      } finally {
        this.writing = null
      }
      return this.finish(reason, taken)
    })()
    this.inFlight = run
    void run.finally(() => { if (this.inFlight === run) this.inFlight = null })
    return run
  }

  /** One interval tick: null when skipped (unchanged, or a snapshot is still running). */
  async tick(): Promise<BackupOutcome | null> {
    if (this.inFlight) return null
    if (this.lastChanges !== null && this.totalChanges() === this.lastChanges) return null
    return this.snapshot('interval')
  }

  /** Start the hourly interval backups. */
  start(intervalMs = BACKUP_INTERVAL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch(error => logger.error('db_backup_tick_failed', { error: errorText(error) }))
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Every backup file of this database, parsed; unrelated files are ignored. */
  files(): BackupFile[] {
    return listBackupFiles(this.dir, this.stem)
  }

  /** Delete leftovers and rotated-out backups (startup and after each snapshot). */
  rotate(): void {
    for (const name of rotationVictims(this.files(), this.writing)) {
      try {
        fs.unlinkSync(path.join(this.dir, name))
      } catch (error) {
        logger.warn('db_backup_rotate_failed', { name, error: errorText(error) })
      }
    }
  }

  status(): BackupStatus {
    const files = this.files()
    const reasons = [...new Set(files.filter(file => file.kind === 'good').map(file => file.reason))].sort()
    const newest = reasons.flatMap(reason => {
      const file = newestBackup(files, reason)
      if (!file) return []
      let bytes = 0
      try { bytes = fs.statSync(path.join(this.dir, file.name)).size } catch { return [] }
      return [{ reason, name: file.name, bytes, checked: 'ok' as const }]
    })
    return { dir: this.dir, newest, failures: [...this.failures] }
  }

  /**
   * `serialize()` waits on the busy handler, but under a concurrent outside
   * writer it rarely returns no copy (bun reports "Out of memory"); measured
   * about once in 800 copies. Retry before reporting the snapshot failed.
   */
  private copy(): Uint8Array {
    const serialize = this.options.serialize ?? (() => this.options.db.serialize())
    for (let attempt = 1; ; attempt++) {
      try {
        return serialize()
      } catch (error) {
        if (attempt >= SERIALIZE_ATTEMPTS) throw error
      }
    }
  }

  private totalChanges(): number {
    return Number((this.options.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
  }

  /** Serialize under the shared lock; outside any transaction only (D15 step 1). */
  private take(reason: BackupReason):
    | { partial: string; final: string; bytes: Uint8Array; changes: number }
    | { error: string } {
    const { db } = this.options
    if (db.inTransaction) return { error: 'a transaction is open on the connection' }
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const changes = this.totalChanges()
      const bytes = this.copy()
      const final = path.join(this.dir, backupFileName(this.stem, this.nextStamp(), reason))
      const partial = `${final}.partial`
      return { partial, final, bytes, changes }
    } catch (error) {
      return { error: errorText(error) }
    }
  }

  private finish(reason: BackupReason, taken: { final: string; bytes: Uint8Array; changes: number }): BackupOutcome {
    const check = integrityCheck(taken.final)
    if (check !== null) {
      let corrupt: string | null = `${taken.final}.corrupt`
      try { fs.renameSync(taken.final, corrupt) } catch { corrupt = taken.final }
      const outcome = this.fail(reason, corrupt, `integrity check failed: ${check}`)
      this.rotate()
      return outcome
    }
    this.lastChanges = taken.changes
    this.rotate()
    logger.info('db_backup_written', { reason, path: taken.final, bytes: taken.bytes.byteLength })
    return { ok: true, reason, path: taken.final, bytes: taken.bytes.byteLength, changes: taken.changes }
  }

  private fail(reason: BackupReason, file: string | null, error: string): BackupOutcome {
    logger.error('db_backup_failed', { reason, path: file, error })
    this.failures.push({ reason, path: file, error, at: new Date(this.now()).toISOString() })
    if (this.failures.length > MAX_FAILURES) this.failures.shift()
    return { ok: false, reason, path: file, error }
  }

  /** Strictly increasing stamps, so two snapshots in one millisecond never collide. */
  private nextStamp(): string {
    let ms = this.now()
    let stamp = formatStamp(ms)
    while (stamp <= this.lastStamp) stamp = formatStamp(++ms)
    this.lastStamp = stamp
    return stamp
  }
}

/** Every backup file for `stem` in `dir`; a missing directory has none. */
export function listBackupFiles(dir: string, stem: string): BackupFile[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.flatMap(name => parseBackupFile(stem, name) ?? [])
}

/** `PRAGMA integrity_check` over a separate read-only connection: null when ok, else the first problem. */
export function integrityCheck(file: string): string | null {
  let copy: Database | null = null
  try {
    copy = new Database(file, { readonly: true })
    const rows = copy.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
    const problems = rows.map(row => row.integrity_check).filter(value => value !== 'ok')
    return rows.length === 0 ? 'no result' : problems.length > 0 ? problems.slice(0, 3).join('; ') : null
  } catch (error) {
    return errorText(error)
  } finally {
    copy?.close()
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
