// The revision-control attention sources (revision-control design D13;
// oracles AT1–AT10 of the design's "Remainder"): `plan-hold-overdue`,
// `plan-pause-overdue`, and `plan-checkpoint-decision`, each pure over the
// open plans' holds and pauses the one revision-control reader states. They
// join `ATTENTION_SOURCES` (workspaceRead.ts) beside plan-supervision's plan
// sources, link with the same `plan` link, and are owned by the human —
// the deadline never releases or kills anything. Each is derived only while
// its plan is open, and one target never raises two items: a Paused target,
// or one Pausing as `holder-killed` or `checkpoint-push-failed`, raises only
// the checkpoint decision, before or after the deadline; a target Pausing for
// another cause past the pause deadline raises only the overdue item.
import type { AttentionItem } from '../../shared/teamWorkspace'
import type { PauseTargetView, PauseView } from '../../shared/planRevisionControl'
import type { RevisionControlDetail } from './revisionControl/revisionControlRead'

/** One open plan's holds and pauses, read once per workspace snapshot. */
export interface RevisionControlAttentionFact extends RevisionControlDetail {
  planId: string
  planTitle: string
  /** When the reader ran: a hold's deadline has passed once it is at or before this. */
  now: string
}

type Source = (input: { revisionControl?: RevisionControlAttentionFact[] }) => AttentionItem[]

const humanOwner = { kind: 'human' as const, id: null, label: 'Human' }
const planLink = (fact: RevisionControlAttentionFact, change?: string) =>
  ({ kind: 'plan' as const, id: fact.planId, planId: fact.planId, ...(change === undefined ? {} : { change }) })

/** The causes that need the owner whatever the deadline (D8): the checkpoint decision's Pausing cells. */
const OWNER_CAUSES = new Set(['holder-killed', 'checkpoint-push-failed'])

/** Each open plan's holds and pauses (D13): a closed plan's holds go quiet (D4), so only open plans are read. */
export function revisionControlFactsOf(openPlans: ReadonlyArray<{ id: string; title: string }>,
  read: (planId: string, now: Date) => RevisionControlDetail, now: Date): RevisionControlAttentionFact[] {
  return openPlans.map(plan => ({ planId: plan.id, planTitle: plan.title, now: now.toISOString(), ...read(plan.id, now) }))
}

/** Which single item one pause target raises, if any (D8 "Deadline", D13). */
export function targetItemKind(pause: Pick<PauseView, 'deadlinePassed'>, target: Pick<PauseTargetView, 'state'>): 'plan-checkpoint-decision' | 'plan-pause-overdue' | null {
  const state = target.state
  if (state.state === 'decided') return null
  if (state.state === 'paused') return 'plan-checkpoint-decision'
  if (state.causes.some(cause => OWNER_CAUSES.has(cause.kind))) return 'plan-checkpoint-decision'
  return pause.deadlinePassed ? 'plan-pause-overdue' : null
}

/** AT1–AT3: an active hold past its review deadline; the deadline in the id, so an extension clears the item. */
export const planHoldOverdueItems: Source = ({ revisionControl }) =>
  (revisionControl ?? []).flatMap(fact => fact.holds
    .filter(hold => hold.releasedAt === null && Date.parse(hold.deadline) <= Date.parse(fact.now))
    .map(hold => ({
      id: `plan-hold-overdue:${hold.id}:${hold.deadline}`,
      kind: 'plan-hold-overdue',
      cause: `Hold ${hold.id} on plan "${fact.planTitle}" passed its review deadline ${hold.deadline}: ${hold.rationale}`,
      owner: humanOwner,
      impact: {},
      nextAction: 'Release or extend the hold',
      link: planLink(fact),
      requiresHuman: true,
    })))

/** AT5: a target still Pausing past the pause deadline for a cause that clears without the owner. */
export const planPauseOverdueItems: Source = ({ revisionControl }) =>
  (revisionControl ?? []).flatMap(fact => fact.pauses.flatMap(pause => pause.targets
    .filter(target => targetItemKind(pause, target) === 'plan-pause-overdue')
    .map(target => ({
      id: `plan-pause-overdue:${pause.id}:${target.change}`,
      kind: 'plan-pause-overdue',
      cause: `Change ${target.change} of plan "${fact.planTitle}" is still Pausing after the pause deadline ${pause.deadline}${causeList(target)}`,
      owner: humanOwner,
      impact: {},
      nextAction: 'Unblock the holder, or restart or stop',
      link: planLink(fact, target.change),
      requiresHuman: true,
    }))))

/** AT6–AT7: a Paused target, or one Pausing as `holder-killed` or `checkpoint-push-failed`, awaiting the owner's decision. */
export const planCheckpointDecisionItems: Source = ({ revisionControl }) =>
  (revisionControl ?? []).flatMap(fact => fact.pauses.flatMap(pause => pause.targets
    .filter(target => targetItemKind(pause, target) === 'plan-checkpoint-decision')
    .map(target => {
      const paused = target.state.state === 'paused'
      return {
        id: `plan-checkpoint:${pause.id}:${target.change}`,
        kind: 'plan-checkpoint-decision',
        cause: paused
          ? `Change ${target.change} of plan "${fact.planTitle}" is Paused and awaits your decision`
          : `Change ${target.change} of plan "${fact.planTitle}" cannot finish pausing${causeList(target)}`,
        owner: humanOwner,
        impact: {},
        nextAction: paused ? 'Continue, adapt, restart, or stop' : 'Restart or stop',
        link: planLink(fact, target.change),
        requiresHuman: true,
      }
    })))

const causeList = (target: PauseTargetView): string =>
  target.state.state === 'pausing' && target.state.causes.length > 0 ? ` (${target.state.causes.map(cause => cause.kind).join(', ')})` : ''

/** The three sources, in D13's order. */
export const REVISION_CONTROL_ATTENTION_SOURCES: readonly Source[] = [planHoldOverdueItems, planPauseOverdueItems, planCheckpointDecisionItems]
