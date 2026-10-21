// The hold gate (revision-control design D5): the pure predicate every step
// that would advance held work consults — the executor's planner, the landing
// mechanisms, promotion, and Start. A change is held while any active hold
// covers it (scope `plan`, or scope `changes` naming it), and closed too
// while an open pause target for it is undecided (Pausing or Paused): that is
// what keeps a task revision published outside Adapt from dispatching
// plan-execution D9's fix attempt while the change is paused. The gate never
// decides anything: a transition that both decides and dispatches still
// records its decision, and the dispatch stays owed in stored state until
// the gate opens.
import type { ActiveHold, HoldClosure } from '../../../shared/planRevisionControl'

/**
 * An open pause target: a target of an unclosed pause. `decision` is null
 * while Pausing or Paused; a decided target never closes the gate. A closed
 * pause's targets are not passed here at all.
 */
export interface OpenPauseTarget {
  pauseId: string
  change: string
  decision: string | null
}

/**
 * The closure for `change`, or null when nothing holds it. `scope` is `plan`
 * when a whole-plan hold covers the change, else `changes`; `holdIds` is
 * sorted so callers render and log deterministically. `pauseId` names the
 * undecided pause target when the pause closes the gate beside the holds
 * (or alone). Several pauses' targets for one change are open in principle:
 * the first in input order wins, and a second pause on the same change is
 * refused upstream (D6: no open pause covers the same hold).
 */
export function holdGate(activeHolds: readonly ActiveHold[], openTargets: readonly OpenPauseTarget[], change: string): HoldClosure | null {
  const covering = activeHolds.filter(hold => hold.scope === 'plan' || hold.changes.includes(change))
  const open = openTargets.find(target => target.change === change && target.decision === null)
  if (covering.length === 0 && !open) return null
  return {
    holdIds: covering.map(hold => hold.id).sort(),
    scope: covering.some(hold => hold.scope === 'plan') ? 'plan' : 'changes',
    pauseId: open?.pauseId ?? null,
  }
}
