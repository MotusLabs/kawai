// A plan's strategy impact (strategy-revision-impact D6/D9), from the one
// impact gate the server also applies at approval, so the badge, the detail,
// and a refused approval always agree. Historical (closed) plans show
// nothing; a gate other than Current links to the impact review, which opens
// the Strategy tab's impact sub-view on the review's strategy revision.
import { IMPACT_GATE_LABELS, type ImpactGate, type PlanImpact } from '@shared/strategyImpact'

const TONE: Record<ImpactGate['state'], string> = {
  current: 'text-secondary',
  continue: 'text-secondary',
  'decision-required': 'text-approval',
  adapt: 'text-approval',
  reconsider: 'text-approval',
  'withdrawn-direction': 'text-chat-danger',
}

/** "Strategy impact: <state>" for one gate. */
export function ImpactGateText({ gate }: { gate: ImpactGate }) {
  return <span className={TONE[gate.state]} data-testid="plan-impact-state" data-state={gate.state}>Strategy impact: {IMPACT_GATE_LABELS[gate.state]}</span>
}

/** The Open review link, when the gate rests on a review. */
export function OpenImpactReview({ revision, onOpen, label = 'Open review' }: { revision: number | null; onOpen?: (revision: number) => void; label?: string }) {
  if (revision === null || !onOpen) return null
  return <button type="button" className="btn ml-2 text-chat-meta" data-testid="plan-impact-open-review"
    aria-label={`${label}: impact review of strategy revision ${revision}`} onClick={() => onOpen(revision)}>{label}</button>
}

export default function PlanImpactBadge({ impact, onOpenReview, link = true }: {
  impact: PlanImpact | null | undefined
  onOpenReview?: (revision: number) => void
  /** False inside another control (a list row button): text only. */
  link?: boolean
}) {
  if (!impact || impact.group === 'historical' || !impact.gate) return null
  return <span className="text-chat-meta" data-testid="plan-impact-badge">
    <ImpactGateText gate={impact.gate} />
    {link && impact.gate.state !== 'current' && <OpenImpactReview revision={impact.reviewRevision} onOpen={onOpenReview} />}
  </span>
}
