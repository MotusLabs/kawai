// testLists.ts - The test list stored beside a full-check record
// (independent-verification D7). A full pass writes `<key>.tests.json.gz` —
// a gzipped JSON array of every test that ran — before its record, and the
// record names the file and its entry count in `tests`. The reader fails
// closed: a missing, unreadable, malformed, or mismatched list is `null`,
// which every caller reads as "run unknown", never as fabricated data.
//
// This module is the one place defining the list's shape, sort order, and
// validation — the writer (scripts/lib/checkRun.ts via
// scripts/lib/junitReports.ts) and the reader (the citation check) share the
// comparator and validator below, so "unsorted" or "wrong shape" can never
// mean different things on the two sides (C1 advisor point 3).

import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { CheckRecord } from './checkRecords'

/** One test that ran: the executed file (repo-relative, no `./` prefix, the
 * same normalization as `parseJUnitExecutedFiles`), the enclosing describe
 * chain joined with ` > ` in source order ('' at the top level), the bare
 * test title, and the outcome the JUnit report recorded. */
export interface TestListEntry {
  file: string
  path: string
  name: string
  status: 'passed' | 'skipped' | 'todo'
}

export const TEST_STATUSES: readonly TestListEntry['status'][] = ['passed', 'skipped', 'todo']

/** The record's `tests` field (D7): the list file's basename and the entry
 * count it claims. */
export interface RecordTestList {
  file: string
  count: number
}

/** The basename of the list file for `key`, as stored in the record's
 * `tests.file`. */
export function testListName(key: string): string {
  return `${key}.tests.json.gz`
}

export function testListPath(dir: string, key: string): string {
  return path.join(dir, testListName(key))
}

/** A decompressed list may not exceed this — the list of a full suite is
 * about a megabyte raw, so the cap is generous headroom against a crafted
 * or corrupt gz, not a working limit (C1 advisor point 3). */
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024

/** The one sort order for list entries: by the full entry tuple, plain
 * string comparison on each field in turn. The writer sorts with this and
 * the reader requires it, so a list either side calls unsorted is the same
 * list. */
export function compareTestListEntries(a: TestListEntry, b: TestListEntry): number {
  for (const key of ['file', 'path', 'name', 'status'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return 0
}

/** Validate the shape of one parsed entry: an object whose four fields are
 * strings with `status` in the union. Anything else is not an entry. */
export function isTestListEntry(value: unknown): value is TestListEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.file === 'string' &&
    typeof entry.path === 'string' &&
    typeof entry.name === 'string' &&
    TEST_STATUSES.includes(entry.status as TestListEntry['status'])
  )
}

/** Parse the decompressed list text into entries, fail-closed: the JSON
 * must be an array of well-formed entries already sorted by the shared
 * comparator. Anything else — a torn write, a foreign array, an unsorted
 * one — is `null`, which reads as run unknown (D7, K1). */
export function parseTestList(json: string): TestListEntry[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const entries: TestListEntry[] = []
  for (const value of parsed) {
    if (!isTestListEntry(value)) return null
    entries.push(value)
  }
  for (let index = 1; index < entries.length; index++) {
    if (compareTestListEntries(entries[index - 1]!, entries[index]!) > 0) return null
  }
  return entries
}

/** The record's own `tests` pointer, fail-closed: it must name this record's
 * list by basename and carry a whole-number count. A record written before
 * this change has no `tests` at all — that reads as no list (the "record
 * without a list" scenario), so a missing field is `null` rather than an
 * error. */
export function recordTestList(record: CheckRecord): RecordTestList | null {
  const tests = record.tests
  if (tests === undefined) return null
  if (typeof tests !== 'object' || tests === null) return null
  const candidate = tests as Partial<RecordTestList>
  if (candidate.file !== testListName(record.key)) return null
  if (typeof candidate.count !== 'number' || !Number.isInteger(candidate.count) || candidate.count < 0) {
    return null
  }
  return { file: candidate.file, count: candidate.count }
}

/** The entries of the record's list, or `null` when there is none the
 * reader can trust: the record carries no `tests`, the pointer is
 * malformed, the file is missing or unreadable, the gz or its JSON is
 * corrupt, the decompressed list is over the size cap, the entries are
 * malformed or unsorted, or the count disagrees with the array (a torn
 * write). Every `null` reads as run unknown upstream — never a failure,
 * never fabricated data (K1). */
export function readTestList(dir: string, record: CheckRecord): TestListEntry[] | null {
  const pointer = recordTestList(record)
  if (pointer === null) return null
  let compressed: Buffer
  try {
    compressed = fs.readFileSync(testListPath(dir, record.key))
  } catch {
    return null
  }
  let raw: Buffer
  try {
    raw = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
  } catch {
    return null
  }
  if (raw.byteLength > MAX_DECOMPRESSED_BYTES) return null
  const entries = parseTestList(raw.toString('utf8'))
  if (entries === null) return null
  if (entries.length !== pointer.count) return null
  return entries
}

/** Write the list atomically: sorted with the shared comparator, gzipped,
 * staged as a temporary file shaped like the record writer's (`.key.pid.tmp`,
 * so its crash cleanup covers this one too), then renamed into place. The
 * rename means a reader sees either the previous or the complete new list,
 * never a partial one — and the caller must write the record only after
 * this returns (K1: the list exists before anything points at it). */
export function writeTestList(dir: string, key: string, entries: TestListEntry[]): void {
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error('check: refusing to write a test list under a non-key name')
  }
  const sorted = [...entries].sort(compareTestListEntries)
  const compressed = gzipSync(Buffer.from(JSON.stringify(sorted), 'utf8'))
  fs.mkdirSync(dir, { recursive: true })
  const temporary = path.join(dir, `.${key}.${process.pid}.tmp`)
  fs.writeFileSync(temporary, compressed)
  fs.renameSync(temporary, testListPath(dir, key))
}

/** Remove the list of `key`, whatever wrote it. Best-effort, like the
 * record removal beside it: an absent or unwritable file is nothing left
 * to remove. */
export function removeTestList(dir: string, key: string): void {
  if (!/^[0-9a-f]{64}$/.test(key)) return
  try {
    fs.unlinkSync(testListPath(dir, key))
  } catch {
    // Already absent, or unwritable: nothing left to remove.
  }
}



