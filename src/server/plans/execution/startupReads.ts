// startupReads.ts - The real git and gh reads behind startup recovery's
// inspectors (plan-execution D14). InspectorReads' contract: a value is an
// answer (null only when the thing is absent), and a read that failed
// rejects, so its inspection is undecidable and retried under the backoff —
// never mistaken for "absent" or "not done" (integration-candidates review
// F2: a failed ls-remote once read as a missing branch). The git reads keep
// it, and so do the gh reads: a failed `pr list`, `pr view`, or run read
// rejects instead of answering no pull requests, an open one, or attempt 1
// (integration-candidates L3), so a failed read never runs its effect again.
import { runGit } from '../../git/gitCommand'
import { ghPrList, ghPrView, ghRunAttempt } from '../landing/github'
import type { GhCommandOptions } from '../landing/ghCommand'
import { gitFetch, isAncestor, lsRemoteHead } from '../landing/gitRemote'
import type { InspectorReads } from './effectInspectors'

export function startupReads(ghOptions?: GhCommandOptions): InspectorReads {
  return {
    worktree: async (repo, wt) => {
      const listed = await runGit(['worktree', 'list', '--porcelain'], { cwd: repo })
      if (!listed.ok) throw new Error(`the worktrees of ${repo} could not be listed`)
      const present = listed.stdout.split('\n').some(line => line.startsWith('worktree ') && line.slice('worktree '.length) === wt)
      if (!present) return { present: false, head: null }
      const head = await runGit(['rev-parse', 'HEAD'], { cwd: wt })
      if (!head.ok) throw new Error(`the head of the worktree ${wt} could not be read`)
      return { present: true, head: head.stdout.trim() }
    },
    localBranch: async (repo, branch) => {
      const result = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo })
      if (result.ok) return result.stdout.trim()
      // `--verify --quiet` exits 1 with nothing on stderr for a missing ref; anything else is a failed read.
      if (result.exitCode === 1 && result.stderr.trim() === '') return null
      throw new Error(`the branch ${branch} could not be read`)
    },
    remoteHead: async (cwd, ref) => {
      const result = await lsRemoteHead(cwd, ref)
      if (!result.ok) throw new Error(`ls-remote of ${ref} failed`)
      return result.sha
    },
    prList: async (repo, head) => {
      const pulls = await ghPrList(repo, { head, base: '' }, ghOptions)
      if (!pulls.ok) throw new Error(`the pull requests of ${head} could not be listed: ${pulls.error.message}`)
      return pulls.data
    },
    prView: async (repo, pr) => {
      const view = await ghPrView(repo, pr, ghOptions)
      if (!view.ok) throw new Error(`pull request ${pr} could not be read: ${view.error.message}`)
      return view.data
    },
    contains: async (cwd, ref, ancestor, descendant) => {
      if (!(await gitFetch(cwd, 'origin', ref)).ok) throw new Error(`the fetch of ${ref} failed`)
      const result = await isAncestor(cwd, ancestor, descendant)
      if (!result.ok) throw new Error(`the ancestry of ${ancestor} could not be read`)
      return result.ancestor
    },
    runAttempt: async (repo, runId) => {
      const attempt = await ghRunAttempt(repo, runId, ghOptions)
      if (!attempt.ok) throw new Error(`run ${runId} could not be read: ${attempt.error.message}`)
      return attempt.data
    },
  }
}
