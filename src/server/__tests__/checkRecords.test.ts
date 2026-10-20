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
  type CheckRecord,
  readRecord,
  recordsDir,
  writeRecord,
} from '../../../scripts/lib/checkRecords'

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
    at: '2026-10-20T08:00:00.000Z',
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
    writeRecord(dir, record({ at: '2026-10-19T08:00:00.000Z' }))
    const refreshed = record({ at: '2026-10-20T09:00:00.000Z' })
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
