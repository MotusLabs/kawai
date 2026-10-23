// ExecutionOwnership (plan-execution D7, D9): the narrow interface the team
// services consult while a running execution owns a change — task creation
// links, dispatch and reassignment, handoffs and release, and result
// submission checks. The null implementation is the default: without the
// plans module the team services build and pass unchanged. The real one
// reads the execution store and runs the branch checks over the injected
// git reads; it never writes.
import type { Database } from 'bun:sqlite'
import type { ChangeStep } from '../../../shared/planExecution'
import type { ExecutionStore } from './executionStore'
import type { isAncestor, lsRemoteHead } from '../landing/gitRemote'
import { PauseStore } from '../revisionControl/pauseStore'

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
   * fix, or null when the submission is accepted. An unowned task always
   * accepts. `submitter` is the caller's session id, or null for the human;
   * `kind` distinguishes a result (commit, branch, and step checks) from
   * findings (the old-holder rule only — ruling L6); both default to the
   * result path when absent.
   */
  checkResult(taskId: string, submission: { commit: string | null; submitter?: string | null; kind?: 'result' | 'findings' }): Promise<string | null>
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

/**
 * The row reads the old-holder rule needs (revision-control D9, lead ruling
 * L6), injected because the pause and assignment rows live outside the
 * execution store. Omitting the seam (callers without the plans module's
 * stores) reads no restart fact and refuses nothing.
 */
export interface OwnershipRows {
  /** Whether any pause target for the change carries a Restart decision naming the session — across every pause of the plan, open and closed. A row fact: it survives a rebuild over the same database. */
  isRestartHolder(teamId: string, planId: string, change: string, sessionId: string | null): boolean
  /** The claimant of the task's outstanding assignment, or null between the supersession and the new dispatch. */
  outstandingClaimant(taskId: string): string | null
}

/** The row reads over the shared database: the pause targets and the assignment claims. */
export function ownershipRowReads(db: Database): OwnershipRows {
  const pauses = new PauseStore(db)
  return {
    isRestartHolder: (teamId, planId, change, sessionId) =>
      pauses.forPlan(teamId, planId, false).some(pause => {
        const target = pauses.target(pause.id, change)
        return target !== null && target.decision === 'restart' && target.holderSession === sessionId
      }),
    outstandingClaimant: taskId => {
      // The outstanding assignment's claimant, derived as `assignmentStore`'s
      // outstandingOf derives it — the newest row neither superseded nor
      // failed (failed being the mail's dead states or a missing instruction)
      // — with the mail's live claim as the fact (D5's claim copy). The mail
      // store is not built when the execution core composes, so the join
      // reads the two tables the store's derivation joins.
      const rows = db.prepare(`SELECT a.superseded_by AS supersededBy, a.claimed_by AS rowClaim,
          m.claimed_by AS mailClaim, m.state AS mailState
        FROM team_task_assignments a LEFT JOIN team_messages m ON m.id = a.message_id
        WHERE a.task_id = ? ORDER BY a.created_at, a.rowid`).all(taskId) as Array<Record<string, unknown>>
      const failed = new Set(['dead', 'cancelled', 'discarded'])
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]
        if (row.supersededBy !== null) continue
        if (row.mailState === null || failed.has(String(row.mailState))) continue
        return (row.mailClaim ?? row.rowClaim ?? null) as string | null
      }
      return null
    },
  }
}

/**
 * The old-holder rule (revision-control D9, lead ruling L6): after a Restart,
 * the holder at the pause's request time is superseded — its result and
 * findings submissions for the owned task are refused, judged from the rows,
 * in both windows (before and after the new attempt's dispatch). The current
 * attempt's outstanding claimant is accepted: a re-dispatch to the same
 * session makes it the holder again. The human (null submitter) is never
 * refused.
 */
export function restartSupersededRefusal(submitter: string | null, owner: Pick<OwnedTask, 'change'>, isRestartHolder: boolean, outstandingClaimant: string | null): string | null {
  if (submitter === null || !isRestartHolder || outstandingClaimant === submitter) return null
  return `The pause of "${owner.change}" was resolved as Restart and this session's attempt was superseded; submit nothing further for it (restart-superseded).`
}

/** The real ownership over the execution store, with git reads injected (tests stub them). */
export function executionOwnership(store: ExecutionStore, git: OwnershipGit, messageSender: (messageId: string) => 'human' | 'agent' | 'system' | null, rows?: OwnershipRows): ExecutionOwnership {
  const owned = (taskId: string): { owner: OwnedTask; teamId: string; planId: string } | null => {
    const row = store.ownerOfTask(taskId)
    if (!row) return null
    const execution = store.execution(row.executionId)
    return execution
      ? {
        owner: { executionId: row.executionId, revision: execution.revision, change: row.change, step: row.step, worktree: row.worktree, branch: row.branch },
        teamId: execution.teamId, planId: execution.planId,
      }
      : null
  }
  const oldHolderRefusal = (taskId: string, task: { owner: OwnedTask; teamId: string; planId: string }, submitter: string | null): string | null => {
    if (rows === undefined) return null
    return restartSupersededRefusal(submitter, task.owner,
      rows.isRestartHolder(task.teamId, task.planId, task.owner.change, submitter),
      rows.outstandingClaimant(taskId))
  }
  return {
    ownerOfTask: taskId => owned(taskId)?.owner ?? null,
    ownerOfChange: (teamId, change) => {
      const row = store.ownerOf(teamId, change)
      return row ? { executionId: row.executionId } : null
    },
    checkResult: async (taskId, submission) => {
      const task = owned(taskId)
      if (task === null) return null
      const submitter = submission.submitter ?? null
      const superseded = oldHolderRefusal(taskId, task, submitter)
      if (superseded !== null) return superseded
      if ((submission.kind ?? 'result') === 'findings') return null
      const owner = task.owner
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
      // An unreadable ref never passes the check: only a clean "absent on
      // origin" (ok with no sha) may skip the origin-head comparison.
      if (!originHead.ok) return `The branch "${owner.branch}" on origin could not be read: ${originHead.error.stderr.trim()}`
      if (originHead.sha !== null) {
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
