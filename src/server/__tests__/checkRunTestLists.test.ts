// checkRunTestLists.test.ts - The write-path half of runCheck's test lists
// (independent-verification D7, task 4.2): the list lands before its record
// (K1), the entries are sorted, an unmergeable report set records loudly
// without a list, and a failed run leaves nothing behind (K3). Split out of
// checkRun.test.ts to keep both files under the 500-line cap (K7).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { runCheck, type CheckStepSpec, type SpawnRequest } from '../../../scripts/lib/checkRun'
import { readRecord, recordsDir } from '../checks/checkRecords'
import { readTestList, testListName } from '../checks/testLists'

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

describe('runCheck writes the test list', () => {
  const ENTRIES = [
    { file: 'src/b.test.ts', path: '', name: 'zeta', status: 'passed' as const },
    { file: 'src/a.test.ts', path: 'outer', name: 'alpha', status: 'passed' as const },
  ]

  function recordsDirectory(): string {
    return recordsDir(repo)
  }

  // @covers: dev-checks › Full-check records list the tests that ran › Pass with its test list
  test('a full pass writes the list before its record, and the record names it (K1)', async () => {
    const observations: { recordExistedAtMerge: boolean }[] = []
    const merge = (reportDir: string) => {
      observations.push({ recordExistedAtMerge: recordJsonNames(recordsDirectory()).length > 0 })
      expect(fs.existsSync(reportDir)).toBe(true)
      return ENTRIES
    }
    const outcome = await runCheck({
      cwd: repo,
      steps: STEPS,
      spawn: fakeSpawn([0, 0, 0]).spawn,
      junit: { dirParent: tempRoot, merge },
    })
    expect(outcome.kind).toBe('passed')
    // At merge time nothing was recorded yet: the list (written next) and
    // the record (written last) both postdate it.
    expect(observations).toEqual([{ recordExistedAtMerge: false }])
    if (outcome.kind !== 'passed') return
    const record = readRecord(recordsDirectory(), outcome.key)
    expect(record?.tests).toEqual({ file: testListName(outcome.key), count: 2 })
    const list = readTestList(recordsDirectory(), record!)
    expect(list?.map((entry) => entry.name)).toEqual(['alpha', 'zeta'])
  })

  // @covers: dev-checks › Full-check records list the tests that ran › Pass with its test list
  test('the renames land the list before the record — the order pinned at the writes (K1)', async () => {
    // The merge callback runs before both writes, so a merge-time observation
    // holds under either order (C3 B1). This observes the writes themselves:
    // both writers finish with fs.renameSync, so the destination basenames'
    // arrival order is the order a concurrent reader between them sees.
    const renames: string[] = []
    const originalRename = fs.renameSync
    fs.renameSync = ((from: string, to: string) => {
      renames.push(path.basename(to))
      return originalRename(from, to)
    }) as typeof fs.renameSync
    let outcome: Awaited<ReturnType<typeof runCheck>>
    try {
      outcome = await runCheck({
        cwd: repo,
        steps: STEPS,
        spawn: fakeSpawn([0, 0, 0]).spawn,
        junit: { dirParent: tempRoot, merge: () => ENTRIES },
      })
    } finally {
      fs.renameSync = originalRename
    }
    expect(outcome.kind).toBe('passed')
    if (outcome.kind !== 'passed') return
    expect(renames).toContain(testListName(outcome.key))
    expect(renames.indexOf(testListName(outcome.key))).toBeLessThan(
      renames.indexOf(`${outcome.key}.json`)
    )
  })

  test('the writer sorts the entries it was given', async () => {
    const outcome = await runCheck({
      cwd: repo,
      steps: STEPS,
      spawn: fakeSpawn([0, 0, 0]).spawn,
      junit: { dirParent: tempRoot, merge: () => ENTRIES },
    })
    if (outcome.kind !== 'passed') throw new Error('expected a pass')
    const record = readRecord(recordsDirectory(), outcome.key)
    expect(readTestList(recordsDirectory(), record!)).toEqual(
      [...ENTRIES].sort((a, b) => (a.file < b.file ? -1 : 1))
    )
  })

  test('an unmergeable report set records the pass without a list, loudly', async () => {
    const errors: string[] = []
    const originalError = console.error
    console.error = (line: unknown) => {
      errors.push(String(line))
    }
    let outcome: Awaited<ReturnType<typeof runCheck>>
    try {
      outcome = await runCheck({
        cwd: repo,
        steps: STEPS,
        spawn: fakeSpawn([0, 0, 0]).spawn,
        junit: { dirParent: tempRoot, merge: () => null },
      })
    } finally {
      console.error = originalError
    }
    expect(outcome.kind).toBe('passed')
    if (outcome.kind !== 'passed') return
    expect(errors.join('\n')).toMatch(/without a test list/)
    const record = readRecord(recordsDirectory(), outcome.key)
    expect(record).not.toBeNull()
    expect(record?.tests).toBeUndefined()
    expect(fs.existsSync(path.join(recordsDirectory(), `${outcome.key}.tests.json.gz`))).toBe(false)
  })

  test('a failed step leaves neither record, list, nor report directory (K3)', async () => {
    const outcome = await runCheck({
      cwd: repo,
      steps: STEPS,
      spawn: fakeSpawn([0, 1]).spawn,
      junit: { dirParent: tempRoot, merge: () => [] },
    })
    expect(outcome.kind).toBe('failed')
    expect(recordJsonNames(recordsDirectory())).toEqual([])
    expect(fs.existsSync(path.join(recordsDirectory(), `${'a'.repeat(64)}.tests.json.gz`))).toBe(false)
    expect(fs.readdirSync(tempRoot).filter((name) => name.startsWith('kawai-check-reports-'))).toEqual([])
  })

  test('the steps see KAWAI_TEST_JUNIT_DIR only when the wiring is on', async () => {
    const fake = fakeSpawn([0, 0, 0])
    await runCheck({ cwd: repo, steps: STEPS, spawn: fake.spawn, junit: { dirParent: tempRoot, merge: () => ENTRIES } })
    const env = fake.spawns[0]?.env
    expect(env?.KAWAI_TEST_JUNIT_DIR).toStartWith(tempRoot)
    const unwired = fakeSpawn([0, 0, 0])
    await runCheck({ cwd: repo, steps: STEPS, spawn: unwired.spawn, junit: null })
    expect(unwired.spawns[0]?.env.KAWAI_TEST_JUNIT_DIR).toBeUndefined()
  })

  test('a reused recorded pass writes no report directory', async () => {
    const first = await runCheck({
      cwd: repo,
      steps: STEPS,
      spawn: fakeSpawn([0, 0, 0]).spawn,
      junit: { dirParent: tempRoot, merge: () => ENTRIES },
    })
    expect(first.kind).toBe('passed')
    const before = fs.readdirSync(tempRoot)
    const second = await runCheck({
      cwd: repo,
      steps: STEPS,
      spawn: fakeSpawn([0, 0, 0]).spawn,
      junit: { dirParent: tempRoot, merge: () => ENTRIES },
    })
    expect(second.kind).toBe('recorded')
    expect(fs.readdirSync(tempRoot)).toEqual(before)
  })
})
