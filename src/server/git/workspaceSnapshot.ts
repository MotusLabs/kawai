// workspaceSnapshot.ts - Assemble deterministic WorkspaceSnapshot values from
// live, hibernating, recent-history, and on-demand project-path seeds.
// Per-repository failures are isolated: a failed refresh keeps the previous
// entry with stale=true instead of dropping or fabricating data, while
// repositories with no remaining seed paths are dropped.

import path from 'node:path'
import {
  repositoryId,
  worktreeId,
  type WorkspaceRepository,
  type WorkspaceSnapshot,
  type WorkspaceWorktree,
} from '../../shared/workspace'
import {
  resolveSeedRepositories,
  type ResolvedGitDirs,
} from './repositoryResolution'
import { discoverRepository } from './worktreeList'
import { deepestWorktreeMatch, isWorktreeDirty } from './worktreeStatus'

/**
 * Build a full workspace snapshot from seed project paths.
 *
 * Repositories exist in the result when a seed resolves into them, or when an
 * unresolvable seed previously belonged to them (carried forward as stale).
 * Previous repositories whose seeds are all gone are dropped — that is the
 * coordinator's path-removal behavior.
 */
export function buildWorkspaceSnapshot(
  seeds: Iterable<string>,
  previous?: WorkspaceSnapshot | null
): WorkspaceSnapshot {
  const resolved = resolveSeedRepositories(seeds)
  const repositories = new Map<string, WorkspaceRepository>()

  for (const [commonDir, dirs] of resolved.repositories) {
    repositories.set(commonDir, buildRepositorySnapshot(commonDir, dirs, previous))
  }

  if (previous) {
    carryForwardUnresolvedSeeds(resolved.seeds, previous, repositories)
  }

  const ordered = [...repositories.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { repositories: ordered, generatedAt: new Date().toISOString() }
}

function buildRepositorySnapshot(
  commonDir: string,
  dirs: ResolvedGitDirs,
  previous?: WorkspaceSnapshot | null
): WorkspaceRepository {
  const id = repositoryId(commonDir)
  const previousEntry = previous?.repositories.find((repository) => repository.id === id)
  let info
  try {
    info = discoverRepository(commonDir)
  } catch {
    info = null
  }
  if (!info) {
    // Isolate the failure: keep the last valid entry marked stale, or emit a
    // minimal placeholder when the repository was never discovered before.
    if (previousEntry) {
      return { ...previousEntry, stale: true, error: 'Git discovery failed' }
    }
    return {
      id,
      name: path.basename(dirs.toplevel) || dirs.toplevel,
      commonDir,
      worktrees: [],
      branches: [],
      stale: true,
      error: 'Git discovery failed',
    }
  }

  const mainWorktree = info.worktrees.find((worktree) => worktree.isMain) ?? info.worktrees[0]
  const worktrees: WorkspaceWorktree[] = info.worktrees
    .map((worktree) => ({
      id: worktreeId(id, worktree.path),
      repositoryId: id,
      path: worktree.path,
      headRevision: worktree.headRevision,
      detached: worktree.detached,
      isMain: worktree.isMain,
      // Prunable (missing-directory) worktrees report clean; they remain
      // listed because git porcelain is the source of truth.
      dirty: isWorktreeDirty(worktree.path),
      openspec: { changes: [], stale: false },
      ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const worktreeIdsByPath = new Map(worktrees.map((worktree) => [worktree.path, worktree.id]))
  const branches = info.branches
    .map((branch) => {
      const assignedWorktreeId = branch.assignedWorktreePath
        ? worktreeIdsByPath.get(branch.assignedWorktreePath)
        : undefined
      return {
        name: branch.name,
        revision: branch.revision,
        ...(assignedWorktreeId !== undefined ? { assignedWorktreeId } : {}),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    id,
    name: path.basename(mainWorktree.path) || mainWorktree.path,
    commonDir,
    worktrees,
    branches,
    stale: false,
  }
}

/**
 * Seeds that no longer resolve to a repository (deleted or unreachable path)
 * still identify their previous owner via deepest-worktree matching; those
 * repositories are carried forward with a stale indication so transient
 * failures never erase a group.
 */
function carryForwardUnresolvedSeeds(
  seeds: Array<{ canonicalPath: string; dirs: ResolvedGitDirs | null }>,
  previous: WorkspaceSnapshot,
  repositories: Map<string, WorkspaceRepository>
): void {
  const worktreeOwners = new Map<string, string>()
  for (const repository of previous.repositories) {
    for (const worktree of repository.worktrees) {
      worktreeOwners.set(worktree.path, repository.id)
    }
  }
  const previousById = new Map(previous.repositories.map((r) => [r.id, r]))

  for (const seed of seeds) {
    if (seed.dirs) continue
    const ownerPath = deepestWorktreeMatch(seed.canonicalPath, worktreeOwners.keys())
    if (!ownerPath) continue
    const ownerId = worktreeOwners.get(ownerPath)
    const previousRepository = ownerId ? previousById.get(ownerId) : undefined
    if (!previousRepository) continue
    if (!repositories.has(previousRepository.id)) {
      repositories.set(previousRepository.id, {
        ...previousRepository,
        stale: true,
        error: 'Git discovery failed',
      })
    }
  }
}
