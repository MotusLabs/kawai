// Incident advice in the Metrics tab (process-quota-history-and-incident-
// advice D6, task 4.6): the team's newest quota and context incidents, each
// with its current advice, and one opened at a time with its alternatives
// frozen at the cutoff — exclusions, headroom and the age of each window —
// the facts, assumptions and unknowns, every assessment version, and the
// frozen evidence (a pruned observation's link reads "expired"). Read from
// the snapshot only: it needs no Prometheus, and nothing here approves,
// applies or routes anything. An attention item's advice link (D6) arrives as
// `reveal`: once listed, that recommendation opens and scrolls into view.
import { useEffect, useState } from 'react'
import {
  ADVICE_CHOICE_LABELS, EXCLUSION_LABELS, type FrozenAlternative, type ProcessAssessment, type ProcessRecommendationDetail,
} from '@shared/processRecommendations'
import { timeLabel } from './reportLabels'

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`

function AlternativeRow({ alternative }: { alternative: FrozenAlternative }) {
  const freshness = alternative.windows.map(window => `${window.key} ${window.percentUsed}% · ${minutes(window.ageMs)} old`).join('; ')
  return <li className="text-sm" data-testid="advice-alternative" data-profile={alternative.profileId}>
    <span className="font-medium">{alternative.profileId}</span> on {alternative.providerId}:{' '}
    {alternative.exclusion
      ? <span data-testid="advice-exclusion">excluded — {EXCLUSION_LABELS[alternative.exclusion.kind]} ({alternative.exclusion.detail})</span>
      : <span data-testid="advice-headroom">{alternative.headroom === 'known' ? 'fresh capacity' : `capacity unknown (${alternative.headroomReason})`}</span>}
    {freshness && <span className="text-chat-meta text-secondary" data-testid="advice-freshness"> · {freshness}</span>}
  </li>
}

function AssessmentDetail({ assessment }: { assessment: ProcessAssessment }) {
  const { advice } = assessment
  return <div className="flex flex-col gap-1" data-testid="advice-assessment" data-version={assessment.version}>
    <p className="text-sm">
      <span className="font-medium">{ADVICE_CHOICE_LABELS[advice.choice]}</span>
      {advice.provisional && <span className="ml-1 text-chat-meta text-secondary" data-testid="advice-provisional">provisional</span>}
      {advice.sample.small && <span className="ml-1 text-chat-meta text-secondary" data-testid="advice-small-sample">
        small sample ({advice.sample.comparisons} of {advice.sample.threshold})</span>}
    </p>
    <p className="text-sm">{advice.summary}</p>
    <p className="text-chat-meta text-secondary">
      As of {timeLabel(assessment.cutoff)} · wait {advice.comparison.wait.until ? `until ${timeLabel(advice.comparison.wait.until)}` : 'unknown'} ·
      saving {advice.comparison.savingsMs === null ? 'unknown' : minutes(advice.comparison.savingsMs)}
    </p>
    <ul className="flex flex-col gap-0.5">{advice.alternatives.map(alternative => <AlternativeRow key={alternative.profileId} alternative={alternative} />)}</ul>
    {[['Facts', advice.facts], ['Assumptions', advice.assumptions], ['Unknowns', advice.unknowns]].map(([label, items]) =>
      (items as string[]).length > 0 && <div key={label as string} data-testid={`advice-${(label as string).toLowerCase()}`}>
        <p className="text-chat-meta font-medium">{label as string}</p>
        <ul className="list-disc pl-4 text-sm">{(items as string[]).map(item => <li key={item}>{item}</li>)}</ul>
      </div>)}
    {assessment.evidence.length > 0 && <ul className="text-chat-meta text-secondary" data-testid="advice-evidence">
      {assessment.evidence.map(entry => <li key={entry.ordinal}>
        {entry.kind === 'limit' ? 'limit' : entry.outcome} · {entry.accountAlias ?? entry.providerId} · {timeLabel(entry.at)}
        {entry.observationId && (entry.expired
          ? <span data-testid="advice-evidence-expired"> · detail expired</span>
          : <span> · observation {entry.observationId.slice(0, 14)}</span>)}
      </li>)}
    </ul>}
  </div>
}

export default function IncidentAdvice({ recommendations, reveal = null, onRevealed }: {
  recommendations: readonly ProcessRecommendationDetail[]
  /** A recommendation an attention item's advice link asked to open; taken once it is listed. */
  reveal?: string | null
  onRevealed?: () => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => {
    if (reveal === null || !recommendations.some(rec => rec.id === reveal)) return
    setOpenId(reveal)
    onRevealed?.()
    if (typeof document !== 'undefined' && typeof CSS !== 'undefined') {
      document.querySelector(`[data-recommendation="${CSS.escape(reveal)}"]`)?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [reveal, recommendations, onRevealed])
  const opened = recommendations.find(rec => rec.id === openId) ?? null
  return <section className="border border-border p-2" data-testid="incident-advice">
    <h3 className="font-medium">Incident advice</h3>
    {recommendations.length === 0 && <p className="text-sm text-secondary">No quota or context incidents.</p>}
    <ul className="mt-1 flex flex-col gap-1">
      {recommendations.map(rec => <li key={rec.id} data-testid="advice-row" data-recommendation={rec.id}>
        <button type="button" className="text-left hover:underline" aria-expanded={rec.id === openId}
          onClick={() => setOpenId(rec.id === openId ? null : rec.id)}>
          {rec.kind === 'quota' ? 'Quota limit' : 'Context exhausted'} · {rec.profileId ?? 'unknown'}
          {rec.providerId ? ` on ${rec.providerId}` : ''} · {timeLabel(rec.cutoff)} —{' '}
          {rec.current ? ADVICE_CHOICE_LABELS[rec.current.advice.choice] : 'evaluating'}
          {rec.versions > 1 ? ` · ${rec.versions} versions` : ''}
        </button>
      </li>)}
    </ul>
    {opened && <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2" data-testid="advice-detail">
      {opened.attentionId && <p className="text-chat-meta text-secondary" data-testid="advice-attention">Attached to {opened.attentionId}</p>}
      {opened.snapshotBasis === 'reconstructed' && <p className="text-chat-meta text-secondary">Routing facts reconstructed at startup.</p>}
      {[...opened.assessments].reverse().map(assessment => <div key={assessment.id}>
        <p className="text-chat-meta text-secondary">Version {assessment.version} · {assessment.state}</p>
        <AssessmentDetail assessment={assessment} />
      </div>)}
    </div>}
  </section>
}
