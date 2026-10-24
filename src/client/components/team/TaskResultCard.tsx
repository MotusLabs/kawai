// One submitted result in task detail (task-results-handoffs 7.1, design
// D1/D2/D4/D6): summary, commit or diff reference, worktree, the tests run
// with their outcomes — labeled **claimed**, never verified — limitations,
// the pinned revision and submitter, the Needs re-evaluation badge, the
// acceptance, and the findings bound to this result with kind, verdict, and
// author. Superseded results render the same way, beneath the outstanding one.
// Kawai's own check of the result (independent-verification D12) renders as
// "Checked by Kawai": each fact with its status, or why the check could not
// run — informational, never a gate.
import type { ReactNode } from 'react'
import type { Session } from '@shared/types'
import type { ResultFactStatus, TaskResult, TaskResultCheck } from '@shared/teamTasks'
import { actorLabel } from './teamTaskLabels'

const STATUS_LABEL: Record<ResultFactStatus, string> = { pass: 'pass', warn: 'warn', fail: 'fail', unknown: 'unknown' }

function statusLine(label: string, status: ResultFactStatus, detail?: string | null) {
  return <p data-testid="result-check-fact">
    {label}: <span data-testid={`result-check-${status}`}>{STATUS_LABEL[status]}</span>
    {detail ? <span className="text-secondary"> — {detail}</span> : null}
  </p>
}

/** One stored check: what it found, or why it could not run (D2/D12). */
function CheckView({ check }: { check: TaskResultCheck }) {
  if (check.status === 'pending') {
    return <p data-testid="result-check-pending">Check running… (requested {new Date(check.createdAt).toLocaleString()})</p>
  }
  if (check.status === 'unavailable') {
    return <p data-testid="result-check-unavailable">Check unavailable: {check.reason}</p>
  }
  const facts = check.facts
  if (!facts || facts.version !== 1) {
    return <p data-testid="result-check-unavailable">Check unavailable: no facts were stored</p>
  }
  return <div>
    {statusLine(`Commit ${facts.commit.sha ?? facts.commit.given ?? '?'}`, facts.commit.status, facts.commit.note)}
    {facts.head && statusLine(`Worktree HEAD${facts.head.branch ? ` (${facts.head.branch})` : ''}`, facts.head.status, facts.head.note)}
    {facts.clean && (facts.clean.paths.length > 0
      ? statusLine('Worktree clean', facts.clean.status,
        `${facts.clean.paths.join(', ')}${facts.clean.more > 0 ? ` (+${facts.clean.more} more)` : ''}`)
      : statusLine('Worktree clean', facts.clean.status, facts.clean.note))}
    {statusLine('Recorded full check', facts.recorded.status, facts.recorded.note
      ?? (facts.recorded.recordBun ? `bun ${facts.recorded.recordBun}` : null))}
    {facts.base.status === 'fail'
      ? statusLine(`Merge into ${facts.base.ref}`, facts.base.status,
        `conflicts: ${facts.base.conflicts.join(', ')}${facts.base.moreConflicts > 0 ? ` (+${facts.base.moreConflicts} more)` : ''}`)
      : statusLine(`Merge into ${facts.base.ref}`, facts.base.status,
        facts.base.behind !== null ? `${facts.base.behind === 0 ? 'up to date' : `${facts.base.behind} commit(s) behind`}` : facts.base.note)}
    {statusLine('Other open branches', facts.branches.status,
      `${facts.branches.comparedCount} compared${facts.branches.skipped > 0 ? `, ${facts.branches.skipped} skipped` : ''}`)}
    {facts.branches.compared.map(entry => (entry.status === 'pass' ? null : (
      <p key={entry.taskId} data-testid="result-check-branch">
        task {entry.taskId}: {entry.status}
        {entry.conflicts.length > 0 && <span> — conflicts: {entry.conflicts.join(', ')}{entry.moreConflicts > 0 ? ` (+${entry.moreConflicts} more)` : ''}</span>}
        {entry.overlap.length > 0 && <span> — both change: {entry.overlap.join(', ')}{entry.moreOverlap > 0 ? ` (+${entry.moreOverlap} more)` : ''}</span>}
      </p>
    )))}
  </div>
}

export default function TaskResultCard({ result, sessions, children }: {
  result: TaskResult
  sessions: Session[]
  /** The result's actions (accept, handoffs), rendered under its evidence. */
  children?: ReactNode
}) {
  const outstanding = result.supersededBy === null
  return <article className="mt-2 border border-border p-2" data-testid="task-result" data-result-id={result.id} data-outstanding={outstanding}>
    <p className="flex flex-wrap gap-2 text-chat-meta text-secondary">
      <span>{outstanding ? 'Outstanding result' : 'Superseded result'}</span>
      <span>by {actorLabel(result.submittedBy, sessions)}</span>
      <span>{new Date(result.createdAt).toLocaleString()}</span>
      <span>pinned to revision {result.taskRevision}</span>
      {result.needsReevaluation && <span className="font-medium text-chat-danger" data-testid="result-reevaluation">Needs re-evaluation</span>}
      {result.acceptedBy && <span className="font-medium" data-testid="result-accepted">Accepted by {actorLabel(result.acceptedBy, sessions)}</span>}
    </p>
    <p className="whitespace-pre-wrap text-chat-body" data-testid="result-summary">{result.summary}</p>
    {result.commit && <p className="break-all text-chat-meta">Commit <code>{result.commit}</code></p>}
    {result.diff && <p className="break-all text-chat-meta">Diff <code>{result.diff}</code></p>}
    {result.worktree && <p className="break-all text-chat-meta">Worktree: {result.worktree}</p>}
    <div className="mt-1 text-chat-meta" data-testid="result-tests">
      <p className="text-secondary">Tests — outcomes are the submitter's claims, not verified evidence</p>
      {result.tests.length === 0 && <p className="text-secondary">No tests reported</p>}
      {result.tests.map((test, index) => <p key={index} data-testid="result-test">
        {test.description}: {test.outcome} <span className="text-secondary">(claimed)</span>
      </p>)}
    </div>
    {result.limitations && <p className="mt-1 whitespace-pre-wrap text-chat-meta">Limitations: {result.limitations}</p>}
    {result.checks && <div className="mt-1 text-chat-meta" data-testid="result-check">
      <p className="text-secondary">Checked by Kawai — informational, never a gate
        {result.checks.newest ? <> · {new Date(result.checks.newest.createdAt).toLocaleString()}</> : null}
        {result.checks.earlier > 0 && <> · {result.checks.earlier} earlier check{result.checks.earlier === 1 ? '' : 's'}</>}
      </p>
      {result.checks.newest === null && <p data-testid="result-check-pending">Not checked yet</p>}
      {result.checks.newest !== null && <CheckView check={result.checks.newest} />}
    </div>}
    <div className="mt-1 text-chat-meta" data-testid="result-findings">
      {result.findings.length === 0
        ? <p className="text-secondary">No findings on this result</p>
        : result.findings.map(findings => <p key={findings.id} data-testid="result-finding" className="border-l-2 border-border pl-2">
          {findings.kind === 'qa' ? 'QA' : 'Review'} · {findings.verdict} · {actorLabel(findings.author, sessions)} · {new Date(findings.createdAt).toLocaleString()}
          <span className="block whitespace-pre-wrap">{findings.findings}</span>
        </p>)}
    </div>
    {children}
  </article>
}
