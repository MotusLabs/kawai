// A plan's revisions, drafts, and history (durable-plans D7/D12). Each
// revision in review shows its diff summary against the approved revision —
// changed sections, added, removed, and reordered changes, and a changed
// strategy pin — with Approve (naming the exact revision, content hash, pin,
// and the approved revision the human saw when the dialog opened, so an
// approval that lands meanwhile makes this one stale) and Withdraw. Drafts can be
// discarded; every revision stays listed with its status, and the event
// history lists every command with its actor and reason.
import { useState } from 'react'
import { useTeamPlanStore } from '../../stores/teamPlanStore'
import type { Session, SendClientMessage } from '@shared/types'
import { planDiffSummary, type PlanDetail, type PlanRevision } from '@shared/plans'
import type { PlanRevisionValidation } from '@shared/planValidation'
import PlanCommandDialog, { sendPlanCommand } from './PlanCommandDialog'
import PlanValidationSection, { standingLabel } from './PlanValidationSection'
import { PLAN_REVISION_LABELS, eventLabel, pinLabel, planActorLabel, shortHash } from './planLabels'

export default function PlanRevisionsSection({ teamPath, detail, sessions, sendMessage, connected, busy, validation, onCaptureStrategy }: {
  teamPath: string
  detail: PlanDetail
  sessions: Session[]
  sendMessage: SendClientMessage
  connected: boolean
  busy: boolean
  /** The pushed Validation sections, per standing revision (plan-validation D11). */
  validation: PlanRevisionValidation[] | null
  onCaptureStrategy?: () => void
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
      <ApproveStanding teamPath={teamPath} planId={plan.id} revision={revision}
        entry={validation?.find(item => item.revision === revision.revision) ?? null}
        sendMessage={sendMessage} connected={connected} />
      <PlanValidationSection teamPath={teamPath} planId={plan.id} revision={revision.revision} pin={revision.pin}
        validation={validation?.find(entry => entry.revision === revision.revision) ?? null}
        earlierRevisions={(validation ?? []).filter(entry => entry.revision < revision.revision)}
        onCaptureStrategy={onCaptureStrategy} sendMessage={sendMessage} connected={connected} busy={busy} />
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

    {approved && <PlanValidationSection teamPath={teamPath} planId={plan.id} revision={approved.revision} pin={approved.pin}
      validation={validation?.find(entry => entry.revision === approved.revision) ?? null}
      earlierRevisions={(validation ?? []).filter(entry => entry.revision < approved.revision)}
      onCaptureStrategy={onCaptureStrategy} sendMessage={sendMessage} connected={connected} busy={busy} />}

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

/**
 * The approve dialog's standing line (plan-validation 11.2): the revision's
 * validation standing beside Approve, and a `validation-current` refusal
 * rendered inline with its blocking counts and a **Validate** control.
 */
function ApproveStanding({ teamPath, planId, revision, entry, sendMessage, connected }: {
  teamPath: string
  planId: string
  revision: PlanRevision
  entry: PlanRevisionValidation | null
  sendMessage: SendClientMessage
  connected: boolean
}) {
  const view = useTeamPlanStore(state => state.views[teamPath])
  const failure = view?.failures.find(item => item.name === 'validation-current') ?? null
  const standing = entry?.standing ?? { state: 'not-validated' as const }
  const badge = standingLabel(standing)
  const readiness = entry?.report?.readiness ?? null
  return <div className="text-chat-meta" data-testid={`plan-approve-standing-${revision.revision}`}>
    <span data-tone={badge.tone}>Validation: {badge.label}</span>
    {failure && <p className="text-approval" data-testid={`plan-approve-refused-${revision.revision}`}>
      {failure.message}
      {readiness && standing.state === 'blocked' ? ` — ${readiness.errors.length} errors, ${readiness.unansweredQuestions.length} unanswered questions, ${readiness.unacceptedWarnings.length} unaccepted warnings` : ''}
      {' '}<button type="button" className="btn text-chat-meta" data-testid={`plan-approve-refused-${revision.revision}-validate`}
        disabled={!connected}
        onClick={() => {
          const requestId = crypto.randomUUID()
          useTeamPlanStore.getState().begin(teamPath, requestId, 'validate')
          sendMessage({ type: 'team-plan-validate', teamPath, requestId, planId, revision: revision.revision })
        }}>Validate</button>
    </p>}
  </div>
}
