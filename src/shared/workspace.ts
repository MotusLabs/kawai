// workspace.ts - Shared contract for repository/worktree/branch/OpenSpec discovery.
// The workspace snapshot is intentionally separate from the session snapshot:
// Git and OpenSpec discovery are slower and change less often than tmux status,
// and a transient discovery failure must not disrupt terminal refreshes.

/** A local Git branch belonging to a discovered repository. */
export interface WorkspaceBranch {
  /** Local branch short name, e.g. "main". */
  name: string
  /** Full commit revision the branch currently points at. */
  revision: string
  /** Id of the worktree that has this branch checked out, when assigned. */
  assignedWorktreeId?: string
}

/** A single active OpenSpec change discovered inside one worktree. */
export interface OpenSpecChangeSummary {
  /** Change name, e.g. "add-auth". */
  name: string
  /** Workflow status reported by openspec (e.g. "in-progress"). */
  status?: string
  /** Completed task count when the installed openspec reports it. */
  completedTasks?: number
  /** Total task count when the installed openspec reports it. */
  totalTasks?: number
  /** ISO timestamp of the last artifact modification, when available. */
  lastModified?: string
}

/** OpenSpec state discovered from one worktree's own filesystem. */
export interface WorktreeOpenSpecState {
  /** Canonical openspec root path when one resolves inside the worktree. */
  rootPath?: string
  /** Active changes discovered in this worktree only. */
  changes: OpenSpecChangeSummary[]
  /** True when last-valid values are shown because a refresh failed. */
  stale: boolean
  /** Worktree-scoped discovery error message. */
  error?: string
}

/**
 * Directory inside a repository's main worktree where convention worktrees
 * for OpenSpec changes live: `<main>/.worktrees/<change-name>`.
 */
export const CHANGE_WORKTREES_DIR = '.worktrees'

/** Which filesystem copy of a change is authoritative for display. */
export type ChangeSourceKind = 'registry' | 'worktree'

/**
 * A registry change with its canonical source resolved. The registry lists
 * unarchived changes from the repository's main worktree; once the convention
 * worktree exists, that worktree's copy is canonical for status/progress.
 */
export interface ChangeRegistryEntry extends OpenSpecChangeSummary {
  /** Canonical source for status and progress. */
  source: ChangeSourceKind
  /** Convention worktree id, when `.worktrees/<name>` exists. */
  worktreeId?: string
  /** Convention worktree path, when it exists. */
  worktreePath?: string
  /** True when the convention worktree exists but does not contain the change. */
  missingInWorktree?: boolean
}

/** Stable section key for a change section. */
export function changeSectionKey(repositoryId: string, changeName: string): string {
  return `${repositoryId}::change::${changeName}`
}

/**
 * Reserved section keys for the `Workspace` and `Remote` fallback sections,
 * which collapse through the same collapsedSectionIds list as every other
 * section. Structurally unreachable as another section's identity: change
 * keys always embed the `::change::` separator, and worktree ids always
 * start with the repository's canonical common-dir path.
 */
export const FALLBACK_WORKSPACE_SECTION_KEY = 'fallback::workspace'
export const FALLBACK_REMOTE_SECTION_KEY = 'fallback::remote'

/** A Git worktree (main or linked) belonging to a discovered repository. */
export interface WorkspaceWorktree {
  /**
   * Stable id derived from canonical repository identity plus canonical
   * worktree path. Sessions associate to worktrees by this id.
   */
  id: string
  /** Owning repository id. */
  repositoryId: string
  /** Canonical absolute path of the worktree root. */
  path: string
  /** Checked-out local branch name; absent when HEAD is detached. */
  branch?: string
  /** HEAD revision of the worktree. */
  headRevision: string
  /** True when HEAD is not attached to any local branch. */
  detached: boolean
  /** True for the repository's main worktree. */
  isMain: boolean
  /** True when tracked or untracked working-tree changes exist. */
  dirty: boolean
  /** OpenSpec state discovered inside this worktree. */
  openspec: WorktreeOpenSpecState
}

/** A Git repository discovered from known local project paths. */
export interface WorkspaceRepository {
  /** Stable id derived from the canonical common Git directory. */
  id: string
  /** Display name derived from the main worktree directory. */
  name: string
  /** Canonical common Git directory path. */
  commonDir: string
  /** Every worktree belonging to this repository. */
  worktrees: WorkspaceWorktree[]
  /** Local branches (assigned and unassigned). */
  branches: WorkspaceBranch[]
  /**
   * Registry of unarchived changes with canonical sources resolved. Optional
   * so payloads from servers that predate the registry stay valid; treat
   * absent as empty.
   */
  changeRegistry?: ChangeRegistryEntry[]
  /** True when the last successful snapshot is shown after a failed refresh. */
  stale: boolean
  /** Repository-scoped discovery error message. */
  error?: string
}

/** Full workspace state published to clients after a successful discovery pass. */
export interface WorkspaceSnapshot {
  repositories: WorkspaceRepository[]
  /** ISO timestamp of the snapshot generation. */
  generatedAt: string
}

/** Machine-readable failure codes for workspace operations. */
export type WorkspaceErrorCode =
  | 'ERR_WORKSPACE_UNKNOWN_REPOSITORY'
  | 'ERR_WORKSPACE_NO_MAIN_WORKTREE'
  | 'ERR_WORKTREE_UNKNOWN_BRANCH'
  | 'ERR_WORKTREE_BRANCH_ASSIGNED'
  | 'ERR_WORKTREE_DESTINATION_EXISTS'
  | 'ERR_WORKTREE_INVALID_DESTINATION'
  | 'ERR_WORKTREE_CREATE_FAILED'
  | 'ERR_CHANGE_INVALID_NAME'
  | 'ERR_CHANGE_MISSING_ARTIFACTS'
  | 'ERR_CHANGE_SEED_FAILED'

/** Result of a client-requested workspace mutation. */
export type WorkspaceOperationResult =
  | {
      operation: 'create-worktree'
      ok: true
      repositoryId: string
      branch: string
      /** Canonical path of the created worktree. */
      path: string
    }
  | {
      operation: 'create-worktree'
      ok: false
      repositoryId?: string
      branch?: string
      /** Machine-readable failure category when known. */
      code?: WorkspaceErrorCode
      /** Actionable error message shown to the user. */
      error: string
    }
  | {
      operation: 'create-change-worktree'
      ok: true
      repositoryId: string
      /** Change name the worktree was seeded from. */
      change: string
      /** Branch checked out in the new worktree (always the change name). */
      branch: string
      /** Canonical path of the created worktree. */
      path: string
      /** Revision of the seed commit on the new branch. */
      commit: string
      /** True when `.worktrees/` was appended to the worktree's .gitignore. */
      gitignoreUpdated: boolean
    }
  | {
      operation: 'create-change-worktree'
      ok: false
      repositoryId?: string
      change?: string
      /** Machine-readable failure category when known. */
      code?: WorkspaceErrorCode
      /** Actionable error message shown to the user. */
      error: string
    }

/** Stable worktree id from repository identity plus canonical worktree path. */
export function worktreeId(repositoryId: string, worktreePath: string): string {
  return `${repositoryId}::${worktreePath}`
}

/** Repository id from a canonical common Git directory path. */
export function repositoryId(commonDir: string): string {
  return commonDir
}

/** Shortened revision for display of detached-HEAD worktrees. */
export function shortRevision(revision: string): string {
  return revision.slice(0, 7)
}

/**
 * Return the container path that contains `target`, choosing the deepest
 * (longest) match on path boundaries so nested worktrees win over their
 * ancestors. `/repo` never matches `/repo-x`. Pure string matching — paths
 * are expected to be canonical on the server and plain on the client.
 */
export function deepestPathMatch(
  target: string,
  containers: Iterable<string>
): string | null {
  let best: string | null = null
  for (const container of containers) {
    if (container === target || target.startsWith(container + '/')) {
      if (best === null || container.length > best.length) {
        best = container
      }
    }
  }
  return best
}
