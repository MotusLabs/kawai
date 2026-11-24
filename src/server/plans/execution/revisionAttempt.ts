// D9's revision fix (plan-execution D9, D13; plan-revision-apply CH4 and
// invariant AL3, review F8). A round pinned to an older task revision is
// superseded and the change owes one fix naming the task's current revision
// — and, when it follows a failed branch update, the base head and the
// conflicting files, which no row re-derives. The git facts are gathered
// first; then ONE guarded transaction supersedes the round, cancels its live
// effects, returns the change to implementing (with a diagnosis close), and
// mints the fix row whose immutable manifest records the conflict. Until that
// commit the round stays open, so a crash or a racing Apply leaves D9's
// stage re-firing; after it the debt is durably owed. The send renders the
// row through the owed renderer (`dispatchOwedFix`), so the immediate send,
// a hold release, a yield's successor, and a second Adapt's carried row all
// name the same facts.
import type { ChangePatch } from './executionPatch'
import type { ChangeRow, RoundRow } from './executionRows'
import type { RoundDeps } from './executionRounds'
import { commitAttemptInsert, routeOf } from './attemptSend'
import { gatherStartFacts, type DispatchDeps } from './executionDispatch'
import { dispatchOwedFix } from './owedFix'

/**
 * The settled branch update a landing follow-on hands D9 (review F9): the
 * change's generation the follow-on read and the done update-branch effect
 * it applies. Until D9's transaction commits the change stays `landing` /
 * `updating`, so an interrupted mint leaves that follow-on eligible and the
 * next tick re-derives the conflict and mints again.
 */
export interface LandingGuard {
  generation: number
  effectId: string | null
}

function landingStands(store: RoundDeps['executions'], executionId: string, change: ChangeRow, landing: LandingGuard): boolean {
  if (change.state !== 'landing' || change.step !== 'updating' || change.generation !== landing.generation || !change.owns) return false
  if (store.execution(executionId)?.state !== 'running') return false
  if (landing.effectId === null) return true
  const effect = store.effect(landing.effectId)
  return effect !== null && effect.state === 'done' && effect.kind === 'update-branch' && effect.change === change.change
}

/** D9: the round's result is pinned to a task revision older than the task's current one. */
export function revisionPending(deps: Pick<RoundDeps, 'tasks'>, taskId: string | null, round: RoundRow): boolean {
  const task = taskId === null ? null : deps.tasks.store.get(taskId)
  if (task === null || task === undefined) return false
  const result = deps.tasks.store.results.get(round.resultId)
  return result !== null && result !== undefined && result.taskRevision < task.revision
}

/**
 * D9's fix attempt naming a newer task revision: supersede the pinned round
 * and return the change to implementing — leaving `landing` releases the
 * slot. A revision applied once a failed branch update settled (D9, D13)
 * names the base head and the conflicting files too, so one attempt answers
 * both and no update attempt follows. False when no revision is pending;
 * true when the round was answered here or by a write that raced the git
 * reads (a Restart's row, a concurrent mint), which then stands alone.
 */
export async function dispatchRevisionAttempt(deps: RoundDeps, changeRow: { executionId: string; change: string; taskId: string | null }, round: RoundRow, update?: { base: string; files: string[] }, close?: { patch: ChangePatch; within: () => void }, landing?: LandingGuard): Promise<boolean> {
  const store = deps.executions
  if (!revisionPending(deps, changeRow.taskId, round)) return false
  const before = store.change(changeRow.executionId, changeRow.change)
  if (before === null || store.execution(changeRow.executionId) === null) return false
  const newestId = store.attempts(changeRow.executionId, changeRow.change).at(-1)?.id ?? null
  const mintable = before.worktree !== null && before.baselineCommit !== null && before.taskId !== null
  const facts = mintable ? await gatherStartFacts(before.worktree!, before.baselineCommit!) : null
  const dispatch: DispatchDeps = { team: deps.team, executions: store, plans: deps.plans, tasks: deps.tasks, assignments: deps.assignments, results: deps.results }
  const minted = store.db.transaction(() => {
    // The guard: the round not superseded (open, passed, or the failed round
    // a diagnosis closes on) and still the newest, its revision still
    // pending, and no attempt minted since the reads — else the racing write
    // (a Restart, a concurrent mint) answers it and nothing is written here.
    const current = store.round(round.id)
    const change = store.change(changeRow.executionId, changeRow.change)
    if (current === null || current === undefined || change === null) return null
    if (current.outcome === 'superseded' || store.rounds(changeRow.executionId, changeRow.change).at(-1)?.id !== round.id) return null
    if (!revisionPending(deps, changeRow.taskId, current)) return null
    if ((store.attempts(changeRow.executionId, changeRow.change).at(-1)?.id ?? null) !== newestId) return null
    // From a settled branch update (review F9): the change still settling
    // that update at the generation the follow-on read, its effect done, and
    // the execution running and owning it — else nothing is written, and the
    // follow-on (or the write that moved the change) decides next.
    if (landing !== undefined && !landingStands(store, changeRow.executionId, change, landing)) return null
    store.supersedeRound(round.id)
    // A7: the superseded round's live round-effect rows never run after it.
    store.cancelLiveRoundEffects(changeRow.executionId, round.id)
    // A diagnosis closed by the revision (review-convergence DX1) closes in
    // the same transaction, with its patch (the count back at 0).
    // From landing, the exit releases the slot and the pass marker clears
    // here, with the mint — never before it (review F9).
    store.transition(changeRow.executionId, changeRow.change, change, { state: 'implementing', step: null, ...(landing !== undefined ? { passedAt: null } : {}), ...close?.patch })
    close?.within()
    if (facts === null) return null
    const taskId = change.taskId!
    // The task revision is the one current at commit: an Adapt between the
    // reads and here is what the fix names, with the conflict kept.
    const taskRevision = deps.tasks.store.get(taskId)?.revision ?? 1
    return commitAttemptInsert({ executions: store, plans: deps.plans, taskRevisionOf: id => deps.tasks.store.get(id)?.revision ?? null },
      { executionId: changeRow.executionId, change: changeRow.change, kind: 'fix' }, { newestId, roundId: round.id, taskRevision }, {
        taskId, baseline: change.baselineCommit!, startCommit: facts.startCommit, artifacts: facts.artifacts,
        answers: { resultId: round.resultId, roundId: round.id, failingChecks: [], findingsIds: [] },
        ...(update !== undefined ? { update } : {}),
      })
  })()
  // The row is the owed dispatch's marker (revision-control 3.2): under a
  // hold the release sends it once through dispatchOwedAttempt.
  if (minted === null || deps.gate?.(changeRow.change) === true) return true
  const row = store.attempts(changeRow.executionId, changeRow.change).at(-1)
  const execution = store.execution(changeRow.executionId)
  const change = store.change(changeRow.executionId, changeRow.change)
  const content = execution === null ? undefined : deps.plans.revision(execution.planId, execution.revision)?.content
  const route = content === undefined || change === null ? null : routeOf(content, change)
  if (row === undefined || row.id !== minted.id || route === null) return true
  await dispatchOwedFix(dispatch, { executionId: changeRow.executionId, change: changeRow.change, group: route.group }, row)
  return true
}
