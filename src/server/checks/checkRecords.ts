// checkRecords.ts - Recorded check passes (check-dedup D2).
//
// A record proves "this content key passed once": one JSON file per key under
// <git-common-dir>/kawai-checks/. The common directory is shared by every
// linked worktree, so a pass recorded in one worktree is reused by the lead's
// check of the same content in another. Writes are atomic (temporary file,
// rename); reads fail closed — anything missing, corrupt, or shaped wrong is
// no record, and the next check runs in full.

import fs from 'node:fs'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { removeTestList, testListName, type RecordTestList } from './testLists'

export interface CheckStep {
  name: string
  ms: number
}

export interface CheckRecord {
  key: string
  treeId: string
  bun: string
  platform: string
  arch: string
  at: string
  worktree: string
  steps: CheckStep[]
  /** The record's test list pointer (independent-verification D7), absent
   * on records written before test lists existed and on a pass whose
   * reports could not be merged — both read as no list upstream. */
  tests?: RecordTestList
}

export const RECORDS_DIR_NAME = 'kawai-checks'
export const RECORD_TTL_MS = 14 * 24 * 60 * 60 * 1000
export const MAX_RECORDS = 500
/** D7's list-retention rule, settled by task 4.2's measurement (8,030
 * entries, 1.4 MB raw, 218.5 KiB gzipped per list — over the 200 KB
 * threshold): only the newest MAX_KEPT_LISTS records keep their lists, in
 * the order master's count cap uses (mtime, newest first). An older record
 * keeps its pass and loses only its list — its citations read run unknown
 * (K2 case 3). The record itself is never touched. */
export const MAX_KEPT_LISTS = 100
/** A temp file older than this is removed even while its writer's pid still
 * answers: pids are reused, so age is the final judge. */
export const TMP_TTL_MS = 60 * 60 * 1000

const KEY_PATTERN = /^[0-9a-f]{64}$/
/** The temporaries writeRecord leaves behind on a crash between the write
 * and the rename: `.<key>.<pid>.tmp` (writeTestList builds the same shape). */
const TMP_NAME = /^\.([0-9a-f]{64})\.(\d+)\.tmp$/
/** The test lists beside the records: `<key>.tests.json.gz` (D7). */
const LIST_NAME = /^([0-9a-f]{64})\.tests\.json\.gz$/
/** An orphan list younger than this survives any prune: its writer may sit
 * between renaming the list and renaming its record — the records directory
 * is shared by every linked worktree, so another worktree's prune can run
 * in exactly that window — and removing the list there would leave the
 * record pointing at nothing. Age, not absence, decides; a writer stalled
 * longer than the grace loses only its list, and the record reads as
 * list-less (never fabricated data). */
export const LIST_ORPHAN_GRACE_MS = 60_000

/** The shared records directory for the repository behind `cwd`. Throws when
 * git cannot resolve a common directory (outside a repository). */
export function recordsDir(cwd: string): string {
  const result = runGit(['rev-parse', '--git-common-dir'], { cwd })
  if (!result.ok) {
    throw new Error(`check: cannot resolve the git directory: ${result.stderr.trim()}`)
  }
  const answer = result.stdout.trim()
  const dir = path.isAbsolute(answer) ? answer : path.join(cwd, answer)
  return path.join(dir, RECORDS_DIR_NAME)
}

/** The record for `key`, or null when there is none, it is unreadable, it is
 * older than the TTL (judged by the record's own `at`, which travels with the
 * file across worktrees, unlike mtime), or it does not describe a pass for
 * this key. A mangled file never reads as a recorded pass. */
export function readRecord(dir: string, key: string, now = Date.now()): CheckRecord | null {
  if (!KEY_PATTERN.test(key)) return null
  let raw: string
  try {
    raw = fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record.key !== key) return null
  if (typeof record.at !== 'string' || record.at === '') return null
  const atMs = Date.parse(record.at)
  if (!Number.isFinite(atMs) || now - atMs >= RECORD_TTL_MS) return null
  if (typeof record.worktree !== 'string' || record.worktree === '') return null
  if (!Array.isArray(record.steps)) return null
  if (!record.steps.every((step) => isStep(step))) return null
  // The test-list pointer is parsed but never invalidates the record: a
  // malformed `tests` on an otherwise good pass drops the pointer (the
  // record reads as list-less, run unknown upstream) instead of discarding
  // the certificate. Absent on older records.
  let tests: RecordTestList | undefined
  if (record.tests !== undefined) {
    if (
      typeof record.tests === 'object' &&
      record.tests !== null &&
      (record.tests as RecordTestList).file === testListName(key) &&
      typeof (record.tests as RecordTestList).count === 'number' &&
      Number.isInteger((record.tests as RecordTestList).count) &&
      (record.tests as RecordTestList).count >= 0
    ) {
      tests = { file: (record.tests as RecordTestList).file, count: (record.tests as RecordTestList).count }
    }
  }
  return {
    key,
    treeId: typeof record.treeId === 'string' ? record.treeId : '',
    bun: typeof record.bun === 'string' ? record.bun : '',
    platform: typeof record.platform === 'string' ? record.platform : '',
    arch: typeof record.arch === 'string' ? record.arch : '',
    at: record.at,
    worktree: record.worktree,
    steps: record.steps.map((step) => ({ name: step.name, ms: step.ms })),
    ...(tests !== undefined ? { tests } : {}),
  }
}

function isStep(step: unknown): step is CheckStep {
  return (
    typeof step === 'object' &&
    step !== null &&
    typeof (step as CheckStep).name === 'string' &&
    typeof (step as CheckStep).ms === 'number' &&
    Number.isFinite((step as CheckStep).ms)
  )
}

/** Every unexpired, well-formed record for `treeId`, newest first — by the
 * record's own `at`, which travels with the file across worktrees, unlike
 * mtime (ties break by key, so the order is total). A tree can hold records
 * under several keys: the key hashes the Bun version, platform, and
 * architecture, and the server cannot rebuild one — a compiled binary embeds
 * its own Bun, which need not be the worktree's (independent-verification
 * D3) — so the directory is scanned instead of computing a key. Fail-closed
 * like readRecord, whose age limit and parsing it applies: a missing or
 * unreadable directory holds no records, and a file that is not a
 * well-formed record is skipped, never thrown. */
export function recordsForTree(dir: string, treeId: string, now = Date.now()): CheckRecord[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const records: CheckRecord[] = []
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue
    const record = readRecord(dir, name.slice(0, -'.json'.length), now)
    if (record === null || record.treeId !== treeId) continue
    records.push(record)
  }
  return records.sort((a, b) => {
    const byAt = Date.parse(b.at) - Date.parse(a.at)
    if (byAt !== 0) return byAt
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

/** Remove the record for `key`, whatever wrote it, and its test list with
 * it (D7 pruning; C1 advisor point 1): the record-less list would be an
 * orphan the next prune removes anyway, but the paths that drop a record —
 * a failed or forced run — must not leave the list pointing at a pass that
 * is gone. Best-effort: a file that is already absent, or a store that
 * cannot be written, is fine — removal must never turn a failing check
 * into a crash. */
export function removeRecord(dir: string, key: string): void {
  if (!KEY_PATTERN.test(key)) return
  try {
    fs.unlinkSync(path.join(dir, `${key}.json`))
  } catch {
    // Already absent, or unwritable: nothing left to remove.
  }
  removeTestList(dir, key)
}

/** Write a record atomically and prune the directory. The rename makes a
 * reader see either the previous or the new file, never a partial one. */
export function writeRecord(dir: string, record: CheckRecord): void {
  if (!KEY_PATTERN.test(record.key)) {
    throw new Error(`check: refusing to write a record under a non-key name`)
  }
  fs.mkdirSync(dir, { recursive: true })
  const final = path.join(dir, `${record.key}.json`)
  const temporary = path.join(dir, `.${record.key}.${process.pid}.tmp`)
  fs.writeFileSync(temporary, JSON.stringify(record))
  fs.renameSync(temporary, final)
  pruneRecords(dir)
}

/** True when `pid` names a live process. Signal 0 probes existence without
 * signalling; EPERM means the process exists under another user. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Remove the temp files of crashed writers. A live writer may still rename
 * its temporary, so one is removed only when its pid is gone or the file is
 * older than TMP_TTL_MS — the records directory is shared by every linked
 * worktree, and an eager removal would break a concurrent writer's rename.
 * Files of any other shape are not ours and stay. */
function pruneTempFiles(dir: string, names: string[], now: number): void {
  for (const name of names) {
    const match = TMP_NAME.exec(name)
    if (!match) continue
    const absolute = path.join(dir, name)
    let mtime: number
    try {
      mtime = fs.statSync(absolute).mtimeMs
    } catch {
      continue // Vanished between readdir and stat.
    }
    if (pidAlive(Number(match[2])) && now - mtime < TMP_TTL_MS) continue
    try {
      fs.unlinkSync(absolute)
    } catch {
      // Already gone; pruning is best-effort.
    }
  }
}

/** Keep records newer than the TTL, and at most MAX_RECORDS of those, the
 * newest by mtime, and remove the temp files of crashed writers. A record
 * this prune removes takes its test list with it (D7: pruned together), a
 * list is removed when it has no record and is older than the orphan grace
 * (the interrupted-writing scenario), and — D7's thinning, since 4.2
 * measured a list over the 200 KB threshold — the kept records beyond the
 * newest MAX_KEPT_LISTS lose only their lists, their records and passes
 * staying (K2's three removal cases; a record the age-and-count rule keeps
 * is never removed). */
export function pruneRecords(dir: string, now = Date.now()): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  pruneTempFiles(dir, names, now)
  const recordNames = new Set<string>()
  const records: { name: string; mtime: number }[] = []
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue
    recordNames.add(name)
    const absolute = path.join(dir, name)
    try {
      records.push({ name, mtime: fs.statSync(absolute).mtimeMs })
    } catch {
      // Vanished between readdir and stat: not a record to prune.
    }
  }
  const fresh = records.filter((record) => now - record.mtime < RECORD_TTL_MS)
  fresh.sort((a, b) => b.mtime - a.mtime)
  const prunedRecords = [
    ...records.filter((record) => now - record.mtime >= RECORD_TTL_MS),
    ...fresh.slice(MAX_RECORDS),
  ]
  for (const record of prunedRecords) {
    try {
      fs.unlinkSync(path.join(dir, record.name))
    } catch {
      // Already gone; pruning is best-effort.
    }
    removeTestList(dir, record.name.slice(0, -'.json'.length))
  }
  // Orphaned lists (D7 "Interrupted writing"): the writer renamed its list
  // and died before the record. One younger than the grace may still be
  // mid-write; an older one has no writer coming.
  for (const name of names) {
    const match = LIST_NAME.exec(name)
    if (!match || recordNames.has(`${match[1]}.json`)) continue
    const absolute = path.join(dir, name)
    let mtime: number
    try {
      mtime = fs.statSync(absolute).mtimeMs
    } catch {
      continue // Vanished between readdir and stat.
    }
    if (now - mtime < LIST_ORPHAN_GRACE_MS) continue
    try {
      fs.unlinkSync(absolute)
    } catch {
      // Already gone; pruning is best-effort.
    }
  }
  // D7's thinning (K2 case 3): the kept records beyond the newest
  // MAX_KEPT_LISTS lose only their lists — the pass stays recorded, and its
  // stale `tests` pointer reads as a missing list upstream (run unknown).
  // fresh is mtime-descending, the same order the count cap keeps.
  for (const record of fresh.slice(MAX_KEPT_LISTS, MAX_RECORDS)) {
    removeTestList(dir, record.name.slice(0, -'.json'.length))
  }
}
