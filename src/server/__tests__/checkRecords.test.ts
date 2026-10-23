// checkRecords.test.ts - Recorded-pass store for `bun run check`
// (check-dedup 1.2). All git spawns target a temporary repository through
// runGit's cleanGitEnv.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import {
  MAX_RECORDS,
  RECORD_TTL_MS,
  TMP_TTL_MS,
  type CheckRecord,
  pruneRecords,
  readRecord,
  recordsDir,
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
