// Approval preconditions (durable-plans design D7, contract C4). Approval
// evaluates this ordered list inside its transaction; every entry runs, and
// each failing one contributes its name and an actionable message, so a
// refusal names every reason at once. The list and the `pinDisposition`
// lookup are the extension points: later changes append entries (plan
// validation adds `validation-current`) or supply dispositions (strategy
// revision impact) without editing the entries shipped here.
//
// The context is built in exactly one place, `buildApprovalContext`, from
// what `prepareApproval` gathered before the transaction. Preparation is
// asynchronous and empty in this change; it is the seam for checks that
// must read outside SQLite (plan validation's `prepareStanding`), whose
// prepared result the builder turns into a context field inside the
// transaction (`standing(prepared)`). Adding such a field changes neither
// PlanService's callers nor the shipped entries.
import type { Plan, PlanRevision, PlanStrategyPin } from '../../shared/plans'
import { samePin } from '../../shared/plans'
import type { PlanStore } from './planStore'

/** What the human approves: the exact revision and hash they reviewed, and the approved revision they saw. */
export interface ApprovalRequest {
  planId: string
  revision: number
  contentHash: string
  expectedApprovedRevision: number | null
  commandId: string
}

/** A recorded decision that keeps an older strategy pin (owned by strategy-revision-impact). */
export interface PinDisposition {
  kind: string
}

/** Read-only lookups approval needs; PlanService supplies them. */
export interface ApprovalDeps {
  store: PlanStore
  /** The team's current approved strategy revision and hash; null without one. */
  currentStrategyPin: (teamId: string) => PlanStrategyPin | null
  /** A disposition that keeps this revision's older pin; always null in this change. */
  pinDisposition: (planId: string, revision: number) => PinDisposition | null
}

/** Gathered before the transaction (async). Empty in this change; later checks add their inputs here. */
export type ApprovalPrepared = Record<never, never>

/** Everything a precondition may read, built inside the approval transaction. */
export interface ApprovalContext {
  plan: Plan
  /** The requested revision; null when it does not exist. */
  revision: PlanRevision | null
  request: ApprovalRequest
  /** The team's current approved strategy pin at commit time. */
  strategyPin: PlanStrategyPin | null
  pinDisposition: (planId: string, revision: number) => PinDisposition | null
}

export interface ApprovalPrecondition {
  name: string
  /** A message saying what to do, or null when the precondition holds. */
  check: (ctx: ApprovalContext) => string | null
}

export interface PreconditionFailure {
  name: string
  message: string
}

/** The shipped preconditions, in order (D7). */
export const APPROVAL_PRECONDITIONS: readonly ApprovalPrecondition[] = [
  {
    name: 'plan-open',
    check: ({ plan }) => (plan.lifecycle === 'open' ? null : `The plan is ${plan.lifecycle}; reopen it before approving a revision.`),
  },
  {
    name: 'revision-in-review',
    check: ({ revision, request }) => {
      if (!revision) return `Revision ${request.revision} does not exist.`
      return revision.status === 'in_review' ? null : `Revision ${request.revision} is ${revision.status}, not in review; only a revision in review can be approved.`
    },
  },
  {
    name: 'hash-matches',
    check: ({ revision, request }) => {
      if (!revision || revision.contentHash === request.contentHash) return null
      return `Revision ${request.revision}'s content hash is ${revision.contentHash}, not ${request.contentHash}: it differs from what was reviewed. Reload and review it again.`
    },
  },
  {
    name: 'approved-revision-unchanged',
    check: ({ plan, request }) => (plan.currentApprovedRevision === request.expectedApprovedRevision ? null
      : `The approved revision changed while this approval was open (expected ${request.expectedApprovedRevision ?? 'none'}, now ${plan.currentApprovedRevision ?? 'none'}). Reload and review the current state.`),
  },
  {
    name: 'strategy-pin-current',
    check: ({ revision, strategyPin, pinDisposition, request }) => {
      if (!revision || samePin(revision.pin, strategyPin)) return null
      if (pinDisposition(request.planId, revision.revision)) return null
      const pinned = revision.pin ? `strategy revision ${revision.pin.revision}` : 'no strategy (Alignment unassessed)'
      const current = strategyPin ? `strategy revision ${strategyPin.revision}` : 'no approved strategy'
      return `Revision ${revision.revision} is pinned to ${pinned}, but the team now has ${current}. Ask the author to resubmit the draft so the pin is current.`
    },
  },
]

/** The pre-transaction gather step (pin 2 seam): awaited before approval's transaction; nothing to gather yet. */
export async function prepareApproval(_deps: ApprovalDeps, _plan: Plan, _request: ApprovalRequest): Promise<ApprovalPrepared> {
  return {}
}

/** The one place the context is built, inside the transaction, from fresh rows and the prepared inputs. */
export function buildApprovalContext(deps: ApprovalDeps, _prepared: ApprovalPrepared, plan: Plan, request: ApprovalRequest): ApprovalContext {
  return {
    plan,
    revision: deps.store.revision(plan.id, request.revision),
    request,
    strategyPin: deps.currentStrategyPin(plan.teamId),
    pinDisposition: deps.pinDisposition,
  }
}

/** Run every precondition; the failures, in list order. */
export function evaluatePreconditions(list: readonly ApprovalPrecondition[], ctx: ApprovalContext): PreconditionFailure[] {
  const failures: PreconditionFailure[] = []
  for (const entry of list) {
    const message = entry.check(ctx)
    if (message !== null) failures.push({ name: entry.name, message })
  }
  return failures
}
