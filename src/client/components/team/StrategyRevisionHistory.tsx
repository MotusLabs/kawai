// The strategy revision history (product-strategy 5.3): every numbered
// revision with its status, author, hash, and expandable content —
// superseded and withdrawn revisions stay accessible — plus the drafts and
// the recorded decisions.
import type { StrategyDecision, StrategyDetail, StrategyRevision } from '@shared/productStrategy'
import type { Session } from '@shared/types'
import { useState } from 'react'
import { REVISION_STATUS_LABELS, actorLabel, shortHash } from '../chat/strategyLabels'

export default function StrategyRevisionHistory({ detail, sessions, onWithdrawRevision, connected, busy }: {
  detail: StrategyDetail
  sessions: Session[]
  connected: boolean
  busy: boolean
  onWithdrawRevision: (revision: number) => void
}) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const revisions = [...detail.revisions].reverse()
  return <section data-testid="strategy-revision-history" className="mt-4">
    <h4 className="font-medium">Revision history</h4>
    {revisions.length === 0 && <p className="text-chat-meta text-secondary">No revisions yet — submit a draft for review.</p>}
    {revisions.map((revision: StrategyRevision) => <article key={revision.revision} data-revision={revision.revision} className="mt-2 border border-border p-2">
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={expanded === revision.revision}
        onClick={() => setExpanded(current => current === revision.revision ? null : revision.revision)}>
        <span className="font-medium">Revision {revision.revision}</span>
        <span className="text-chat-meta text-secondary" data-testid={`revision-status-${revision.revision}`}>
          {REVISION_STATUS_LABELS[revision.status]} · {actorLabel(revision.author, sessions)} · {shortHash(revision.contentHash)}
        </span>
      </button>
      {revision.impactProposal && <p className="mt-1 text-chat-meta text-secondary">Impact proposal: {revision.impactProposal}</p>}
      {expanded === revision.revision && <div className="mt-2 space-y-1 border-t border-border pt-2" data-testid={`revision-content-${revision.revision}`}>
        <Section title="Purpose">{revision.content.purpose || '(explicitly empty)'}</Section>
        <Section title="Primary users">{revision.content.primaryUsers || '(explicitly empty)'}</Section>
        <Section title="Needs and outcomes">{revision.content.needsOutcomes || '(explicitly empty)'}</Section>
        <Section title="Product approach">{revision.content.productApproach || '(explicitly empty)'}</Section>
        <Section title="Use cases">{revision.content.useCases.length > 0
          ? revision.content.useCases.map(useCase => `${useCase.userOrSituation} — ${useCase.trigger} → ${useCase.wantedOutcome}`).join('; ')
          : '(none)'}</Section>
        <Section title="Principles and trade-offs">{revision.content.principles.length > 0
          ? revision.content.principles.map(principle => `${principle.principle} (trade-off: ${principle.tradeoff || 'none stated'})`).join('; ')
          : '(none)'}</Section>
        <Section title="Boundaries">{revision.content.boundaries.length > 0 ? revision.content.boundaries.join('; ') : '(none)'}</Section>
        <Section title="Success measures">{revision.content.successMeasures.length > 0
          ? revision.content.successMeasures.map(measure => `${measure.outcome}: ${measure.measure} (baseline ${measure.baseline}, target ${measure.target})`).join('; ')
          : '(none)'}</Section>
        <Section title="Claims">{revision.content.claims.length > 0
          ? revision.content.claims.map(claim => `${claim.text} [${claim.kind}]`).join('; ')
          : '(none)'}</Section>
        <Section title="Open questions">{revision.content.openQuestions.length > 0 ? revision.content.openQuestions.join('; ') : '(none)'}</Section>
        <Section title="Decisions">{revision.content.decisions.length > 0
          ? revision.content.decisions.map(decision => `${decision.decision}${decision.date ? ` (${decision.date})` : ''}`).join('; ')
          : '(none)'}</Section>
        {connected && revision.status !== 'withdrawn' && <button type="button" className="btn text-chat-meta" disabled={busy}
          data-testid={`withdraw-revision-${revision.revision}`} onClick={() => onWithdrawRevision(revision.revision)}>Withdraw</button>}
      </div>}
    </article>)}
    {detail.drafts.length > 0 && <div className="mt-3">
      <h5 className="font-medium text-chat-body">Drafts</h5>
      {detail.drafts.map(draft => <p key={draft.draftId} className="text-chat-meta text-secondary" data-testid="draft-row">
        {draft.draftId} · {actorLabel(draft.author, sessions)} · based on revision {draft.baseRevision ?? 'none'} · updated {draft.updatedAt}
      </p>)}
    </div>}
    {detail.decisions.length > 0 && <div className="mt-3">
      <h5 className="font-medium text-chat-body">Decisions</h5>
      {detail.decisions.map((decision: StrategyDecision) => <p key={decision.id} className="text-chat-meta text-secondary" data-testid="decision-row">
        {decision.decision === 'approve' ? 'Approved' : 'Withdrew'} revision {decision.revision ?? '—'} by {actorLabel(decision.actor, sessions)} at {decision.createdAt}
        {decision.approvalScope ? ` · scope: ${decision.approvalScope}` : ''}{decision.openQuestions ? ` · open questions: ${decision.openQuestions}` : ''}
      </p>)}
    </div>}
    {detail.impactReviews.length > 0 && <div className="mt-3">
      <h5 className="font-medium text-chat-body">Impact review</h5>
      {detail.impactReviews.map(review => <p key={review.id} className="text-chat-meta text-secondary" data-testid="impact-review-row">
        Revision {review.revision} · {review.state} (created with the approval; reviewing live plans is a later step)
      </p>)}
    </div>}
  </section>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <p className="text-chat-meta text-secondary"><span className="font-medium text-primary">{title}:</span> {children}</p>
}
