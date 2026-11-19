// Apply's composition (plan-revision-apply D1): the ApplyService over the
// stores and settings Start reads, the team services its writes go through
// (task publications and notices, assignments, mail), origin's branch-head
// read for re-issued attempts, and the executor wake after a commit. Kept
// out of `planComposition.ts`, which calls `composeApply` once and attaches
// the result beside the hold and pause services. `originBranchHead` is the
// pre-transaction head read Apply and the pause resolve share.
import type { Database } from 'bun:sqlite'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { TaskService } from '../../team/TaskService'
import type { MailboxStore } from '../../team/mailboxStore'
import { AssignmentStore } from '../../team/assignmentStore'
import type { PlanService } from '../PlanService'
import type { PlanStore } from '../planStore'
import type { ExecutionStore } from '../execution/executionStore'
import type { StartGatherDeps } from '../execution/startGather'
import type { ImpactGate } from '../../../shared/strategyImpact'
import { lsRemoteHead } from '../landing/gitRemote'
import { ApplyService } from './applyService'
import { ExecutionRevisionStore } from './executionRevisionStore'
import type { AdaptHeadFacts } from './pauseResolve'

/** origin's head of a change's branch, read from its worktree (else the team's main checkout); null when it has no branch yet. */
export function originBranchHead(executions: ExecutionStore, identityOf: (teamId: string) => TeamIdentity | undefined) {
  return async (executionId: string, change: string): Promise<AdaptHeadFacts | null> => {
    const row = executions.change(executionId, change)
    const teamId = executions.execution(executionId)?.teamId
    const identity = teamId !== undefined ? identityOf(teamId) : undefined
    if (row === null || row.branch === null || identity === undefined) return null
    const head = await lsRemoteHead(row.worktree ?? identity.groupsRoot, `refs/heads/${row.branch}`)
    if (!head.ok || head.sha === null) return { ok: false }
    return { ok: true, startCommit: head.sha, artifacts: {} }
  }
}

export interface ApplyCompositionOptions extends StartGatherDeps {
  db: Database
  plansStore: PlanStore
  plans: PlanService
  validation: {
    prepareStanding: (planId: string, revision: number) => Promise<unknown> | null
    standing: (prepared: unknown) => unknown
  }
  impact: { gate: (planId: string, revision: number) => ImpactGate | null }
  /** The team services; without them Apply refuses and only the preview reads. */
  team?: { tasks: TaskService; mailbox: MailboxStore; identityOf: (teamId: string) => TeamIdentity | undefined }
  sessionExists: (sessionId: string) => boolean
  wake: (teamId: string) => void
}

export function composeApply(options: ApplyCompositionOptions): ApplyService {
  const { team } = options
  return new ApplyService({
    ...options,
    executionRevisions: new ExecutionRevisionStore(options.db),
    ...(team !== undefined ? {
      writes: {
        store: options.store, tasks: team.tasks, assignments: new AssignmentStore(options.db, team.mailbox),
        mailbox: team.mailbox, sessionExists: options.sessionExists,
      },
      adaptHead: originBranchHead(options.store, team.identityOf),
    } : {}),
  })
}
