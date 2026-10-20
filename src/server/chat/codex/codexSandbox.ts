// The one Codex sandbox (codex-chat-sessions design D5): every thread starts
// and resumes under `workspace-write`, the repository's git common directory
// is the extra writable root — so a commit from a linked worktree, whose
// objects and refs live in the main checkout's `.git`, needs no escalation —
// and network access follows the profile (on unless it says `network:
// false`). The sandbox never depends on the approval policy: the policy only
// decides who answers an escalation (codexRequests.ts).
import path from 'node:path'
import { runGitAsync } from '../../git/gitCommand'

/** The thread parameters the sandbox contributes. */
export interface CodexSandboxParams {
  sandbox: 'workspace-write'
  config: Record<string, unknown>
}

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

/**
 * The sandbox for one thread start or resume. The writable root list is
 * omitted outside a repository (the project directory is writable under
 * `workspace-write` already); Kawai always sends its own set, so a resumed
 * thread's accumulated roots never decide anything.
 */
export function codexSandbox(input: { network: boolean; commonDir: string | null }): CodexSandboxParams {
  return {
    sandbox: 'workspace-write',
    config: {
      ...(input.commonDir ? { 'sandbox_workspace_write.writable_roots': [input.commonDir] } : {}),
      'sandbox_workspace_write.network_access': input.network,
    },
  }
}
