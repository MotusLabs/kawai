// checkRecords.test.ts - Recorded-pass store for `bun run check`
// (check-dedup 1.2). All git spawns target a temporary repository through
// runGit's cleanGitEnv.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import {
  LIST_ORPHAN_GRACE_MS,
  MAX_RECORDS,
  RECORD_TTL_MS,
  TMP_TTL_MS,
  type CheckRecord,
  pruneRecords,
  readRecord,
  recordsDir,
  recordsForTree,
  removeRecord,
  writeRecord,
} from '../checks/checkRecords'

let tempRoot: string
let repo: string
let dir: string

function git(...args: string[]) {
  const result = runGit(args, { cwd: repo, timeoutMs: 10000 })
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

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

/** The pid of a process that has exited, verified gone. */
function deadPid(): number {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const pid = Bun.spawnSync({ cmd: ['true'], stdout: 'ignore', stderr: 'ignore' }).pid
    try {
      process.kill(pid, 0)
    } catch {
      return pid
    }
  }
  throw new Error('no dead pid found')
}

/** A temp file shaped the way writeRecord's interrupted write leaves one. */
function seedTmp(pid: number, mtime: number) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `.${'a'.repeat(64)}.${pid}.tmp`)
  fs.writeFileSync(file, '{"key":"') // the partial body of a crashed write
  fs.utimesSync(file, mtime / 1000, mtime / 1000)
}

/** A deterministic pseudo-random generator over a fixed seed (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-checkrecords-'))
  repo = path.join(tempRoot, 'repo')
  fs.mkdirSync(repo)
  git('init', '--initial-branch=main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n')
  git('add', '-A')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init')
  dir = recordsDir(repo)
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('recordsDir', () => {
  test('resolves under the repository git directory', () => {
    expect(dir).toBe(path.join(repo, '.git', 'kawai-checks'))
  })

  test('outside a repository it throws', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-checkrecords-plain-'))
    try {
      expect(() => recordsDir(plain)).toThrow(/git directory/)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('readRecord', () => {
  test('round-trips a written record', () => {
    const written = record()
    writeRecord(dir, written)
    expect(readRecord(dir, written.key)).toEqual(written)
  })

  test('a missing record reads as none', () => {
    expect(readRecord(dir, 'b'.repeat(64))).toBeNull()
  })

  test('a corrupt file never reads as a recorded pass', () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${'c'.repeat(64)}.json`), '{not json')
    expect(readRecord(dir, 'c'.repeat(64))).toBeNull()
  })

  test('a record naming another key reads as none', () => {
    writeRecord(dir, record())
    expect(readRecord(dir, 'd'.repeat(64))).toBeNull()
  })

  test('a record whose body names another key reads as none under its own name', () => {
    // a.json exists but describes key b: the key guard, not a missing file,
    // must reject it.
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${'a'.repeat(64)}.json`),
      JSON.stringify(record({ key: 'b'.repeat(64) }))
    )
    expect(readRecord(dir, 'a'.repeat(64))).toBeNull()
  })

  test('a record older than the TTL reads as none, an unparseable time too', () => {
    const stale = record({ at: new Date(Date.now() - RECORD_TTL_MS - 1_000).toISOString() })
    writeRecord(dir, stale)
    expect(readRecord(dir, stale.key)).toBeNull()
    const fresh = record({ at: new Date(Date.now() - 1_000).toISOString() })
    writeRecord(dir, fresh)
    expect(readRecord(dir, fresh.key)).toEqual(fresh)
    const unparseable = record({ at: 'not-a-time' })
    writeRecord(dir, unparseable)
    expect(readRecord(dir, unparseable.key)).toBeNull()
  })

  test('a record without steps, time, or worktree reads as none', () => {
    fs.mkdirSync(dir, { recursive: true })
    const partial = { key: 'e'.repeat(64), at: '2026-10-20T08:00:00.000Z' }
    fs.writeFileSync(path.join(dir, `${'e'.repeat(64)}.json`), JSON.stringify(partial))
    expect(readRecord(dir, 'e'.repeat(64))).toBeNull()
    const noSteps = { ...record({ key: 'f'.repeat(64) }), steps: 'three minutes' }
    fs.writeFileSync(path.join(dir, `${'f'.repeat(64)}.json`), JSON.stringify(noSteps))
    expect(readRecord(dir, 'f'.repeat(64))).toBeNull()
  })

  test('a non-key argument reads as none instead of touching the filesystem', () => {
    expect(readRecord(dir, '../../etc/passwd')).toBeNull()
  })
})

describe('writeRecord', () => {
  test('leaves exactly the record file behind (atomic rename)', () => {
    const written = record()
    writeRecord(dir, written)
    expect(fs.readdirSync(dir).sort()).toEqual([`${written.key}.json`])
  })

  test('overwrites a previous record for the same key', () => {
    writeRecord(dir, record({ at: new Date(Date.now() - 3_600_000).toISOString() }))
    const refreshed = record()
    writeRecord(dir, refreshed)
    expect(readRecord(dir, refreshed.key)?.at).toBe(refreshed.at)
  })

  test('refuses a non-key name', () => {
    expect(() => writeRecord(dir, record({ key: 'not-a-key' }))).toThrow(/non-key/)
  })
})

describe('pruning', () => {
  test('records older than the TTL are removed on the next write', () => {
    const old = record({ key: '1'.repeat(64) })
    writeRecord(dir, old)
    fs.utimesSync(
      path.join(dir, `${old.key}.json`),
      (Date.now() - RECORD_TTL_MS - 1000) / 1000,
      (Date.now() - RECORD_TTL_MS - 1000) / 1000
    )
    writeRecord(dir, record({ key: '2'.repeat(64) }))
    expect(readRecord(dir, old.key)).toBeNull()
    expect(readRecord(dir, '2'.repeat(64))).not.toBeNull()
  })

  test('beyond the newest 500, the oldest records are removed', () => {
    for (let index = 0; index < MAX_RECORDS + 5; index += 1) {
      // The first five are backdated an hour so "oldest" is unambiguous.
      const age = index < 5 ? 3_600_000 : 0
      seedRecord(hexKey(index + 1), Date.now() - age)
    }
    const newest = record({ key: hexKey(MAX_RECORDS + 6) })
    writeRecord(dir, newest)
    const remaining = fs.readdirSync(dir)
    expect(remaining.length).toBe(MAX_RECORDS)
    expect(readRecord(dir, newest.key)).toEqual(newest)
    for (let index = 1; index <= 5; index += 1) {
      expect(fs.existsSync(path.join(dir, `${hexKey(index)}.json`))).toBe(false)
    }
  })

  test('non-record files in the directory are left alone', () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a record')
    writeRecord(dir, record())
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
  })

  test('a fresh temp file whose writer pid is dead is removed', () => {
    const pid = deadPid()
    seedTmp(pid, Date.now())
    pruneRecords(dir)
    expect(fs.existsSync(path.join(dir, `.${'a'.repeat(64)}.${pid}.tmp`))).toBe(false)
  })

  test('a temp file older than an hour is removed even while its writer lives', () => {
    // pid reuse would otherwise keep the file forever, so age decides.
    seedTmp(process.pid, Date.now() - TMP_TTL_MS - 60_000)
    pruneRecords(dir)
    expect(fs.existsSync(path.join(dir, `.${'a'.repeat(64)}.${process.pid}.tmp`))).toBe(false)
  })

  test('a fresh temp file of a live writer is kept, and so is any other shape', () => {
    seedTmp(process.pid, Date.now())
    const other = path.join(dir, '.not-ours.tmp')
    fs.writeFileSync(other, 'x')
    pruneRecords(dir)
    expect(fs.existsSync(path.join(dir, `.${'a'.repeat(64)}.${process.pid}.tmp`))).toBe(true)
    expect(fs.existsSync(other)).toBe(true)
  })

  test('temp-file pruning leaves the records untouched', () => {
    const kept = record({ key: 'b'.repeat(64) })
    writeRecord(dir, kept)
    seedTmp(deadPid(), Date.now())
    pruneRecords(dir)
    expect(readRecord(dir, kept.key)).toEqual(kept)
    expect(fs.readdirSync(dir)).toEqual([`${kept.key}.json`])
  })
})

describe('records are shared across linked worktrees', () => {
  test('a pass recorded in one worktree is visible from another', () => {
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export const x = 1\n')
    git('add', '-A')
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'src')
    const worktree = path.join(tempRoot, 'wt')
    // `main` is checked out in the fixture repo; the worktree gets its own branch.
    git('worktree', 'add', '-b', 'wt-main', worktree)
    const fromWorktree = recordsDir(worktree)
    expect(fromWorktree).toBe(dir)
    const written = record()
    writeRecord(fromWorktree, written)
    // Read back through the other worktree's resolution of the same directory.
    expect(readRecord(recordsDir(repo), written.key)).toEqual(written)
  })
})

describe('recordsForTree', () => {
  // The age limit judges the record's own `at` against this fixed instant, so
  // the fixtures neither expire nor shift with the suite's wall clock.
  const NOW = Date.parse('2026-10-20T12:00:00.000Z')
  const at = (msBefore: number) => new Date(NOW - msBefore).toISOString()

  function seed(fixture: CheckRecord) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${fixture.key}.json`), JSON.stringify(fixture))
  }

  test('returns every record of the tree across Bun versions, newest first', () => {
    seed(record({ key: hexKey(1), treeId: 'tree-t', bun: '1.4.0', at: at(5_000) }))
    seed(record({ key: hexKey(2), treeId: 'tree-t', bun: '1.4.3', at: at(1_000) }))
    expect(recordsForTree(dir, 'tree-t', NOW).map((entry) => [entry.bun, entry.key])).toEqual([
      ['1.4.3', hexKey(2)],
      ['1.4.0', hexKey(1)],
    ])
  })

  test('a record past the age limit is not returned, the TTL boundary excluded', () => {
    seed(record({ key: hexKey(3), treeId: 'tree-t', at: at(RECORD_TTL_MS + 1) }))
    expect(recordsForTree(dir, 'tree-t', NOW)).toEqual([])
    seed(record({ key: hexKey(4), treeId: 'tree-t', at: at(RECORD_TTL_MS) }))
    expect(recordsForTree(dir, 'tree-t', NOW)).toEqual([])
    seed(record({ key: hexKey(5), treeId: 'tree-t', at: at(RECORD_TTL_MS - 1) }))
    expect(recordsForTree(dir, 'tree-t', NOW).map((entry) => entry.key)).toEqual([hexKey(5)])
  })

  test('a malformed or truncated file is skipped without throwing, its valid neighbors returned', () => {
    seed(record({ key: hexKey(6), treeId: 'tree-t', at: at(1_000) }))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${hexKey(7)}.json`), '{"key":"') // a truncated write
    fs.writeFileSync(path.join(dir, `${hexKey(8)}.json`), 'not json at all')
    fs.writeFileSync(path.join(dir, `${hexKey(9)}.json`), JSON.stringify({ key: hexKey(9), treeId: 'tree-t' }))
    // A well-formed record under a non-record name is not scanned at all.
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(record({ key: hexKey(10), treeId: 'tree-t' })))
    expect(recordsForTree(dir, 'tree-t', NOW).map((entry) => entry.key)).toEqual([hexKey(6)])
  })

  test('a record of another tree is not returned', () => {
    seed(record({ key: hexKey(11), treeId: 'tree-other', at: at(1_000) }))
    expect(recordsForTree(dir, 'tree-t', NOW)).toEqual([])
    seed(record({ key: hexKey(12), treeId: 'tree-t', at: at(2_000) }))
    expect(recordsForTree(dir, 'tree-t', NOW).map((entry) => entry.key)).toEqual([hexKey(12)])
  })

  test('an empty or missing record directory returns no records', () => {
    fs.mkdirSync(dir, { recursive: true }) // existing and empty, not merely absent
    expect(recordsForTree(dir, 'tree-t', NOW)).toEqual([])
    expect(recordsForTree(path.join(dir, 'not-there'), 'tree-t', NOW)).toEqual([])
  })

  test('random record sets resolve to exactly the unexpired, well-formed records of the tree', () => {
    // A tiny seeded PRNG (mulberry32): the property needs reproducibility,
    // not cryptography, and the suite adds no dependency for it.
    const random = mulberry32(0x5eed1234)
    const trees = ['tree-a', 'tree-b', 'tree-c']
    const buns = ['1.4.0', '1.4.3', '1.5.0']
    for (let set = 0; set < 220; set++) {
      fs.rmSync(dir, { recursive: true, force: true })
      const target = trees[(random() * trees.length) | 0]
      const entries: CheckRecord[] = []
      const count = 1 + ((random() * 6) | 0)
      for (let n = 0; n < count; n++) {
        entries.push(
          record({
            key: hexKey(set * 16 + n + 1),
            treeId: trees[(random() * trees.length) | 0],
            bun: buns[(random() * buns.length) | 0],
            // Quantized to a coarse grid so same-`at` ties actually occur.
            at: at(((random() * 10) | 0) * (RECORD_TTL_MS / 5)),
          })
        )
      }
      const corrupted = random() < 0.3 ? (random() * entries.length) | 0 : -1
      const foreignName = random() < 0.2 ? (random() * entries.length) | 0 : -1
      fs.mkdirSync(dir, { recursive: true })
      entries.forEach((entry, index) => {
        const name = index === foreignName ? 'notes.json' : `${entry.key}.json`
        fs.writeFileSync(path.join(dir, name), index === corrupted ? '{"key":' : JSON.stringify(entry))
      })
      const expected = entries
        .filter((entry, index) => index !== corrupted && index !== foreignName)
        .filter((entry) => NOW - Date.parse(entry.at) < RECORD_TTL_MS)
        .filter((entry) => entry.treeId === target)
        .sort((a, b) => {
          const byAt = Date.parse(b.at) - Date.parse(a.at)
          if (byAt !== 0) return byAt
          return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
        })
      expect(recordsForTree(dir, target, NOW)).toEqual(expected)
    }
  })
})

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

describe('orphaned lists (D7 "Interrupted writing")', () => {
  function seedOrphanList(key: string, mtime: number) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${key}.tests.json.gz`)
    fs.writeFileSync(file, Buffer.from([0x1f, 0x8b, 0, 0]))
    fs.utimesSync(file, mtime / 1000, mtime / 1000)
  }

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
