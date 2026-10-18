// The Plans view (durable-plans 8.2, design D12): a team's plans as a list
// (title, displayed state, approved revision, strategy pin or Alignment
// unassessed) and one plan's detail — intent with the claimed alignment,
// the ordered changes with progress and waits, the floor beside the extra
// checks, landing, roles, revisions with the diff summary and Approve /
// Withdraw, drafts, history, and close/reopen. Host-agnostic: it owns its
// list and detail subscriptions over `teamPath` and renders inside whatever
// container mounts it (the Team page's Plans tab, which names the selected
// plan in its URL through `onSelectedPlan`).
// List and detail are one column with a Back control, so the same flow
// works on a phone. Every control disables while disconnected; refusals,
// with each failing approval precondition, show inline — a pin refusal with
// its strategy impact (strategy-revision-impact D6) beside it, the same state
// the plan's impact badge shows, linking to the impact review.
import { useEffect, useRef } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import { PLAN_STATE_LABELS, type PlanDetail, type PlanSummary } from '@shared/plans'
import type { PlanRevisionValidation } from '@shared/planValidation'
import { useTeamPlanStore, type PlanView } from '../../stores/teamPlanStore'
import PlanIntentSection from './PlanIntentSection'
import PlanChangesSection from './PlanChangesSection'
import PlanPolicySection from './PlanPolicySection'
import PlanExecutionSection from './PlanExecutionSection'
import PlanRevisionsSection from './PlanRevisionsSection'
import PlanLifecycleControls from './PlanLifecycleControls'
import { pinLabel, planActorLabel } from './planLabels'
import PlanImpactBadge, { ImpactGateText, OpenImpactReview } from './PlanImpactBadge'
import type { PlanImpact } from '@shared/strategyImpact'

export default function TeamPlansView({ teamPath, view, sendMessage, connected, connectionEpoch, sessions, onOpenTask, onSelectedPlan, onOpenImpactReview, onCaptureStrategy }: {
  teamPath: string
  view: PlanView
  sendMessage: SendClientMessage
  connected: boolean
  /** Bumps on every reconnect, so subscriptions are re-sent. */
  connectionEpoch: number
  sessions: Session[]
  onOpenTask?: (taskId: string) => void
  /** The human opened a plan or went back to the list (the host's location follows). */
  onSelectedPlan?: (planId: string | null) => void
  /** Open the impact review of a strategy revision (the Strategy tab's impact sub-view). */
  onOpenImpactReview?: (revision: number) => void
  /** Opens the Strategy tab's capture affordance, from the Unassessed note (plan-validation D11). */
  onCaptureStrategy?: () => void
}) {
  const selected = view.selected
  useEffect(() => {
    if (!connected || !view.open) return
    sendMessage({ type: 'team-plans-open', teamPath })
    return () => sendMessage({ type: 'team-plans-close', teamPath })
  }, [teamPath, connected, connectionEpoch, view.open, sendMessage])
  useEffect(() => {
    if (!connected || !view.open || !selected) return
    sendMessage({ type: 'team-plan-open', teamPath, planId: selected })
    return () => sendMessage({ type: 'team-plan-close', teamPath, planId: selected })
  }, [teamPath, connected, connectionEpoch, view.open, selected, sendMessage])
  // A result lost with the connection never leaves the view busy: a
  // reconnect clears waiting requests, whether it shows as a connected edge
  // or only as a new epoch (the socket came back between renders).
  const wasConnected = useRef(connected)
  const lastEpoch = useRef(connectionEpoch)
  useEffect(() => {
    const reconnected = (!wasConnected.current && connected) || (connected && lastEpoch.current !== connectionEpoch)
    if (reconnected) useTeamPlanStore.getState().reconnected(teamPath)
    wasConnected.current = connected
    lastEpoch.current = connectionEpoch
  }, [connected, connectionEpoch, teamPath])

  const busy = Object.keys(view.pending).length > 0
  const select = (planId: string | null) => {
    useTeamPlanStore.getState().select(teamPath, planId)
    onSelectedPlan?.(planId)
  }
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="team-plans">
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update plans.</p>}
    {view.error && <div role="alert" data-testid="plan-error" className="border-b border-border p-3 text-chat-meta text-chat-danger">
      <p>{view.error}</p>
      {view.failures.length > 0 && <ul className="mt-1 list-disc pl-5">{view.failures.map(failure => <li key={failure.name}><code>{failure.name}</code>: {failure.message}</li>)}</ul>}
      {view.refusalImpact && <p className="mt-1" data-testid="plan-refusal-impact">
        <ImpactGateText gate={view.refusalImpact} />
        <OpenImpactReview revision={(selected ? view.detailImpact ?? view.impact[selected] : null)?.reviewRevision ?? null} onOpen={onOpenImpactReview} />
      </p>}
    </div>}
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {selected
        ? <PlanDetailPane teamPath={teamPath} planId={selected} detail={view.detail} validation={view.detailValidation} onCaptureStrategy={onCaptureStrategy} sessions={sessions} sendMessage={sendMessage}
          connected={connected} busy={busy} onBack={() => select(null)} onOpenTask={onOpenTask}
          impact={view.detailImpact ?? view.impact[selected] ?? null} onOpenImpactReview={onOpenImpactReview} />
        : <PlanList plans={view.plans} loading={view.loading} onSelect={select} impact={view.impact} onOpenImpactReview={onOpenImpactReview} />}
    </div>
  </div>
}

function PlanList({ plans, loading, onSelect, impact, onOpenImpactReview }: {
  plans: PlanSummary[] | null
  loading: boolean
  onSelect: (planId: string) => void
  impact: Record<string, PlanImpact>
  onOpenImpactReview?: (revision: number) => void
}) {
  if (loading || plans === null) return <p role="status" className="text-chat-meta text-secondary">Loading plans…</p>
  if (plans.length === 0) {
    return <p className="text-chat-meta text-secondary" data-testid="plans-empty">No plans yet. A lead whose group sets <code>canCreatePlans: true</code> drafts one with the plan tools; you review and approve it here.</p>
  }
  return <ul className="space-y-2" data-testid="plan-list" aria-label="Plans">
    {plans.map(plan => <li key={plan.id}>
      <button type="button" className="w-full border border-border p-2 text-left" data-testid={`plan-row-${plan.id}`} onClick={() => onSelect(plan.id)}>
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{plan.title}</span>
          <span className="text-chat-meta" data-testid="plan-state">{PLAN_STATE_LABELS[plan.state]}</span>
        </span>
        <span className="block text-chat-meta text-secondary">
          {plan.currentApprovedRevision === null ? 'No approved revision' : `Approved revision ${plan.currentApprovedRevision}`}
          {' · '}{plan.currentApprovedRevision === null ? 'not pinned yet' : pinLabel(plan.pin)}
          {plan.linkedTaskCount > 0 ? ` · ${plan.linkedTaskCount} linked task${plan.linkedTaskCount === 1 ? '' : 's'}` : ''}
        </span>
        <span className="block"><PlanImpactBadge impact={impact[plan.id]} link={false} /></span>
      </button>
      {impact[plan.id]?.group === 'affected' && <OpenImpactReview revision={impact[plan.id]!.reviewRevision} onOpen={onOpenImpactReview} />}
    </li>)}
  </ul>
}

function PlanDetailPane({ teamPath, planId, detail, sessions, sendMessage, connected, busy, onBack, onOpenTask, impact, onOpenImpactReview, validation, onCaptureStrategy }: {
  teamPath: string
  planId: string
  detail: PlanDetail | null
  sessions: Session[]
  sendMessage: SendClientMessage
  connected: boolean
  busy: boolean
  onBack: () => void
  onOpenTask?: (taskId: string) => void
  impact: PlanImpact | null
  onOpenImpactReview?: (revision: number) => void
  /** The pushed Validation sections, per standing revision (plan-validation D11). */
  validation: PlanRevisionValidation[] | null
  /** Opens the Strategy tab's capture affordance, from the Unassessed note (plan-validation D11). */
  onCaptureStrategy?: () => void
}) {
  const heading = useRef<HTMLHeadingElement | null>(null)
  const loaded = detail?.plan.id === planId
  // Moving into a plan moves focus to its title, so keyboard and screen-reader users land in the detail.
  useEffect(() => { if (loaded) heading.current?.focus() }, [loaded, planId])
  const back = <button type="button" className="btn text-chat-meta" data-testid="plan-back" onClick={onBack}>← All plans</button>
  if (!detail || !loaded) return <div>{back}<p role="status" className="mt-2 text-chat-meta text-secondary">Loading plan…</p></div>
  const { plan } = detail
  const approved = detail.revisions.find(revision => revision.revision === plan.currentApprovedRevision) ?? null
  const shown = approved ?? detail.revisions.filter(revision => revision.status === 'in_review').at(-1) ?? null
  return <article data-testid="plan-detail" aria-labelledby="plan-title">
    {back}
    <h3 id="plan-title" ref={heading} tabIndex={-1} className="mt-2 text-lg font-medium">{plan.title}</h3>
    <p className="text-chat-meta text-secondary" data-testid="plan-detail-state">
      {PLAN_STATE_LABELS[plan.state]} · created by {planActorLabel(plan.creator, sessions)} · owner Human
      {approved ? ` · approved revision ${approved.revision}` : ' · no approved revision'}
    </p>
    <PlanImpactBadge impact={impact} onOpenReview={onOpenImpactReview} />
    {!shown && <p className="mt-2 text-chat-meta text-secondary">No revision has been submitted yet; the author's draft is listed under Revisions.</p>}
    {shown && <>
      {shown !== approved && <p className="mt-2 text-chat-meta text-approval" data-testid="plan-not-approved">Showing revision {shown.revision}, in review — not approved, so not yet the direction.</p>}
      <PlanIntentSection content={shown.content} pin={shown.pin} />
      <PlanChangesSection content={shown.content} progress={shown === approved ? detail.progress : null} onOpenTask={onOpenTask} />
      <PlanPolicySection content={shown.content} />
      <PlanExecutionSection teamPath={teamPath} plan={detail.plan} detail={detail} connected={connected} onSend={sendMessage} onOpenTask={onOpenTask} />
    </>}
    <PlanRevisionsSection teamPath={teamPath} detail={detail} sessions={sessions} sendMessage={sendMessage} connected={connected} busy={busy}
      validation={validation} onCaptureStrategy={onCaptureStrategy} />
    <PlanLifecycleControls teamPath={teamPath} detail={detail} sendMessage={sendMessage} connected={connected} busy={busy} />
  </article>
}
