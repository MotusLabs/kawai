// The publication handoff panel (owner-publication-handoff D11), above the
// task's direction: the pending handoff's requester, base revision and its
// contract identity, base commit, evidence and payload hash, each prepared
// field against the base revision's (a carried field reads "unchanged"; a
// contract shows its parse view), and three actions — **Publish prepared
// revision** (**Publish and notify** when the request asked to notify),
// **Edit before publishing** (which asks before replacing an existing
// draft) and **Decline** (a reason required). Each publish and decline
// carries a client command key armed per payload, outside the reserved
// `handoff:` prefix, so a double click or a resend replays. A stale
// handoff can only be declined; an ended one is history, with a published
// one's revision and "published as edited" when the hashes differ.
import { useState } from 'react'
import type { TaskHandoff } from '@shared/taskHandoffs'
import type { TaskDraft, TaskRevision, TeamTaskSummary } from '@shared/teamTasks'
import { parseContract } from '@shared/implementationContract'
import type { Session } from '@shared/types'
import type { TaskActFn } from './TaskDirectionEditor'
import { sessionLabel } from './teamTaskLabels'
import TaskContractView from './TaskContractView'

const short = (hash: string | null) => (hash ? hash.slice(0, 12) : 'none')

function FieldDiff({ label, base, prepared }: { label: string; base: string | null; prepared: string | null }) {
  if (prepared === null) return <p className="text-chat-meta text-secondary">{label}: unchanged</p>
  return <div className="text-chat-meta" data-testid={`handoff-diff-${label.toLowerCase()}`}>
    <p className="font-semibold">{label}</p>
    <p className="whitespace-pre-wrap text-secondary line-through" aria-label={`Base ${label.toLowerCase()}`}>{base ?? '(none)'}</p>
    <p className="whitespace-pre-wrap" aria-label={`Prepared ${label.toLowerCase()}`}>{prepared}</p>
  </div>
}

function PendingHandoff({ task, handoff, base, draft, sessions, disabled, act }: {
  task: TeamTaskSummary; handoff: TaskHandoff; base: TaskRevision | undefined; draft: TaskDraft | null | undefined; sessions: Session[]; disabled: boolean; act: TaskActFn
}) {
  const [reason, setReason] = useState('')
  const [confirmReplace, setConfirmReplace] = useState(false)
  const open = handoff.state === 'open'
  const parsed = handoff.contract ? parseContract(handoff.contract) : null
  const load = (replace: boolean) => {
    setConfirmReplace(false)
    act('draft', { type: 'team-task-handoff-load-draft', handoffId: handoff.id, replace })
  }
  return <div className="flex flex-col gap-2" data-testid={`task-handoff-${handoff.id}`}>
    <p className="text-chat-body">
      Prepared revision on revision {handoff.baseRevision} · {handoff.state} · requested by {sessionLabel(handoff.requesterSession, sessions)}
      {handoff.requesterGroup ? ` (${handoff.requesterGroup})` : ''}
    </p>
    <p className="text-chat-meta text-secondary" data-testid="handoff-provenance">
      Base contract {short(handoff.baseContractHash)} · base commit {handoff.baseCommit ?? 'none'} · payload {short(handoff.payloadHash)}
      {handoff.evidenceRefs.length > 0 ? ` · evidence: ${handoff.evidenceRefs.join(', ')}` : ''}
    </p>
    {handoff.state === 'stale' && <p role="alert" className="text-chat-meta" data-testid="handoff-stale">
      Revision {task.revision} was published since revision {handoff.baseRevision}: this handoff can no longer be published. The requester may re-prepare it.</p>}
    <FieldDiff label="Direction" base={base?.direction ?? null} prepared={handoff.direction} />
    <FieldDiff label="Acceptance" base={base?.acceptance ?? null} prepared={handoff.acceptance} />
    {parsed?.contract ? <TaskContractView identity={undefined} contract={parsed.contract} testId="handoff-contract" /> : <FieldDiff label="Contract" base={null} prepared={handoff.contract} />}
    <p className="text-chat-meta">Rationale: {handoff.rationale}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-primary" data-testid="handoff-publish" disabled={disabled || !open}
        onClick={() => act('publish', { type: 'team-task-handoff-publish', handoffId: handoff.id }, { slot: `handoff-publish:${handoff.id}`, payload: handoff.id })}>
        {handoff.notify ? 'Publish and notify' : 'Publish prepared revision'}</button>
      <button type="button" className="btn" data-testid="handoff-edit" disabled={disabled || !open}
        onClick={() => (draft ? setConfirmReplace(true) : load(false))}>Edit before publishing</button>
    </div>
    {confirmReplace && <div role="alertdialog" aria-label="Replace draft" className="text-chat-meta" data-testid="handoff-replace-confirm">
      Your saved draft (based on revision {draft?.baseRevision}) will be replaced by the prepared revision.
      <button type="button" className="btn ml-2" data-testid="handoff-replace-yes" disabled={disabled} onClick={() => load(true)}>Replace draft</button>
      <button type="button" className="btn ml-2" onClick={() => setConfirmReplace(false)}>Keep my draft</button>
    </div>}
    <div className="flex flex-wrap gap-2">
      <input className="input text-chat-body" aria-label="Decline reason" placeholder="Why decline (required)" value={reason}
        disabled={disabled} onChange={event => setReason(event.target.value)} />
      <button type="button" className="btn" data-testid="handoff-decline" disabled={disabled || !reason.trim()}
        onClick={() => act('publish', { type: 'team-task-handoff-decline', handoffId: handoff.id, reason: reason.trim() },
          { slot: `handoff-decline:${handoff.id}`, payload: reason.trim() })}>Decline</button>
    </div>
  </div>
}

export default function TaskPublicationHandoffPanel({ task, handoffs, revisions, draft, sessions, disabled, act }: {
  task: TeamTaskSummary
  handoffs: TaskHandoff[] | undefined
  revisions: TaskRevision[]
  draft: TaskDraft | null | undefined
  sessions: Session[]
  disabled: boolean
  act: TaskActFn
}) {
  if (!handoffs?.length) return null
  const pending = handoffs.find(handoff => handoff.state === 'open' || handoff.state === 'stale')
  const ended = handoffs.filter(handoff => handoff !== pending)
  return <section className="mb-3 rounded border border-default p-2" aria-label="Publication handoff" data-testid="task-handoff-panel">
    {pending && <PendingHandoff task={task} handoff={pending} base={revisions.find(revision => revision.revision === pending.baseRevision)}
      draft={draft} sessions={sessions} disabled={disabled} act={act} />}
    {ended.length > 0 && <ul className="mt-2 text-chat-meta text-secondary" data-testid="handoff-history">
      {ended.map(handoff => <li key={handoff.id} data-testid={`handoff-ended-${handoff.id}`}>
        Prepared on revision {handoff.baseRevision} by {sessionLabel(handoff.requesterSession, sessions)} · {handoff.state}
        {handoff.state === 'published' && handoff.publishedRevision !== null ? ` as revision ${handoff.publishedRevision}` : ''}
        {handoff.state === 'published' && handoff.publishedPayloadHash && handoff.publishedPayloadHash !== handoff.payloadHash
          ? ` (published as edited: prepared ${short(handoff.payloadHash)}, published ${short(handoff.publishedPayloadHash)})` : ''}
        {handoff.stateReason ? ` · ${handoff.stateReason}` : ''}
      </li>)}
    </ul>}
  </section>
}
