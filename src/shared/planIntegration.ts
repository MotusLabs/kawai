// SDK-free integration-branch records and views (integration-candidates
// design D3, D11, D13; contracts I1, I2), shared by the server, `plan_get`,
// and the Plans view. It names the candidate kinds and states, the outside
// commits a candidate flags, the promotion steps, states, outcomes, and
// effect kinds, and the integration view. Three pure functions run over
// stored rows, so the server, the agent tool, and the client agree without a
// git call:
// - `candidateChain`: a branch's candidates, newest first;
// - `referenceCommit`: the commit the rewritten check and outside commits
//   compare with (D4);
// - `promotedThrough`: how far merged promotions carried each branch (D11);
// - `promotedChanges` and `somethingToPromote`: the Plans view's promoted
//   marks and whether Promote is offered (D11, D13).
import type { CiCheck } from './planExecution'

/** An increment lands a change; a promotion records the head a promotion verified (D3, D10). */
export type CandidateKind = 'increment' | 'promotion'
export const CANDIDATE_KINDS: readonly CandidateKind[] = ['increment', 'promotion']

/** verifying → passed → landed, or failed / superseded (D5–D7). */
export type CandidateState = 'verifying' | 'passed' | 'landed' | 'failed' | 'superseded'
export const CANDIDATE_STATES: readonly CandidateState[] = ['verifying', 'passed', 'landed', 'failed', 'superseded']

/** A commit on the integration branch that Kawai did not land (D5). */
export interface OutsideCommit {
  sha: string
  author: string
  subject: string
}

/** One `plan_integration_branches` row: the branch, its plan, and the latest creation (D3, D4). */
export interface IntegrationBranchRecord {
  teamId: string
  branch: string
  planId: string
  /** The default branch: the promotion target. */
  targetBranch: string
  /** The execution of the latest creation. */
  createdBy: string
  createdSha: string
  createdAt: string
}

/** One `plan_integration_candidates` row (D3). */
export interface IntegrationCandidate {
  id: string
  teamId: string
  branch: string
  seq: number
  kind: CandidateKind
  executionId: string | null
  change: string | null
  resultId: string | null
  roundId: string | null
  promotionId: string | null
  /** The integration head it extends. */
  baselineSha: string
  commitSha: string
  treeSha: string
  /** Commits between the reference commit and the baseline; null when none. */
  outside: OutsideCommit[] | null
  state: CandidateState
  createdAt: string
  decidedAt: string | null
}

/** The promotion steps of D10, in order; `held` is the hold wait of revision-control D5. */
export type PromotionStep =
  | 'branch'
  | 'pull-request'
  | 'slot'
  | 'held'
  | 'up-to-date'
  | 'ci'
  | 're-read'
  | 'merge'
  | 'record'
  | 'fast-forward'
  | 'finish'
export const PROMOTION_STEPS: readonly PromotionStep[] = ['branch', 'pull-request', 'slot', 'held', 'up-to-date', 'ci', 're-read', 'merge', 'record', 'fast-forward', 'finish']

export type PromotionState = 'running' | 'finished'

/** Why a promotion failed (D10, spec "A failed promotion merges nothing"). */
export type PromotionFailure = 'promotion-conflict' | 'effect-failed' | 'effect-unknown' | 'pr-closed' | 'target-moved' | 'ci-failed' | 'ci-missing' | 'ci-timeout'
export const PROMOTION_FAILURES: readonly PromotionFailure[] = ['promotion-conflict', 'effect-failed', 'effect-unknown', 'pr-closed', 'target-moved', 'ci-failed', 'ci-missing', 'ci-timeout']

export type PromotionOutcome = 'merged' | 'cancelled' | `failed:${PromotionFailure}`

/** The promotion effects table's kinds (D3, D10). */
export type PromotionEffectKind = 'create-promotion-branch' | 'open-pr' | 'update-branch' | 'rerun' | 'merge' | 'fast-forward' | 'close-pr'
export const PROMOTION_EFFECT_KINDS: readonly PromotionEffectKind[] = ['create-promotion-branch', 'open-pr', 'update-branch', 'rerun', 'merge', 'fast-forward', 'close-pr']

/** One `plan_promotions` row (D3). */
export interface PromotionRecord {
  id: string
  teamId: string
  planId: string
  branch: string
  /** n in `<branch>--promote-<n>`. */
  number: number
  commandId: string
  /** The pinned integration head. */
  fromSha: string
  /** The last landed candidate the pinned head contains. */
  throughSeq: number
  targetBranch: string
  promotionBranch: string
  prNumber: number | null
  prUrl: string | null
  /** The verified head P. */
  headSha: string | null
  step: PromotionStep | null
  moves: number
  state: PromotionState
  outcome: PromotionOutcome | null
  outcomeDetail: Record<string, unknown> | null
  mergeSha: string | null
  treeVerified: boolean | null
  fastForwarded: boolean | null
  fastForwardNote: string | null
  cancelReason: string | null
  startedAt: string
  finishedAt: string | null
}

/** A promotion as the view shows it: the record plus its CI on the floor snapshot (null before CI ran). */
export type PromotionView = PromotionRecord & { ci: { checks: CiCheck[]; flaky: string[] } | null }

/** One integration branch as the Plans view and `plan_get` show it (D12, D13). */
export interface PlanIntegrationView {
  branch: string
  targetBranch: string
  /** The branch's head on origin when last read; null when unread or missing. */
  head: string | null
  createdSha: string
  /** Newest first (`candidateChain`). */
  candidates: IntegrationCandidate[]
  /** Newest first, each with its CI evidence (the flaky names marked). */
  promotions: PromotionView[]
  /** The highest promoted `seq`; 0 when nothing was promoted. */
  promotedThroughSeq: number
}

/** A branch's candidates, newest first: a failed candidate stays in the chain beside the one that replaced it (D13). */
export function candidateChain(candidates: readonly IntegrationCandidate[], branch?: string): IntegrationCandidate[] {
  return candidates
    .filter(candidate => branch === undefined || candidate.branch === branch)
    .slice()
    .sort((a, b) => b.seq - a.seq)
}

/**
 * The reference commit (D4): the last landed candidate's commit, or the
 * creation commit when the branch was created after that landing or nothing
 * has landed. Superseded and failed candidates never count, so a promotion
 * whose fast-forward was skipped is not the reference.
 */
export function referenceCommit(branch: Pick<IntegrationBranchRecord, 'branch' | 'createdSha' | 'createdAt'>, candidates: readonly IntegrationCandidate[]): string {
  const landed = candidateChain(candidates, branch.branch).find(candidate => candidate.state === 'landed')
  if (landed === undefined) return branch.createdSha
  const landedAt = landed.decidedAt ?? landed.createdAt
  return branch.createdAt > landedAt ? branch.createdSha : landed.commitSha
}

/** Per branch, the highest `through_seq` among merged promotions (D11); a branch without one is absent. */
export function promotedThrough(promotions: readonly Pick<PromotionRecord, 'branch' | 'outcome' | 'throughSeq'>[]): Map<string, number> {
  const through = new Map<string, number>()
  for (const promotion of promotions) {
    if (promotion.outcome !== 'merged') continue
    through.set(promotion.branch, Math.max(through.get(promotion.branch) ?? 0, promotion.throughSeq))
  }
  return through
}

/** Whether a landed candidate's change counts as promoted: its `seq` is at most the branch's promoted `through_seq` (D11). */
export function candidatePromoted(candidate: Pick<IntegrationCandidate, 'branch' | 'seq' | 'state'>, through: ReadonlyMap<string, number>): boolean {
  return candidate.state === 'landed' && candidate.seq <= (through.get(candidate.branch) ?? 0)
}

/** The changes whose landed increment a merged promotion carried into the target (D11). */
export function promotedChanges(views: readonly PlanIntegrationView[]): Set<string> {
  const promoted = new Set<string>()
  for (const view of views) {
    for (const candidate of view.candidates) {
      if (candidate.kind === 'increment' && candidate.change !== null && candidate.state === 'landed' && candidate.seq <= view.promotedThroughSeq) promoted.add(candidate.change)
    }
  }
  return promoted
}

/** Promote is offered (D13): a landed increment is not yet promoted and no promotion of the branch runs. */
export function somethingToPromote(view: PlanIntegrationView): boolean {
  if (view.promotions.some(promotion => promotion.state === 'running')) return false
  return view.candidates.some(candidate => candidate.kind === 'increment' && candidate.state === 'landed' && candidate.seq > view.promotedThroughSeq)
}

/** What the Promote dialog shows (D9, D13): the standing, the pinned head, what it carries, and the outside commits. */
export interface PromotionPreview {
  branch: string
  targetBranch: string | null
  /** The head Promote would pin: the branch's head on origin. */
  head: string | null
  failures: Array<{ name: string; message: string }>
  /** The last landed candidate the head contains. */
  throughSeq: number
  /** Landed candidates not yet promoted and contained in the head, newest first. */
  carried: IntegrationCandidate[]
  outside: OutsideCommit[]
}
