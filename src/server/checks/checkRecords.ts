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
}

export const RECORDS_DIR_NAME = 'kawai-checks'
export const RECORD_TTL_MS = 14 * 24 * 60 * 60 * 1000
export const MAX_RECORDS = 500
/** A temp file older than this is removed even while its writer's pid still
 * answers: pids are reused, so age is the final judge. */
export const TMP_TTL_MS = 60 * 60 * 1000

const KEY_PATTERN = /^[0-9a-f]{64}$/
/** The temporaries writeRecord leaves behind on a crash between the write
 * and the rename: `.<key>.<pid>.tmp` (writeRecord builds the same shape). */
const TMP_NAME = /^\.([0-9a-f]{64})\.(\d+)\.tmp$/

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
  return {
    key,
    treeId: typeof record.treeId === 'string' ? record.treeId : '',
    bun: typeof record.bun === 'string' ? record.bun : '',
    platform: typeof record.platform === 'string' ? record.platform : '',
    arch: typeof record.arch === 'string' ? record.arch : '',
    at: record.at,
    worktree: record.worktree,
    steps: record.steps.map((step) => ({ name: step.name, ms: step.ms })),
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

/** Remove the record for `key`, whatever wrote it. Best-effort: a file that
 * is already absent, or a store that cannot be written, is fine — removal
 * must never turn a failing check into a crash. */
export function removeRecord(dir: string, key: string): void {
  if (!KEY_PATTERN.test(key)) return
  try {
    fs.unlinkSync(path.join(dir, `${key}.json`))
  } catch {
    // Already absent, or unwritable: nothing left to remove.
  }
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
 * newest by mtime, and remove the temp files of crashed writers. Only files
 * shaped `<key>.json` are records; anything else in the directory is left
 * alone except those temporaries. */
export function pruneRecords(dir: string, now = Date.now()): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  pruneTempFiles(dir, names, now)
  const records: { name: string; mtime: number }[] = []
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue
    const absolute = path.join(dir, name)
    try {
      records.push({ name, mtime: fs.statSync(absolute).mtimeMs })
    } catch {
      // Vanished between readdir and stat: not a record to prune.
    }
  }
  const fresh = records.filter((record) => now - record.mtime < RECORD_TTL_MS)
  fresh.sort((a, b) => b.mtime - a.mtime)
  for (const stale of records.filter((record) => now - record.mtime >= RECORD_TTL_MS)) {
    try {
      fs.unlinkSync(path.join(dir, stale.name))
    } catch {
      // Already gone; pruning is best-effort.
    }
  }
  for (const old of fresh.slice(MAX_RECORDS)) {
    try {
      fs.unlinkSync(path.join(dir, old.name))
    } catch {
      // Already gone; pruning is best-effort.
    }
  }
}
