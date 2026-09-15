// workspaceCoordinator.ts - Caches workspace snapshots, coalesces concurrent
// refresh requests (so multiple sessions in one repository do not multiply
// Git/OpenSpec subprocess work), refreshes only affected repositories, and
// broadcasts only structural changes. Kept outside the tmux refresh worker:
// Git/OpenSpec discovery is slower and changes less often than tmux status.

import {
  type WorkspaceRepository,
  type WorkspaceSnapshot,
} from '../../shared/workspace'
import {
  canonicalizePath,
  resolveSeedRepositories,
  type ResolvedGitDirs,
  type ResolvedSeed,
} from '../git/repositoryResolution'
import { buildRepositorySnapshot } from '../git/workspaceSnapshot'
import { deepestWorktreeMatch } from '../git/worktreeStatus'
import {
  refreshRepositoryOpenSpec,
  type OpenspecCommandRunner,
} from './openspecDiscovery'

export interface WorkspaceDiscoveryApi {
  /** Resolve seed paths to repositories (git rev-parse based). */
  resolveSeeds(seeds: string[]): { repositories: Map<string, ResolvedGitDirs>; seeds: ResolvedSeed[] }
  /** Rebuild one repository entry from its common dir. */
  buildRepository(
    commonDir: string,
    dirs: ResolvedGitDirs | null,
    previous?: WorkspaceSnapshot | null
  ): WorkspaceRepository
  /** Refresh OpenSpec state for one repository entry. */
  refreshOpenSpec(
    repository: WorkspaceRepository,
    previous?: WorkspaceRepository[]
  ): WorkspaceRepository
}

export const defaultDiscoveryApi: WorkspaceDiscoveryApi = {
  resolveSeeds: (seeds) => resolveSeedRepositories(seeds),
  buildRepository: (commonDir, dirs, previous) =>
    buildRepositorySnapshot(commonDir, dirs, previous),
  refreshOpenSpec: (repository, previous) => refreshRepositoryOpenSpec(repository, previous),
}

export interface WorkspaceCoordinatorOptions {
  /** Current seed project paths (live, hibernating, history, on-demand). */
  getSeeds(): string[]
  /** Publish a structurally changed snapshot to connected clients. */
  broadcast(snapshot: WorkspaceSnapshot): void
  discovery?: WorkspaceDiscoveryApi
  openspecRunner?: OpenspecCommandRunner
}

interface RepositoryCacheEntry {
  repository: WorkspaceRepository
  /** Canonical seed paths that resolved into this repository at last build. */
  seedPaths: string[]
}

export class WorkspaceCoordinator {
  private readonly options: WorkspaceCoordinatorOptions
  private readonly discovery: WorkspaceDiscoveryApi
  private snapshot: WorkspaceSnapshot | null = null
  private cache = new Map<string, RepositoryCacheEntry>()
  private refreshing = false
  private pendingPass = false
  private pendingForced = false
  private pendingScopedPaths = new Set<string>()
  private onDemandPaths = new Set<string>()

  constructor(options: WorkspaceCoordinatorOptions) {
    this.options = options
    this.discovery = options.discovery ?? defaultDiscoveryApi
  }

  getSnapshot(): WorkspaceSnapshot | null {
    return this.snapshot
  }

  /** Register an on-demand path (new-session preview); refreshes its repo. */
  async requestRefresh(projectPath?: string): Promise<void> {
    this.pendingPass = true
    if (projectPath) {
      this.onDemandPaths.add(projectPath)
      this.pendingScopedPaths.add(projectPath)
    }
    await this.drainPending()
  }

  /**
   * Full forced reconciliation: rebuild every known repository regardless of
   * seed-set caching, recovering from missed watch events and external
   * branch/worktree changes.
   */
  async reconcile(): Promise<void> {
    this.pendingPass = true
    this.pendingForced = true
    this.pendingScopedPaths.clear()
    await this.drainPending()
  }

  /**
   * Refresh only repositories containing the changed paths (watch events).
   * Coalesced: callers never block on each other's scopes.
   */
  async refreshPaths(paths: string[]): Promise<void> {
    this.pendingPass = true
    for (const path of paths) {
      this.pendingScopedPaths.add(path)
    }
    await this.drainPending()
  }

  /** Drop an on-demand path when its session creation completed or failed. */
  forgetOnDemandPath(projectPath: string): void {
    this.onDemandPaths.delete(projectPath)
  }

  private async drainPending(): Promise<void> {
    if (this.refreshing) {
      // Coalesce concurrent requests: one in-flight rebuild; later scopes
      // merge into the next pass. This is the subprocess-concurrency cap.
      return
    }
    this.refreshing = true
    try {
      // Yield once so concurrently arriving requests register their scopes
      // before the pass snapshot is taken.
      await Promise.resolve()
      let guard = 0
      while ((this.pendingPass || this.pendingScopedPaths.size > 0) && guard < 10) {
        guard += 1
        const forced = this.pendingForced
        const scopedPaths = [...this.pendingScopedPaths]
        this.pendingPass = false
        this.pendingForced = false
        this.pendingScopedPaths.clear()
        try {
          this.runPass(forced, scopedPaths)
        } catch (error) {
          // A failed pass keeps the last snapshot; reconciliation retries.
          this.lastError = error instanceof Error ? error.message : String(error)
        }
      }
    } finally {
      this.refreshing = false
    }
  }

  private lastError: string | null = null

  getLastError(): string | null {
    return this.lastError
  }

  private runPass(forceFull: boolean, scopedPaths: string[]): void {
    this.lastError = null
    const seeds = [...new Set([...this.options.getSeeds(), ...this.onDemandPaths])]
    const resolved = this.discovery.resolveSeeds(seeds)

    // Group resolved seed paths by repository and carry unresolved seeds to
    // their previous owners (stale carry-forward semantics from §2.4).
    const seedPathsByCommonDir = new Map<string, string[]>()
    for (const commonDir of resolved.repositories.keys()) {
      seedPathsByCommonDir.set(commonDir, [])
    }
    const previousWorktreeOwners = new Map<string, string>()
    for (const repository of this.snapshot?.repositories ?? []) {
      for (const worktree of repository.worktrees) {
        previousWorktreeOwners.set(worktree.path, repository.id)
      }
    }
    for (const seed of resolved.seeds) {
      if (seed.dirs) {
        const existing = seedPathsByCommonDir.get(seed.dirs.commonDir)
        if (existing) existing.push(seed.canonicalPath)
        continue
      }
      const ownerPath = deepestWorktreeMatch(seed.canonicalPath, previousWorktreeOwners.keys())
      if (!ownerPath) continue
      const ownerId = previousWorktreeOwners.get(ownerPath)
      if (!ownerId) continue
      const existing = seedPathsByCommonDir.get(ownerId)
      if (existing) existing.push(seed.canonicalPath)
    }

    // Repositories to rebuild this pass: forced (reconciliation), all (no
    // snapshot yet / full refresh), or those affected by scoped paths.
    const affectedCommonDirs = this.resolveScopedOwners(scopedPaths, previousWorktreeOwners)
    const nextRepositories = new Map<string, WorkspaceRepository>()
    const nextCache = new Map<string, RepositoryCacheEntry>()

    for (const [commonDir, seedPaths] of seedPathsByCommonDir) {
      const cached = this.cache.get(commonDir)
      const seedsChanged =
        !cached || !sameSeedSet(cached.seedPaths, seedPaths)
      const mustRebuild =
        this.snapshot === null || forceFull || affectedCommonDirs.has(commonDir) || seedsChanged
      if (!mustRebuild && cached) {
        nextCache.set(commonDir, cached)
        nextRepositories.set(commonDir, cached.repository)
        continue
      }
      try {
        const dirs = resolved.repositories.get(commonDir) ?? null
        let entry = this.discovery.buildRepository(commonDir, dirs, this.snapshot)
        entry = this.discovery.refreshOpenSpec(entry, this.snapshot?.repositories)
        nextCache.set(commonDir, { repository: entry, seedPaths })
        nextRepositories.set(commonDir, entry)
      } catch (error) {
        // Error isolation: one failing repository never blocks the others.
        const message = error instanceof Error ? error.message : String(error)
        this.lastError = message
        if (cached) {
          const staleEntry: WorkspaceRepository = {
            ...cached.repository,
            stale: true,
            error: message,
          }
          nextCache.set(commonDir, { ...cached, repository: staleEntry })
          nextRepositories.set(commonDir, staleEntry)
        }
        // No cached entry: the repository stays absent until discovery works.
      }
    }

    const repositories = [...nextRepositories.values()].sort((a, b) => a.id.localeCompare(b.id))
    const structuralChange =
      this.snapshot === null ||
      JSON.stringify(repositories) !== JSON.stringify(this.snapshot.repositories)

    this.cache = nextCache
    this.snapshot = {
      repositories,
      generatedAt: new Date().toISOString(),
    }
    if (structuralChange) {
      this.options.broadcast(this.snapshot)
    }
  }

  private resolveScopedOwners(
    scopedPaths: string[],
    previousWorktreeOwners: Map<string, string>
  ): Set<string> {
    const owners = new Set<string>()
    const worktreePaths = [...previousWorktreeOwners.keys()]
    for (const scopedPath of scopedPaths) {
      const canonical = canonicalizePath(scopedPath)
      // Scoped paths are usually inside a known worktree; fall back to the
      // repository whose common dir contains the path segment.
      const ownerPath = deepestWorktreeMatch(canonical, worktreePaths)
      if (ownerPath) {
        const ownerId = previousWorktreeOwners.get(ownerPath)
        if (ownerId) owners.add(ownerId)
        continue
      }
      for (const [commonDir] of this.cache) {
        if (canonical.startsWith(commonDir)) owners.add(commonDir)
      }
      // New repository under a watched ancestor: full seed resolution in
      // runPass picks it up; nothing more to do here.
    }
    return owners
  }
}

function sameSeedSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  for (const value of b) {
    if (!setA.has(value)) return false
  }
  return true
}
