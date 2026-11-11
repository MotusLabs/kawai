// checkRunReuse.test.ts - The record fields and the reuse rule of
// check-time-optimization D3 (tasks 3.4, 3.5): a pass records its case
// profile and the runner's real-tmux retries; a record written before them
// reads as no retries and an unknown profile; and the reuse table RU1–RU5,
// verbatim, over runCheck. Git spawns target a temporary repository.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { runCheck, type CheckStepSpec, type SpawnRequest } from '../../../scripts/lib/checkRun'
import { writePlannedReports } from '../../../scripts/lib/junitReports'
import { writeRetriesRecord } from '../../../scripts/lib/realTmuxRetries'
import { computeContentKey } from '../checks/checkKey'
import { readRecord, recordsDir, writeRecord, type CaseProfile, type CheckRecord } from '../checks/checkRecords'

let tempRoot: string
let repo: string

const STEPS: CheckStepSpec[] = [
  { name: 'lint', command: ['echo', 'lint'] },
  { name: 'test', command: ['echo', 'test'] },
]

function git(...args: string[]) {
  const result = runGit(args, { cwd: repo, timeoutMs: 10000 })
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-checkrun-reuse-'))
  repo = path.join(tempRoot, 'repo')
  fs.mkdirSync(repo)
  git('init', '--initial-branch=main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n')
  git('add', '-A')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function key(): string {
  return computeContentKey({ cwd: repo }).key
}

function seed(profile: CaseProfile | 'unknown'): void {
  const record: CheckRecord = {
    key: key(),
    treeId: 'tree-1',
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    worktree: repo,
    steps: [{ name: 'lint', ms: 1 }],
    ...(profile === 'unknown' ? {} : { caseProfile: profile }),
  }
  writeRecord(recordsDir(repo), record)
}

function counting() {
  const spawns: SpawnRequest[] = []
  return { spawns, spawn: async (request: SpawnRequest) => (spawns.push(request), 0) }
}

const LOCAL_ENV = { PATH: process.env.PATH }

describe('record fields (task 3.4)', () => {
  // @covers: dev-checks › A recorded pass names its retries and case profile › An older record
  test('a record written before this change reads as no retries and an unknown profile', () => {
    const dir = recordsDir(repo)
    fs.mkdirSync(dir, { recursive: true })
    const k = key()
    // The shape every pass had before check-time-optimization, test list
    // pointer and selection included.
    fs.writeFileSync(
      path.join(dir, `${k}.json`),
      JSON.stringify({
        key: k, treeId: 't', bun: '1.4.3', platform: 'linux', arch: 'x64', at: new Date().toISOString(),
        worktree: repo, steps: [{ name: 'test', ms: 5 }],
      })
    )
    const record = readRecord(dir, k)
    expect(record).not.toBeNull()
    expect(record!.retries).toBeUndefined()
    expect(record!.caseProfile).toBeUndefined()
  })

  test('malformed retries or profile drop only themselves', () => {
    const dir = recordsDir(repo)
    fs.mkdirSync(dir, { recursive: true })
    const k = key()
    fs.writeFileSync(
      path.join(dir, `${k}.json`),
      JSON.stringify({
        key: k, at: new Date().toISOString(), worktree: repo, steps: [],
        retries: [{ file: 3 }], caseProfile: 'half',
      })
    )
    const record = readRecord(dir, k)
    expect(record).not.toBeNull()
    expect(record!.retries).toBeUndefined()
    expect(record!.caseProfile).toBeUndefined()
  })

  test('RT3\'s record names the retried file and its first-attempt failures', async () => {
    const file = 'src/server/__tests__/output-coalescing.integration.test.ts'
    const outcome = await runCheck({
      cwd: repo,
      steps: STEPS,
      env: LOCAL_ENV,
      junit: { dirParent: tempRoot, merge: () => null },
      spawn: async (request) => {
        const reports = request.env.KAWAI_TEST_JUNIT_DIR
        if (request.command.includes('test') && reports !== undefined) {
          writePlannedReports(reports, ['0-parallel-x.junit.xml'])
          writeRetriesRecord(reports, [{ file, failures: ['coalescing > orders output'] }])
        }
        return 0
      },
    })
    expect(outcome.kind).toBe('passed')
    const record = readRecord(recordsDir(repo), key())
    expect(record?.retries).toEqual([{ file, failures: ['coalescing > orders output'] }])
    expect(record?.caseProfile).toBe('reduced')
  })

  test('a pass without retries records none; CI=true records the full profile', async () => {
    await runCheck({ cwd: repo, steps: STEPS, env: { ...LOCAL_ENV, CI: 'true' }, junit: null, spawn: counting().spawn })
    const record = readRecord(recordsDir(repo), key())
    expect(record?.retries).toBeUndefined()
    expect(record?.caseProfile).toBe('full')
  })
})

interface ReuseRow {
  id: string
  request: 'default' | 'full-properties'
  force: boolean
  existing: CaseProfile | 'unknown' | 'none'
  result: 'run' | 'reuse'
}

const REUSE: ReuseRow[] = [
  { id: 'RU1', request: 'default', force: false, existing: 'none', result: 'run' },
  { id: 'RU2', request: 'default', force: false, existing: 'reduced', result: 'reuse' },
  { id: 'RU2', request: 'default', force: false, existing: 'full', result: 'reuse' },
  { id: 'RU2', request: 'default', force: false, existing: 'unknown', result: 'reuse' },
  { id: 'RU3', request: 'full-properties', force: false, existing: 'full', result: 'reuse' },
  { id: 'RU3', request: 'full-properties', force: false, existing: 'unknown', result: 'reuse' },
  { id: 'RU4', request: 'full-properties', force: false, existing: 'reduced', result: 'run' },
  ...(['none', 'reduced', 'full', 'unknown'] as const).flatMap((existing) =>
    (['default', 'full-properties'] as const).map((request) => ({ id: 'RU5', request, force: true, existing, result: 'run' as const }))
  ),
]

describe('reuse table (check-time-optimization D3, task 3.5)', () => {
  for (const row of REUSE) {
    test(`${row.id}: ${row.force ? '--force with ' : ''}${row.request} request, ${row.existing} record → ${row.result}`, async () => {
      if (row.existing !== 'none') seed(row.existing)
      const { spawns, spawn } = counting()
      const outcome = await runCheck({
        cwd: repo,
        steps: STEPS,
        env: LOCAL_ENV,
        junit: null,
        spawn,
        force: row.force,
        fullProperties: row.request === 'full-properties',
      })
      if (row.result === 'reuse') {
        expect(outcome.kind).toBe('recorded')
        expect(spawns).toHaveLength(0)
        return
      }
      expect(outcome.kind).toBe('passed')
      expect(spawns).toHaveLength(STEPS.length)
      // The run records the profile it executed: --full-properties exports
      // the full counts to every step and records `full` (RU4, A6).
      const expected = row.request === 'full-properties' ? 'full' : 'reduced'
      expect(readRecord(recordsDir(repo), key())?.caseProfile).toBe(expected)
      for (const request of spawns) {
        expect(request.env.KAWAI_FULL_PROPERTIES).toBe(row.request === 'full-properties' ? '1' : undefined)
      }
    })
  }
})
