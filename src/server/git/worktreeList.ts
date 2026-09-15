// worktreeList.ts - Parse `git worktree list --porcelain` and
// `git for-each-ref refs/heads` output into repository, worktree,
// local-branch, detached-HEAD, main-worktree, revision, and branch-assignment
// metadata. Git porcelain is the source of truth (handles linked worktrees,
// packed refs, and version-specific layouts better than reading .git files).

import { canonicalizePath } from './repositoryResolution'
import { runGit } from './gitCommand'

export interface GitWorktreeInfo {
  /** Canonical absolute worktree root path. */
  path: string
  /** HEAD revision of the worktree. */
  headRevision: string
  /** Short checked-out branch name; absent when detached. */
  branch?: string
  /** True when HEAD is detached from any branch. */
  detached: boolean
  /** True for the repository's main worktree (first porcelain entry). */
  isMain: boolean
  /** True when git marked the worktree prunable (missing directory). */
  prunable: boolean
  /** True when git marked the worktree locked. */
  locked: boolean
}

export interface GitBranchInfo {
  /** Short local branch name. */
  name: string
  /** Revision the branch points at. */
  revision: string
  /** Canonical path of the worktree that has this branch checked out. */
  assignedWorktreePath?: string
}

export interface GitRepositoryInfo {
  worktrees: GitWorktreeInfo[]
  branches: GitBranchInfo[]
}

/**
 * Parse `git worktree list --porcelain` output. The first entry is the main
 * worktree. Blank lines separate entries; unknown attribute lines are
 * ignored for forward compatibility.
 */
export function parseWorktreePorcelain(output: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  let current: Partial<GitWorktreeInfo> | null = null

  const flush = () => {
    if (current && typeof current.path === 'string' && typeof current.headRevision === 'string') {
      worktrees.push({
        path: current.path,
        headRevision: current.headRevision,
        detached: current.detached === true,
        isMain: worktrees.length === 0,
        prunable: current.prunable === true,
        locked: current.locked === true,
        ...(current.branch !== undefined ? { branch: current.branch } : {}),
      })
    }
    current = null
  }

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: canonicalizePath(line.slice('worktree '.length)) }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) {
      current.headRevision = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'detached') {
      current.detached = true
    } else if (line === 'prunable') {
      current.prunable = true
    } else if (line.startsWith('prunable ')) {
      current.prunable = true
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
    }
    // Bare repositories report "bare"; unknown keys are ignored.
  }
  flush()
  return worktrees
}

/**
 * Parse `git for-each-ref --format=%(objectname) %(refname:short) refs/heads`
 * output into local branch entries.
 */
export function parseForEachRefHeads(output: string): Array<{ name: string; revision: string }> {
  const branches: Array<{ name: string; revision: string }> = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const spaceIndex = line.indexOf(' ')
    if (spaceIndex <= 0) continue
    const revision = line.slice(0, spaceIndex)
    const name = line.slice(spaceIndex + 1).trim()
    if (!/^[0-9a-f]{7,64}$/.test(revision) || !name) continue
    branches.push({ name, revision })
  }
  return branches
}

/**
 * Annotate local branches with the worktree that has each checked out.
 * Multiple worktrees cannot share a branch (git enforces this), but a bare or
 * corrupted state can still produce ambiguous data — first match wins.
 */
export function assignBranches(
  worktrees: GitWorktreeInfo[],
  branches: Array<{ name: string; revision: string }>
): GitBranchInfo[] {
  const byBranch = new Map<string, string>()
  for (const worktree of worktrees) {
    if (worktree.branch && !byBranch.has(worktree.branch)) {
      byBranch.set(worktree.branch, worktree.path)
    }
  }
  return branches.map((branch) => {
    const assignedWorktreePath = byBranch.get(branch.name)
    return assignedWorktreePath
      ? { ...branch, assignedWorktreePath }
      : { name: branch.name, revision: branch.revision }
  })
}

/**
 * Discover all worktrees and local branches of a repository identified by its
 * canonical common Git directory. Returns null when git fails or output is
 * unusable.
 */
export function discoverRepository(commonDir: string): GitRepositoryInfo | null {
  const worktreeResult = runGit(['--git-dir', commonDir, 'worktree', 'list', '--porcelain'])
  if (!worktreeResult.ok) return null
  const worktrees = parseWorktreePorcelain(worktreeResult.stdout)
  if (worktrees.length === 0) return null

  const refResult = runGit([
    '--git-dir',
    commonDir,
    'for-each-ref',
    '--format=%(objectname) %(refname:short)',
    'refs/heads',
  ])
  // A failing ref listing still yields worktrees; branch list stays empty.
  const branches = refResult.ok ? parseForEachRefHeads(refResult.stdout) : []

  return { worktrees, branches: assignBranches(worktrees, branches) }
}
