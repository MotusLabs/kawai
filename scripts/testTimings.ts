// The timings record (design D4): per-file durations from a full run,
// published atomically to <git-common-dir>/kawai-checks/timings.json and fed
// back to `bun test --timings` so --parallel starts the slowest files first.
// The record is scheduling input only: a missing, malformed, or lost record
// changes ordering, never which tests run or what they assert. The snapshot
// bun writes lives in the run root; the runner copies it into the shared
// directory through a unique temporary file and renames it into place, so a
// concurrent suite always reads one whole record or finds none. Each
// published full run also keeps its own snapshot beside the record (D7), so
// the misplaced-file report judges a file on its shortest kept duration
// instead of one possibly load-inflated run.

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
// published record, or null when the snapshot is missing or malformed. The
// runner publishes only after a batch passed — bun writes the snapshot even
// when the batch exits non-zero — so a failed run never overwrites the
// record; the ordering is main()'s publish gate, not this function's.
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
    // Keys keep the spelling the invocation used ('./'-prefixed — the runner
    // passes toTestFilePath paths); the predicate checks the normalized one.
    if (fileExists(file.startsWith('./') ? file.slice(2) : file)) files[file] = ms
  }
  fs.mkdirSync(recordsDir, { recursive: true })
  // The record bun reads back with --timings: Bun's own shape. Last writer
  // wins — the per-run snapshots keep every sample (D7).
  writeWholeFile(recordsDir, TIMINGS_FILE_NAME, JSON.stringify({ version: 1, files }))
  // This run's own snapshot (D7): a file of its own, so a concurrent
  // publisher never loses a sample; then prune older runs by name.
  writeWholeFile(recordsDir, runSnapshotName(), JSON.stringify({ version: 1, files }))
  pruneRunSnapshots(recordsDir)
  return { version: 1, files }
}

// --- per-run snapshots (design D7) ---

// The newest five run snapshots are kept; older ones are pruned.
export const KEPT_RUN_SNAPSHOTS = 5

// Names sort by their UTC stamp, so pruning by name is pruning by age.
export function runSnapshotName(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `timings-${stamp}-${process.pid}.json`
}

export function isRunSnapshotName(name: string): boolean {
  return /^timings-\d{8}T\d{6}Z-.+\.json$/.test(name)
}

// One whole file via a unique temporary and a rename: a concurrent reader of
// this directory parses the file or finds it absent, never a torn one. The
// temporary carries the final name, so a crash between the write and the
// rename leaves a recognizable leftover.
function writeWholeFile(dir: string, name: string, text: string): void {
  const temporary = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temporary, text)
  fs.renameSync(temporary, path.join(dir, name))
}

// Keeps the newest KEPT_RUN_SNAPSHOTS snapshots by name and removes the rest.
// Best effort: a snapshot lost to a racing prune or a failed unlink costs one
// sample of the shortest-duration report, nothing more.
export function pruneRunSnapshots(recordsDir: string, keep: number = KEPT_RUN_SNAPSHOTS): void {
  let names: string[]
  try {
    names = fs.readdirSync(recordsDir)
  } catch {
    return
  }
  const snapshots = names.filter(isRunSnapshotName).sort()
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    try {
      fs.unlinkSync(path.join(recordsDir, name))
    } catch {
      // another publisher's prune got there first
    }
  }
}

// --- the misplaced-file report (design D7) ---

export const SLOW_TIER_THRESHOLD_MS = 5_000

// Files over the threshold that stay outside the slow tier on purpose: a
// file over 5 s alone at N=1 is durably slow and belongs in the tier
// (renamed to *.integration.test.ts) — an entry is only for one an open
// branch keeps from renaming, with its measured N=1 time and the branch as
// the reason. Every entry the earlier rule listed was contention-only (its
// N=1 time is under 5 s; only a shared-slot run inflated it) and was
// deleted with that rule; the shortest-duration judgment below keeps them
// visible to the report instead. Empty today: the two files over 5 s alone
// with no N=1 record entry (codexRolloutReplay, codexTeamPath) turned out
// unpinned by any open branch and are renamed into the tier.
export const SLOW_TIER_EXCEPTIONS: ReadonlyArray<{ file: string; reason: string }> = []

export interface MisplacedFile {
  file: string
  ms: number
}

// Files over the threshold outside the slow tier that no exception lists.
// Keys are normalized (a leading './' stripped) and matched by basename.
export function misplacedFiles(options: {
  files: Record<string, number>
  isSlowTier: (file: string) => boolean
  exceptions?: ReadonlyArray<{ file: string; reason: string }>
  thresholdMs?: number
}): MisplacedFile[] {
  const thresholdMs = options.thresholdMs ?? SLOW_TIER_THRESHOLD_MS
  const listed = new Set(
    (options.exceptions ?? SLOW_TIER_EXCEPTIONS).map((exception) => path.basename(exception.file))
  )
  const misplaced: MisplacedFile[] = []
  for (const [key, ms] of Object.entries(options.files)) {
    const file = key.startsWith('./') ? key.slice(2) : key
    if (ms <= thresholdMs) continue
    if (options.isSlowTier(file)) continue
    if (listed.has(path.basename(file))) continue
    misplaced.push({ file, ms })
  }
  misplaced.sort((a, b) => b.ms - a.ms)
  return misplaced
}

// Every timing sample the report may judge: the record itself first, then
// each whole kept run snapshot. A malformed file is skipped; a directory
// that cannot be read yields only what does parse.
export function loadTimingSamples(recordsDir: string): Array<Record<string, number>> {
  const read = (name: string): Record<string, number> | null => {
    try {
      const parsed = parseTimingsRecord(fs.readFileSync(path.join(recordsDir, name), 'utf8'))
      return parsed === null ? null : parsed.files
    } catch {
      return null
    }
  }
  const samples: Array<Record<string, number>> = []
  const record = read(TIMINGS_FILE_NAME)
  if (record !== null) samples.push(record)
  let names: string[]
  try {
    names = fs.readdirSync(recordsDir)
  } catch {
    return samples
  }
  for (const name of names.filter(isRunSnapshotName).sort()) {
    const sample = read(name)
    if (sample !== null) samples.push(sample)
  }
  return samples
}

// The report's figure per file (D7): the shortest duration the file showed
// in any kept sample — one load-inflated run must not name a file.
export function shortestAcross(samples: Array<Record<string, number>>): Record<string, number> {
  const shortest: Record<string, number> = {}
  for (const sample of samples) {
    for (const [file, ms] of Object.entries(sample)) {
      const seen = shortest[file]
      if (seen === undefined || ms < seen) shortest[file] = ms
    }
  }
  return shortest
}

// The misplaced-file report over the kept samples (D7): a file is misplaced
// when its shortest kept duration is over 5 s, it sits outside the slow
// tier, and no exception lists it. Null when there is no sample to judge —
// the caller prints nothing rather than a clean bill with no evidence.
export function misplacedFromRecords(
  recordsDir: string,
  isSlowTier: (file: string) => boolean
): MisplacedFile[] | null {
  const samples = loadTimingSamples(recordsDir)
  if (samples.length === 0) return null
  return misplacedFiles({ files: shortestAcross(samples), isSlowTier })
}

// The lines the runner prints after a published full run: the dispositions
// when files need one, a quiet confirmation when the tier is honest.
export function formatMisplacedReport(misplaced: MisplacedFile[]): string[] {
  if (misplaced.length === 0) {
    return ['[test-runner] timings: no file over 5 s sits outside the slow tier']
  }
  return [
    `[test-runner] timings: ${misplaced.length} file(s) over 5 s outside the slow tier — rename to *.integration.test.ts or list in SLOW_TIER_EXCEPTIONS:`,
    ...misplaced.map((entry) => `  ${(entry.ms / 1000).toFixed(1)} s  ${entry.file}`),
  ]
}
