// The resolve's inline fix dispatch (revision-control 4.4, A2r): Kawai
// dispatches the resolution's own attempt row inside the caller's
// transaction when the hold gate reads open after the decision — the same
// request-key grammar, instruction builder, and role narrowing the round
// dispatch uses. The execution-origin system caller is minted HERE and only
// here (D2, the fixTasks precedent: each subsystem mints its own origin
// privately); when the change's dispatch facts are missing the row stays
// owed and the owed step dispatches it later (H1: the dispatch stays owed in
// stored state).
import type { TeamIdentity } from '../../team/teamIdentity'
import type { AssignmentService } from '../../team/AssignmentService'
import type { SystemCaller } from '../../team/systemCaller'
import type { ExecutionRow, ChangeRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PlanChange, PlanContent } from '../../../shared/plans'
import { fixInstruction } from './instructions'
import { effectiveExtraChecks } from '../../../shared/planExecutionGates'

/** The integration branch an execution lands on (D12), named in its instructions; null under direct landing. Same rule as executionDispatch's private copy. */
function integrationBranchOf(execution: { landingMode: string; baseBranch: string }): string | null {
  return execution.landingMode === 'integration-branch' ? execution.baseBranch : null
}

/** The execution-origin caller of the resolve's dispatch (D2): module-private. */
function resolveCaller(team: TeamIdentity, executionId: string): SystemCaller {
  return { kind: 'system', team, origin: { kind: 'execution', executionId } }
}

export interface AdaptedFixDispatchInput {
  team: TeamIdentity
  execution: ExecutionRow
  /** The change row read fresh inside the transaction: its generation keys the dispatch. */
  changeRow: ChangeRow
  entry: PlanChange
  content: PlanContent
  planTitle: string
  taskId: string
  attempt: { id: string; number: number; manifestHash: string }
  startCommit: string
  taskRevision: number
  rationale: string | null
  executions: Pick<ExecutionStore, 'setAttemptAssignment'>
  assignments: Pick<AssignmentService, 'dispatchWithin'>
}

/**
 * Dispatch the resolution's new fix attempt inline (A2r: "inline when the
 * gate is open"), under the attempt's own request key. Returns the stamped
 * assignment id, or null when the change lacks its dispatch facts — the row
 * then stays owed for the owed step, whose own guards apply at its time.
 */
export function dispatchAdaptedFixWithin(input: AdaptedFixDispatchInput): string | null {
  const { changeRow } = input
  const group = input.entry.group
  if (group === null) return null
  if (changeRow.worktree === null || changeRow.branch === null || changeRow.baselineCommit === null) return null
  const roleProfiles = input.content.roles.find(role => role.group === group)?.profiles ?? []
  const instruction = fixInstruction({
    planTitle: input.planTitle,
    revision: input.execution.revision,
    change: input.changeRow.change,
    worktree: changeRow.worktree,
    branch: changeRow.branch,
    baseline: changeRow.baselineCommit,
    head: input.startCommit,
    acceptance: [...input.entry.acceptance, ...input.content.acceptanceRules],
    extraChecks: effectiveExtraChecks(input.content, input.entry).map(check => check.name),
    guidance: input.entry.guidance,
    taskId: input.taskId,
    manifestHash: input.attempt.manifestHash,
    integrationBranch: integrationBranchOf(input.execution),
    failingChecks: [],
    findings: [
      `The task's direction was republished as revision ${input.taskRevision}${input.rationale ? ` (${input.rationale})` : ''}. Re-apply your work on top of the new direction.`,
    ],
    fixRounds: changeRow.fixRounds,
    continueFrom: input.startCommit,
  })
  const outcome = input.assignments.dispatchWithin(resolveCaller(input.team, input.execution.id), {
    taskId: input.taskId,
    target: { kind: 'group', id: group },
    instruction,
    requestKey: `exec:${input.execution.id}:${input.changeRow.change}:attempt:${input.attempt.number}:${changeRow.generation}`,
    ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
  })
  input.executions.setAttemptAssignment(input.attempt.id, outcome.assignment.id)
  return outcome.assignment.id
}
