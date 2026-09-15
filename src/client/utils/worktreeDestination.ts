// worktreeDestination.ts - Pure helpers for suggesting a create-worktree
// destination (§8.2): a sibling of the repository's main worktree named from
// the repository and a sanitized branch, de-conflicted against every worktree
// path the client knows. The server independently revalidates the destination
// against the real filesystem before running git (§8.3).

/** Reduce a branch name to a safe single path segment. */
export function sanitizeBranchForPath(branch: string): string {
  const sanitized = branch
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || 'worktree'
}

/**
 * Suggest a collision-resistant sibling destination for a new worktree:
 * `<parent-of-main>/<repository>-<sanitized-branch>`, then `-2`, `-3`, …
 * while the candidate matches any known worktree path.
 */
export function suggestWorktreeDestination(
  mainWorktreePath: string,
  repositoryName: string,
  branch: string,
  existingPaths: Iterable<string>
): string {
  const separatorIndex = mainWorktreePath.lastIndexOf('/')
  const parent = separatorIndex > 0 ? mainWorktreePath.slice(0, separatorIndex) : ''
  const prefix = parent === '' ? '' : `${parent}/`
  const base = `${prefix}${sanitizeBranchForPath(repositoryName)}-${sanitizeBranchForPath(branch)}`

  const taken = new Set(existingPaths)
  if (!taken.has(base)) return base
  let counter = 2
  while (taken.has(`${base}-${counter}`)) counter += 1
  return `${base}-${counter}`
}
