// workspaceCoordinator.test.ts - Task 4.1 coverage: the coordinator caches
// snapshots, coalesces concurrent requests, refreshes affected repositories,
// and broadcasts only structural changes.
import { describe, expect, test } from 'bun:test'
import type { ResolvedGitDirs, ResolvedSeed } from '../git/repositoryResolution'
import type { WorkspaceDiscoveryApi } from '../workspace/workspaceCoordinator'
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
    resolveSeeds: (seeds) => {
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
    buildRepository: (commonDir, _dirs, _previous) => {
      recording.buildCalls.push(commonDir)
      if (failCommonDirs.has(commonDir)) {
        throw new Error(`discovery failed for ${commonDir}`)
      }
      return structuredClone(repositoriesById.get(commonDir) ?? repositoryFixture(commonDir))
    },
    refreshOpenSpec: (repository) => {
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
