// The check service (independent-verification task 2.3, design D1): the
// submitted result's pending row is already there when submit returns and
// the service settles it — submit, pending, check, stored row, restart —;
// pending checks run one at a time per team, oldest first; a call that does
// not answer records the check unavailable and releases the flight; a row
// that appears during a flight is picked up; another team's tasks never
// feed a comparison; and startup runs every pending row again, once.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { runGit } from '../git/gitCommand'
import { recordsDir, writeRecord } from '../checks/checkRecords'
import { testListName, writeTestList } from '../checks/testLists'
import { schemaDb } from './schemaDb'
import { ResultCheckStore } from '../verification/resultCheckStore'
import { ResultCheckService } from '../verification/resultCheckService'
import { CheckUnavailable, type CheckGit } from '../verification/resultChecks'

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e',
}

interface RepoFixture {
  root: string
  worktree: string
  sha: string
  git: (args: string[], cwd?: string) => ReturnType<typeof runGit>
}

/** One repository with one worktree and one real commit to check. The repo
 * itself is the team: its common dir is the stored team id, so the real
 * repoRootOf resolves it without a seam. */
function makeRepo(at: string): RepoFixture {
  const root = path.join(at, 'repo')
  fs.mkdirSync(root, { recursive: true })
  runGit(['init', '--initial-branch=master', root], { timeoutMs: 10_000 })
  const git = (args: string[], cwd = root) => runGit(args, { cwd, timeoutMs: 10_000, env: COMMIT_ENV })
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  git(['add', '--', 'a.txt'])
  git(['commit', '-m', 'c1'])
  const worktree = path.join(at, 'wt')
  git(['worktree', 'add', '-b', 'feature', worktree])
  return { root, worktree, sha: git(['rev-parse', 'HEAD']).stdout.trim(), git }
}

const teamIdOf = (fixture: RepoFixture) => path.join(fixture.root, '.git')

let tempRoot: string
beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-check-service-')))
})
afterAll(() => { fs.rmSync(tempRoot, { recursive: true, force: true }) })

describe('ResultCheckService over its store', () => {
  let db: Database
  let checks: ResultCheckStore

  beforeEach(() => {
    db = schemaDb()
    checks = new ResultCheckStore(db)
  })

  const pending = (fixture: RepoFixture, resultId: string, extra: Record<string, unknown> = {}) =>
    checks.insertPending({
      teamId: teamIdOf(fixture), taskId: 'task-1', resultId, trigger: 'submit',
      requestedBy: { kind: 'agent', sessionId: 'dev' }, ...extra,
    } as Parameters<ResultCheckStore['insertPending']>[0])

  const sources = (fixture: RepoFixture) => ({
    result: (id: string) => ({ commit: fixture.sha, worktree: fixture.worktree, coverage: null }),
    openTasks: (teamId: string) => [{ id: 'task-1', worktree: fixture.worktree, createdAt: '2026-10-24T00:00:00Z' }],
    listedWorktrees: async (teamId: string) => [fixture.root, fixture.worktree],
  })

  test('a pending row settles done with the facts of its check', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'one'))
    const { check } = pending(fixture, 'result-1')
    const service = new ResultCheckService({ store: checks, sources: sources(fixture) })
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    const stored = checks.get(check.id)
    expect(stored?.status).toBe('done')
    expect(stored?.facts?.version).toBe(1)
    expect(stored?.facts?.commit.sha).toBe(fixture.sha)
  })

  // The production path for the coverage map (independent-verification
  // 3.1): the sources' map reaches the check, whose facts resolve its
  // citations at the commit — found with no list, so run-unknown.
  test('a result carrying a coverage map settles facts that resolve its citations', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'mapped'))
    fs.writeFileSync(path.join(fixture.root, 'src.test.ts'), "test('covers the clause', () => {})\n")
    fixture.git(['add', '--', 'src.test.ts'])
    fixture.git(['commit', '-q', '-m', 'tests'])
    const sha = fixture.git(['rev-parse', 'HEAD']).stdout.trim()
    const { check } = pending(fixture, 'result-mapped')
    const service = new ResultCheckService({
      store: checks,
      sources: {
        ...sources(fixture),
        result: () => ({
          commit: sha, worktree: fixture.worktree,
          coverage: [{ clause: 'The clause', tests: ['`src.test.ts` › `covers the clause`'] }],
        }),
      },
    })
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    const stored = checks.get(check.id)
    expect(stored?.status).toBe('done')
    expect(stored?.facts?.coverage).toEqual([['run-unknown']])
  })

  // The wired reader (independent-verification D7, task 4.3): the check
  // service's real testList resolves the tree's newest usable record, so a
  // citation a seeded record answers reads ran-passed — no injection.
  test('the wired reader answers a citation from the tree\'s recorded list', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'wired'))
    fs.writeFileSync(path.join(fixture.root, 'src.test.ts'), "test('covers the clause', () => {})\n")
    fixture.git(['add', '--', 'src.test.ts'])
    fixture.git(['commit', '-q', '-m', 'tests'])
    const sha = fixture.git(['rev-parse', 'HEAD']).stdout.trim()
    const tree = fixture.git(['rev-parse', `${sha}^{tree}`]).stdout.trim()
    const dir = recordsDir(fixture.root)
    const key = 'c'.repeat(64)
    writeTestList(dir, key, [
      { file: 'src.test.ts', path: 'src.test.ts', name: 'covers the clause', status: 'passed' },
    ])
    writeRecord(dir, {
      key, treeId: tree, bun: '1.4.3', platform: 'linux', arch: 'x64',
      at: new Date().toISOString(), worktree: fixture.root,
      steps: [{ name: 'test', ms: 1000 }],
      tests: { file: testListName(key), count: 1 },
    })
    const { check } = pending(fixture, 'result-wired')
    const service = new ResultCheckService({
      store: checks,
      sources: {
        ...sources(fixture),
        result: () => ({
          commit: sha, worktree: fixture.worktree,
          coverage: [{ clause: 'The clause', tests: ['`src.test.ts` › `covers the clause`'] }],
        }),
      },
    })
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    expect(checks.get(check.id)?.facts?.coverage).toEqual([['ran-passed']])
  })

  test('a pending row whose result is gone is unavailable, with the reason', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'gone'))
    const { check } = pending(fixture, 'result-gone')
    const service = new ResultCheckService({
      store: checks, sources: { ...sources(fixture), result: () => null },
    })
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    const stored = checks.get(check.id)
    expect(stored?.status).toBe('unavailable')
    expect(stored?.reason).toBe('result result-gone is gone')
  })

  test('one check at a time per team; both rows settle', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'serial'))
    const first = pending(fixture, 'result-1').check
    const second = pending(fixture, 'result-2').check
    let active = 0
    let maxActive = 0
    const runner = (): CheckGit => async (args, opts) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active--
      return { ok: true, exitCode: 0, stdout: `${fixture.sha}\n`, stderr: '' }
    }
    const service = new ResultCheckService({ store: checks, sources: sources(fixture), runner })
    service.wake(teamIdOf(fixture))
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    expect(maxActive).toBe(1)
    expect([first, second].map(row => checks.get(row.id)?.status)).toEqual(['done', 'done'])
  })

  // @covers: specs/task-results "Result checks never block or gate"
  test('a call that does not answer: unavailable, and the next check still runs', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'refusing'))
    const first = pending(fixture, 'result-1').check
    const second = pending(fixture, 'result-2').check
    // A CheckGit that throws CheckUnavailable is what the real one does when
    // a call times out or the budget runs out; the raw exitCode-null
    // translation is makeCheckGit's, already covered in resultChecks tests.
    const refusing = (): CheckGit => async () => {
      throw new CheckUnavailable('git rev-parse did not answer')
    }
    const service = new ResultCheckService({ store: checks, sources: sources(fixture), runner: refusing })
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    const stored = checks.get(first.id)
    expect(stored?.status).toBe('unavailable')
    expect(stored?.reason).toContain('did not answer')
    expect(checks.get(second.id)?.status).toBe('unavailable')
    // The flight was released when the budget settled: a new row runs.
    const working = new ResultCheckService({ store: checks, sources: sources(fixture) })
    const third = pending(fixture, 'result-3').check
    working.wake(teamIdOf(fixture))
    await working.quiesce()
    expect(checks.get(third.id)?.status).toBe('done')
  })

  test('a check whose team repository is missing is unavailable', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'missing'))
    pending(fixture, 'result-1')
    const service = new ResultCheckService({
      store: checks, sources: sources(fixture), repoRootOf: () => null,
    })
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    expect(checks.pendingForTeam(teamIdOf(fixture))).toEqual([])
    const stored = checks.allForResult('result-1')[0]
    expect(stored?.status).toBe('unavailable')
    expect(stored?.reason).toBe('the team repository is missing')
  })

  // @covers: specs/task-results "Result checks never block or gate"
  test('startup runs every pending row once, for every team', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'startup'))
    pending(fixture, 'result-1')
    pending(fixture, 'result-2')
    // Another team whose root does not exist: the real repoRootOf reads it
    // as missing, so the seam stays out of this test.
    const otherRoot = path.join(tempRoot, 'startup', 'other')
    const otherTeam = checks.insertPending({
      teamId: path.join(otherRoot, '.git'), taskId: 'task-9', resultId: 'result-9', trigger: 'submit',
      requestedBy: { kind: 'human', sessionId: null },
    }).check
    const service = new ResultCheckService({ store: checks, sources: sources(fixture) })
    service.start()
    await service.quiesce()
    for (const resultId of ['result-1', 'result-2']) {
      const all = checks.allForResult(resultId)
      expect(all).toHaveLength(1)
      expect(all[0]?.status).toBe('done')
    }
    const other = checks.get(otherTeam.id)
    expect(other?.status).toBe('unavailable')
    expect(other?.reason).toBe('the team repository is missing')
  })

  test('a row that appears during a flight settles without a second wake', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'midflight'))
    const teamId = teamIdOf(fixture)
    pending(fixture, 'result-1')
    let firstCallStarted = false
    const runner = (): CheckGit => async (args, opts) => {
      if (!firstCallStarted) {
        firstCallStarted = true
        await new Promise(resolve => setTimeout(resolve, 40))
        // A submit that lands while the flight runs adds its row here.
        checks.insertPending({
          teamId, taskId: 'task-1', resultId: 'result-2', trigger: 'recheck',
          requestedBy: { kind: 'human', sessionId: null },
        })
      }
      return { ok: true, exitCode: 0, stdout: `${fixture.sha}\n`, stderr: '' }
    }
    const service = new ResultCheckService({ store: checks, sources: sources(fixture), runner })
    service.wake(teamId)
    await service.quiesce()
    const all = checks.allForResult('result-2')
    expect(all).toHaveLength(1)
    expect(all[0]?.status).toBe('done')
  })

  test('a settled row tells the composition once, with its team (D12)', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'settled-notify'))
    pending(fixture, 'result-1')
    pending(fixture, 'result-2')
    const told: string[] = []
    const service = new ResultCheckService({
      store: checks, sources: sources(fixture), onSettled: teamId => told.push(teamId),
    })
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    expect(told).toEqual([teamIdOf(fixture), teamIdOf(fixture)])
  })

  test('other open tasks feed the comparison; another team never appears', async () => {
    const fixture = makeRepo(path.join(tempRoot, 'teams'))
    const otherWt = path.join(tempRoot, 'teams', 'other')
    fixture.git(['worktree', 'add', '-b', 'other-task', otherWt])
    fixture.git(['commit', '-q', '--allow-empty', '-m', 'other'], otherWt)
    const { check } = pending(fixture, 'result-1')
    const service = new ResultCheckService({
      store: checks,
      sources: {
        ...sources(fixture),
        listedWorktrees: async () => [fixture.root, fixture.worktree, otherWt],
        openTasks: teamId => teamId === teamIdOf(fixture)
          ? [
              { id: 'task-1', worktree: fixture.worktree, createdAt: '2026-10-24T00:00:00Z' },
              { id: 'task-2', worktree: otherWt, createdAt: '2026-10-24T00:00:01Z' },
            ]
          : [{ id: 'task-9', worktree: otherWt, createdAt: '2026-10-24T00:00:02Z' }],
      },
    })
    service.wake(teamIdOf(fixture))
    await service.quiesce()
    const facts = checks.get(check.id)?.facts
    expect(facts?.branches.compared.map(entry => entry.taskId)).toEqual(['task-2'])
  })
})
