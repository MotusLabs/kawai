// changeRegistry.ts - Per-repository OpenSpec change registry with canonical
// source resolution. The registry lists unarchived changes from the main
// worktree's OpenSpec root; for each change, the convention worktree at
// `<main>/.worktrees/<change-name>` is canonical once it exists. A worktree
// with a matching basename outside the convention directory never matches.

import {
  CHANGE_WORKTREES_DIR,
  type ChangeRegistryEntry,
  type WorkspaceRepository,
} from '../../shared/workspace'

/** Convention worktree path for one change name. */
export function conventionWorktreePath(mainWorktreePath: string, changeName: string): string {
  return `${mainWorktreePath}/${CHANGE_WORKTREES_DIR}/${changeName}`
}

/**
 * Resolve the change registry for one repository from its worktrees'
 * OpenSpec states (no subprocesses). Entries are sorted by change name so
 * section order is deterministic. A repository without a main worktree has
 * no registry.
 */
export function resolveChangeRegistry(repository: WorkspaceRepository): ChangeRegistryEntry[] {
  const main = repository.worktrees.find((worktree) => worktree.isMain)
  if (!main) return []

  const worktreeByPath = new Map(repository.worktrees.map((worktree) => [worktree.path, worktree]))

  return [...main.openspec.changes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((seed) => {
      const worktree = worktreeByPath.get(conventionWorktreePath(main.path, seed.name))
      if (!worktree) {
        return { ...seed, source: 'registry' as const }
      }
      const canonical = worktree.openspec.changes.find((change) => change.name === seed.name)
      if (!canonical) {
        return {
          ...seed,
          source: 'registry' as const,
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          missingInWorktree: true,
        }
      }
      return {
        ...canonical,
        source: 'worktree' as const,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
      }
    })
}
