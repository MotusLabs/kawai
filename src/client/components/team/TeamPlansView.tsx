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
import { useEffect, useRef, useState } from 'react'
import type { SendClientMessage, ServerMessage, Session } from '@shared/types'
import { PLAN_STATE_LABELS, type PlanDetail, type PlanSummary } from '@shared/plans'
import type { PlanRevisionValidation } from '@shared/planValidation'
import { useTeamPlanStore, type PlanView } from '../../stores/teamPlanStore'
import PlanIntentSection from './PlanIntentSection'
import PlanChangesSection from './PlanChangesSection'
import PlanPolicySection from './PlanPolicySection'
import PlanExecutionSection from './PlanExecutionSection'
import PlanReportSection from './PlanReportSection'
import PlanUsageSection from './PlanUsageSection'
import { PlanDecisionsList } from './PlanDecisionCard'
import PlanRevisionsSection from './PlanRevisionsSection'
import PlanWorkspaceSection from './PlanWorkspaceSection'
import PlanWorkspaceConversation from './PlanWorkspaceConversation'
import PlanLifecycleControls from './PlanLifecycleControls'
import { pinLabel, planActorLabel } from './planLabels'
import PlanImpactBadge, { ImpactGateText, OpenImpactReview } from './PlanImpactBadge'
import type { OpenNewSessionForRole } from './PlanWorkspaceConversation'
import type { PlanImpact } from '@shared/strategyImpact'

export default function TeamPlansView({ teamPath, view, sendMessage, subscribe, connected, connectionEpoch, sessions, onOpenTask, onSelectedPlan, onOpenImpactReview, onCaptureStrategy, onOpenNewSession }: {
  teamPath: string
  view: PlanView
  sendMessage: SendClientMessage
  /** The chat lifecycle subscription (the conversation panel's reset/create flows). */
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
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
  /** Opens the normal New Session dialog (App-owned) for an unbound conversation role. */
  onOpenNewSession?: OpenNewSessionForRole
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
          subscribe={subscribe} onOpenNewSession={onOpenNewSession}
          connected={connected} connectionEpoch={connectionEpoch} busy={busy} onBack={() => select(null)} onOpenTask={onOpenTask}
          impact={view.detailImpact ?? view.impact[selected] ?? null} onOpenImpactReview={onOpenImpactReview} />
        : <PlansListWithConversation teamPath={teamPath} view={view} sessions={sessions} connected={connected}
          connectionEpoch={connectionEpoch}
          sendMessage={sendMessage} subscribe={subscribe} onOpenNewSession={onOpenNewSession}
          onSelect={select} onOpenImpactReview={onOpenImpactReview} />}
    </div>
  </div>
}

/**
 * The plans list (and the repository's no-plan empty state) with the
 * optional conversation panel (§6.2): available even with no plan selected,
 * planning unscoped. The panel owns its team bindings subscription (Q1), so
 * a fresh visit with no plan record binds exactly like the plan detail.
 */
function PlansListWithConversation({ teamPath, view, sessions, connected, connectionEpoch, sendMessage, subscribe, onOpenNewSession, onSelect, onOpenImpactReview }: {
  teamPath: string
  view: PlanView
  sessions: Session[]
  connected: boolean
  connectionEpoch: number
  sendMessage: SendClientMessage
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  onOpenNewSession?: OpenNewSessionForRole
  onSelect: (planId: string) => void
  onOpenImpactReview?: (revision: number) => void
}) {
  const [conversationOpen, setConversationOpen] = useState(false)
  return <>
    <PlanList plans={view.plans} loading={view.loading} onSelect={onSelect} impact={view.impact} onOpenImpactReview={onOpenImpactReview} />
    <div className="mt-3">
      <button type="button" className="btn text-chat-meta" data-testid="plans-conversation-toggle"
        aria-expanded={conversationOpen} onClick={() => setConversationOpen(open => !open)}>
        {conversationOpen ? 'Hide conversation' : 'Conversation'}
      </button>
      {conversationOpen && <PlanWorkspaceConversation teamPath={teamPath}
        sessions={sessions} connected={connected}
        connectionEpoch={connectionEpoch}
        sendMessage={sendMessage} subscribe={subscribe} onOpenNewSession={onOpenNewSession}
        selection={null} />}
    </div>
  </>
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

function PlanDetailPane({ teamPath, planId, detail, sessions, sendMessage, subscribe, onOpenNewSession, connected, connectionEpoch, busy, onBack, onOpenTask, impact, onOpenImpactReview, validation, onCaptureStrategy }: {
  teamPath: string
  planId: string
  detail: PlanDetail | null
  sessions: Session[]
  sendMessage: SendClientMessage
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  onOpenNewSession?: OpenNewSessionForRole
  connected: boolean
  /** Bumps on every reconnect; the workspace section re-sends its subscription. */
  connectionEpoch: number
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
  // The attention link's scroll target (plan-supervision D15): the change
  // row and decision card effects act on it first (child effects run
  // before their parents'), then this consumes it once — whether or not a
  // row matched. An unknown change or a card no longer listed leaves the
  // detail at its top, with no error and no late scroll.
  const reveal = useTeamPlanStore(state => state.reveal)
  const revealAnchor = loaded && reveal !== null && reveal.teamKey === teamPath && reveal.planId === planId ? reveal.anchor : null
  // Whether that target is an element this loaded detail renders (a change
  // row of the newest execution, or a decision card). Read by the
  // title-focus effect through a ref set during render, so it sees its own
  // commit's value without re-running on every detail push.
  const titleYieldsToReveal = useRef(false)
  titleYieldsToReveal.current = revealAnchor !== null && detail !== null && revealTargetRendered(revealAnchor, detail)
  // Moving into a plan moves focus to its title, so keyboard and screen-reader users land in the detail.
  // A pending reveal whose rendered target wins instead: the child effects scroll and focus the row or
  // card first, and exactly one element ends focused — the revealed target when the detail renders it,
  // else the title (plan-supervision D15).
  useEffect(() => { if (loaded && !titleYieldsToReveal.current) heading.current?.focus() }, [loaded, planId])
  useEffect(() => {
    if (loaded && reveal && reveal.teamKey === teamPath && reveal.planId === planId) {
      useTeamPlanStore.getState().consumeReveal(teamPath)
    }
  }, [loaded, reveal, teamPath, planId])
  const back = <button type="button" className="btn text-chat-meta" data-testid="plan-back" onClick={onBack}>← All plans</button>
  if (!detail || !loaded) return <div>{back}<p role="status" className="mt-2 text-chat-meta text-secondary">Loading plan…</p></div>
  const { plan } = detail
  // Cards with a change render inline in that change's execution row (D15); the
  // Decisions list takes the rest — cards without a change, every card when no
  // execution lists change rows, and any whose change has no row there.
  const newestExecution = detail.executions?.[0] ?? null
  const listedCards = (detail.decisions ?? []).filter(entry =>
    entry.card.change === null || newestExecution === null
    || !newestExecution.changes.some(row => row.change === entry.card.change))
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
      <PlanExecutionSection teamPath={teamPath} plan={detail.plan} detail={detail} connected={connected} onSend={sendMessage} onOpenTask={onOpenTask}
        sessions={sessions} busy={busy} revealAnchor={revealAnchor} />
      {/* Supervision (plan-supervision D15): the report, the plan-level Decisions list, and the usage totals,
          each only when the detail carries it. */}
      {detail.supervision && <PlanReportSection view={detail.supervision} sessions={sessions} onOpenImpactReview={onOpenImpactReview} />}
      <PlanDecisionsList teamPath={teamPath} planId={detail.plan.id} cards={listedCards}
        sessions={sessions} connected={connected} busy={busy} onSend={sendMessage} onOpenTask={onOpenTask ?? (() => undefined)}
        revealAnchor={revealAnchor} />
      {detail.usage && <PlanUsageSection view={detail.usage} />}
    </>}
    {/* The dependency workspace (plan-workspace 5.1): map, documents, and health
        beside the sections above — which it never replaces or gates. */}
    <PlanWorkspaceSection teamPath={teamPath} detail={detail} sessions={sessions} connected={connected}
      connectionEpoch={connectionEpoch} sendMessage={sendMessage}
      subscribe={subscribe} onOpenNewSession={onOpenNewSession} />
    <PlanRevisionsSection teamPath={teamPath} detail={detail} sessions={sessions} sendMessage={sendMessage} connected={connected} busy={busy}
      validation={validation} onCaptureStrategy={onCaptureStrategy} />
    <PlanLifecycleControls teamPath={teamPath} detail={detail} sendMessage={sendMessage} connected={connected} busy={busy} />
  </article>
}

/** Whether the reveal's anchor names an element this detail renders (plan-supervision D15): a change row of the newest execution, or a decision card — every card renders, inline beneath its change's row or in the plan-level Decisions list. Nothing renders when no revision is shown. */
function revealTargetRendered(anchor: string, detail: PlanDetail): boolean {
  const approved = detail.plan.currentApprovedRevision === null
    ? null : detail.revisions.find(revision => revision.revision === detail.plan.currentApprovedRevision) ?? null
  const shown = approved ?? detail.revisions.filter(revision => revision.status === 'in_review').at(-1) ?? null
  if (shown === null) return false
  if (anchor.startsWith('plan-change-')) {
    const change = anchor.slice('plan-change-'.length)
    const newest = detail.executions?.[0]
    return newest !== undefined && newest.changes.some(row => row.change === change)
  }
  if (anchor.startsWith('decision-card-')) {
    const id = anchor.slice('decision-card-'.length)
    return (detail.decisions ?? []).some(entry => entry.card.id === id)
  }
  return false
}
