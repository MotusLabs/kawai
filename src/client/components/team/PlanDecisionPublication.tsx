import { useState } from 'react'
import { renderContract } from '@shared/implementationContract'
import type { DecisionPublicationReceipt, DecisionPublicationView, PublicationContent, PublicationReview } from '@shared/planDecisions'
import type { SendClientMessage } from '@shared/types'
import { useTeamPlanStore } from '../../stores/teamPlanStore'

function PublishedRevision({ receipt }: { receipt: DecisionPublicationReceipt }) {
  return <details className="text-chat-meta" data-testid="plan-publication-receipt">
    <summary>Published task revision {receipt.publishedRevision}</summary>
    <dl className="mt-1 break-all">
      <dt>Decision</dt><dd>{receipt.decisionId}</dd>
      <dt>Approval command</dt><dd>{receipt.commandId}</dd>
      <dt>Published</dt><dd><time dateTime={receipt.publishedAt}>{receipt.publishedAt}</time></dd>
      <dt>Initial notice messages</dt><dd>{receipt.noticeMessageIds.join(', ') || 'None'}</dd>
      <dt>Requester message</dt><dd>{receipt.wakeupMessageId ?? 'None'}</dd>
    </dl>
  </details>
}

function ReviewContent({ title, content }: { title: string; content: PublicationContent }) {
  return <section aria-label={title} className="min-w-0 border border-border p-2">
    <h4 className="font-medium">{title}</h4>
    <dl className="space-y-1">
      <dt>Direction</dt><dd className="whitespace-pre-wrap break-words">{content.direction}</dd>
      <dt>Acceptance</dt><dd className="whitespace-pre-wrap break-words">{content.acceptance ?? 'None'}</dd>
      <dt>Implementation contract</dt>
      <dd className="whitespace-pre-wrap break-words">{content.contract ? renderContract(content.contract) : 'None'}</dd>
    </dl>
  </section>
}

function ReviewedPublication({ review }: { review: PublicationReview }) {
  return <>
    <p className="font-medium">{review.taskTitle} · {review.change}</p>
    <dl className="mt-1 grid gap-x-2 gap-y-1 break-all sm:grid-cols-[auto_1fr]">
      <dt>Base task revision</dt><dd>{review.baseIdentity} · {review.baseContentHash}</dd>
      <dt>Approved plan revision</dt><dd>{review.approvedPlanRevision}</dd>
      {review.execution && <>
        <dt>Execution</dt><dd>{review.execution.id} · revision {review.execution.revision} · sequence {review.execution.revisionSeq}</dd>
        <dt>Attempt</dt><dd>{review.execution.attemptId} · generation {review.execution.changeGeneration}</dd>
      </>}
      <dt>Prepared by</dt><dd>{review.requester.sessionId}{review.requester.groupId && ` · ${review.requester.groupId}`}</dd>
      <dt>Prepared rationale</dt><dd className="whitespace-pre-wrap break-words">{review.preparedRationale}</dd>
      <dt>Base commit</dt><dd>{review.baseCommit ?? 'None'}</dd>
      <dt>Evidence</dt><dd>{review.evidenceRefs.length ? <ul>{review.evidenceRefs.map(ref => <li key={ref}>{ref}</li>)}</ul> : 'None'}</dd>
      <dt>Notify current holder</dt><dd>Yes</dd>
      <dt>Prepared payload hash</dt><dd>{review.link.payloadHash}</dd>
      <dt>Binding hash</dt><dd>{review.link.bindingHash}</dd>
    </dl>
    <div className="mt-2 grid gap-2 md:grid-cols-2">
      <ReviewContent title="Before" content={review.before} />
      <ReviewContent title="After publication" content={review.after} />
    </div>
  </>
}

export default function PlanDecisionPublication({ teamPath, planId, cardId, publication, answered, connected, busy, onSend, onOpenTask }: {
  teamPath: string
  planId: string
  cardId: string
  publication: DecisionPublicationView
  answered: boolean
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
  onOpenTask: (taskId: string) => void
}) {
  const [rationale, setRationale] = useState('')
  const standing = useTeamPlanStore(state => state.views[teamPath]?.publicationReview)
  const approval = useTeamPlanStore(state => state.views[teamPath]?.publicationApprovals[cardId])
  const open = standing?.request.planId === planId && standing.request.cardId === cardId &&
    standing.link.bindingHash === publication.bindingHash && standing.link.handoffId === publication.handoffId
  const result = open ? standing.result : undefined
  const review = result && 'review' in result ? result.review : null
  const approvalResult = approval?.result
  const receipt = publication.receipt ?? (approvalResult && 'receipt' in approvalResult ? approvalResult.receipt : null)
  const refusal = approvalResult && 'error' in approvalResult ? approvalResult.error : null
  const mayRetry = approvalResult && 'reason' in approvalResult && approvalResult.reason === 'state'
  const blocked = !connected || busy || answered || !!receipt || !!approval?.result || !!approval?.requestId || review?.availability !== 'ready'
  const requestReview = () => {
    if (!connected) return
    const request = { type: 'team-plan-publication-review' as const, teamPath, planId, cardId, requestId: crypto.randomUUID() }
    useTeamPlanStore.getState().beginPublicationReview(request, publication)
    onSend(request)
  }
  const confirm = () => {
    if (blocked) return
    const command = useTeamPlanStore.getState().confirmPublication(teamPath, planId, cardId, rationale)
    if (command) onSend(command)
  }
  return <div className="mt-2 space-y-2 text-chat-meta">
    <p className="break-words">
      <button type="button" className="link" onClick={() => onOpenTask(publication.taskId)}>Open task {publication.taskId}</button>
      {' · '}Prepared handoff {publication.handoffId}
    </p>
    {receipt && <PublishedRevision receipt={receipt} />}
    {open ? <div role="group" aria-label="Prepared task publication" className="space-y-2 border border-border p-2"
      onKeyDown={event => { if (event.key === 'Escape') useTeamPlanStore.getState().closePublicationReview(standing.request) }}>
      {!result && <p role="status">{connected ? 'Loading publication review…' : 'Connection interrupted.'}</p>}
      {result && 'error' in result && <div role="status">
        <p>{result.error}</p>
        <button type="button" className="btn" disabled={!connected || busy} onClick={requestReview}>Request review again</button>
      </div>}
      {review && <ReviewedPublication review={review} />}
      {review?.unavailableReason && <p role="status">{review.unavailableReason}</p>}
      {refusal && <p role="alert" className="whitespace-pre-wrap">{refusal}</p>}
      {mayRetry && review?.availability === 'ready' && !answered && !receipt &&
        <button type="button" className="btn" disabled={!connected || busy} onClick={requestReview}>Review again to retry</button>}
      {review?.availability === 'ready' && !answered && !receipt && <>
        <label className="flex flex-col gap-1">
          Owner rationale (optional)
          <textarea className="input min-h-12 text-chat-body" value={approval ? approval.intent.rationale ?? '' : rationale}
            disabled={!connected || busy || !!approval} onChange={event => setRationale(event.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" disabled={blocked}
          onClick={confirm}>Approve and publish</button>
      </>}
      <button type="button" className="btn" onClick={() => useTeamPlanStore.getState().closePublicationReview(standing.request)}>Close review</button>
    </div> : <button type="button" className="btn" disabled={!connected || busy}
      onClick={requestReview}>Review prepared publication…</button>}
  </div>
}
