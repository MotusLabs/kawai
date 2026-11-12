// Opening a diagnosis (review-convergence decision 4, table DO): at the fix
// step of a failed round, before any fix dispatch, a convergence signal on
// the round's own counted review — when it is the window's newest — or the
// backstop opens one diagnosis instead of the fix. One transaction writes the
// diagnosis row (`UNIQUE(round_id)`), the Kawai-asked card and its mail, the
// convergence stall-alert row naming that mail, the move to
// `gating`/`diagnosing` (leaving the landing slot as the fix transition
// does), and the journal entry. A crash before the commit leaves nothing and
// the next tick re-runs the step; after it, the planner sees `diagnosing`.
import type { Database } from 'bun:sqlite'
import { blocking, foldLedger } from '../../../shared/findingsLedger'
import { convergenceOf, signalFindings, signalLine, type DiagnosisSignal } from '../../../shared/reviewConvergence'
import { isBlocking } from '../../../shared/reviewFindings'
import { SYSTEM_ACTOR } from '../../../shared/team'
import type { MailboxStore } from '../../team/mailboxStore'
import type { TaskStore } from '../../team/taskStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import { DecisionStore } from '../decisions/decisionStore'
import { diagnosisOptions, diagnosisText, raiseDiagnosisCard, reassignTargets, rejectable } from '../decisions/diagnosisCards'
import type { PlanStore } from '../planStore'
import { StallAlertStore } from '../supervision/stallAlertStore'
import { DiagnosisStore, type DiagnosisRow } from './diagnosisStore'
import type { ChangeRow, RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'

export interface DiagnosisDeps {
  db: Database
  team: TeamIdentity
  executions: ExecutionStore
  plans: PlanStore
  tasks: TaskStore
  mail: Pick<MailboxStore, 'enqueue'>
  /** A test seam: called inside the open transaction after the card insert (a crash there rolls everything back). */
  afterCardInsert?: () => void
}

/** What the fix step reads about a round's diagnosis. */
export type DiagnosisVerdict =
  | { kind: 'none' }
  | { kind: 'opened'; diagnosis: DiagnosisRow }
  /** A diagnosis already exists for the round: open (the stage owns it), or closed (the fix goes out — DO6). */
  | { kind: 'exists'; diagnosis: DiagnosisRow }

/** The signals the failed round's review raises in the change's window (DO1, DO3, DO7); empty for a review-less or text-reviewed round. */
export function roundSignals(deps: Pick<DiagnosisDeps, 'tasks'>, diagnoses: DiagnosisStore, change: ChangeRow, round: RoundRow): { signals: DiagnosisSignal[]; reviewSubmissionId: string | null; counts: number[] } {
  if (change.taskId === null) return { signals: [], reviewSubmissionId: null, counts: [] }
  const submissions = deps.tasks.findings.countedSubmissions(change.taskId)
  const events = deps.tasks.findings.events(change.taskId)
  const convergence = convergenceOf(submissions, events, diagnoses.anchor(change.executionId, change.change))
  const review = round.blockingIds === null ? null : submissions.find(submission => submission.resultId === round.resultId) ?? null
  const newest = convergence.window.at(-1)
  if (review === null || newest === undefined || newest.submissionId !== review.id) return { signals: [], reviewSubmissionId: review?.id ?? null, counts: convergence.counts }
  return { signals: convergence.signals, reviewSubmissionId: review.id, counts: convergence.counts }
}

/**
 * Table DO for one failed round at the fix step. `backstop` is the count
 * rule's verdict for this round. Returns `opened` when the diagnosis was
 * written (no fix goes out), `exists` when one already stood, else `none`.
 */
export function openDiagnosisIfDue(deps: DiagnosisDeps, change: ChangeRow, round: RoundRow, backstop: { reached: boolean; count: number; limit: number }): DiagnosisVerdict {
  const diagnoses = new DiagnosisStore(deps.db)
  const existing = diagnoses.forRound(round.id)
  if (existing !== null) return { kind: 'exists', diagnosis: existing }
  if (change.taskId === null) return { kind: 'none' }
  const found = roundSignals(deps, diagnoses, change, round)
  const signals: DiagnosisSignal[] = [...found.signals, ...(backstop.reached ? [{ kind: 'backstop' as const, count: backstop.count, limit: backstop.limit }] : [])]
  if (signals.length === 0) return { kind: 'none' }
  const execution = deps.executions.execution(change.executionId)
  const plan = execution === null ? null : deps.plans.get(execution.planId)
  if (execution === null || plan === null) return { kind: 'none' }
  const taskId = change.taskId
  const ledger = foldLedger(deps.tasks.findings.countedSubmissions(taskId), deps.tasks.findings.events(taskId))
  const content = deps.plans.revision(execution.planId, execution.revision)?.content
  const entry = content?.changes.find(candidate => candidate.change === change.change)
  const current = change.groupOverride ?? entry?.group ?? null
  const named = new Set([...signalFindings(signals), ...blocking(ledger).map(row => row.id)])
  const text = diagnosisText({
    plan: { id: plan.id, title: plan.title }, change: change.change, signals, counts: found.counts,
    findings: ledger.filter(row => named.has(row.id)),
  })
  const options = diagnosisOptions({
    reject: rejectable(signals, ledger, row => isBlocking(row.level, row.state)),
    reassignTo: reassignTargets(content?.changes ?? [], current),
  })
  const decisions = new DecisionStore(deps.db)
  const alerts = new StallAlertStore(deps.db)
  const opened = deps.db.transaction(() => {
    const fresh = deps.executions.change(change.executionId, change.change)
    if (fresh === null || fresh.generation !== change.generation) return null
    const card = raiseDiagnosisCard({ decisions, mail: deps.mail, plans: deps.plans }, {
      team: deps.team, planId: execution.planId, revision: execution.revision, change: change.change, taskId,
      question: text.question, context: text.context, options,
    })
    deps.afterCardInsert?.()
    const diagnosis = diagnoses.insert({
      executionId: change.executionId, change: change.change, roundId: round.id, reviewSubmissionId: found.reviewSubmissionId,
      signals, cardId: card.id, messageId: card.messageId,
    })
    const stall = { kind: 'convergence' as const, episodeKey: diagnosis.id, signals, cardId: card.id, awaitingRevision: null }
    alerts.insert({
      teamId: deps.team.teamId, planId: execution.planId, executionId: change.executionId, change: change.change, kind: 'convergence', episodeKey: diagnosis.id,
      detail: { stage: 'kawai', holder: null, progress: null, activity: null, stall }, messageId: card.messageId,
    })
    deps.executions.transition(change.executionId, change.change, fresh, { state: 'gating', step: 'diagnosing' })
    deps.tasks.appendJournal(taskId, SYSTEM_ACTOR,
      `Round ${round.number} failed and opened diagnosis ${diagnosis.id} instead of a fix round (card ${card.id}): ${signals.map(signalLine).join('; ')}`)
    return diagnosis
  })()
  return opened === null ? { kind: 'none' } : { kind: 'opened', diagnosis: opened }
}
