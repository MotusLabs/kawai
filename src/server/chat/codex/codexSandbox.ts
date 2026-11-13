// Git discovery for the one Codex sandbox (codex-chat-sessions design D5):
// every thread starts and resumes under `workspace-write`, and the
// repository's git common directory is the extra writable root, so a commit
// from a linked worktree, whose objects and refs live in the main checkout's
// `.git`, needs no escalation. Kawai keeps this discovery; the adapter hands
// its answer to the package as `writableRoots` (codexRuntimeSupport.ts
// launchFields), and the package composes the sandbox parameters with the
// profile's network access (task-ce05430a R2).
import path from 'node:path'
import { runGitAsync } from '../../git/gitCommand'

/**
 * The absolute git common directory of `cwd`'s repository, or null outside
 * one. `git rev-parse --git-common-dir` answers relative to `cwd` for a main
  * checkout (`.git`) and absolute for a linked worktree; both resolve here.
 * Asynchronous, so a spawn never blocks the server's event loop.
 */
export async function gitCommonDir(cwd: string): Promise<string | null> {
  const result = await runGitAsync(['rev-parse', '--git-common-dir'], { cwd })
  const dir = result.stdout.trim()
  if (!result.ok || dir === '') return null
  return path.resolve(cwd, dir)
}

