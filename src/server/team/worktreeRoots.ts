// Worktree identity for team-tasks staffing (design D4/D5). A member's
// current worktree is resolved, never compared verbatim: `worktreeRootOf`
// walks up from its project path to the nearest directory holding `.git` (a
// linked worktree's `.git` file or the main checkout's `.git` directory), so
// an agent that moved into `<worktree>/src` still matches its worktree. Task
// targets are validated against `git worktree list --porcelain` for the
// team's repository and normalized to the listed root, so both sides compare
// as plain strings. The listing is cached briefly and re-read on a miss — a
// worktree added a moment ago is found, a removed one stops validating.
import fs from 'node:fs'
import path from 'node:path'
import { runGitAsync } from '../git/gitCommand'
import { canonicalizePath } from '../git/repositoryResolution'
import { parseWorktreePorcelain } from '../git/worktreeList'

/** The worktree root containing `projectPath`, or its realpath outside any repository. */
export function worktreeRootOf(projectPath: string): string {
  const start = canonicalizePath(projectPath)
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    if (path.dirname(dir) === dir) return start
  }
}

export type WorktreeTarget = { ok: true; root: string } | { ok: false; error: string }

const LIST_TTL_MS = 5_000

export class TeamWorktrees {
  private readonly lists = new Map<string, { at: number; roots: string[] }>()

  constructor(private readonly options: { ttlMs?: number; now?: () => number } = {}) {}

  /** Live worktree roots of a team (its common git dir); [] for a plain directory. */
  async list(teamId: string, fresh = false): Promise<string[]> {
    const now = this.options.now?.() ?? Date.now()
    const cached = this.lists.get(teamId)
    if (!fresh && cached && now - cached.at < (this.options.ttlMs ?? LIST_TTL_MS)) return cached.roots
    const result = await runGitAsync(['--git-dir', teamId, 'worktree', 'list', '--porcelain'])
    // A removed directory lingers as `prunable` until `git worktree prune`;
    // it is not a place an agent can run.
    const roots = result.ok
      ? parseWorktreePorcelain(result.stdout).filter(entry => !entry.prunable && fs.existsSync(entry.path)).map(entry => entry.path)
      : []
    this.lists.set(teamId, { at: now, roots })
    return roots
  }

  /** Normalize a task target to a listed root; any other path is refused by name. */
  async resolveTarget(teamId: string, target: string): Promise<WorktreeTarget> {
    const canonical = canonicalizePath(target)
    if ((await this.list(teamId)).includes(canonical) || (await this.list(teamId, true)).includes(canonical)) {
      return { ok: true, root: canonical }
    }
    return { ok: false, error: `${target} is not a worktree of this team's repository` }
  }

  /**
   * Whether a stored root still exists as a worktree. A cached hit is only
   * trusted while its `.git` entry is still on disk; otherwise the listing
   * is re-read, so a deleted worktree is noticed within the cache window.
   */
  async exists(teamId: string, root: string): Promise<boolean> {
    if ((await this.list(teamId)).includes(root) && fs.existsSync(path.join(root, '.git'))) return true
    return (await this.list(teamId, true)).includes(root)
  }
}
