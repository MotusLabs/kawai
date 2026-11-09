// The manual-task convergence notice (review-convergence decision 10, A10):
// after a counted review commits on a task no execution owns, the shared
// signal function reads the task's window, anchored at the newest notice so
// one churn episode notices once. When a signal fires, one transaction
// inserts the `team_task_convergence_notices` row (keyed by the submission,
// so a replayed submission notices nothing), journals the signals, and
// enqueues one system message to the creator when the creator is a session.
// Nothing waits and no finding changes (I1): the creator judges it.
import { convergenceOf, signalFindings, signalLine, type ConvergenceSignal } from '../../shared/reviewConvergence'
import { SYSTEM_ACTOR } from '../../shared/team'
import type { TeamTask } from '../../shared/teamTasks'
import type { TaskStore } from './taskStore'

export const CONVERGENCE_NOTICE_TAG = 'convergence-notice'

export interface ConvergenceNotice {
  submissionId: string
  signals: ConvergenceSignal[]
  messageId: string | null
}

/** The newest notice's submission: the window starts after it. */
function anchorOf(store: TaskStore, taskId: string): string | null {
  const row = store.db.prepare('SELECT submission_id FROM team_task_convergence_notices WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(taskId) as { submission_id: string } | null
  return row?.submission_id ?? null
}

/** Notice a churning manual task after its counted review `submissionId` committed; null when no signal fires or it was noticed. */
export function noticeConvergence(store: TaskStore, input: { teamId: string; originPath: string; task: TeamTask; submissionId: string }): ConvergenceNotice | null {
  const { task, submissionId } = input
  return store.immediate(() => {
    const findings = store.findings
    const submissions = findings.countedSubmissions(task.id)
    if (!submissions.some(entry => entry.id === submissionId)) return null
    const { signals, counts } = convergenceOf(submissions, findings.events(task.id), anchorOf(store, task.id))
    if (signals.length === 0) return null
    const inserted = store.db.prepare('INSERT OR IGNORE INTO team_task_convergence_notices (submission_id, task_id, signals_json, created_at) VALUES (?, ?, ?, ?)')
      .run(submissionId, task.id, JSON.stringify(signals), new Date().toISOString())
    if (inserted.changes === 0) return null
    const named = signalFindings(signals)
    const lines = signals.map(signalLine).join('; ')
    store.appendJournal(task.id, SYSTEM_ACTOR,
      `Convergence notice after review ${submissionId}: ${lines}. Open P0/P1 by review: ${counts.join(' → ')}.${named.length > 0 ? ` Findings: ${named.join(', ')}.` : ''} Judge it by "Convergence" in the Review protocol; nothing waits.`)
    const creator = task.creator.kind === 'agent' ? task.creator.sessionId : null
    const message = creator === null || !store.mail ? null : store.mail.enqueue({
      teamId: input.teamId, toKind: 'session', toId: creator, fromKind: 'system', fromSession: null, fromGroup: null,
      originPath: input.originPath, tags: [CONVERGENCE_NOTICE_TAG], taskId: task.id, actor: 'system',
      body: [
        `Task "${task.title}" (${task.id}) is not converging: ${lines}.`,
        `Open P0/P1 by review: ${counts.join(' → ')}.`,
        'No execution owns it, so nothing waits. Judge it by the playbook ("Convergence" in docs/agent-collaboration.md, "Review protocol"): another fix round, rejecting the findings, `Amend the contract`, another writer, or escalation.',
      ].join('\n'),
    })
    return { submissionId, signals, messageId: message?.id ?? null }
  })
}
