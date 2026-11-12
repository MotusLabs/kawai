// The diagnosis stage (review-convergence decisions 5 and 7, table DX): a
// `gating`/`diagnosing` change's open diagnosis is applied from the stored
// rows, with no listener. In order: a task revision past the failed round's
// result closes it (`revision`) and sends the revision fix with the count at
// 0 (DX1); a card with no decision, or whose newest decision is the `amend`
// already applied, waits (DX2, DX7); otherwise the newest decision's outcome
// applies (DX3–DX10, an override after `amend` included — DX8). Every close
// is guarded by `closed_at IS NULL` and commits with the transition that
// leaves `diagnosing`, after the keyed fix dispatch: a crash between them
// re-runs the stage, which replays the same attempt key (I2). Rejections are
// keyed per decision and finding, so a replay writes none twice.
import { foldLedger, roundReview } from '../../../shared/findingsLedger'
import { evaluateCi } from '../../../shared/planExecutionGates'
import { signalLine } from '../../../shared/reviewConvergence'
import { isBlocking } from '../../../shared/reviewFindings'
import { SYSTEM_ACTOR } from '../../../shared/team'
import type { PlanDecision } from '../../../shared/planDecisions'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { DecisionStore } from '../decisions/decisionStore'
import { diagnosisOutcome, diagnosisRationale, type DiagnosisOutcome } from '../decisions/diagnosisCards'
import { DiagnosisStore, type DiagnosisRow } from './diagnosisStore'
import { dispatchRevisionAttempt, type RoundDeps } from './executionRounds'
import type { ChangeRow, RoundRow } from './executionRows'
import { sendRoundFix, type FixStepDeps } from './fixStep'

export interface DiagnosisStageDeps {
  team: TeamIdentity
  fix: FixStepDeps
  round: RoundDeps
  decisions: Pick<DecisionStore, 'decisionsOfCard'>
  /** A test seam: runs inside the closing transaction, before the close (a crash there rolls the close and the transition back). */
  beforeClose?: () => void
}

/** What the stage does for an open diagnosis now (the DX row's verdict, before any write). */
export type DiagnosisStep =
  | { kind: 'revision' }
  | { kind: 'wait' }
  | { kind: 'apply'; decision: PlanDecision; outcome: DiagnosisOutcome }

/** Table DX's decision, from the rows. */
export function diagnosisStep(input: {
  diagnosis: Pick<DiagnosisRow, 'outcome' | 'decisionId'>
  revisionPast: boolean
  decisions: readonly PlanDecision[]
}): DiagnosisStep {
  if (input.revisionPast) return { kind: 'revision' } // DX1
  const newest = input.decisions.at(-1)
  if (newest === undefined) return { kind: 'wait' } // DX2
  if (input.diagnosis.outcome === 'amend' && input.diagnosis.decisionId === newest.id) return { kind: 'wait' } // DX7
  const outcome = diagnosisOutcome(newest.choice)
  // Unreachable: a diagnosis card refuses free text at record.
  if (outcome === null) return { kind: 'wait' }
  return { kind: 'apply', decision: newest, outcome }
}

/** Run the stage for one change. */
export async function applyDiagnosisStage(deps: DiagnosisStageDeps, row: ChangeRow, gate?: (change: string) => boolean): Promise<void> {
  const executions = deps.fix.store
  const tasks = deps.fix.tasks.store
  const diagnoses = new DiagnosisStore(executions.db)
  const diagnosis = diagnoses.open(row.executionId, row.change)
  const round = diagnosis === null ? null : executions.round(diagnosis.roundId)
  if (diagnosis === null || round === null || row.taskId === null || row.step !== 'diagnosing') return
  const taskId = row.taskId
  const task = tasks.get(taskId)
  const result = tasks.results.get(round.resultId)
  const step = diagnosisStep({
    diagnosis,
    revisionPast: task !== undefined && task !== null && result !== undefined && result !== null && result.taskRevision < task.revision,
    decisions: deps.decisions.decisionsOfCard(deps.team.teamId, diagnosis.cardId),
  })
  if (step.kind === 'wait') return
  const close = (outcome: DiagnosisRow['outcome'], decisionId: string | null, line: string) => () => {
    deps.beforeClose?.()
    if (!diagnoses.close(diagnosis.id, { reason: outcome === null ? 'revision' : 'decision', outcome, decisionId })) {
      throw new Error(`diagnosis ${diagnosis.id} was closed meanwhile`)
    }
    tasks.appendJournal(taskId, SYSTEM_ACTOR, line)
  }
  if (step.kind === 'revision') {
    await dispatchRevisionAttempt({ ...deps.round, gate }, row, round, undefined, {
      patch: { fixRounds: 0 },
      within: close(null, null, `Diagnosis ${diagnosis.id} closed: the task was republished as revision ${task!.revision}, so the fix names it and the count starts again`),
    })
    return
  }
  const { decision, outcome } = step
  const rationale = diagnosisRationale(decision)
  if (outcome.kind === 'amend') {
    tasks.atomically(() => {
      if (!diagnoses.markAmend(diagnosis.id, decision.id)) return
      tasks.appendJournal(taskId, SYSTEM_ACTOR,
        `Diagnosis ${diagnosis.id}: decision ${decision.id} asks for an amended contract; the change waits for a new task revision, which the owner publishes`)
    })
    return
  }
  if (outcome.kind === 'escalate') {
    executions.db.transaction(() => {
      executions.transition(row.executionId, row.change, row, {
        state: 'stopped', stopReason: 'diagnosis-escalated', step: null,
        stopDetail: { message: `Escalated by diagnosis ${diagnosis.id}: ${diagnosis.signals.map(signalLine).join('; ')}`, signals: diagnosis.signals, rationale: decision.rationale ?? '' },
      })
      close('escalate', decision.id, `Diagnosis ${diagnosis.id} escalated on decision ${decision.id}: the change stopped`)()
    })()
    return
  }
  if (outcome.kind === 'reject') {
    const passes = rejectFindings(deps, taskId, diagnosis, decision, outcome.ids)
    // Reject changes findings, never the CI verdict or a missing review.
    const execution = executions.execution(row.executionId)
    const ciPasses = execution !== null && evaluateCi(round.ci ?? [], execution.floor.map, {
      windowFrom: round.ciWindowFrom ?? round.pushedAt ?? deps.round.now(), now: deps.round.now(), rerun: null,
    }).kind === 'pass'
    if (passes && round.blockingIds !== null && ciPasses) {
      regatePassed(deps, row, round, close('reject', decision.id, `Diagnosis ${diagnosis.id}: decision ${decision.id} rejected ${outcome.ids.join(', ')}; nothing blocks, so result ${round.resultId} passes again`))
      return
    }
  }
  const fixClose = close(outcome.kind, decision.id, `Diagnosis ${diagnosis.id} closed on decision ${decision.id} (${decision.choice}): a fix round goes out, the count starting at 0`)
  await sendRoundFix(deps.fix, row, round, {
    fixRounds: 0, diagnosis: rationale, within: fixClose,
    ...(outcome.kind === 'reassign' ? { patch: { groupOverride: outcome.group } } : {}),
  }, gate)
}

/**
 * `Reject F…`: a `rejected` event, carrying the card and decision ids, for
 * each named finding still blocking (one replay key per decision and
 * finding). True when the fold then passes (nothing blocks or awaits a dispute).
 */
function rejectFindings(deps: DiagnosisStageDeps, taskId: string, diagnosis: DiagnosisRow, decision: PlanDecision, ids: readonly string[]): boolean {
  const findings = deps.fix.tasks.store.findings
  const ledger = () => foldLedger(findings.countedSubmissions(taskId), findings.events(taskId))
  const rows = new Map(ledger().map(entry => [entry.id, entry]))
  const actor = decision.decidedBy.kind === 'agent'
    ? { kind: 'agent', sessionId: decision.decidedBy.session ?? null }
    : { kind: 'human', sessionId: null }
  deps.fix.tasks.store.atomically(() => {
    for (const id of ids) {
      const entry = rows.get(id)
      if (entry === undefined || !isBlocking(entry.level, entry.state)) continue
      findings.insertEvent({
        taskId, findingId: id, kind: 'rejected', cardId: diagnosis.cardId, decisionId: decision.id, actor,
        text: decision.rationale, sourceKey: `diagnosis:${decision.id}:${id}`,
      })
    }
  })
  return roundReview(ledger()) === 'pass'
}

/** DX4: a re-gate round for the failed round's result passes, and the change moves back to gating passed, count 0. */
function regatePassed(deps: DiagnosisStageDeps, row: ChangeRow, failed: RoundRow, within: () => void): void {
  const executions = deps.fix.store
  executions.db.transaction(() => {
    // attempt_id is NOT NULL: the re-gate answers the failed round's own attempt; no fix attempt was sent.
    executions.insertRegateRound(failed, failed.attemptId)
    executions.transition(row.executionId, row.change, row, { state: 'gating', step: null, passedAt: deps.round.now(), fixRounds: 0 })
    within()
  })()
}

/**
 * Decision 7's release after `Reassign`: the change's spawned, worktree-scoped
 * members of every group it implemented under before (the revision's group
 * and earlier Reassign targets), other than its current group, are released
 * once ready — a busy one on a later tick. Not a planned step: it writes no
 * execution state.
 */
export function releaseReassigned(
  deps: Pick<RoundDeps, 'team' | 'executions' | 'plans' | 'records' | 'releases' | 'groupScoped'> & { decisions: Pick<DecisionStore, 'decision'> },
  change: ChangeRow,
): void {
  const worktree = change.worktree
  const current = change.groupOverride
  if (worktree === null || current === null) return
  const execution = deps.executions.execution(change.executionId)
  if (execution === null) return
  const content = deps.plans.revision(execution.planId, execution.revision)?.content
  const entry = content?.changes.find(candidate => candidate.change === change.change)
  const reviewGroup = entry?.reviewGroup ?? content?.reviewGroup ?? null
  const earlier = new Set<string>(entry?.group ? [entry.group] : [])
  for (const diagnosis of new DiagnosisStore(deps.executions.db).ofChange(change.executionId, change.change)) {
    if (diagnosis.outcome !== 'reassign' || diagnosis.decisionId === null) continue
    const outcome = diagnosisOutcome(deps.decisions.decision(deps.team.teamId, diagnosis.decisionId)?.choice ?? '')
    if (outcome?.kind === 'reassign') earlier.add(outcome.group)
  }
  earlier.delete(current)
  if (reviewGroup !== null) earlier.delete(reviewGroup)
  const members = [...deps.records()].filter(member =>
    member.archivedAt == null && member.spawned === true && member.groupId != null && earlier.has(member.groupId)
    && deps.groupScoped(deps.team.teamId, member.groupId)
    && (member.projectPath === worktree || member.projectPath.startsWith(`${worktree}/`)))
  for (const member of members) {
    if (deps.releases.readiness(member.sessionId).ready) {
      deps.releases.release(member.sessionId, ` after a diagnosis reassigned change ${change.change} to ${current}`)
    }
  }
}
