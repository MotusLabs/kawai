// gitRemote.ts - The remote-facing git operations execution performs
// (plan-execution D6, D13, D14): fetch, ls-remote, fast-forward push
// (a force flag is never passed, so a non-fast-forward push is rejected by
// the remote and the branch is left as it was), worktree add and remove
// (never forced: a dirty or locked worktree refuses), ancestry, and
// `merge-tree --name-only` for the conflict prediction. Every call is an
// argument array over `runGitAsync`, so nothing touches the event loop and
// injection via branch names or paths is not possible. Failures carry the
// argv, exit code, and stderr — the error shape the classifier (D14) reads.
import { runGitAsync, type GitCommandResult } from '../../git/gitCommand'

/** D14: network git calls get 120 seconds; local reads keep runGitAsync's default. */
export const GIT_REMOTE_TIMEOUT_MS = 120_000

/** One git call's failure, shaped for the outcome classifier (D14). */
export interface GitRemoteError {
  argv: string[]
  /** Null = the process did not run to its own exit (timeout or spawn failure). */
  exitCode: number | null
  stderr: string
}

type Failed = { ok: false; error: GitRemoteError }

const failure = (args: string[], result: GitCommandResult): Failed => ({
  ok: false,
  error: { argv: ['git', ...args], exitCode: result.exitCode, stderr: result.stderr },
})

const run = async (args: string[], cwd: string, timeoutMs?: number): Promise<GitCommandResult> =>
  runGitAsync(args, { cwd, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })

/** `git fetch origin [refspec]` in the repository at `cwd` (D6 fetches just the base). */
export async function gitFetch(cwd: string, remote = 'origin', refspec?: string): Promise<{ ok: true } | Failed> {
  const args = refspec === undefined ? ['fetch', remote] : ['fetch', remote, refspec]
  const result = await run(args, cwd, GIT_REMOTE_TIMEOUT_MS)
  return result.ok ? { ok: true } : failure(args, result)
}

/**
 * The head commit of `ref` (a full ref, e.g. `refs/heads/<branch>`) on
 * `origin`, read without a local checkout; null when the ref does not exist
 * there, so provisioning can create the branch.
 */
export async function lsRemoteHead(cwd: string, ref: string, remote = 'origin'): Promise<{ ok: true; sha: string | null } | Failed> {
  const args = ['ls-remote', remote, ref]
  const result = await run(args, cwd, GIT_REMOTE_TIMEOUT_MS)
  if (!result.ok) return failure(args, result)
  const sha = result.stdout.trim().split(/\s+/)[0] ?? ''
  return { ok: true, sha: sha === '' ? null : sha }
}

/**
 * Push `source` (a commit sha or a local ref) to `refs/heads/<branch>` on
 * `origin` as a fast-forward only: no force flag is ever added, so the
 * remote rejects a non-fast-forward push and keeps the branch as it was.
 */
export async function pushToRemote(cwd: string, source: string, branch: string, remote = 'origin'): Promise<{ ok: true } | Failed> {
  const args = ['push', remote, `${source}:refs/heads/${branch}`]
  const result = await run(args, cwd, GIT_REMOTE_TIMEOUT_MS)
  return result.ok ? { ok: true } : failure(args, result)
}

/**
 * Add a worktree at `path`: a new branch `branch` at `start` when `start` is
 * given, else a checkout of the existing local branch `branch`. Never
 * forced: an existing path or an assigned branch refuses.
 */
export async function worktreeAdd(input: { repo: string; path: string; branch: string; start?: string }): Promise<{ ok: true } | Failed> {
  const args = input.start !== undefined
    ? ['worktree', 'add', '-b', input.branch, input.path, input.start]
    : ['worktree', 'add', input.path, input.branch]
  const result = await run(args, input.repo)
  return result.ok ? { ok: true } : failure(args, result)
}

/**
 * Remove the worktree at `path`. Never forced: a worktree with changes or a
 * locked one refuses, so nothing a live session wrote is discarded.
 */
export async function worktreeRemove(repo: string, path: string): Promise<{ ok: true } | Failed> {
  const args = ['worktree', 'remove', path]
  const result = await run(args, repo)
  return result.ok ? { ok: true } : failure(args, result)
}

/** Whether `ancestor` is an ancestor of `descendant` (the up-to-date check). */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<{ ok: true; ancestor: boolean } | Failed> {
  const args = ['merge-base', '--is-ancestor', ancestor, descendant]
  const result = await run(args, cwd)
  if (result.exitCode === 0) return { ok: true, ancestor: true }
  if (result.exitCode === 1) return { ok: true, ancestor: false }
  return failure(args, result)
}

/**
 * `git merge-tree --write-tree --name-only <ours> <theirs>` (the conflict
 * prediction, D13): the merge result's tree and, on a conflict, the
 * conflicting path names. Exit 1 means conflicted files, not a failed call.
 */
export async function mergeTree(cwd: string, ours: string, theirs: string): Promise<{ ok: true; tree: string; conflicts: string[] } | Failed> {
  const args = ['merge-tree', '--write-tree', '--name-only', ours, theirs]
  const result = await run(args, cwd)
  if (!result.ok && result.exitCode !== 1) return failure(args, result)
  // Output: the tree oid, the conflicted names (on conflict), a blank line,
  // then merge messages ("Auto-merging …", "CONFLICT …"). Only the head
  // section before the blank line is data.
  const head = result.stdout.split('\n\n')[0] ?? ''
  const lines = head.split('\n').map(line => line.trim()).filter(line => line !== '')
  const tree = lines[0] ?? ''
  if (tree === '') return failure(args, { ...result, stderr: result.stderr || 'merge-tree printed no tree' })
  return { ok: true, tree, conflicts: lines.slice(1) }
}
