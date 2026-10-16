// ExecutionOwnership (plan-execution D7, D9): the narrow interface the team
// services consult while a running execution owns a change — task creation
// links, dispatch and reassignment, handoffs and release, and result
// submission checks. The null implementation is the default: without the
// plans module the team services build and pass unchanged. The real one
// reads the execution store and runs the branch checks over the injected
// git reads; it never writes.
import type { ChangeStep } from '../../../shared/planExecution'
import type { ExecutionStore } from './executionStore'
import type { isAncestor, lsRemoteHead } from '../landing/gitRemote'

export interface OwnedTask {
  executionId: string
  /** The revision the execution runs, which the plan's approved revision may have moved past. */
  revision: number
  change: string
  step: ChangeStep | null
  worktree: string | null
  branch: string | null
}

/** What the team services consult (D7's four, plus the system create path's revision read). */
export interface ExecutionOwnership {
  ownerOfTask(taskId: string): OwnedTask | null
  ownerOfChange(teamId: string, change: string): { executionId: string } | null
  /**
   * D9's submission check for an owned task: a refusal message naming the
   * fix, or null when the result is accepted. An unowned task always accepts.
   */
  checkResult(taskId: string, submission: { commit: string | null }): Promise<string | null>
  isKawaiMessage(messageId: string): boolean
  /** The execution a system caller names: its plan and the revision it runs. */
  revisionOf(executionId: string): { planId: string; revision: number } | null
}

/** Without the plans module: nothing is owned, every result accepts, no mail is Kawai's. */
export const NULL_OWNERSHIP: ExecutionOwnership = {
  ownerOfTask: () => null,
  ownerOfChange: () => null,
  checkResult: async () => null,
  isKawaiMessage: () => false,
  revisionOf: () => null,
}

export interface OwnershipGit {
  isAncestor: typeof isAncestor
  lsRemoteHead: typeof lsRemoteHead
}

/** The real ownership over the execution store, with git reads injected (tests stub them). */
export function executionOwnership(store: ExecutionStore, git: OwnershipGit, messageSender: (messageId: string) => 'human' | 'agent' | 'system' | null): ExecutionOwnership {
  const owned = (taskId: string): OwnedTask | null => {
    const row = store.ownerOfTask(taskId)
    if (!row) return null
    const execution = store.execution(row.executionId)
    return execution
      ? { executionId: row.executionId, revision: execution.revision, change: row.change, step: row.step, worktree: row.worktree, branch: row.branch }
      : null
  }
  return {
    ownerOfTask: owned,
    ownerOfChange: (teamId, change) => {
      const row = store.ownerOf(teamId, change)
      return row ? { executionId: row.executionId } : null
    },
    checkResult: async (taskId, submission) => {
      const owner = owned(taskId)
      if (owner === null) return null
      if (owner.step === 'updating' || owner.step === 'merging') {
        return `Kawai is writing the change's branch (${owner.step}); submit the result once it settles.`
      }
      if (submission.commit === null || submission.commit.trim() === '') {
        return 'A result for an executed change needs the commit it landed as.'
      }
      const commit = submission.commit.trim()
      const cwd = owner.worktree
      if (cwd === null || owner.branch === null) {
        return `The change "${owner.change}" has no provisioned worktree or branch yet; its results cannot be checked.`
      }
      const onBranch = await git.isAncestor(cwd, commit, `refs/heads/${owner.branch}`)
      if (!onBranch.ok) return `The commit could not be checked against the change's branch: ${onBranch.error.stderr.trim()}`
      if (!onBranch.ancestor) return `The commit ${commit} is not on the change's branch "${owner.branch}".`
      const originHead = await git.lsRemoteHead(cwd, `refs/heads/${owner.branch}`)
      if (originHead.ok && originHead.sha !== null) {
        const ahead = await git.isAncestor(cwd, originHead.sha, commit)
        if (!ahead.ok) return `The origin head could not be checked: ${ahead.error.stderr.trim()}`
        if (!ahead.ancestor) return `The branch "${owner.branch}" on origin is ahead of ${commit}; push or rebase the result first.`
      }
      return null
    },
    isKawaiMessage: messageId => messageSender(messageId) === 'system',
    revisionOf: executionId => {
      const execution = store.execution(executionId)
      return execution ? { planId: execution.planId, revision: execution.revision } : null
    },
  }
}
