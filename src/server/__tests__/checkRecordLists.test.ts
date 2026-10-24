// checkRecordLists.test.ts - The test lists beside recorded passes
// (independent-verification D7): pruning takes each list with its record
// (K2 cases 1-2), D7's thinning keeps only the newest 100 lists (K2 case
// 3), orphaned lists and the record's tests pointer fail closed. Split
// from checkRecords.test.ts (file-size cap, K7); the record-store tests
// without lists stay there. All git spawns target a temporary repository
// through runGit's cleanGitEnv.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import {
  LIST_ORPHAN_GRACE_MS,
  MAX_RECORDS,
  RECORD_TTL_MS,
  type CheckRecord,
  pruneRecords,
  readRecord,
  recordsDir,
  removeRecord,
} from '../checks/checkRecords'
import { readTestList } from '../checks/testLists'

let tempRoot: string
let repo: string
let dir: string

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-check-record-lists-')))
  repo = path.join(tempRoot, 'repo')
  fs.mkdirSync(repo)
  const init = runGit(['init', '--initial-branch=master', repo], { timeoutMs: 10_000 })
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
  dir = recordsDir(repo)
})
afterEach(() => { fs.rmSync(tempRoot, { recursive: true, force: true }) })

function record(overrides: Partial<CheckRecord> = {}): CheckRecord {
  return {
    key: 'a'.repeat(64),
    treeId: 'tree-1',
    bun: '1.4.3',
    platform: 'linux',
    arch: 'x64',
    // Relative to now: readRecord refuses records older than the TTL, so a
    // fixed timestamp would expire this fixture out of the suite.
    at: new Date().toISOString(),
    worktree: '/somewhere/impl-feature',
    steps: [
      { name: 'lint', ms: 900 },
      { name: 'typecheck', ms: 41_000 },
      { name: 'test', ms: 412_000 },
    ],
    ...overrides,
  }
}

function hexKey(n: number) {
  return n.toString(16).padStart(64, '0')
}

function seedRecord(key: string, mtime: number) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${key}.json`)
  fs.writeFileSync(file, JSON.stringify(record({ key })))
  fs.utimesSync(file, mtime / 1000, mtime / 1000)
}

// --- test lists beside records (independent-verification D7, task 4.2) ---

describe('pruning takes each list with its record (K2)', () => {
  function seedList(key: string, mtime: number, count = 1) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${key}.tests.json.gz`)
    fs.writeFileSync(file, Buffer.from([0x1f, 0x8b, 0, 0]))
    fs.utimesSync(file, mtime / 1000, mtime / 1000)
    return { key, count }
  }

  // @covers: dev-checks › Full-check records list the tests that ran › Pruned together
  test('a record pruned for age takes its list with it', () => {
    const key = hexKey(1)
    const old = Date.now() - RECORD_TTL_MS - 1000
    seedRecord(key, old)
    seedList(key, old)
    pruneRecords(dir)
    expect(fs.existsSync(path.join(dir, `${key}.json`))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${key}.tests.json.gz`))).toBe(false)
  })

  test('a record pushed out by the count cap takes its list with it', () => {
    const oldKey = hexKey(1)
    const newKey = hexKey(2)
    const base = Date.now() - 1000
    for (let index = 0; index < MAX_RECORDS; index++) seedRecord(hexKey(100 + index), base + index)
    seedRecord(oldKey, base - 10_000)
    seedList(oldKey, base - 10_000)
    pruneRecords(dir)
    expect(fs.existsSync(path.join(dir, `${oldKey}.json`))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${oldKey}.tests.json.gz`))).toBe(false)
    expect(readRecord(dir, newKey) === null || newKey === hexKey(100)).toBe(true)
    // A record the cap keeps still has its list.
    seedRecord(newKey, Date.now())
    seedList(newKey, Date.now())
    pruneRecords(dir)
    expect(fs.existsSync(path.join(dir, `${newKey}.json`))).toBe(true)
    expect(fs.existsSync(path.join(dir, `${newKey}.tests.json.gz`))).toBe(true)
  })

  test('pruning one stale record never removes another record\'s list', () => {
    const staleKey = hexKey(1)
    const freshKey = hexKey(2)
    const now = Date.now()
    seedRecord(staleKey, now - RECORD_TTL_MS - 1000)
    seedList(staleKey, now - RECORD_TTL_MS - 1000)
    seedRecord(freshKey, now)
    seedList(freshKey, now)
    pruneRecords(dir, now)
    expect(fs.existsSync(path.join(dir, `${freshKey}.json`))).toBe(true)
    expect(fs.existsSync(path.join(dir, `${freshKey}.tests.json.gz`))).toBe(true)
  })
})

describe('D7 thinning: only the newest 100 records keep lists (K2 case 3)', () => {
  function seedWithList(key: string, mtime: number) {
    seedRecord(key, mtime)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${key}.tests.json.gz`)
    fs.writeFileSync(file, Buffer.from([0x1f, 0x8b, 0, 0]))
    fs.utimesSync(file, mtime / 1000, mtime / 1000)
  }

  test('the 100th-newest record keeps its list, the 101st keeps its record without its list', () => {
    const base = Date.now() - 10_000
    const oldest = hexKey(1)
    seedWithList(oldest, base)
    for (let index = 1; index <= 100; index++) seedWithList(hexKey(1 + index), base + index)
    pruneRecords(dir, Date.now())
    // The 101st-newest keeps its record and loses only its list; the stale
    // pointer reads as no list, run unknown upstream — never fabricated.
    expect(fs.existsSync(path.join(dir, `${oldest}.json`))).toBe(true)
    expect(fs.existsSync(path.join(dir, `${oldest}.tests.json.gz`))).toBe(false)
    const kept = readRecord(dir, oldest)
    expect(kept).not.toBeNull()
    expect(readTestList(dir, kept!)).toBeNull()
    // The 100th-newest still has its list.
    expect(fs.existsSync(path.join(dir, `${hexKey(2)}.tests.json.gz`))).toBe(true)
  })

  test('exactly 100 records keep every list', () => {
    const base = Date.now() - 10_000
    for (let index = 0; index < 100; index++) seedWithList(hexKey(10 + index), base + index)
    pruneRecords(dir, Date.now())
    for (let index = 0; index < 100; index++) {
      expect(fs.existsSync(path.join(dir, `${hexKey(10 + index)}.tests.json.gz`))).toBe(true)
    }
  })

  test('thinning removes no record the age-and-count rule keeps', () => {
    const base = Date.now() - 10_000
    for (let index = 0; index < 150; index++) seedWithList(hexKey(20 + index), base + index)
    pruneRecords(dir, Date.now())
    const records = fs.readdirSync(dir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    expect(records).toHaveLength(150)
    const lists = fs.readdirSync(dir).filter((name) => name.endsWith('.tests.json.gz'))
    expect(lists).toHaveLength(100)
  })
})

describe('orphaned lists (D7 "Interrupted writing")', () => {
  function seedOrphanList(key: string, mtime: number) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${key}.tests.json.gz`)
    fs.writeFileSync(file, Buffer.from([0x1f, 0x8b, 0, 0]))
    fs.utimesSync(file, mtime / 1000, mtime / 1000)
  }

  // @covers: dev-checks › Full-check records list the tests that ran › Interrupted writing
  test('an orphan list older than the grace is removed by the next prune', () => {
    const key = hexKey(3)
    const now = Date.now()
    seedOrphanList(key, now - LIST_ORPHAN_GRACE_MS - 1000)
    pruneRecords(dir, now)
    expect(fs.existsSync(path.join(dir, `${key}.tests.json.gz`))).toBe(false)
  })

  test('a list whose record still exists is never an orphan, whatever its age', () => {
    const key = hexKey(4)
    const now = Date.now()
    seedRecord(key, now - RECORD_TTL_MS + 60_000)
    seedOrphanList(key, now - RECORD_TTL_MS + 60_000)
    pruneRecords(dir, now)
    expect(fs.existsSync(path.join(dir, `${key}.tests.json.gz`))).toBe(true)
  })

  test('a young orphan list survives the grace (a concurrent writer may sit between the renames)', () => {
    const key = hexKey(5)
    const now = Date.now()
    seedOrphanList(key, now - 1000)
    pruneRecords(dir, now)
    expect(fs.existsSync(path.join(dir, `${key}.tests.json.gz`))).toBe(true)
  })

  test('files that are not key-shaped lists are left alone', () => {
    const now = Date.now()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'notes.tests.json.gz'), 'x')
    fs.writeFileSync(path.join(dir, 'zz.tests.json.gz'), 'x')
    pruneRecords(dir, now)
    expect(fs.existsSync(path.join(dir, 'notes.tests.json.gz'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'zz.tests.json.gz'))).toBe(true)
  })
})

describe('removeRecord takes the list with it (force and failure paths, C1 advisor point 1)', () => {
  test('a forced run\'s removeRecord drops the older list too', () => {
    const key = hexKey(6)
    fs.mkdirSync(dir, { recursive: true })
    seedRecord(key, Date.now())
    fs.writeFileSync(path.join(dir, `${key}.tests.json.gz`), 'x')
    removeRecord(dir, key)
    expect(fs.existsSync(path.join(dir, `${key}.json`))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${key}.tests.json.gz`))).toBe(false)
  })

  test('removeRecord of an unknown key writes nothing and throws nothing', () => {
    expect(() => removeRecord(dir, 'not-a-key')).not.toThrow()
  })
})

describe('the record\'s tests pointer parses fail-closed without invalidating the pass', () => {
  test('a malformed tests field drops the pointer and keeps the record', () => {
    const key = hexKey(7)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ ...record({ key }), tests: { file: 'elsewhere.gz', count: 'many' } })
    )
    const read = readRecord(dir, key)
    expect(read).not.toBeNull()
    expect(read?.tests).toBeUndefined()
  })

  test('a tests pointer naming another key\'s list drops the pointer, keeps the record', () => {
    const key = hexKey(8)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ ...record({ key }), tests: { file: `${hexKey(9)}.tests.json.gz`, count: 3 } })
    )
    expect(readRecord(dir, key)?.tests).toBeUndefined()
  })

  test('a well-formed tests pointer round-trips', () => {
    const key = hexKey(10)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ ...record({ key }), tests: { file: `${key}.tests.json.gz`, count: 6412 } })
    )
    expect(readRecord(dir, key)?.tests).toEqual({ file: `${key}.tests.json.gz`, count: 6412 })
  })
})
