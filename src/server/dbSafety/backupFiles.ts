// Backup file names and retention (execution-safety-recovery D15), pure.
// A snapshot of `<stem>.db` is `<stem>-<UTC stamp>-<reason>.db` in the
// backups directory beside the database (`agentboard-…` in production); it is
// written as `<name>.partial` and renamed into place, and a copy that fails
// its integrity check becomes `<name>.corrupt`. The stamp is fixed-width and
// sorts chronologically, so every "newest" below is a name comparison.
// Retention is per reason: 24 `interval`, 7 `startup`, and every
// `pre-migration-<n>` of the newest 3 migrations; leftovers keep their own
// newest 3 `.partial` (never the one being written) and 3 `.corrupt`.

export type BackupReason = 'startup' | 'interval' | `pre-migration-${number}`
export type BackupFileKind = 'good' | 'partial' | 'corrupt'

export interface BackupFile {
  name: string
  stamp: string
  reason: BackupReason
  kind: BackupFileKind
}

export const RETENTION = {
  interval: 24,
  startup: 7,
  /** Distinct migrations whose pre-migration backups are all kept. */
  preMigrations: 3,
  partial: 3,
  corrupt: 3,
} as const

const STAMP = /^\d{8}T\d{9}Z$/

/** `20261015T120000123Z`: UTC to the millisecond, fixed width. */
export function formatStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '')
}

export function backupFileName(stem: string, stamp: string, reason: BackupReason): string {
  return `${stem}-${stamp}-${reason}.db`
}

export function isBackupReason(value: string): value is BackupReason {
  return value === 'startup' || value === 'interval' || /^pre-migration-[1-9]\d*$/.test(value)
}

/** Parse a name this module wrote for `stem`; anything else (the owner's own files) is null and never touched. */
export function parseBackupFile(stem: string, name: string): BackupFile | null {
  let base = name
  let kind: BackupFileKind = 'good'
  if (base.endsWith('.partial')) { kind = 'partial'; base = base.slice(0, -'.partial'.length) }
  else if (base.endsWith('.corrupt')) { kind = 'corrupt'; base = base.slice(0, -'.corrupt'.length) }
  const prefix = `${stem}-`
  if (!base.startsWith(prefix) || !base.endsWith('.db')) return null
  const rest = base.slice(prefix.length, -'.db'.length)
  const dash = rest.indexOf('-')
  if (dash < 0) return null
  const stamp = rest.slice(0, dash)
  const reason = rest.slice(dash + 1)
  if (!STAMP.test(stamp) || !isBackupReason(reason)) return null
  return { name, stamp, reason, kind }
}

/** The migration number of a pre-migration reason, else null. */
export function migrationOf(reason: BackupReason): number | null {
  return reason.startsWith('pre-migration-') ? Number(reason.slice('pre-migration-'.length)) : null
}

const newestFirst = (a: BackupFile, b: BackupFile) =>
  a.stamp === b.stamp ? (a.name < b.name ? 1 : -1) : a.stamp < b.stamp ? 1 : -1

/**
 * The names to delete so the set matches the retention. `writing` names the
 * `.partial` in progress: it is never deleted and never counted.
 */
export function rotationVictims(files: readonly BackupFile[], writing: string | null = null): string[] {
  const victims: string[] = []
  const keepNewest = (group: BackupFile[], keep: number) => {
    victims.push(...group.sort(newestFirst).slice(keep).map(file => file.name))
  }
  const of = (kind: BackupFileKind, reason?: 'startup' | 'interval') =>
    files.filter(file => file.kind === kind && (reason === undefined || file.reason === reason) && file.name !== writing)
  keepNewest(of('good', 'interval'), RETENTION.interval)
  keepNewest(of('good', 'startup'), RETENTION.startup)
  keepNewest(of('partial'), RETENTION.partial)
  keepNewest(of('corrupt'), RETENTION.corrupt)
  const preMigration = files.filter(file => file.kind === 'good' && migrationOf(file.reason) !== null)
  const kept = [...new Set(preMigration.map(file => migrationOf(file.reason)!))]
    .sort((a, b) => b - a)
    .slice(0, RETENTION.preMigrations)
  for (const file of preMigration) if (!kept.includes(migrationOf(file.reason)!)) victims.push(file.name)
  return victims
}

/** The newest good backup with this reason, or null. */
export function newestBackup(files: readonly BackupFile[], reason: BackupReason): BackupFile | null {
  return files.filter(file => file.kind === 'good' && file.reason === reason).sort(newestFirst)[0] ?? null
}
