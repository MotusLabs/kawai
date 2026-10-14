// One submitted result in task detail (task-results-handoffs 7.1, design
// D1/D2/D4/D6): summary, commit or diff reference, worktree, the tests run
// with their outcomes — labeled **claimed**, never verified — limitations,
// the pinned revision and submitter, the Needs re-evaluation badge, the
// acceptance, and the findings bound to this result with kind, verdict, and
// author. Superseded results render the same way, beneath the outstanding one.
import type { ReactNode } from 'react'
import type { Session } from '@shared/types'
import type { TaskResult } from '@shared/teamTasks'
import { actorLabel } from './teamTaskLabels'

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
