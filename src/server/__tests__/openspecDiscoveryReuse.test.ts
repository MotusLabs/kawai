// openspecDiscoveryReuse.test.ts - Tables RD (the pure reuse decision) and
// DO (discovery outcomes through refreshRepositoryOpenSpec with an injected
// runner, cache, fingerprint, and clock) from bounded-openspec-discovery
// design.md, plus the coordinator's per-pass log line (A6).
import { describe, expect, test } from 'bun:test'
import type { WorkspaceRepository, WorktreeOpenSpecState } from '../../shared/workspace'
import type { ResolvedGitDirs } from '../git/repositoryResolution'
import {
  refreshRepositoryOpenSpec,
  type OpenspecCommandResult,
  type OpenspecCommandRunner,
} from '../workspace/openspecDiscovery'
import {
  OPENSPEC_REUSE_MAX_AGE_MS,
  OpenSpecDiscoveryCache,
  shouldRunOpenSpec,
  type CachedOpenSpecDiscovery,
} from '../workspace/openspecDiscoveryCache'
import {
  WorkspaceCoordinator,
  type OpenSpecPassLog,
  type OpenSpecRefreshContext,
} from '../workspace/workspaceCoordinator'

const T0 = 1_800_000_000_000
const STATE: WorktreeOpenSpecState = { changes: [{ name: 'alpha', completedTasks: 1, totalTasks: 3 }], stale: false }
const ENTRY: CachedOpenSpecDiscovery = { fingerprint: 'fp-a', discoveredAt: T0, state: STATE }

describe('shouldRunOpenSpec RD table', () => {
  const rows: Array<{
    id: string
    previous: CachedOpenSpecDiscovery | undefined
    fingerprint: string | null
    age: number
    run: boolean
  }> = [
    { id: 'RD1', previous: undefined, fingerprint: 'fp-a', age: 0, run: true },
    { id: 'RD1', previous: undefined, fingerprint: null, age: 0, run: true },
    { id: 'RD2', previous: ENTRY, fingerprint: null, age: 1_000, run: true },
    { id: 'RD3', previous: ENTRY, fingerprint: 'fp-b', age: 1_000, run: true },
    { id: 'RD3', previous: ENTRY, fingerprint: 'fp-b', age: OPENSPEC_REUSE_MAX_AGE_MS, run: true },
    { id: 'RD4', previous: ENTRY, fingerprint: 'fp-a', age: 0, run: false },
    { id: 'RD4', previous: ENTRY, fingerprint: 'fp-a', age: OPENSPEC_REUSE_MAX_AGE_MS - 1, run: false },
    { id: 'RD5', previous: ENTRY, fingerprint: 'fp-a', age: OPENSPEC_REUSE_MAX_AGE_MS, run: true },
    { id: 'RD5', previous: ENTRY, fingerprint: 'fp-a', age: OPENSPEC_REUSE_MAX_AGE_MS * 3, run: true },
  ]
  for (const row of rows) {
    test(`${row.id}: previous ${row.previous ? 'entry' : 'none'}, fingerprint ${row.fingerprint ?? 'null'}, age ${row.age} ms -> ${row.run ? 'run' : 'reuse'}`, () => {
      expect(shouldRunOpenSpec(row.previous, row.fingerprint, T0 + row.age)).toBe(row.run)
    })
  }

  // @covers: openspec-visibility › Reuse unchanged OpenSpec discovery results › The result is old
  test('RD5: a result exactly 10 minutes old is rediscovered even when the fingerprint matches', () => {
    expect(OPENSPEC_REUSE_MAX_AGE_MS).toBe(600_000)
    expect(shouldRunOpenSpec(ENTRY, 'fp-a', T0 + 600_000)).toBe(true)
    expect(shouldRunOpenSpec(ENTRY, 'fp-a', T0 + 599_999)).toBe(false)
  })
})

function repository(paths: string[]): WorkspaceRepository {
  return {
    id: '/repo/.git',
    name: 'repo',
    commonDir: '/repo/.git',
    worktrees: paths.map((worktreePath, index) => ({
      id: `/repo/.git::${worktreePath}`,
      repositoryId: '/repo/.git',
      path: worktreePath,
      headRevision: 'abc1234',
      detached: false,
      isMain: index === 0,
      dirty: false,
      openspec: { changes: [], stale: false },
    })),
    branches: [],
    stale: false,
  }
}

function okPayload(completed: number): OpenspecCommandResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: JSON.stringify({ changes: [{ name: 'alpha', completedTasks: completed, totalTasks: 3 }] }),
    stderr: '',
  }
}

/** A controllable world: fingerprints per path, a clock, and a scripted runner. */
function harness() {
  const fingerprints = new Map<string, string | null>([['/repo', 'fp-1']])
  let now = T0
  const calls: string[] = []
  let next: (cwd: string) => Promise<OpenspecCommandResult> = async () => okPayload(1)
  const runner: OpenspecCommandRunner = async ({ cwd }) => {
    calls.push(cwd)
    return next(cwd)
  }
  const cache = new OpenSpecDiscoveryCache()
  const options = {
    runner,
    cache,
    fingerprint: async (worktreePath: string) => fingerprints.get(worktreePath) ?? null,
    now: () => now,
  }
  return {
    fingerprints,
    calls,
    cache,
    options,
    advance: (ms: number) => {
      now += ms
    },
    script: (fn: (cwd: string) => Promise<OpenspecCommandResult>) => {
      next = fn
    },
  }
}

describe('refreshRepositoryOpenSpec DO table', () => {
  test('DO1: first discovery succeeds: one run, the entry stored with the pre-run fingerprint, the result published', async () => {
    const h = harness()
    const refreshed = await refreshRepositoryOpenSpec(repository(['/repo']), undefined, h.options)
    expect(h.calls).toEqual(['/repo'])
    expect(h.cache.get('/repo')).toEqual({ fingerprint: 'fp-1', discoveredAt: T0, state: refreshed.worktrees[0].openspec })
    expect(refreshed.worktrees[0].openspec.changes[0]?.completedTasks).toBe(1)
    expect(h.cache.takeCounts()).toEqual({ runs: 1, reused: 0 })
  })

  // @covers: openspec-visibility › Reuse unchanged OpenSpec discovery results › Nothing changed
  test('DO2: a second pass two minutes later with an unchanged fingerprint runs nothing and publishes the cached result', async () => {
    const h = harness()
    const first = await refreshRepositoryOpenSpec(repository(['/repo']), undefined, h.options)
    h.cache.takeCounts()
    h.advance(120_000)
    const second = await refreshRepositoryOpenSpec(repository(['/repo']), [first], h.options)
    expect(h.calls).toEqual(['/repo'])
    expect(second.worktrees[0].openspec).toEqual(first.worktrees[0].openspec)
    expect(h.cache.takeCounts()).toEqual({ runs: 0, reused: 1 })
  })

  // @covers: openspec-visibility › Reuse unchanged OpenSpec discovery results › A task is checked off
  test('DO2b: a changed fingerprint runs again and publishes the new progress', async () => {
    const h = harness()
    const first = await refreshRepositoryOpenSpec(repository(['/repo']), undefined, h.options)
    h.fingerprints.set('/repo', 'fp-2')
    h.script(async () => okPayload(2))
    const second = await refreshRepositoryOpenSpec(repository(['/repo']), [first], h.options)
    expect(h.calls).toHaveLength(2)
    expect(second.worktrees[0].openspec.changes[0]?.completedTasks).toBe(2)
    expect(h.cache.get('/repo')?.fingerprint).toBe('fp-2')
  })

  test('DO3: a failed run after a cached success removes the entry and publishes last-valid values marked stale', async () => {
    const h = harness()
    const first = await refreshRepositoryOpenSpec(repository(['/repo']), undefined, h.options)
    h.fingerprints.set('/repo', 'fp-2')
    h.script(async () => ({ ok: false, exitCode: null, stdout: '', stderr: '' }))
    const second = await refreshRepositoryOpenSpec(repository(['/repo']), [first], h.options)
    expect(h.calls).toHaveLength(2)
    expect(h.cache.get('/repo')).toBeUndefined()
    expect(second.worktrees[0].openspec).toEqual({ ...first.worktrees[0].openspec, stale: true, error: 'openspec timed out' })
  })

  // @covers: openspec-visibility › Reuse unchanged OpenSpec discovery results › The last run failed
  test('DO4: the pass after a failure runs again with an unchanged fingerprint and stores the success', async () => {
    const h = harness()
    const first = await refreshRepositoryOpenSpec(repository(['/repo']), undefined, h.options)
    h.fingerprints.set('/repo', 'fp-2')
    h.script(async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'boom' }))
    const failed = await refreshRepositoryOpenSpec(repository(['/repo']), [first], h.options)
    h.script(async () => okPayload(3))
    h.advance(1_000)
    const recovered = await refreshRepositoryOpenSpec(repository(['/repo']), [failed], h.options)
    expect(h.calls).toHaveLength(3)
    expect(recovered.worktrees[0].openspec).toEqual({ changes: [{ name: 'alpha', completedTasks: 3, totalTasks: 3 }], stale: false })
    expect(h.cache.get('/repo')).toEqual({ fingerprint: 'fp-2', discoveredAt: T0 + 1_000, state: recovered.worktrees[0].openspec })
  })

  test('DO5: a missing-root payload is stored as an empty, non-stale result', async () => {
    const h = harness()
    h.script(async () => ({
      ok: false,
      exitCode: 1,
      stdout: JSON.stringify({ changes: [], root: null, status: [{ severity: 'error', code: 'no_openspec_root' }] }),
      stderr: '',
    }))
    const refreshed = await refreshRepositoryOpenSpec(repository(['/repo']), undefined, h.options)
    expect(h.calls).toHaveLength(1)
    expect(refreshed.worktrees[0].openspec).toEqual({ changes: [], stale: false })
    expect(h.cache.get('/repo')?.state).toEqual({ changes: [], stale: false })
  })

  test('DO6: a write during the run keeps the pre-run fingerprint, so the next pass reruns', async () => {
    const h = harness()
    h.script(async () => {
      // The tree changes while the CLI is reading it.
      h.fingerprints.set('/repo', 'fp-during')
      return okPayload(1)
    })
    const first = await refreshRepositoryOpenSpec(repository(['/repo']), undefined, h.options)
    expect(h.cache.get('/repo')?.fingerprint).toBe('fp-1')
    h.script(async () => okPayload(2))
    await refreshRepositoryOpenSpec(repository(['/repo']), [first], h.options)
    expect(h.calls).toHaveLength(2)
    expect(h.cache.get('/repo')?.fingerprint).toBe('fp-during')
  })

  test('DO6b: a null fingerprint runs every time and stores nothing', async () => {
    const h = harness()
    h.fingerprints.set('/repo', null)
    const first = await refreshRepositoryOpenSpec(repository(['/repo']), undefined, h.options)
    await refreshRepositoryOpenSpec(repository(['/repo']), [first], h.options)
    expect(h.calls).toHaveLength(2)
    expect(h.cache.get('/repo')).toBeUndefined()
  })

  test('DO7: a worktree the pass no longer lists runs nothing and its entry is dropped by the coordinator', async () => {
    const h = harness()
    h.fingerprints.set('/repo-b', 'fp-b')
    let listed = ['/repo', '/repo-b']
    let captured: OpenSpecRefreshContext | undefined
    const logs: OpenSpecPassLog[] = []
    const coordinator = new WorkspaceCoordinator({
      getSeeds: () => ['/repo'],
      broadcast: () => {},
      now: h.options.now,
      logOpenSpecPass: (fields) => logs.push(fields),
      discovery: {
        resolveSeeds: async () => {
          const dirs: ResolvedGitDirs = { gitDir: '/repo/.git', commonDir: '/repo/.git', toplevel: '/repo' }
          return { repositories: new Map([['/repo/.git', dirs]]), seeds: [{ canonicalPath: '/repo', dirs }] }
        },
        buildRepository: async () => repository(listed),
        refreshOpenSpec: (repo, previous, context) => {
          captured = context
          return refreshRepositoryOpenSpec(repo, previous, {
            ...h.options,
            ...(context ? { cache: context.cache, now: context.now } : {}),
          })
        },
      },
    })
    await coordinator.reconcile()
    expect(captured?.cache.paths().sort()).toEqual(['/repo', '/repo-b'])
    listed = ['/repo']
    await coordinator.reconcile()
    expect(h.calls.sort()).toEqual(['/repo', '/repo-b'])
    expect(captured?.cache.paths()).toEqual(['/repo'])
    // A6: one line per pass with the summed counters.
    expect(logs.map(({ runs, reused, worktrees }) => ({ runs, reused, worktrees }))).toEqual([
      { runs: 2, reused: 0, worktrees: 2 },
      { runs: 0, reused: 1, worktrees: 1 },
    ])
    for (const line of logs) {
      expect(Number.isInteger(line.poolPeak)).toBe(true)
      expect(Number.isInteger(line.durationMs)).toBe(true)
    }
  })
})
