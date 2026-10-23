// The resolve's releaseHold overlay (revision-control 4.4, design "Under a
// standing hold", H1r-H4r), split from pauseResolve.ts so that file stays
// under 500 lines. The hold a resolution releases is the pause's own
// (`pause.holdId` — the hold the dialog names): checks refuse with nothing
// written, then the `hold-released` event lands in the resolution's own
// transaction under `<commandId>:release-hold`.
import { PlanRefusal } from '../planCommands'
import type { PlanCaller } from '../PlanService'
import type { PlanPause, PlanPauseTarget } from '../../../shared/planRevisionControl'
import type { PauseServiceDeps } from './pauseService'
import { ResolveRefusal, type ResolveInput } from './pauseResolve'

/**
 * The overlay, run inside `within` before the choice dispatch. Checks first,
 * each refusing with nothing written (Q-A4): H3r — the hold was released
 * standalone (releasing a hold never resolves a pause, so an open pause can
 * outlive it); H2r — a whole-plan hold cannot release with a resolution, the
 * dialog points to narrowing first (a release with `retain`). Then the
 * release itself: the `hold-released` event recorded through
 * `recordRevisionControlEvent` inside the resolve's own transaction (a
 * nested savepoint; the outer replay never reaches `within`, so a retried
 * resolve cannot release twice), freeing the change's row — the store
 * releases the hold outright once no row remains. Returns the facts the
 * outcome names (H4r): the other active holds still covering the change
 * stay, and the change remains gated by them.
 */
export function releaseNamedHoldWithin(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput,
  pause: PlanPause, target: PlanPauseTarget): { holdId: string; stillCovering: string[] } {
  const named = deps.holds.get(caller.team.teamId, pause.holdId)
  if (named === null) throw new PlanRefusal('state', `The hold ${pause.holdId} of pause ${pause.id} is missing. Nothing was written.`)
  if (named.releasedAt !== null) {
    throw new ResolveRefusal('hold-already-released', `Hold ${named.id} is already released; there is nothing left to release with this resolution. Nothing was written.`)
  }
  if (named.scope === 'plan') {
    throw new ResolveRefusal('whole-plan-hold', `Hold ${named.id} covers the whole plan, so this resolution cannot release it: narrow the hold to its changes first (a release with retain), then resolve again. Nothing was written.`)
  }
  const commandId = `${input.commandId.trim()}:release-hold`
  const reason = `released with the resolution of change ${target.change} (pause ${pause.id})`
  const released = deps.planService.recordRevisionControlEvent(pause.planId, {
    kind: 'hold-released', commandId, holdId: named.id, changes: [target.change], retain: [], reason,
  }, () => deps.holds.release({ teamId: caller.team.teamId, holdId: named.id, changes: [target.change], reason, commandId }))
  if (!released.ok || released.replayed || released.result === undefined || !released.result.written) {
    throw new PlanRefusal('state', `The hold ${named.id} did not release with the resolution. Nothing was written.`)
  }
  const stillCovering = deps.holds.active(caller.team.teamId, pause.planId)
    .filter(hold => hold.scope === 'plan' || hold.changes.includes(target.change))
    .map(hold => hold.id).sort()
  return { holdId: named.id, stillCovering }
}
