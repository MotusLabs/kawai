// checkRun.test.ts - The `bun run check` pipeline (check-dedup 2.1): steps in
// order, records only on a full pass, reuse without re-running, --force, and
// GIT_*-free step environments. Git spawns target a temporary repository.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv, runGit } from '../git/gitCommand'
import {
  runCheck,
  stepEnv,
  type CheckStepSpec,
  type SpawnRequest,
} from '../../../scripts/lib/checkRun'
import { computeContentKey } from '../../../scripts/lib/checkKey'
import {
  readRecord,
  recordsDir,
  writeRecord,
  type CheckRecord,
} from '../../../scripts/lib/checkRecords'

/** Record files in the store, or none when the store was never created — a
 * run that never passed leaves not even the directory behind. */
function recordJsonNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

let tempRoot: string
let repo: string

const STEPS: CheckStepSpec[] = [
  { name: 'lint', command: ['echo', 'lint'] },
  { name: 'typecheck', command: ['echo', 'typecheck'] },
  { name: 'test', command: ['echo', 'test'] },
]

function fakeSpawn(exitCodes: (number | null)[]) {
  const spawns: SpawnRequest[] = []
  let call = 0
  return {
    spawns,
    count: () => call,
    spawn: async (request: SpawnRequest) => {
      spawns.push(request)
      const code = call < exitCodes.length ? exitCodes[call] : 0
      call += 1
      return code
    },
  }
}

function git(...args: string[]) {
  const result = runGit(args, { cwd: repo, timeoutMs: 10000 })
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function seededRecord(key: string): CheckRecord {
  return {
    key,
    treeId: 'tree-1',
    bun: Bun.version ?? '1.4.3',
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    worktree: path.resolve(repo),
    steps: [
      { name: 'lint', ms: 1 },
      { name: 'typecheck', ms: 1 },
      { name: 'test', ms: 1 },
    ],
  }
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-checkrun-'))
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

describe('runCheck', () => {
  test('a full pass runs every step in order and records it', async () => {
    const fake = fakeSpawn([0, 0, 0])
    const outcome = await runCheck({ cwd: repo, steps: STEPS, spawn: fake.spawn })
    expect(outcome.kind).toBe('passed')
    expect(fake.spawns.map((spawn) => spawn.command[0])).toEqual(['echo', 'echo', 'echo'])
    expect(fake.count()).toBe(3)
    const record = readRecord(recordsDir(repo), outcome.kind === 'passed' ? outcome.key : '')
    expect(record?.worktree).toBe(path.resolve(repo))
    expect(record?.steps.map((step) => step.name)).toEqual(['lint', 'typecheck', 'test'])
    for (const step of record?.steps ?? []) {
      expect(step.ms).toBeGreaterThanOrEqual(0)
    }
  })

  test('a recorded pass runs no step and reports its time and worktree', async () => {
    const first = await runCheck({ cwd: repo, steps: STEPS, spawn: fakeSpawn([0]).spawn })
    expect(first.kind).toBe('passed')
    const fake = fakeSpawn([])
    const second = await runCheck({ cwd: repo, steps: STEPS, spawn: fake.spawn })
    expect(second.kind).toBe('recorded')
    expect(fake.count()).toBe(0)
    if (first.kind !== 'passed' || second.kind !== 'recorded') return
    expect(readRecord(recordsDir(repo), first.key)?.at).toBe(second.record.at)
    expect(second.record.worktree).toBe(path.resolve(repo))
  })

  test('a failed step stops the run, names the step, and records nothing', async () => {
    const fake = fakeSpawn([0, 1])
    const outcome = await runCheck({ cwd: repo, steps: STEPS, spawn: fake.spawn })
    expect(outcome).toEqual({ kind: 'failed', step: 'typecheck', exitCode: 1 })
    expect(fake.count()).toBe(2)
    expect(recordJsonNames(recordsDir(repo))).toEqual([])
  })

  test('an interrupted step (no exit code) records nothing', async () => {
    const fake = fakeSpawn([null])
    const outcome = await runCheck({ cwd: repo, steps: STEPS, spawn: fake.spawn })
    expect(outcome).toEqual({ kind: 'failed', step: 'lint', exitCode: null })
    expect(recordJsonNames(recordsDir(repo))).toEqual([])
  })

  test('a failed forced run removes the older record, and the next check reruns in full', async () => {
    const first = await runCheck({ cwd: repo, steps: STEPS, spawn: fakeSpawn([0]).spawn })
    expect(first.kind).toBe('passed')
    const forced = await runCheck({ cwd: repo, steps: STEPS, spawn: fakeSpawn([1]).spawn, force: true })
    expect(forced.kind).toBe('failed')
    expect(recordJsonNames(recordsDir(repo))).toEqual([])
    const fake = fakeSpawn([0, 0, 0])
    const next = await runCheck({ cwd: repo, steps: STEPS, spawn: fake.spawn })
    expect(next.kind).toBe('passed')
    expect(fake.count()).toBe(3)
  })

  test('a forced run that dies mid-step leaves no earlier record behind', async () => {
    const first = await runCheck({ cwd: repo, steps: STEPS, spawn: fakeSpawn([0]).spawn })
    expect(first.kind).toBe('passed')
    const crashing = async (): Promise<number | null> => {
      throw new Error('interrupted mid-step')
    }
    let crashed = false
    try {
      await runCheck({ cwd: repo, steps: STEPS, spawn: crashing, force: true })
    } catch {
      crashed = true
    }
    expect(crashed).toBe(true)
    expect(recordJsonNames(recordsDir(repo))).toEqual([])
  })

  test('a failed plain run removes a record that appeared for its key mid-run', async () => {
    const first = await runCheck({ cwd: repo, steps: STEPS, spawn: fakeSpawn([0]).spawn })
    expect(first.kind).toBe('passed')
    if (first.kind !== 'passed') return
    const key = first.key
    // The race: the record is absent when the plain run reads (so it runs the
    // steps), and a concurrent writer's pass for the same key lands mid-run.
    fs.rmSync(path.join(recordsDir(repo), `${key}.json`))
    const racing = async (): Promise<number | null> => {
      writeRecord(recordsDir(repo), seededRecord(key))
      return 1
    }
    const outcome = await runCheck({ cwd: repo, steps: STEPS, spawn: racing })
    expect(outcome.kind).toBe('failed')
    expect(recordJsonNames(recordsDir(repo))).toEqual([])
  })

  test('a failed run removes only its own key, not another key\'s record', async () => {
    fs.writeFileSync(path.join(repo, 'other.ts'), 'export const other = 1\n')
    const other = await runCheck({ cwd: repo, steps: STEPS, spawn: fakeSpawn([0]).spawn })
    expect(other.kind).toBe('passed')
    if (other.kind !== 'passed') return
    // A different tree fails; key A's cleanup must not touch key B's record.
    fs.writeFileSync(path.join(repo, 'broken.ts'), 'export const broken = 1\n')
    const failed = await runCheck({ cwd: repo, steps: STEPS, spawn: fakeSpawn([1]).spawn })
    expect(failed.kind).toBe('failed')
    expect(readRecord(recordsDir(repo), other.key)).not.toBeNull()
    expect(recordJsonNames(recordsDir(repo))).toEqual([`${other.key}.json`])
  })

  test('a tree that changes mid-run passes but records nothing', async () => {
    const editing = async (request: SpawnRequest): Promise<number | null> => {
      if (request.command[1] === 'test') {
        // The last step edits a tracked file while it "runs".
        fs.writeFileSync(path.join(repo, 'README.md'), '# edited mid-run\n')
      }
      return 0
    }
    const outcome = await runCheck({ cwd: repo, steps: STEPS, spawn: editing })
    expect(outcome.kind).toBe('passed')
    if (outcome.kind !== 'passed') return
    expect(outcome.recorded).toBe(false)
    expect(recordJsonNames(recordsDir(repo))).toEqual([])
    // Nothing was recorded, so the next plain run executes every step again.
    const fake = fakeSpawn([0, 0, 0])
    const next = await runCheck({ cwd: repo, steps: STEPS, spawn: fake.spawn })
    expect(next.kind).toBe('passed')
    if (next.kind !== 'passed') return
    expect(next.recorded).toBe(true)
    expect(fake.count()).toBe(3)
  })

  test('--force runs every step despite a record and refreshes it', async () => {
    // Anchored near now: readRecord refuses records older than the TTL, so an
    // epoch-based clock would make the refreshed record read as stale.
    const base = Date.now()
    let tick = 0
    const now = () => new Date(base + tick++ * 1000)
    const first = await runCheck({ cwd: repo, steps: STEPS, spawn: fakeSpawn([0]).spawn, now })
    expect(first.kind).toBe('passed')
    const fake = fakeSpawn([0, 0, 0])
    const forced = await runCheck({ cwd: repo, steps: STEPS, spawn: fake.spawn, force: true, now })
    expect(forced.kind).toBe('passed')
    expect(fake.count()).toBe(3)
    const refreshed = readRecord(recordsDir(repo), forced.kind === 'passed' ? forced.key : '')
    expect(refreshed?.at).toBe(new Date(base + 1_000).toISOString())
  })

  test('step environments carry no GIT_* variables and keep the rest', async () => {
    const fake = fakeSpawn([0, 0, 0])
    await runCheck({
      cwd: repo,
      steps: STEPS,
      spawn: fake.spawn,
      env: { PATH: process.env.PATH ?? '', GIT_INDEX_FILE: '/gone/index', GIT_DIR: '/gone', KAWAI_PROBE: 'yes' },
    })
    expect(fake.count()).toBe(3)
    for (const spawn of fake.spawns) {
      for (const name of Object.keys(spawn.env)) {
        expect(name.startsWith('GIT_')).toBe(false)
      }
      expect(spawn.env.KAWAI_PROBE).toBe('yes')
    }
  })

  test('a garbage GIT_INDEX_FILE in the base env does not disturb the key', async () => {
    const disturbed = await runCheck({
      cwd: repo,
      steps: STEPS,
      spawn: fakeSpawn([0]).spawn,
      env: { PATH: process.env.PATH ?? '', GIT_INDEX_FILE: '/gone/index' },
    })
    expect(disturbed.kind).toBe('passed')
    if (disturbed.kind !== 'passed') return
    // The recorded key is the one a clean environment computes for this tree.
    expect(disturbed.key).toBe(computeContentKey({ cwd: repo }).key)
  })

  test('outside a repository it errors without running steps', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-checkrun-plain-'))
    try {
      const fake = fakeSpawn([])
      const outcome = await runCheck({ cwd: plain, steps: STEPS, spawn: fake.spawn })
      expect(outcome.kind).toBe('error')
      expect(fake.count()).toBe(0)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('stepEnv', () => {
  test('strips every GIT_-prefixed variable', () => {
    const stripped = stepEnv({
      GIT_DIR: '/x',
      GIT_INDEX_FILE: '/x',
      GIT_AUTHOR_NAME: 'someone',
      PATH: '/bin',
      HOME: '/home',
    })
    expect(Object.keys(stripped).sort()).toEqual(['HOME', 'PATH'])
  })
})

describe('scripts/check.ts end to end', () => {
  function makeProject() {
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { lint: 'true', typecheck: 'true', test: 'true' } })
    )
  }

  function runCli(args: string[]) {
    return Bun.spawnSync({
      cmd: [process.execPath, path.resolve(import.meta.dir, '../../../scripts/check.ts'), ...args],
      cwd: repo,
      env: cleanGitEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }

  test('a pass records, a second run reports the record and runs nothing', () => {
    makeProject()
    const first = runCli([])
    expect(first.exitCode).toBe(0)
    const stdout = first.stdout.toString()
    expect(stdout).toContain('pass recorded')
    expect(stdout).toContain('test ok in')
    const records = fs.readdirSync(recordsDir(repo)).filter((name) => name.endsWith('.json'))
    expect(records.length).toBe(1)
    const started = Date.now()
    const second = runCli([])
    const elapsed = Date.now() - started
    expect(second.exitCode).toBe(0)
    expect(second.stdout.toString()).toContain('recorded pass')
    expect(elapsed).toBeLessThan(15_000)
  })

  test('--force reruns a recorded pass', () => {
    makeProject()
    expect(runCli([]).exitCode).toBe(0)
    const forced = runCli(['--force'])
    expect(forced.exitCode).toBe(0)
    expect(forced.stdout.toString()).toContain('pass recorded')
  })

  test('a failing step exits non-zero naming the step and records nothing', () => {
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { lint: 'true', typecheck: 'false', test: 'true' } })
    )
    const failed = runCli([])
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr.toString()).toContain('typecheck failed')
    expect(recordJsonNames(recordsDir(repo))).toEqual([])
  })
})
