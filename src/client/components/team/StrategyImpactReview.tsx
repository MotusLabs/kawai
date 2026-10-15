// The Strategy tab's impact sub-view (strategy-revision-impact D9, the
// `#/team/<key>/strategy/impact[/<revision>]` location): one review at a
// time — the current one by default — with its state and, for the current
// review only, the derived assessment in three groups. An affected row shows
// each standing revision's strategy pin, its gate, and the unassessed mark,
// the effective decision with its history, and the newest proposal, with the
// owner's **Decide** dialog; the review offers **Ask to assess**. Earlier
// reviews show only what was recorded in them. Every control disables while
// disconnected, and refusals render inside their dialog.
import { useState } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { PlanStrategyPin } from '@shared/plans'
import {
  IMPACT_DISPOSITION_LABELS, IMPACT_GATE_LABELS, IMPACT_GROUP_LABELS, IMPACT_REVIEW_STATE_LABELS,
  type ImpactDecision, type ImpactGroup, type ImpactPlanRow, type ImpactReviewRecord, type StrategyImpactDetail,
} from '@shared/strategyImpact'
import { sessionLabel, shortHash } from '../chat/strategyLabels'
import type { StrategyView } from '../../stores/strategyStore'
import { AskDialog, DecideDialog } from './ImpactDialogs'

const GROUPS: readonly ImpactGroup[] = ['affected', 'unaffected', 'historical']

export const pinText = (pin: PlanStrategyPin | null, strategyId: string | null) => {
  if (!pin) return 'No strategy pin'
  return pin.strategyId === strategyId ? `Strategy revision ${pin.revision}` : `Revision ${pin.revision} of another strategy record`
}

export default function StrategyImpactReview({ teamPath, view, impact, strategyId, connected, sessions, sendMessage, revision, onSelectRevision }: {
  teamPath: string
  view: StrategyView
  impact: StrategyImpactDetail
  strategyId: string
  connected: boolean
  sessions: Session[]
  sendMessage: SendClientMessage
  /** The review's strategy revision from the URL; absent = the current review. */
  revision?: string
  onSelectRevision: (revision: number) => void
}) {
  const [asking, setAsking] = useState(false)
  if (impact.reviews.length === 0) {
    return <p className="text-sm text-secondary" data-testid="impact-none">No impact review yet — approving a strategy revision opens one.</p>
  }
  const review = impact.reviews.find(entry => String(entry.revision) === revision)
    ?? impact.reviews.find(entry => entry.reviewId === impact.currentReviewId)
    ?? impact.reviews[0]!
  const current = review.reviewId === impact.currentReviewId
  return <section data-testid="strategy-impact-review" aria-labelledby="impact-review-title">
    <nav aria-label="Impact reviews" className="flex flex-wrap gap-1">
      {impact.reviews.map(entry => <button key={entry.reviewId} type="button" data-testid={`impact-review-tab-${entry.revision}`}
        aria-current={entry.reviewId === review.reviewId ? 'true' : undefined}
        className={`btn text-chat-meta ${entry.reviewId === review.reviewId ? 'btn-primary' : ''}`}
        onClick={() => onSelectRevision(entry.revision)}>
        Revision {entry.revision} · {IMPACT_REVIEW_STATE_LABELS[entry.state]}
      </button>)}
    </nav>
    <h4 id="impact-review-title" className="mt-3 font-medium">Impact review of strategy revision {review.revision}</h4>
    <p className="text-chat-meta text-secondary" data-testid="impact-review-state">
      {IMPACT_REVIEW_STATE_LABELS[review.state]} · opened {review.createdAt} · {shortHash(review.contentHash)}
    </p>
    {view.impactNotice && <p role="status" className="text-chat-meta text-secondary" data-testid="impact-notice">{view.impactNotice}</p>}
    {current && impact.assessment ? <>
      <div className="mt-2">
        <button type="button" className="btn text-chat-meta" disabled={!connected || asking} data-testid="impact-ask-open"
          onClick={() => setAsking(true)}>Ask to assess</button>
        {asking && <AskDialog teamPath={teamPath} view={view} connected={connected} sendMessage={sendMessage}
          reviewId={review.reviewId} onClose={() => setAsking(false)} />}
      </div>
      {GROUPS.map(group => <GroupSection key={group} group={group} rows={impact.assessment![group]} review={review}
        teamPath={teamPath} view={view} connected={connected} sendMessage={sendMessage} strategyId={strategyId} sessions={sessions} />)}
    </> : <RecordsOnly review={review} sessions={sessions} />}
  </section>
}

interface RowContext {
  review: ImpactReviewRecord
  teamPath: string
  view: StrategyView
  connected: boolean
  sendMessage: SendClientMessage
  strategyId: string
  sessions: Session[]
}

function GroupSection({ group, rows, ...context }: RowContext & { group: ImpactGroup; rows: ImpactPlanRow[] }) {
  return <section className="mt-3" data-testid={`impact-group-${group}`} aria-label={`${IMPACT_GROUP_LABELS[group]} plans`}>
    <h5 className="font-medium text-chat-body">{IMPACT_GROUP_LABELS[group]} ({rows.length})</h5>
    {rows.length === 0 && <p className="text-chat-meta text-secondary">None.</p>}
    {rows.map(row => <PlanRow key={row.planId} row={row} group={group} {...context} />)}
  </section>
}

function PlanRow({ row, group, review, teamPath, view, connected, sendMessage, strategyId, sessions }: RowContext & { row: ImpactPlanRow; group: ImpactGroup }) {
  const [deciding, setDeciding] = useState(false)
  const [history, setHistory] = useState(false)
  return <article className="mt-2 border border-border p-2" data-testid={`impact-row-${row.planId}`}>
    <p className="font-medium">{row.title}</p>
    <ul className="text-chat-meta text-secondary">
      {row.revisions.map(entry => <li key={entry.revision} data-testid={`impact-revision-${row.planId}-${entry.revision}`}>
        Revision {entry.revision} ({entry.status === 'in_review' ? 'in review' : entry.status}) · {pinText(entry.pin, strategyId)} ·{' '}
        <span data-testid="impact-gate">{IMPACT_GATE_LABELS[entry.gate.state]}</span>
        {entry.unassessed && <span className="ml-1 font-medium" data-testid="impact-unassessed">· Unassessed</span>}
      </li>)}
    </ul>
    {group === 'affected' && <>
      <p className="text-chat-meta" data-testid="impact-effective-decision">
        Decision: {row.effectiveDecision ? decisionText(row.effectiveDecision) : 'none recorded'}
      </p>
      {row.decisionHistory.length > 1 && <button type="button" className="btn text-chat-meta" aria-expanded={history}
        data-testid="impact-history-toggle" onClick={() => setHistory(open => !open)}>History ({row.decisionHistory.length})</button>}
      {history && <ol className="text-chat-meta text-secondary" data-testid="impact-decision-history">
        {row.decisionHistory.map(decision => <li key={decision.id}>{decisionText(decision)} · {decision.createdAt}</li>)}
      </ol>}
      <p className="text-chat-meta text-secondary" data-testid="impact-latest-proposal">
        Proposal: {row.latestProposal
          ? `${IMPACT_DISPOSITION_LABELS[row.latestProposal.disposition]} by ${sessionLabel(row.latestProposal.author.sessionId, sessions)} — ${row.latestProposal.rationale} (${row.proposalCount} in total)`
          : 'none'}
      </p>
      <button type="button" className="btn text-chat-meta" disabled={!connected || deciding} data-testid={`impact-decide-open-${row.planId}`}
        onClick={() => setDeciding(true)}>Decide</button>
      {deciding && <DecideDialog teamPath={teamPath} view={view} connected={connected} sendMessage={sendMessage}
        reviewId={review.reviewId} row={row} onClose={() => setDeciding(false)} />}
    </>}
  </article>
}

const decisionText = (decision: ImpactDecision) => `${IMPACT_DISPOSITION_LABELS[decision.disposition]} — ${decision.rationale}`

/** An earlier review: only what was recorded in it (D3) — a live regrouping against it would mislead. */
function RecordsOnly({ review, sessions }: { review: ImpactReviewRecord; sessions: Session[] }) {
  const empty = review.decisions.length === 0 && review.proposals.length === 0 && review.requests.length === 0
  return <div className="mt-2 text-chat-meta text-secondary" data-testid="impact-records">
    <p>This review is no longer current; it shows what was recorded in it.</p>
    {empty && <p>Nothing was recorded.</p>}
    {review.decisions.length > 0 && <ul aria-label="Decisions">
      {review.decisions.map(decision => <li key={decision.id} data-testid="impact-record-decision">Plan {decision.planId}: {decisionText(decision)} · {decision.createdAt}</li>)}
    </ul>}
    {review.proposals.length > 0 && <ul aria-label="Proposals">
      {review.proposals.map(proposal => <li key={proposal.id}>Plan {proposal.planId}: proposed {IMPACT_DISPOSITION_LABELS[proposal.disposition]} by {sessionLabel(proposal.author.sessionId, sessions)} — {proposal.rationale}</li>)}
    </ul>}
    {review.requests.length > 0 && <ul aria-label="Assessment requests">
      {review.requests.map(request => <li key={request.id}>Asked {request.targetGroup} to assess · {request.createdAt}</li>)}
    </ul>}
  </div>
}
