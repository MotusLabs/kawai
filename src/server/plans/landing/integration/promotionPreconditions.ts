// Promote preconditions (integration-candidates design D9): the ordered list
// every Promote evaluates inside its transaction, shaped like Start's
// (plan-execution D4): `{ name, check(ctx) → string | null }` over a context
// PromotionService builds from its pre-reads (ls-remote, ancestry, the
// repository settings, the landing probe) and fresh rows. Every entry runs,
// and each failure contributes its name and an actionable message, so a
// refusal names every reason at once. Plan state is never an entry: a
// completed plan is the usual one to promote, and a cancelled plan's landed
// work may still be wanted.
import type { IntegrationBranchRecord } from '../../../../shared/planIntegration'
import type { ActiveHold } from '../../../../shared/planRevisionControl'
import type { ProbeFinding } from '../landingProbe'

export interface PromoteRequest {
  planId: string
  branch: string
  fromSha: string
  commandId: string
}

/** Everything a Promote precondition may read, built inside the transaction from the pre-reads and fresh rows. */
export interface PromoteCheckContext {
  request: PromoteRequest
  /** The branch's `plan_integration_branches` row when it is this plan's; null otherwise. */
  branchRecord: IntegrationBranchRecord | null
  /** The plan's running execution, if any. */
  runningExecution: { id: string } | null
  /** The plan's running promotion, if any (the partial unique index also enforces it). */
  runningPromotion: { id: string; number: number; step: string | null } | null
  /** The integration branch's head on origin, pre-read; null when missing or unreadable. */
  originHead: string | null
  /** Whether the target's head on origin contains `fromSha`; null when it could not be read. */
  targetContains: boolean | null
  /** The repository's `allow_merge_commit`; null when it could not be read. */
  allowMergeCommit: boolean | null
  /** The probe's repository and floor-map findings; empty when landing is ready. */
  probeFindings: ProbeFinding[]
  /** The promotion branch the pre-reads checked, and whether it exists on origin (null: unreadable). */
  promotionBranch: string
  promotionBranchExists: boolean | null
  /** The name the insert would take now; differs from `promotionBranch` when another promotion was inserted since the reads. */
  nextPromotionBranch: string
  /** The plan's active holds (revision-control D5), fresh in the transaction. */
  activeHolds: ActiveHold[]
  /** The carried changes an active hold covers, from the same reads as the preview's `carried`. */
  heldCarried: string[]
}

export interface PromotePrecondition {
  name: string
  /** A message saying what to do, or null when the precondition holds. */
  check: (ctx: PromoteCheckContext) => string | null
}

/** The Promote preconditions, in order (D9). Later changes append entries and never edit a shipped one. */
export const PROMOTE_PRECONDITIONS: readonly PromotePrecondition[] = [
  {
    name: 'integration-branch-known',
    check: ctx => ctx.branchRecord !== null ? null
      : `${ctx.request.branch} is not an integration branch this plan's execution created; promote the branch its execution records.`,
  },
  {
    name: 'no-execution',
    check: ctx => ctx.runningExecution === null ? null
      : `The plan's execution ${ctx.runningExecution.id} is still running; wait for it to finish, or stop it, before promoting.`,
  },
  {
    name: 'no-promotion',
    check: ctx => ctx.runningPromotion === null ? null
      : `Promotion ${ctx.runningPromotion.number} of this plan is still running (step ${ctx.runningPromotion.step ?? 'finishing'}); wait for it or cancel it.`,
  },
  {
    name: 'from-current',
    check: ctx => {
      if (ctx.originHead === null) return `${ctx.request.branch}'s head on origin could not be read, or the branch is missing; nothing is promoted from an unread head.`
      return ctx.originHead === ctx.request.fromSha ? null
        : `${ctx.request.branch} is now at ${ctx.originHead}, not ${ctx.request.fromSha}; reopen the Promote dialog to review the new head.`
    },
  },
  {
    name: 'something-to-promote',
    check: ctx => {
      if (ctx.targetContains === null) return `Whether ${ctx.branchRecord?.targetBranch ?? 'the default branch'} already contains ${ctx.request.fromSha} could not be read; try again.`
      return ctx.targetContains ? `${ctx.branchRecord?.targetBranch ?? 'The default branch'} already contains ${ctx.request.fromSha}; there is nothing to promote.` : null
    },
  },
  {
    name: 'merge-commits-allowed',
    check: ctx => {
      if (ctx.allowMergeCommit === null) return "The repository's allow_merge_commit setting could not be read; a promotion always merges with a merge commit."
      return ctx.allowMergeCommit ? null
        : "The repository does not allow merge commits (allow_merge_commit is false); a promotion always merges with a merge commit, so enable it in the repository settings."
    },
  },
  {
    name: 'landing-ready',
    check: ctx => ctx.probeFindings.length === 0 ? null : ctx.probeFindings.map(finding => finding.message).join(' '),
  },
  {
    name: 'promotion-name-free',
    check: ctx => {
      if (ctx.promotionBranch !== ctx.nextPromotionBranch) return `Another promotion took ${ctx.promotionBranch} while Promote read; try again.`
      if (ctx.promotionBranchExists === null) return `Whether ${ctx.promotionBranch} exists on origin could not be read; try again.`
      return ctx.promotionBranchExists ? `${ctx.promotionBranch} already exists on origin; Kawai never adopts a branch it did not create. Delete it on origin, then promote again.` : null
    },
  },
  // revision-control D5, appended: a whole-plan hold refuses, and so does a
  // hold covering any change the promotion would carry.
  {
    name: 'no-hold',
    check: ctx => {
      const plan = ctx.activeHolds.filter(hold => hold.scope === 'plan')
      if (plan.length > 0) return `The plan is on hold: ${plan.map(hold => hold.id).join(', ')}. Release the hold before promoting.`
      if (ctx.heldCarried.length > 0) return `Held changes this promotion would carry: ${ctx.heldCarried.join(', ')}. Release the hold before promoting.`
      return null
    },
  },
]

/** Every failing entry with its message, in list order; empty when Promote may proceed. */
export function evaluatePromotePreconditions(
  ctx: PromoteCheckContext,
  list: readonly PromotePrecondition[] = PROMOTE_PRECONDITIONS,
): Array<{ name: string; message: string }> {
  const failures: Array<{ name: string; message: string }> = []
  for (const entry of list) {
    const message = entry.check(ctx)
    if (message !== null) failures.push({ name: entry.name, message })
  }
  return failures
}
