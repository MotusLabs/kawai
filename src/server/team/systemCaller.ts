// Kawai's task caller and its rights per origin (plan-execution D2, widened
// by plan-supervision D7). The system caller carries why Kawai acts:
// - `execution`: a plan execution, minted only inside
//   `src/server/plans/execution`; it keeps D2's rights unchanged;
// - `override` / `promotion`: an owner's decision override or a failed
//   promotion, minted only by `src/server/plans/decisions/fixTasks.ts`
//   through functions it does not export; their rights end at creating a fix
//   or correction task (with its `plan_fix_tasks` row), dispatching it, and
//   closing it as its creator.
// Every path that accepts a system caller asks `refuseSystem` first, so a new
// origin must name its rights here before it compiles.
import type { TeamIdentity } from './teamIdentity'

export type SystemOrigin =
  | { kind: 'execution'; executionId: string }
  | { kind: 'override'; decisionId: string }
  | { kind: 'promotion'; promotionId: string }

export interface SystemCaller {
  kind: 'system'
  team: TeamIdentity
  origin: SystemOrigin
}

/** What Kawai does through a task path; each path names the one it needs. */
export type SystemRight =
  | 'read'
  | 'create-linked'
  | 'create-fix'
  | 'dispatch'
  | 'handoff'
  | 'accept'
  | 'close'
  | 'status'
  | 'note'
  | 'submit'
  | 'acknowledge'
  // A recheck is requested by the human or a team member (independent-
  // verification D4); no origin holds it — Kawai never rechecks on its own.
  | 'recheck'

const EXECUTION_RIGHTS: readonly SystemRight[] = ['read', 'create-linked', 'dispatch', 'handoff', 'accept', 'close', 'status', 'note', 'submit', 'acknowledge']
const DECISION_RIGHTS: readonly SystemRight[] = ['create-fix', 'dispatch', 'close']

/** The rights of an origin (D7): exhaustive, so a new origin names its rights before it compiles. */
export function originRights(origin: SystemOrigin): readonly SystemRight[] {
  switch (origin.kind) {
    case 'execution':
      return EXECUTION_RIGHTS
    case 'override':
    case 'promotion':
      return DECISION_RIGHTS
    default: {
      const never: never = origin
      throw new Error(`Unknown system origin: ${JSON.stringify(never)}`)
    }
  }
}

/** A short name for refusals and journal lines. */
export function originLabel(origin: SystemOrigin): string {
  switch (origin.kind) {
    case 'execution':
      return `execution ${origin.executionId}`
    case 'override':
      return `override ${origin.decisionId}`
    case 'promotion':
      return `promotion ${origin.promotionId}`
    default: {
      const never: never = origin
      return String(never)
    }
  }
}

/** Throw unless a system caller's origin holds the right; agents and the human pass untouched. */
export function refuseSystem(caller: { kind: string; origin?: SystemOrigin }, right: SystemRight): void {
  if (caller.kind !== 'system' || caller.origin === undefined) return
  if (!originRights(caller.origin).includes(right)) {
    throw new Error(`Kawai acting for ${originLabel(caller.origin)} has no ${right} right; nothing was written.`)
  }
}

/** The execution a system caller acts for, or null for the decision origins. */
export function executionOf(caller: SystemCaller): string | null {
  return caller.origin.kind === 'execution' ? caller.origin.executionId : null
}
