// The timings record (design D4): per-file durations from a full run,
// published atomically to <git-common-dir>/kawai-checks/timings.json and fed
// back to `bun test --timings` so --parallel starts the slowest files first.
// The record is scheduling input only: a missing, malformed, or lost record
// changes ordering, never which tests run or what they assert. The snapshot
// bun writes lives in the run root; the runner copies it into the shared
// directory through a unique temporary file and renames it into place, so a
// concurrent suite always reads one whole record or finds none.

import fs from 'node:fs'
import path from 'node:path'

export const TIMINGS_FILE_NAME = 'timings.json'

export interface TimingsRecord {
  version: number
  files: Record<string, number>
}

// Bun's format: { "version": 1, "files": { "<path>": <milliseconds> } }
// (probed on 1.4.3; bun itself refuses any other shape). Null for anything
// unreadable, malformed, or wrongly shaped — the caller runs unordered.
export function parseTimingsRecord(text: string): TimingsRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return null
  if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)) {
    return null
  }
  const files: Record<string, number> = {}
  for (const [file, ms] of Object.entries(record.files)) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
    files[file] = ms
  }
  return { version: 1, files }
}

// The previous record's text, or null when there is none usable. A missing
// or malformed record never fails the run (D4).
export function readTimingsSeed(recordsDir: string): string | null {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(recordsDir, TIMINGS_FILE_NAME), 'utf8')
  } catch {
    return null
  }
  return parseTimingsRecord(raw) === null ? null : raw
}

// The per-run snapshot bun reads and, with --update-timings, rewrites at the
// end of the main batch. The seed — when there is one — is copied in, so bun
// never touches the shared record directly and never sees a malformed file.
export function seedTimingsSnapshot(runRoot: string, seedText: string | null): string {
  const snapshot = path.join(runRoot, TIMINGS_FILE_NAME)
  if (seedText !== null) fs.writeFileSync(snapshot, seedText)
  return snapshot
}

// Publish the finished snapshot: parse it, drop keys whose file no longer
// exists (a rename or deletion must not flag its ghost forever), then write
// it to the shared directory through a unique temporary file and rename it
// into place, so a concurrent suite reads one whole record or finds none —
// never a partial one. Throws on a filesystem failure; the runner logs that
// and keeps running (a lost update affects scheduling only). Returns the
// published record, or null when the snapshot is missing or malformed — a
// failed batch leaves no usable snapshot, and the previous record stands.
export function publishTimingsSnapshot(
  recordsDir: string,
  snapshotPath: string,
  fileExists: (file: string) => boolean = (file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  }
): TimingsRecord | null {
  let raw: string
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8')
  } catch {
    return null
  }
  const parsed = parseTimingsRecord(raw)
  if (parsed === null) return null
  const files: Record<string, number> = {}
  for (const [file, ms] of Object.entries(parsed.files)) {
    // The predicate sees the normalized key: bun records paths as they were
    // spelled on the command line, with a leading './'.
    if (fileExists(file.startsWith('./') ? file.slice(2) : file)) files[file] = ms
  }
  fs.mkdirSync(recordsDir, { recursive: true })
  const final = path.join(recordsDir, TIMINGS_FILE_NAME)
  // Same shape checkRecords uses, so a crash between the write and the
  // rename leaves a recognizable temporary behind.
  const temporary = path.join(recordsDir, `.${TIMINGS_FILE_NAME}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, files }))
  fs.renameSync(temporary, final)
  return { version: 1, files }
}
