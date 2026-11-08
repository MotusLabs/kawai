// The Findings section of task detail (review-findings-ledger D10): one row
// per finding of the task's ledger — id, level, state, and clause — each
// with its transitions behind a toggle, every one naming its result,
// submission, or decision and its time. A disputed finding on a task no plan
// owns gets **Uphold** and **Reject** with a rationale: the human decides it
// here (the server also lets the task's creator decide with
// `task_decide_dispute`). A plan task's disputes are decided on their
// decision card, so the section names the card instead. Text-only findings
// have no ledger rows; they stay readable on their result cards.
import { useState } from 'react'
import type { HumanTaskDetail, LedgerRow } from '@shared/teamTasks'
import type { TaskActFn } from './TaskDirectionEditor'

const STATE_LABEL: Record<LedgerRow['state'], string> = {
  accepted: 'accepted', unsupported: 'unsupported', advisory: 'advisory', 'out-of-contract': 'out of contract',
  disputed: 'disputed', rejected: 'rejected', resolved: 'resolved', 'still-open': 'still open', reopened: 'reopened', superseded: 'superseded',
}

function transitionSource(entry: LedgerRow['transitions'][number]): string {
  if (entry.cardId) return `decision card ${entry.cardId}`
  if (entry.source === 'submission') return `submission ${entry.sourceId}${entry.resultId ? ` on result ${entry.resultId}` : ''}`
  return `event ${entry.sourceId}`
}

function DisputeDecision({ row, disabled, act }: { row: LedgerRow; disabled: boolean; act: TaskActFn }) {
  const [rationale, setRationale] = useState('')
  const decide = (decision: 'uphold' | 'reject') => act('decide-dispute', {
    type: 'team-task-decide-dispute', findingId: row.id, decision, rationale: rationale.trim(),
  })
  return <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="finding-decision">
    <input className="input text-chat-body" aria-label={`Rationale for ${row.id}`} placeholder="Rationale (required)"
      value={rationale} disabled={disabled} onChange={event => setRationale(event.target.value)} />
    <button type="button" className="btn" disabled={disabled || !rationale.trim()} onClick={() => decide('uphold')}>Uphold {row.id}</button>
    <button type="button" className="btn" disabled={disabled || !rationale.trim()} onClick={() => decide('reject')}>Reject {row.id}</button>
  </div>
}

function FindingRow({ row, planTask, disabled, act }: { row: LedgerRow; planTask: boolean; disabled: boolean; act: TaskActFn }) {
  const [open, setOpen] = useState(false)
  const disputed = row.state === 'disputed'
  return <li className="mt-2 border-l-2 border-border pl-2" data-testid="finding-row" data-finding-id={row.id} data-state={row.state}>
    <p className="flex flex-wrap gap-2">
      <span className="font-medium">{row.id}</span>
      <span>{row.level}</span>
      <span data-testid="finding-state" className={disputed || row.state === 'accepted' || row.state === 'still-open' || row.state === 'reopened' ? 'text-chat-danger' : ''}>
        {STATE_LABEL[row.state]}{row.regressed ? ' (regressed)' : ''}
      </span>
      <span className="text-secondary">{row.clause ?? 'no clause'}</span>
      <button type="button" className="text-secondary underline" aria-expanded={open} data-testid="finding-history-toggle"
        onClick={() => setOpen(value => !value)}>{open ? 'Hide history' : `History (${row.transitions.length})`}</button>
    </p>
    {row.locus && <p className="break-all text-secondary">{row.locus}</p>}
    {open && <ol className="mt-1" data-testid="finding-transitions">
      {row.transitions.map(entry => <li key={`${entry.source}:${entry.sourceId}:${entry.seq}`} data-testid="finding-transition" data-kind={entry.kind}>
        {entry.kind} · {transitionSource(entry)} · {new Date(entry.at).toLocaleString()}
        {entry.contractIdentity && <span className="text-secondary"> · {entry.contractIdentity}</span>}
        {entry.note && <span className="block whitespace-pre-wrap text-secondary">{entry.note}</span>}
      </li>)}
    </ol>}
    {disputed && (planTask
      ? <p className="text-secondary" data-testid="finding-card-hint">Decided on its decision card in the Plans view</p>
      : <DisputeDecision row={row} disabled={disabled} act={act} />)}
  </li>
}

export default function TaskFindingsSection({ detail, disabled, act }: {
  detail: HumanTaskDetail
  /** Disconnected, or an action awaits its result. */
  disabled: boolean
  act: TaskActFn
}) {
  const rows = detail.findingsLedger ?? []
  const planTask = (detail.task.planId ?? null) !== null
  if (rows.length === 0) {
    return <p className="mt-1 text-chat-meta text-secondary" data-testid="task-findings-empty">No structured findings yet</p>
  }
  return <ul className="mt-1 text-chat-meta" data-testid="task-findings">
    {rows.map(row => <FindingRow key={row.id} row={row} planTask={planTask} disabled={disabled} act={act} />)}
  </ul>
}
