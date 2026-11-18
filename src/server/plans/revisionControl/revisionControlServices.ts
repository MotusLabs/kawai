// The revision-control services a composed PlanService carries (revision-
// control design D14, D15). `composePlanServices` builds the hold and pause
// services and the one read model beside the PlanService it returns, and
// attaches them here, keyed by that PlanService instance; the plan
// connections (the human hold and pause commands, the detail's `holds` and
// `pauses`), `plan_get`, and the workspace's attention read them through
// `revisionControlOf`. A side table rather than a new manager field keeps
// the session manager untouched: every consumer already holds the composed
// PlanService. Nothing here is agent-callable — the commands' only entry is
// the human's socket, and the services refuse a non-human caller (D15, I1).
import type { PlanService } from '../PlanService'
import type { HoldService } from './holdService'
import type { PauseService } from './pauseService'
import type { RevisionControlDetail } from './revisionControlRead'

export interface RevisionControlServices {
  holds: HoldService
  /** Null without team services: no pause can be requested there. */
  pauses: PauseService | null
  /** One plan's holds and pauses (`readRevisionControl` over the composed stores). */
  read: (teamId: string, planId: string, now?: Date) => RevisionControlDetail
}

const attached = new WeakMap<PlanService, RevisionControlServices>()

/** Attach the composed services to their PlanService (the composition's one call). */
export function attachRevisionControl(plans: PlanService, services: RevisionControlServices): void {
  attached.set(plans, services)
}

/** The services composed beside this PlanService; null when it was built outside `composePlanServices`. */
export function revisionControlOf(plans: PlanService | null | undefined): RevisionControlServices | null {
  return plans ? attached.get(plans) ?? null : null
}
