// The resolve's restart dispatch (revision-control 4.4-4.5, R2): Kawai
// dispatches the restart's own attempt row inside the caller's transaction
// when the hold gate reads open after the decision — the adapt dispatch's
// request-key grammar and role narrowing, with D5's start-point package in
// the instruction: the contained checkpoint when one of THIS pause target's
// own checkpoints reached origin, else origin's branch head with the
// may-predates note (a Pausing target's causes never left work on origin —
// R10-R13). The execution-origin system caller is minted HERE and only here
// (D2, the fixTasks precedent: each subsystem mints its own origin
// privately); when the change's dispatch facts are missing the row stays
// owed and the owed step dispatches it later (H1: the dispatch stays owed in
// stored state).
import type { TeamIdentity } from '../../team/teamIdentity'
import type { AssignmentService } from '../../team/AssignmentService'
import type { SystemCaller } from '../../team/systemCaller'
import type { ExecutionRow, ChangeRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PlanChange, PlanContent } from '../../../shared/plans'
import type { AttemptKind, AttemptManifest } from '../../../shared/planExecution'
import { implementInstruction } from './instructions'
import { effectiveExtraChecks } from '../../../shared/planExecutionGates'

/** The integration branch an execution lands on (D12), named in its instructions; null under direct landing. Same rule as executionDispatch's private copy. */
function integrationBranchOf(execution: { landingMode: string; baseBranch: string }): string | null {
  return execution.landingMode === 'integration-branch' ? execution.baseBranch : null
}

/** The execution-origin caller of the resolve's dispatch (D2): module-private. */
function resolveCaller(team: TeamIdentity, executionId: string): SystemCaller {
  return { kind: 'system', team, origin: { kind: 'execution', executionId } }
}

/** D5's start-point paragraph: the contained checkpoint, or origin's head with the may-predates note. */
function restartParagraph(checkpoint: { id: string; commit: string } | null, head: string): string {
  return checkpoint !== null
    ? `A checkpoint of the paused work is on origin: continue from checkpoint ${checkpoint.id} (commit ${checkpoint.commit}).`
    : `Nothing of the paused work reached origin: start from origin's branch head ${head} — your predecessor's work may predate it, so re-derive whatever of it you can.`
}

export interface RestartedAttemptDispatchInput {
  team: TeamIdentity
  execution: ExecutionRow
  /** The change row read fresh inside the transaction: its generation keys the dispatch. */
  changeRow: ChangeRow
  entry: PlanChange
  content: PlanContent
  planTitle: string
  taskId: string
  kind: AttemptKind
  attempt: { id: string; number: number; manifestHash: string }
  /** The row's own manifest: its answers and update facts ride the per-kind lines. */
  manifest: AttemptManifest
  startCommit: string
  /** The contained checkpoint (D5), or null when the restart starts from origin's branch head. */
  checkpoint: { id: string; commit: string } | null
  executions: Pick<ExecutionStore, 'setAttemptAssignment'>
  assignments: Pick<AssignmentService, 'dispatchWithin'>
}

/**
 * Dispatch the restart's new attempt inline (R2: "per the hold: inline when
 * the gate is open"), under the attempt's own request key. Returns the
 * stamped assignment id, or null when the change lacks its dispatch facts —
 * the row then stays owed for the owed step, whose own guards apply at its
 * time.
 */
export function dispatchRestartedAttemptWithin(input: RestartedAttemptDispatchInput): string | null {
  const { changeRow } = input
  const group = input.entry.group
  if (group === null) return null
  if (changeRow.worktree === null || changeRow.branch === null || changeRow.baselineCommit === null) return null
  const roleProfiles = input.content.roles.find(role => role.group === group)?.profiles ?? []
  const lines = [
    implementInstruction({
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
    }),
    '',
    `Kawai restarted this work (attempt ${input.attempt.number}): the paused attempt's row was superseded and its holder stepped away from it. ${restartParagraph(input.checkpoint, input.startCommit)}`,
    input.manifest.update !== undefined ? updateLine(input.manifest.update) : null,
    input.kind === 'fix' && input.manifest.answers !== undefined && input.manifest.answers.failingChecks.length > 0
      ? `The fix this restart re-runs answered: ${input.manifest.answers.failingChecks.map(check => check.name).join(', ')}.`
      : null,
  ].filter(line => line !== null)
  const outcome = input.assignments.dispatchWithin(resolveCaller(input.team, input.execution.id), {
    taskId: input.taskId,
    target: { kind: 'group', id: group },
    instruction: lines.join('\n\n'),
    requestKey: `exec:${input.execution.id}:${input.changeRow.change}:attempt:${input.attempt.number}:${changeRow.generation}`,
    ...(roleProfiles.length > 0 ? { allowedProfiles: roleProfiles } : {}),
  })
  input.executions.setAttemptAssignment(input.attempt.id, outcome.assignment.id)
  return outcome.assignment.id
}

/** The update line (R21r and its twins: the re-minted update re-runs). */
function updateLine(update: { base: string; files: string[] }): string {
  const files = update.files.length > 0 ? `files ${update.files.join(', ')}` : 'no named files'
  return `The failed update this restart re-runs: base ${update.base}, ${files}.`
}
