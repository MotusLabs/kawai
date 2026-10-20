// One decision card in the Plans view (plan-supervision D15): its question,
// options, and context; the current decision with who made it; the full
// decision history with superseded decisions beside the current one; each
// override's fix task with its derived status; and the affected tasks'
// result commits since the current decision. Open cards offer **Answer**,
// decided ones **Override** (PlanDecisionDialog), which names the decision
// it replaces. Cards render inline in their change's execution row and in
// the plan-level Decisions list; the anchor id (`decision-card-<id>`) is
// where attention links scroll to. Every control disables while
// disconnected.
import type { SendClientMessage, Session } from '@shared/types'
import type { PlanDecisionCardView } from '@shared/planDecisions'
import { FIX_PHASE_LABELS } from '@shared/planDecisions'
import PlanDecisionDialog from './PlanDecisionDialog'
import { CARD_STATE_LABELS, DECISION_KIND_LABELS, decisionPartyLabel } from './planLabels'

export default function PlanDecisionCard({ teamPath, planId, cardView, sessions, connected, busy, onSend, onOpenTask }: {
  teamPath: string
  planId: string
  cardView: PlanDecisionCardView
  sessions: Session[]
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
  onOpenTask: (taskId: string) => void
}) {
  const { card, state, decisions, current, fixes, commits } = cardView
  const answered = state !== 'open'
  const shortId = (taskId: string) => taskId.slice(0, 13)
  return <li className="border border-border p-2" id={`decision-card-${card.id}`} data-testid="plan-decision-card">
    <p className="flex flex-wrap items-baseline justify-between gap-2 text-chat-body">
      <span className="font-medium">{card.question}</span>
      <span className="text-chat-meta" data-testid="plan-decision-state">{CARD_STATE_LABELS[state]}</span>
    </p>
    <p className="text-chat-meta text-secondary">
      asked by {decisionPartyLabel({ ...card.askedBy, kind: 'agent' }, sessions)}
      {' · '}addressed to {card.addressedTo === 'owner' ? 'the owner' : card.addressedGroup ?? 'lead'}
      {card.change ? ` · change ${card.change}` : ''}
    </p>
    {card.options.length > 0 && <ul className="mt-1 list-decimal pl-5 text-chat-meta">
      {card.options.map((option, index) => <li key={index}>{option}</li>)}
    </ul>}
    {card.context && <p className="mt-1 whitespace-pre-wrap text-chat-meta text-secondary">{card.context}</p>}
    {current && <p className="mt-1 text-chat-meta" data-testid="plan-decision-current">
      {current.choice}{current.optionIndex !== null ? ` (option ${current.optionIndex})` : ''}
      {' — '}{decisionPartyLabel(current.decidedBy, sessions)}
      {current.rationale ? ` — ${current.rationale}` : ''}
    </p>}
    {decisions.length > 0 && <ul className="mt-1 text-chat-meta text-secondary" data-testid="plan-decision-history">
      {decisions.map(decision => <li key={decision.id}>
        #{decision.seq} {DECISION_KIND_LABELS[decision.kind]}: {decision.choice}
        {' — '}{decisionPartyLabel(decision.decidedBy, sessions)}
        {decision.rationale ? ` — ${decision.rationale}` : ''}
        {current !== null && decision.seq < current.seq ? ' (superseded)' : ''}
      </li>)}
    </ul>}
    {fixes.length > 0 && <ul className="mt-1 text-chat-meta" data-testid="plan-decision-fixes">
      {fixes.map(fix => <li key={fix.decisionId}>
        Forward fix task <button type="button" className="link" data-testid="plan-decision-fix-task"
          onClick={() => onOpenTask(fix.taskId)}>{shortId(fix.taskId)}…</button>
        {' — '}{FIX_PHASE_LABELS[fix.status.phase]}
        {fix.status.outstanding.length > 0 ? ` · outstanding: ${fix.status.outstanding.join(', ')}` : ''}
        {fix.status.landings.some(landing => !landing.treeVerified) ? ' · landing not tree-verified' : ''}
      </li>)}
    </ul>}
    {commits.map(entry => <p key={entry.taskId} className="mt-1 text-chat-meta text-secondary">
      task {shortId(entry.taskId)}… commits since the decision: {entry.commits.join(', ')}
    </p>)}
    <div className="mt-2">
      {!answered && <PlanDecisionDialog teamPath={teamPath} planId={planId} card={card} mode="answer" current={null}
        sessions={sessions} connected={connected} busy={busy} onSend={onSend} />}
      {answered && <PlanDecisionDialog teamPath={teamPath} planId={planId} card={card} mode="override" current={current}
        sessions={sessions} connected={connected} busy={busy} onSend={onSend} />}
    </div>
  </li>
}

/** The plan-level Decisions list (D15): cards with no change — or every card when no execution gives them a change row. */
export function PlanDecisionsList({ teamPath, planId, cards, sessions, connected, busy, onSend, onOpenTask }: {
  teamPath: string
  planId: string
  cards: PlanDecisionCardView[]
  sessions: Session[]
  connected: boolean
  busy: boolean
  onSend: SendClientMessage
  onOpenTask: (taskId: string) => void
}) {
  if (cards.length === 0) return null
  return <section className="mt-3" data-testid="plan-decisions-section" aria-labelledby="plan-decisions-heading">
    <h3 id="plan-decisions-heading" className="text-chat-meta font-medium">Decisions</h3>
    <ul className="mt-1 space-y-2">
      {cards.map(cardView => <PlanDecisionCard key={cardView.card.id} teamPath={teamPath} planId={planId}
        cardView={cardView} sessions={sessions} connected={connected} busy={busy} onSend={onSend} onOpenTask={onOpenTask} />)}
    </ul>
  </section>
}
