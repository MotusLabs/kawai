// Deferred fix handoffs: rebuild the failed round's findings and the applied
// diagnosis decision from stored rows after a hold or restart.
import { DecisionStore } from '../decisions/decisionStore'
import { diagnosisRationale } from '../decisions/diagnosisCards'
import { DiagnosisStore } from './diagnosisStore'
import { dispatchFix, type DispatchDeps, type FixAttemptInput } from './executionDispatch'
import type { AttemptRow } from './executionRows'
import { fixFindings } from './fixFindings'

/** The fix attempt's re-send, texts rebuilt at send time from the round the attempt answers — the manifest keeps only ids. */
export async function dispatchOwedFix(deps: DispatchDeps, input: { executionId: string; change: string; group: string }, newest: AttemptRow): Promise<void> {
  const changeRow = deps.executions.change(input.executionId, input.change)
  if (changeRow === null) return
  const round = newest.manifest.answers !== undefined
    ? deps.executions.round(newest.manifest.answers.roundId) ?? null
    : null
  let failingChecks: FixAttemptInput['failingChecks'] = []
  let findingsIds: string[] = []
  let notes: string[] = []
  // The findings are rebuilt at send time from the ledger and the round the
  // attempt answers — the manifest keeps only ids (review-findings-ledger
  // D7). A superseded round's owed fix names the task's CURRENT revision (a
  // second republish after the attempt was minted is still the round's
  // answer), a failed round its failing checks and the verdict's findings.
  if (round?.outcome === 'superseded') {
    const task = changeRow.taskId === null ? null : deps.tasks.store.get(changeRow.taskId)
    const rationale = task === null || task === undefined ? null : deps.tasks.store.revisions(task.id).at(-1)?.rationale ?? null
    notes = [`The task's direction was republished as revision ${task?.revision ?? 1}${rationale ? ` (${rationale})` : ''}. Re-apply your work on top of the new direction.`]
  } else if (round !== null && round.outcome === 'fail') {
    failingChecks = (round.ci ?? []).filter(check => check.conclusion.toLowerCase() === 'failure')
      .map(check => ({ name: check.name, conclusion: check.conclusion, link: check.link }))
    const all = changeRow.taskId === null ? [] : deps.tasks.store.results.findingsFor(round.resultId)
    findingsIds = (round.verdictFindingsId !== null ? all.filter(entry => entry.id === round.verdictFindingsId) : all).map(row => row.id)
  }
  const findings = changeRow.taskId === null
    ? { blocking: [], blockingText: '', others: 0, legacyTexts: notes }
    : fixFindings(deps.tasks.store, changeRow.taskId, round?.outcome === 'fail' ? round : null, notes)
  // A hold can close the diagnosis before the handoff is sent. Recover the
  // applied decision by id; a later owner override must not change its text.
  const diagnosis = round === null ? null : new DiagnosisStore(deps.executions.db).forRound(round.id)
  const decision = diagnosis?.closedAt != null && diagnosis.decisionId !== null
    ? new DecisionStore(deps.executions.db).decision(deps.team.teamId, diagnosis.decisionId) : null
  await dispatchFix(deps, {
    executionId: input.executionId, change: input.change, group: input.group,
    failingChecks, findingsIds, findings,
    diagnosis: decision === null ? null : diagnosisRationale(decision),
    continueFrom: round?.commitSha ?? changeRow.baselineCommit ?? '',
    fixRounds: changeRow.fixRounds,
  }, { id: newest.id, number: newest.number, manifestHash: newest.manifestHash })
}

