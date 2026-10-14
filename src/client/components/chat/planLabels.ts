// Labels for the Plans view (durable-plans D12): revision statuses, change
// progress, events, actors, and the strategy pin, in the style of
// strategyLabels.
import type { Session } from '@shared/types'
import type { PlanActor, PlanChangeStatus, PlanEvent, PlanRevisionStatus, PlanStrategyPin } from '@shared/plans'
import { sessionLabel, shortHash } from './strategyLabels'

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

export { shortHash }
