// A plan's revisions, drafts, and history (durable-plans D7/D12). Each
// revision in review shows its diff summary against the approved revision —
// changed sections, added, removed, and reordered changes, and a changed
// strategy pin — with Approve (naming the exact revision, content hash, pin,
// and the approved revision the human saw when the dialog opened, so an
// approval that lands meanwhile makes this one stale) and Withdraw. Drafts can be
// discarded; every revision stays listed with its status, and the event
// history lists every command with its actor and reason.
import { useState } from 'react'
import type { Session, SendClientMessage } from '@shared/types'
import { planDiffSummary, type PlanDetail, type PlanRevision } from '@shared/plans'
import PlanCommandDialog, { sendPlanCommand } from './PlanCommandDialog'
import { PLAN_REVISION_LABELS, eventLabel, pinLabel, planActorLabel, shortHash } from './planLabels'

export default function PlanRevisionsSection({ teamPath, detail, sessions, sendMessage, connected, busy }: {
  teamPath: string
  detail: PlanDetail
  sessions: Session[]
  sendMessage: SendClientMessage
  connected: boolean
  busy: boolean
}) {
  const { plan } = detail
  const approved = detail.revisions.find(revision => revision.revision === plan.currentApprovedRevision) ?? null
  const inReview = detail.revisions.filter(revision => revision.status === 'in_review')
  const isOpen = plan.lifecycle === 'open'
  // The approved revision each open Approve dialog was shown, per revision.
  const [seen, setSeen] = useState<Record<number, number | null>>({})
  const seenApproved = (number: number) => (number in seen ? seen[number] ?? null : plan.currentApprovedRevision)
  return <section data-testid="plan-revisions" aria-labelledby="plan-revisions-heading" className="mt-3">
    <h4 id="plan-revisions-heading" className="font-medium">Revisions</h4>
    {inReview.length === 0 && <p className="text-chat-meta text-secondary">No revision is waiting for review.</p>}
    {inReview.map(revision => <div key={revision.revision} className="mt-2 border border-border p-2" data-testid={`plan-review-${revision.revision}`}>
      <h5 className="font-medium">Revision {revision.revision} — in review</h5>
      <p className="text-chat-meta text-secondary">by {planActorLabel(revision.author, sessions)} · {shortHash(revision.contentHash)} · {pinLabel(revision.pin)}</p>
      <DiffSummary base={approved} next={revision} />
      <div className="mt-2 flex flex-wrap gap-2">
        <PlanCommandDialog teamPath={teamPath} slot={`approve:${plan.id}:${revision.revision}`} openLabel={`Approve revision ${revision.revision}`}
          confirmLabel="Approve" testId={`plan-approve-${revision.revision}`} primary connected={connected} busy={busy} disabled={!isOpen}
          onOpen={() => setSeen(current => ({ ...current, [revision.revision]: plan.currentApprovedRevision }))}
          onConfirm={() => {
            const expectedApprovedRevision = seenApproved(revision.revision)
            const payload = { planId: plan.id, revision: revision.revision, contentHash: revision.contentHash, expectedApprovedRevision }
            sendPlanCommand(teamPath, sendMessage, 'approve', `approve:${plan.id}:${revision.revision}`, payload,
              ids => ({ type: 'team-plan-approve', teamPath, ...ids, ...payload }))
          }}>
          <p className="text-chat-meta">Approve exactly revision {revision.revision}, content hash <code>{revision.contentHash}</code>, pinned to {pinLabel(revision.pin).toLowerCase()}.</p>
          <p className="text-chat-meta text-secondary">It becomes the plan's direction{seenApproved(revision.revision) !== null ? `, superseding revision ${seenApproved(revision.revision)}` : ''}. Approval starts no work: nothing is dispatched, and no task or mail is created.</p>
        </PlanCommandDialog>
        <PlanCommandDialog teamPath={teamPath} slot={`withdraw:${plan.id}:${revision.revision}`} openLabel="Withdraw" confirmLabel={`Withdraw revision ${revision.revision}`}
          testId={`plan-withdraw-${revision.revision}`} connected={connected} busy={busy}
          onConfirm={() => {
            const payload = { planId: plan.id, revision: revision.revision }
            sendPlanCommand(teamPath, sendMessage, 'withdraw', `withdraw:${plan.id}:${revision.revision}`, payload,
              ids => ({ type: 'team-plan-withdraw', teamPath, ...ids, ...payload }))
          }}>
          <p className="text-chat-meta">The revision stays readable as withdrawn; drafts are kept.</p>
        </PlanCommandDialog>
      </div>
    </div>)}

    <h5 className="mt-3 text-chat-meta font-medium text-secondary">Drafts</h5>
    {detail.drafts.length === 0 ? <p className="text-chat-meta text-secondary">(none)</p> : <ul className="space-y-1">
      {detail.drafts.map(draft => <li key={draft.draftId} className="flex flex-wrap items-center gap-2 text-chat-meta" data-testid={`plan-draft-${draft.draftId}`}>
        <span>{draft.draftId} · by {planActorLabel(draft.author, sessions)} · based on {draft.baseRevision === null ? 'no approved revision' : `revision ${draft.baseRevision}`} · {shortHash(draft.contentHash)}</span>
        <PlanCommandDialog teamPath={teamPath} slot={`discard:${plan.id}:${draft.draftId}`} openLabel="Discard draft" confirmLabel={`Discard draft ${draft.draftId}`}
          testId={`plan-discard-${draft.draftId}`} connected={connected} busy={busy}
          onConfirm={() => {
            const payload = { planId: plan.id, draftId: draft.draftId }
            sendPlanCommand(teamPath, sendMessage, 'withdraw', `discard:${plan.id}:${draft.draftId}`, payload,
              ids => ({ type: 'team-plan-withdraw', teamPath, ...ids, ...payload }))
          }}>
          <p className="text-chat-meta">The draft is deleted; the history records its id and last hash.</p>
        </PlanCommandDialog>
      </li>)}
    </ul>}

    <h5 className="mt-3 text-chat-meta font-medium text-secondary">All revisions</h5>
    <ul className="text-chat-meta" data-testid="plan-revision-list">
      {[...detail.revisions].reverse().map(revision => <li key={revision.revision}>
        Revision {revision.revision} — {PLAN_REVISION_LABELS[revision.status]} · by {planActorLabel(revision.author, sessions)} · {shortHash(revision.contentHash)}
      </li>)}
      {detail.revisions.length === 0 && <li className="text-secondary">(none submitted)</li>}
    </ul>

    <h5 className="mt-3 text-chat-meta font-medium text-secondary">History</h5>
    <ol className="text-chat-meta" data-testid="plan-history">
      {[...detail.events].reverse().map(event => <li key={event.id}>
        {new Date(event.createdAt).toLocaleString()} · {eventLabel(event.kind)}{event.revision !== null ? ` revision ${event.revision}` : ''}
        {event.draftId ? ` (draft ${event.draftId})` : ''} · {planActorLabel(event.actor, sessions)}{event.reason ? ` — ${event.reason}` : ''}
      </li>)}
    </ol>
  </section>
}

function DiffSummary({ base, next }: { base: PlanRevision | null; next: PlanRevision }) {
  const diff = planDiffSummary(base, next)
  const parts = [
    diff.sections.length > 0 ? `changed: ${diff.sections.join(', ')}` : 'no section changes',
    ...(diff.addedChanges.length > 0 ? [`added ${diff.addedChanges.join(', ')}`] : []),
    ...(diff.removedChanges.length > 0 ? [`removed ${diff.removedChanges.join(', ')}`] : []),
    ...(diff.reordered ? ['changes reordered'] : []),
    ...(diff.pinChanged ? ['strategy pin changed'] : []),
  ]
  return <p className="text-chat-meta text-secondary" data-testid="plan-diff">
    {base ? `Compared with approved revision ${base.revision}` : 'No approved revision yet — all content is new'}: {parts.join('; ')}
  </p>
}
