// Labels for the Plans view (durable-plans D12): revision statuses, change
// progress, events, actors, and the strategy pin, in the style of
// strategyLabels — plus the decision-card labels (plan-supervision D15).
import type { Session } from '@shared/types'
import type { PlanActor, PlanChangeStatus, PlanEvent, PlanRevisionStatus, PlanStrategyPin } from '@shared/plans'
import type { CardState, DecisionKind, DecisionParty } from '@shared/planDecisions'
import { sessionLabel, shortHash } from '../chat/strategyLabels'

export const PLAN_REVISION_LABELS: Record<PlanRevisionStatus, string> = {
  in_review: 'In review',
  approved: 'Approved',
  superseded: 'Superseded',
  withdrawn: 'Withdrawn',
}

export const CHANGE_STATUS_LABELS: Record<PlanChangeStatus, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

const EVENT_LABELS: Record<string, string> = {
  created: 'Created',
  submitted: 'Submitted',
  approved: 'Approved',
  withdrawn: 'Withdrawn',
  'draft-discarded': 'Draft discarded',
  completed: 'Completed',
  cancelled: 'Cancelled',
  reopened: 'Reopened',
}

/** A known event kind's label; later changes' kinds render verbatim. */
export const eventLabel = (kind: string): string => EVENT_LABELS[kind] ?? kind

export const planActorLabel = (actor: PlanActor | PlanEvent['actor'], sessions: Session[]): string =>
  actor.kind === 'human' ? 'Human' : actor.kind === 'system' ? 'Kawai' : sessionLabel(actor.sessionId, sessions)

/** The pin as the list and detail show it; no pin reads as Alignment unassessed. */
export const pinLabel = (pin: PlanStrategyPin | null): string =>
  pin ? `Strategy revision ${pin.revision} · ${shortHash(pin.hash)}` : 'Alignment unassessed'

export const CARD_STATE_LABELS: Record<CardState, string> = { open: 'Open', decided: 'Decided', overridden: 'Overridden' }

export const DECISION_KIND_LABELS: Record<DecisionKind, string> = { answer: 'Answer', 'own-call': 'Own call', override: 'Override' }

/** Who asked or decided a card: the human is the owner; an agent names its session, group, and profile. */
export const decisionPartyLabel = (party: DecisionParty, sessions: Session[]): string => {
  if (party.kind === 'human') return 'Human (owner)'
  const who = party.session === null ? 'an agent' : sessionLabel(party.session, sessions)
  return [who, party.group, party.profile].filter(Boolean).join(' · ')
}

export { shortHash }
