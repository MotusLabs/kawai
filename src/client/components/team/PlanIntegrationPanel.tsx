// A plan's integration branches in its detail (integration-candidates D11,
// D13): per branch, its head and target, the candidate chain newest first —
// `seq`, change, commit, CI, state, and outside commits flagged, a failed
// candidate kept beside the one that replaced it — **Promote to <target>**
// while a landed change is left to promote and nothing of the plan runs, and
// the promotions newest first. Every control disables while disconnected.
import type { SendClientMessage } from '@shared/types'
import { somethingToPromote, type CandidateState, type IntegrationCandidate, type PlanIntegrationView } from '@shared/planIntegration'
import PlanPromoteDialog from './PlanPromoteDialog'
import PlanPromotionRow from './PlanPromotionRow'

const STATE_LABELS: Record<CandidateState, string> = {
  verifying: 'verifying', passed: 'passed', landed: 'landed', failed: 'failed', superseded: 'superseded',
}

// A candidate's state is its CI's verdict: verifying until CI decides (D3).
const CI_LABELS: Record<CandidateState, string> = {
  verifying: 'CI running', passed: 'CI passed', landed: 'CI passed', failed: 'CI failed', superseded: 'CI —',
}

function CandidateRow({ candidate, promoted }: { candidate: IntegrationCandidate; promoted: boolean }) {
  const outside = candidate.outside ?? []
  return <li className="text-chat-meta" data-testid="plan-integration-candidate">
    <span className="font-medium">#{candidate.seq}</span>
    {' · '}{candidate.kind === 'promotion' ? 'promotion' : candidate.change ?? '—'}
    {' · '}{candidate.commitSha.slice(0, 8)}
    {' · '}{CI_LABELS[candidate.state]}
    {' · '}{STATE_LABELS[candidate.state]}
    {promoted ? ' · promoted' : ''}
    {outside.length > 0 && <span data-testid="plan-integration-outside" title={outside.map(commit => `${commit.sha.slice(0, 8)} ${commit.subject} — ${commit.author}`).join('\n')}>
      {' · '}⚑ {outside.length} outside commit{outside.length === 1 ? '' : 's'}
    </span>}
  </li>
}

export default function PlanIntegrationPanel({ teamPath, planId, views, executionRunning, connected, onSend }: {
  teamPath: string
  planId: string
  views: PlanIntegrationView[]
  /** An execution of the plan runs: Promote waits for it (`no-execution`). */
  executionRunning: boolean
  connected: boolean
  onSend: SendClientMessage
}) {
  if (views.length === 0) return null
  return <section className="mt-3" data-testid="plan-integration-panel">
    <h3 className="text-chat-meta font-medium">Integration</h3>
    {views.map(view => <div key={view.branch} className="mt-1 border border-border p-2" data-testid="plan-integration-branch">
      <p className="text-chat-body">
        <span className="font-medium break-all">{view.branch}</span>
        {' · head '}{view.head !== null ? view.head.slice(0, 8) : 'unread'}
        {' · into '}{view.targetBranch}
      </p>
      {view.candidates.length === 0
        ? <p className="text-chat-meta text-secondary">No candidate yet.</p>
        : <ul className="mt-1">{view.candidates.map(candidate =>
          <CandidateRow key={candidate.id} candidate={candidate} promoted={candidate.state === 'landed' && candidate.seq <= view.promotedThroughSeq} />)}</ul>}
      {somethingToPromote(view) && !executionRunning && <div className="mt-2">
        <PlanPromoteDialog teamPath={teamPath} planId={planId} view={view} connected={connected} onSend={onSend} />
      </div>}
      {somethingToPromote(view) && executionRunning && <p className="mt-1 text-chat-meta text-secondary" data-testid="plan-promote-waits">Promote waits until the execution finishes.</p>}
      {view.promotions.length > 0 && <ul className="mt-2">
        {view.promotions.map(promotion => <PlanPromotionRow key={promotion.id} teamPath={teamPath} promotion={promotion} connected={connected} onSend={onSend} />)}
      </ul>}
    </div>)}
  </section>
}
