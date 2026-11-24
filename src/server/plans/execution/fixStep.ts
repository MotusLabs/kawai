// The fix dispatch of a failed round (plan-execution D12), shared by the fix
// step and the diagnosis stage's Fix round, Reject, and Reassign outcomes
// (review-convergence decision 7). The dispatch comes first: a refused fix
// stops the change while it still gates on the failed round, so Retry finds
// the round again. A send that commits carries the transition and the
// diagnosis close in its own transaction, so the instruction under one
// request key and the decision and count the close records are one write:
// a crash or a failed close before it leaves nothing sent, and an owner's
// override in that gap is what the next send renders (plan-revision-apply
// AL3, the F8 challenge). The findings are read from the ledger inside that
// transaction. Under a hold (revision-control 3.2) the attempt row —
// the owed dispatch's marker — is still created and the fix transition
// stands; only the handoff waits, and the release dispatches it once. This is
// the change's one writer for its own row (H″ O2): a refused send wrote
// nothing, and the step re-sends the same key after Retry; the owed step
// never fires here — 'gating' is not a fix row's owed state.
import type { TaskService } from '../../team/TaskService'
import type { PlanStore } from '../planStore'
import { dispatchFix, ensureFixAttempt, type DispatchDeps } from './executionDispatch'
import type { ChangePatch } from './executionPatch'
import type { ChangeRow, RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import { fixFindings } from './fixFindings'

export interface FixStepDeps {
  store: ExecutionStore
  plans: PlanStore
  tasks: TaskService
  dispatch: DispatchDeps
}

/** The group a change's fixes go to: a Reassign outcome's, else the execution's plan revision's. */
export function fixGroupOf(deps: Pick<FixStepDeps, 'store' | 'plans'>, row: ChangeRow): string | null {
  if (row.groupOverride !== null) return row.groupOverride
  const execution = deps.store.execution(row.executionId)
  if (execution === null) return null
  return deps.plans.revision(execution.planId, execution.revision)?.content.changes.find(entry => entry.change === row.change)?.group ?? null
}

/**
 * Dispatch the failed round's fix and move the change to `implementing` with
 * `fixRounds`, plus `patch` in the same transition (a Reassign's group) and
 * `within` in its transaction.
 * Returns false when the change cannot take a fix (no group, no task).
 */
export async function sendRoundFix(deps: FixStepDeps, row: ChangeRow, round: RoundRow, options: {
  fixRounds: number
  diagnosis?: string | null
  patch?: ChangePatch
  /** Runs in the transition's transaction (a diagnosis outcome's close: every close leaves `diagnosing` with it). */
  within?: () => void
}, gate?: (change: string) => boolean): Promise<boolean> {
  const group = options.patch?.groupOverride ?? fixGroupOf(deps, row)
  if (group === null || row.taskId === null) return false
  const taskId = row.taskId
  const failing = (round.ci ?? []).filter(check => check.conclusion.toLowerCase() === 'failure')
    .map(check => ({ name: check.name, conclusion: check.conclusion, link: check.link }))
  const all = deps.tasks.store.results.findingsFor(round.resultId)
  const findings = round.verdictFindingsId !== null ? all.filter(entry => entry.id === round.verdictFindingsId) : all
  const input = {
    executionId: row.executionId, change: row.change, group,
    ...(options.patch?.groupOverride ? { reassign: options.patch.groupOverride } : {}),
    failingChecks: failing,
    findingsIds: findings.map(entry => entry.id),
    findings: () => fixFindings(deps.tasks.store, taskId, round),
    continueFrom: round.commitSha,
    fixRounds: options.fixRounds,
    ...(options.diagnosis ? { diagnosis: options.diagnosis } : {}),
  }
  const leave = (): void => {
    deps.store.transition(row.executionId, row.change, row, { state: 'implementing', step: null, fixRounds: options.fixRounds, ...options.patch })
    options.within?.()
  }
  const attempt = await ensureFixAttempt(deps.dispatch, input)
  const sent = attempt !== null && gate?.(row.change) !== true && await dispatchFix(deps.dispatch, input, attempt, leave)
  // Held, yielded, or no row: nothing went out, and the transition and close commit alone.
  if (!sent) deps.store.db.transaction(leave)()
  return true
}
