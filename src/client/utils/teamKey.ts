// The client's key for a team (team-workspace-pages D2): the path every team
// view sends as `teamPath` and keys its store by. A chat anywhere inside a
// discovered repository — its main checkout, a linked worktree, or a
// subdirectory of either — maps to the repository's main checkout, so every
// chat of one team shares one key and one view. A chat outside every
// discovered repository keys by its own directory (a plain-directory team,
// or a repository discovery has not reported yet; the server resolves both).
import type { WorkspaceRepository } from '@shared/workspace'

const trimmed = (value: string) => value.length > 1 ? value.replace(/\/+$/, '') : value

const contains = (root: string, target: string) => target === root || target.startsWith(`${root}/`)

export function teamKeyOf(projectPath: string, repositories: readonly WorkspaceRepository[] | null | undefined): string {
  const target = trimmed(projectPath)
  let best: { repository: WorkspaceRepository; depth: number } | null = null
  for (const repository of repositories ?? []) {
    for (const worktree of repository.worktrees) {
      const root = trimmed(worktree.path)
      if (contains(root, target) && (!best || root.length > best.depth)) best = { repository, depth: root.length }
    }
  }
  if (!best) return target
  // A bare repository has no main worktree; its first worktree path keeps the key stable.
  const main = best.repository.worktrees.find(worktree => worktree.isMain)
    ?? [...best.repository.worktrees].sort((a, b) => a.path.localeCompare(b.path))[0]!
  return trimmed(main.path)
}
