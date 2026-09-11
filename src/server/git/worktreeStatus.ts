// worktreeStatus.ts - Bounded dirty-state discovery and deepest-worktree
// path matching. Dirty state reports tracked and untracked changes without
// offering any destructive operation (see workspace-navigation spec).

import { deepestPathMatch } from '../../shared/workspace'
import { runGit } from './gitCommand'

// Only the first byte matters for the dirty flag; keep the bound small so a
// huge working tree cannot inflate discovery memory.
export const DIRTY_STATE_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * True when the worktree has tracked or untracked changes. A failing git
 * status reports dirty=false rather than guessing.
 */
export function isWorktreeDirty(worktreePath: string): boolean {
  const result = runGit(
    ['-C', worktreePath, 'status', '--porcelain'],
    { maxOutputBytes: DIRTY_STATE_MAX_OUTPUT_BYTES }
  )
  if (!result.ok) return false
  return result.stdout.trim().length > 0
}

/**
 * Return the worktree path that contains `target`, choosing the deepest
 * (longest) match on path boundaries so nested worktrees win over their
 * ancestors. `/repo` never matches `/repo-x` or `/repository`.
 */
export function deepestWorktreeMatch(
  target: string,
  worktreePaths: Iterable<string>
): string | null {
  return deepestPathMatch(target, worktreePaths)
}
