// workspaceCoordinator.test.ts - Task 4.1 coverage: the coordinator caches
// snapshots, coalesces concurrent requests, refreshes affected repositories,
// and broadcasts only structural changes.
import { describe, expect, test } from 'bun:test'
import type { ResolvedGitDirs, ResolvedSeed } from '../git/repositoryResolution'
import { refreshRepositoryOpenSpec, type OpenspecCommandRunner } from '../workspace/openspecDiscovery'
import type { OpenSpecPassLog, WorkspaceDiscoveryApi } from '../workspace/workspaceCoordinator'
import { WorkspaceCoordinator } from '../workspace/workspaceCoordinator'
import type {
  WorkspaceRepository,
  WorkspaceSnapshot,
} from '../../shared/workspace'

function repositoryFixture(id: string, overrides: Partial<WorkspaceRepository> = {}): WorkspaceRepository {
  return {
    id,
    name: id,
    commonDir: id,
    worktrees: [
      {
        id: `${id}::${id}-main`,
        repositoryId: id,
        path: `${id}-main`,
        headRevision: 'abc1234',
        detached: false,
        isMain: true,
        dirty: false,
        openspec: { changes: [], stale: false },
      },
    ],
    branches: [],
    stale: false,
    ...overrides,
  }
}

interface Recording {
  resolveCalls: number
  buildCalls: string[]
  openSpecCalls: string[]
  broadcasts: WorkspaceSnapshot[]
}

function createDiscovery(
  repositoriesById: Map<string, WorkspaceRepository>,
  failCommonDirs: Set<string> = new Set()
): { api: WorkspaceDiscoveryApi; recording: Recording } {
  const recording: Recording = {
    resolveCalls: 0,
    buildCalls: [],
    openSpecCalls: [],
    broadcasts: [],
  }
  const api: WorkspaceDiscoveryApi = {
    resolveSeeds: async (seeds) => {
      recording.resolveCalls += 1
      const repoMap = new Map<string, ResolvedGitDirs>()
      const resolvedSeeds: ResolvedSeed[] = []
      for (const seed of seeds) {
        // Seeds look like "/repoA" for repository /repoA/.git.
        const candidate = `${seed}/.git`
        const dirs: ResolvedGitDirs | null = repositoriesById.has(candidate)
          ? { gitDir: candidate, commonDir: candidate, toplevel: seed }
          : null
        resolvedSeeds.push({ canonicalPath: seed, dirs })
        if (dirs && !repoMap.has(dirs.commonDir)) {
          repoMap.set(dirs.commonDir, dirs)
        }
      }
      return { repositories: repoMap, seeds: resolvedSeeds }
    },
    buildRepository: async (commonDir, _dirs, _previous) => {
      recording.buildCalls.push(commonDir)
      if (failCommonDirs.has(commonDir)) {
        throw new Error(`discovery failed for ${commonDir}`)
      }
      return structuredClone(repositoriesById.get(commonDir) ?? repositoryFixture(commonDir))
    },
    refreshOpenSpec: async (repository) => {
      recording.openSpecCalls.push(repository.id)
      return repository
    },
  }
  return { api, recording }
}

function createCoordinator(
  seeds: string[],
  repositoriesById: Map<string, WorkspaceRepository>,
  failCommonDirs?: Set<string>
): { coordinator: WorkspaceCoordinator; recording: Recording } {
  const { api, recording } = createDiscovery(repositoriesById, failCommonDirs)
  const coordinator = new WorkspaceCoordinator({
    getSeeds: () => [...seeds],
    broadcast: (snapshot) => recording.broadcasts.push(snapshot),
    discovery: api,
  })
  return { coordinator, recording }
}

describe('WorkspaceCoordinator', () => {
  test('builds an initial snapshot and broadcasts it once', async () => {
    const repos = new Map([
      ['/repoA/.git', repositoryFixture('/repoA/.git')],
      ['/repoB/.git', repositoryFixture('/repoB/.git')],
    ])
    const { coordinator, recording } = createCoordinator(['/repoA', '/repoB'], repos)

    await coordinator.requestRefresh()

    expect(recording.broadcasts).toHaveLength(1)
    expect(recording.broadcasts[0].repositories.map((repository) => repository.id)).toEqual([
      '/repoA/.git',
      '/repoB/.git',
    ])
    expect(coordinator.getSnapshot()?.repositories).toHaveLength(2)
  })

  test('coalesces concurrent refresh requests into one pass', async () => {
    const repos = new Map([['/repoA/.git', repositoryFixture('/repoA/.git')]])
    const { coordinator, recording } = createCoordinator(['/repoA'], repos)

    await Promise.all([
      coordinator.requestRefresh(),
      coordinator.requestRefresh(),
      coordinator.requestRefresh(),
      coordinator.requestRefresh(),
    ])

    expect(recording.resolveCalls).toBe(1)
    expect(recording.buildCalls).toHaveLength(1)
    expect(recording.broadcasts).toHaveLength(1)
  })

  test('unchanged snapshots are not rebroadcast', async () => {
    const repos = new Map([['/repoA/.git', repositoryFixture('/repoA/.git')]])
    const { coordinator, recording } = createCoordinator(['/repoA'], repos)

    await coordinator.requestRefresh()
    expect(recording.broadcasts).toHaveLength(1)

    // Same seeds, cached repository entry: no structural change, no rebuild.
    await coordinator.requestRefresh()
    expect(recording.broadcasts).toHaveLength(1)
    expect(recording.buildCalls).toHaveLength(1)
  })

  test('rebuilds and rebroadcasts when repository content changes', async () => {
    const repos = new Map([['/repoA/.git', repositoryFixture('/repoA/.git')]])
    const { coordinator, recording } = createCoordinator(['/repoA'], repos)
    await coordinator.requestRefresh()
    expect(recording.broadcasts).toHaveLength(1)

    const changed = repositoryFixture('/repoA/.git', {
      branches: [{ name: 'feat', revision: 'fff000' }],
    })
    repos.set('/repoA/.git', changed)
    await coordinator.reconcile()

    expect(recording.broadcasts).toHaveLength(2)
    expect(recording.broadcasts[1].repositories[0].branches).toHaveLength(1)
  })

  test('scoped refresh rebuilds only the affected repository', async () => {
    const repos = new Map([
      ['/repoA/.git', repositoryFixture('/repoA/.git')],
      ['/repoB/.git', repositoryFixture('/repoB/.git')],
    ])
    const { coordinator, recording } = createCoordinator(['/repoA', '/repoB'], repos)
    await coordinator.requestRefresh()
    recording.buildCalls.length = 0

    await coordinator.refreshPaths(['/repoA/.git-main/src'])

    expect(recording.buildCalls).toEqual(['/repoA/.git'])
    // No structural change: no rebroadcast.
    expect(recording.broadcasts).toHaveLength(1)
  })

  test('isolates per-repository discovery failures', async () => {
    const repos = new Map([
      ['/repoA/.git', repositoryFixture('/repoA/.git')],
      ['/repoB/.git', repositoryFixture('/repoB/.git')],
    ])
    const { coordinator, recording } = createCoordinator(
      ['/repoA', '/repoB'],
      repos,
      new Set(['/repoB/.git'])
    )

    await coordinator.requestRefresh()

    // repoA succeeded despite repoB throwing; snapshot holds repoA only.
    expect(recording.buildCalls).toContain('/repoA/.git')
    expect(coordinator.getSnapshot()?.repositories.map((r) => r.id)).toEqual(['/repoA/.git'])
    expect(coordinator.getLastError()).toBe('discovery failed for /repoB/.git')
  })

  test('retains last-valid entry marked stale when a repository starts failing', async () => {
    const repos = new Map([['/repoA/.git', repositoryFixture('/repoA/.git')]])
    const failures = new Set<string>()
    const { coordinator } = createCoordinator(['/repoA'], repos, failures)
    await coordinator.requestRefresh()
    expect(coordinator.getSnapshot()?.repositories[0].stale).toBe(false)

    failures.add('/repoA/.git')
    await coordinator.reconcile()
    const repository = coordinator.getSnapshot()?.repositories[0]
    expect(repository?.stale).toBe(true)
    expect(repository?.worktrees).toHaveLength(1)
  })

  test('new seed path discovers its repository without rebuilding others', async () => {
    const repos = new Map([
      ['/repoA/.git', repositoryFixture('/repoA/.git')],
      ['/repoB/.git', repositoryFixture('/repoB/.git')],
    ])
    const seeds = ['/repoA']
    const { coordinator, recording } = createCoordinator(seeds, repos)
    await coordinator.requestRefresh()
    const buildsAfterFirst = recording.buildCalls.length

    seeds.push('/repoB')
    await coordinator.requestRefresh()

    // repoA's seed set is unchanged -> cache hit; only repoB was built.
    expect(recording.buildCalls.slice(buildsAfterFirst)).toEqual(['/repoB/.git'])
    expect(coordinator.getSnapshot()?.repositories).toHaveLength(2)
    expect(recording.broadcasts).toHaveLength(2)
  })

  test('removed seed paths drop the repository from the snapshot', async () => {
    const repos = new Map([['/repoA/.git', repositoryFixture('/repoA/.git')]])
    const seeds = ['/repoA']
    const { coordinator, recording } = createCoordinator(seeds, repos)
    await coordinator.requestRefresh()
    expect(coordinator.getSnapshot()?.repositories).toHaveLength(1)

    seeds.length = 0
    await coordinator.requestRefresh()
    expect(coordinator.getSnapshot()?.repositories).toHaveLength(0)
    expect(recording.broadcasts).toHaveLength(2)
  })

  test('on-demand paths participate as seeds', async () => {
    const repos = new Map([['/repoA/.git', repositoryFixture('/repoA/.git')]])
    const { coordinator } = createCoordinator([], repos)

    await coordinator.requestRefresh('/repoA')
    expect(coordinator.getSnapshot()?.repositories).toHaveLength(1)

    coordinator.forgetOnDemandPath('/repoA')
    await coordinator.reconcile()
    expect(coordinator.getSnapshot()?.repositories).toHaveLength(0)
  })
})

// Transient seed-resolution failure: realistic layouts, where the seed path is
// the main worktree's toplevel and the repository identity is `<seed>/.git`.
// OpenSpec state flows through the production refreshRepositoryOpenSpec over
// the coordinator's actual reuse cache, observed via the per-pass log.
describe('WorkspaceCoordinator transient seed retention', () => {
  const REPO_A = '/examples/repoA'
  const REPO_A_GIT = '/examples/repoA/.git'
  const REPO_B = '/examples/repoB'
  const REPO_B_GIT = '/examples/repoB/.git'
  const OPENSPEC_STATE = { changes: [{ name: 'alpha', completedTasks: 1, totalTasks: 2 }], stale: false }

  function realisticRepository(seedPath: string): WorkspaceRepository {
    const commonDir = `${seedPath}/.git`
    return {
      id: commonDir,
      name: seedPath.split('/').pop() ?? seedPath,
      commonDir,
      worktrees: [
        {
          id: `${commonDir}::${seedPath}`,
          repositoryId: commonDir,
          path: seedPath,
          headRevision: 'abc1234',
          detached: false,
          isMain: true,
          dirty: false,
          openspec: { changes: [], stale: false },
        },
      ],
      branches: [],
      stale: false,
    }
  }

  interface ControlledRecording {
    resolveSeedsCalls: string[][]
    buildCalls: Array<{ commonDir: string; dirsIsNull: boolean; previousRepositoryIds: string[] }>
    broadcasts: WorkspaceSnapshot[]
  }

  interface ControlledWorld {
    coordinator: WorkspaceCoordinator
    recording: ControlledRecording
    openSpecRuns: string[]
    logs: OpenSpecPassLog[]
    seeds: string[]
    failAllResolutions: () => void
    resolveNormally: () => void
    healBuilds: () => void
    failBuildsFor: (commonDirs: string[]) => void
  }

  function createWorld(initialSeeds: string[]): ControlledWorld {
    const recording: ControlledRecording = { resolveSeedsCalls: [], buildCalls: [], broadcasts: [] }
    const seeds = [...initialSeeds]
    const repositories = new Map<string, WorkspaceRepository>([
      [REPO_A_GIT, realisticRepository(REPO_A)],
      [REPO_B_GIT, realisticRepository(REPO_B)],
    ])
    let resolveFailures = false
    const failingBuilds = new Set<string>()
    const fingerprints = new Map<string, string>()
    const openSpecRuns: string[] = []
    const logs: OpenSpecPassLog[] = []
    for (const repository of repositories.values()) {
      for (const worktree of repository.worktrees) fingerprints.set(worktree.path, 'fp-1')
    }
    const runner: OpenspecCommandRunner = async ({ cwd }) => {
      openSpecRuns.push(cwd)
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ changes: OPENSPEC_STATE.changes }),
        stderr: '',
      }
    }
    const api: WorkspaceDiscoveryApi = {
      resolveSeeds: async (requested) => {
        recording.resolveSeedsCalls.push([...requested])
        for (const seed of requested) {
          if (!seed.startsWith('/examples/')) throw new Error(`unexpected seed: ${seed}`)
        }
        const repoMap = new Map<string, ResolvedGitDirs>()
        const resolvedSeeds: ResolvedSeed[] = requested.map((seed) => {
          const commonDir = `${seed}/.git`
          const dirs: ResolvedGitDirs | null =
            !resolveFailures && repositories.has(commonDir)
              ? { gitDir: commonDir, commonDir, toplevel: seed }
              : null
          if (dirs) repoMap.set(commonDir, dirs)
          return { canonicalPath: seed, dirs }
        })
        return { repositories: repoMap, seeds: resolvedSeeds }
      },
      buildRepository: async (commonDir, dirs, previous) => {
        recording.buildCalls.push({
          commonDir,
          dirsIsNull: dirs === null,
          previousRepositoryIds: (previous?.repositories ?? []).map((repository) => repository.id),
        })
        if (failingBuilds.has(commonDir)) throw new Error(`git discovery failed for ${commonDir}`)
        const built = repositories.get(commonDir)
        if (!built) throw new Error(`unexpected build call for ${commonDir}`)
        return structuredClone(built)
      },
      refreshOpenSpec: (repository, previous, context) =>
        refreshRepositoryOpenSpec(repository, previous, {
          runner,
          ...(context ? { cache: context.cache, now: context.now } : {}),
          fingerprint: async (worktreePath) => fingerprints.get(worktreePath) ?? null,
        }),
    }
    const coordinator = new WorkspaceCoordinator({
      getSeeds: () => [...seeds],
      broadcast: (snapshot) => recording.broadcasts.push(snapshot),
      discovery: api,
      now: () => 1_800_000_000_000,
      logOpenSpecPass: (fields) => logs.push(fields),
    })
    return {
      coordinator,
      recording,
      openSpecRuns,
      logs,
      seeds,
      failAllResolutions: () => {
        resolveFailures = true
      },
      resolveNormally: () => {
        resolveFailures = false
      },
      healBuilds: () => {
        failingBuilds.clear()
      },
      failBuildsFor: (commonDirs: string[]) => {
        for (const commonDir of commonDirs) failingBuilds.add(commonDir)
      },
    }
  }

  // @covers: workspace-navigation › Automatically synchronize workspace metadata › Discovery temporarily fails
  test('carries every unresolved seed to its owner and stale-publishes the failed rebuild', async () => {
    const world = createWorld([REPO_A])
    await world.coordinator.requestRefresh()
    expect(world.recording.resolveSeedsCalls).toEqual([['/examples/repoA']])
    expect(world.recording.buildCalls).toEqual([
      { commonDir: REPO_A_GIT, dirsIsNull: false, previousRepositoryIds: [] },
    ])

    world.failAllResolutions()
    world.failBuildsFor([REPO_A_GIT])
    await world.coordinator.reconcile()

    // The carried seed rebuilt the repository through the existing path with
    // null dirs and the last snapshot as previous; the failure published the
    // cached entry marked stale with its error, worktrees intact.
    expect(world.recording.buildCalls[1]).toEqual({
      commonDir: REPO_A_GIT,
      dirsIsNull: true,
      previousRepositoryIds: [REPO_A_GIT],
    })
    const repository = world.coordinator.getSnapshot()?.repositories[0]
    expect(repository?.id).toBe(REPO_A_GIT)
    expect(repository?.stale).toBe(true)
    expect(repository?.error).toBe('git discovery failed for /examples/repoA/.git')
    expect(repository?.worktrees.map((worktree) => worktree.path)).toEqual([REPO_A])
    expect(world.coordinator.getLastError()).toBe('git discovery failed for /examples/repoA/.git')
  })

  // @covers: workspace-navigation › Automatically synchronize workspace metadata › Discovery temporarily fails
  test('a failing repository never blocks an unrelated one, and recovery clears the stale state', async () => {
    const world = createWorld([REPO_A, REPO_B])
    await world.coordinator.requestRefresh()
    expect(world.logs.at(-1)).toMatchObject({ runs: 2, reused: 0, worktrees: 2 })
    expect(world.openSpecRuns).toHaveLength(2)

    world.failAllResolutions()
    world.failBuildsFor([REPO_A_GIT])
    await world.coordinator.reconcile()

    const staleById = new Map(
      (world.coordinator.getSnapshot()?.repositories ?? []).map((entry) => [entry.id, entry])
    )
    expect(staleById.get(REPO_A_GIT)?.stale).toBe(true)
    expect(staleById.get(REPO_B_GIT)?.stale).toBe(false)
    // repoB still refreshed while repoA failed: its OpenSpec result came from
    // the reuse cache, and repoA's listed worktree kept its cache entry.
    expect(world.logs.at(-1)).toMatchObject({ runs: 0, reused: 1, worktrees: 2 })

    world.resolveNormally()
    world.healBuilds()
    await world.coordinator.reconcile()
    const recovered = new Map(
      (world.coordinator.getSnapshot()?.repositories ?? []).map((entry) => [entry.id, entry])
    )
    expect(recovered.get(REPO_A_GIT)?.stale).toBe(false)
    expect(recovered.get(REPO_A_GIT)?.error).toBeUndefined()
    expect(recovered.get(REPO_A_GIT)?.worktrees[0]?.openspec).toEqual(OPENSPEC_STATE)
    // The failure episode never re-ran OpenSpec discovery: both worktrees
    // reused their retained cache entries through the stale and recovery passes.
    expect(world.logs.at(-1)).toMatchObject({ runs: 0, reused: 2, worktrees: 2 })
    expect(world.openSpecRuns).toHaveLength(2)
  })

  // @covers: workspace-navigation › Automatically synchronize workspace metadata › Discovery temporarily fails
  test('keeps the repository listed without a rebuild when its seed fails on an ordinary pass', async () => {
    const world = createWorld([REPO_A])
    await world.coordinator.requestRefresh()
    expect(world.recording.buildCalls).toHaveLength(1)

    world.failAllResolutions()
    await world.coordinator.requestRefresh()

    // The carried seed kept the cache hit: no rebuild, no broadcast, last
    // valid entry still listed fresh, reuse cache intact.
    expect(world.recording.buildCalls).toHaveLength(1)
    const repository = world.coordinator.getSnapshot()?.repositories[0]
    expect(repository?.id).toBe(REPO_A_GIT)
    expect(repository?.stale).toBe(false)
    expect(world.recording.broadcasts).toHaveLength(1)
    expect(world.logs.at(-1)).toMatchObject({ runs: 0, reused: 0, worktrees: 1 })
  })

  test('removing the final seed still drops the repository and its OpenSpec cache entry', async () => {
    const world = createWorld([REPO_A, REPO_B])
    await world.coordinator.requestRefresh()
    expect(world.openSpecRuns).toHaveLength(2)

    world.seeds.splice(world.seeds.indexOf(REPO_A), 1)
    await world.coordinator.requestRefresh()

    expect(world.coordinator.getSnapshot()?.repositories.map((entry) => entry.id)).toEqual([REPO_B_GIT])
    expect(world.logs.at(-1)).toMatchObject({ runs: 0, reused: 0, worktrees: 1 })

    // Returning the seed rebuilds the repository and OpenSpec discovery runs
    // again for it: removal evicted the cache entry instead of keeping a ghost.
    world.seeds.push(REPO_A)
    await world.coordinator.reconcile()
    expect(world.coordinator.getSnapshot()?.repositories.map((entry) => entry.id)).toEqual([
      REPO_A_GIT,
      REPO_B_GIT,
    ])
    expect(world.logs.at(-1)).toMatchObject({ runs: 1, reused: 1, worktrees: 2 })
    expect(world.openSpecRuns).toHaveLength(3)
    expect(world.openSpecRuns.at(-1)).toBe(REPO_A)
  })

  // @covers: workspace-navigation › Automatically synchronize workspace metadata › Discovery temporarily fails
  test('carries the seed through a scoped refresh during resolution failure and rebuilds only the scoped owner', async () => {
    const world = createWorld([REPO_A, REPO_B])
    await world.coordinator.requestRefresh()
    world.recording.buildCalls.length = 0

    world.failAllResolutions()
    world.failBuildsFor([REPO_A_GIT])
    await world.coordinator.refreshPaths([`${REPO_A}/src/app.ts`])

    expect(world.recording.buildCalls).toEqual([
      {
        commonDir: REPO_A_GIT,
        dirsIsNull: true,
        previousRepositoryIds: [REPO_A_GIT, REPO_B_GIT],
      },
    ])
    const byId = new Map(
      (world.coordinator.getSnapshot()?.repositories ?? []).map((entry) => [entry.id, entry])
    )
    expect(byId.get(REPO_A_GIT)?.stale).toBe(true)
    expect(byId.get(REPO_B_GIT)?.stale).toBe(false)
    expect(byId.get(REPO_B_GIT)?.worktrees[0]?.openspec).toEqual(OPENSPEC_STATE)
    expect(world.logs.at(-1)).toMatchObject({ runs: 0, reused: 0, worktrees: 2 })
  })
})
