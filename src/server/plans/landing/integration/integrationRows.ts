// Row mapping for the integration tables (integration-candidates D3): SQLite
// rows → the shared records of `src/shared/planIntegration.ts`. It also holds
// the candidate transition table and the named conflicts that a constraint
// error becomes. It does no I/O.
import type {
  CandidateState, IntegrationBranchRecord, IntegrationCandidate, OutsideCommit,
  PromotionOutcome, PromotionRecord, PromotionStep,
} from '../../../../shared/planIntegration'

export type IntegrationConflictKind = 'seq-taken' | 'no-promotion' | 'promotion-replay' | 'promotion-number-taken' | 'illegal-transition'

export class IntegrationConflict extends Error {
  constructor(readonly kind: IntegrationConflictKind, message: string) {
    super(message)
    this.name = 'IntegrationConflict'
  }
}

/** The legal candidate transitions (D5–D7, D10); landed, failed, and superseded are final. */
export const CANDIDATE_TRANSITIONS: Readonly<Record<CandidateState, readonly CandidateState[]>> = {
  verifying: ['passed', 'failed', 'superseded'],
  passed: ['landed', 'superseded'],
  landed: [],
  failed: [],
  superseded: [],
}

/** Map a constraint error of the integration tables to its named conflict; anything else is rethrown as is. */
export function mapIntegrationConstraint(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('UNIQUE constraint failed: plan_integration_candidates.team_id, plan_integration_candidates.branch, plan_integration_candidates.seq')) {
    throw new IntegrationConflict('seq-taken', 'The candidate sequence number is already taken on this branch.')
  }
  if (message.includes('UNIQUE constraint failed: plan_promotions.plan_id, plan_promotions.command_id')) {
    throw new IntegrationConflict('promotion-replay', 'A promotion was already recorded under this command id.')
  }
  if (message.includes('UNIQUE constraint failed: plan_promotions.plan_id, plan_promotions.number')) {
    throw new IntegrationConflict('promotion-number-taken', 'The promotion number is already taken.')
  }
  if (message.includes('UNIQUE constraint failed: plan_promotions.plan_id')) {
    throw new IntegrationConflict('no-promotion', 'The plan already has a running promotion.')
  }
  throw error
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const int = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const flag = (value: unknown): boolean | null => (typeof value === 'number' ? value === 1 : null)
const json = <T>(value: unknown): T | null => (typeof value === 'string' ? JSON.parse(value) as T : null)

export function mapBranch(row: Record<string, unknown>): IntegrationBranchRecord {
  return {
    teamId: String(row.team_id), branch: String(row.branch), planId: String(row.plan_id),
    targetBranch: String(row.target_branch), createdBy: String(row.created_by),
    createdSha: String(row.created_sha), createdAt: String(row.created_at),
  }
}

export function mapCandidate(row: Record<string, unknown>): IntegrationCandidate {
  return {
    id: String(row.id), teamId: String(row.team_id), branch: String(row.branch), seq: Number(row.seq),
    kind: String(row.kind) as IntegrationCandidate['kind'],
    executionId: text(row.execution_id), change: text(row.change), resultId: text(row.result_id),
    roundId: text(row.round_id), promotionId: text(row.promotion_id),
    baselineSha: String(row.baseline_sha), commitSha: String(row.commit_sha), treeSha: String(row.tree_sha),
    outside: json<OutsideCommit[]>(row.outside_json),
    state: String(row.state) as CandidateState,
    createdAt: String(row.created_at), decidedAt: text(row.decided_at),
  }
}

export function mapPromotion(row: Record<string, unknown>): PromotionRecord & { floor: unknown; ci: unknown; rerunAt: string | null; ciWindowFrom: string | null } {
  return {
    id: String(row.id), teamId: String(row.team_id), planId: String(row.plan_id), branch: String(row.branch),
    number: Number(row.number), commandId: String(row.command_id),
    fromSha: String(row.from_sha), throughSeq: Number(row.through_seq),
    targetBranch: String(row.target_branch), promotionBranch: String(row.promotion_branch),
    floor: json(row.floor_json),
    prNumber: int(row.pr_number), prUrl: text(row.pr_url), headSha: text(row.head_sha),
    step: text(row.step) as PromotionStep | null, moves: Number(row.moves ?? 0),
    ci: json(row.ci_json), rerunAt: text(row.rerun_at), ciWindowFrom: text(row.ci_window_from),
    state: String(row.state) as PromotionRecord['state'],
    outcome: text(row.outcome) as PromotionOutcome | null,
    outcomeDetail: json<Record<string, unknown>>(row.outcome_detail_json),
    mergeSha: text(row.merge_sha), treeVerified: flag(row.tree_verified),
    fastForwarded: flag(row.fast_forwarded), fastForwardNote: text(row.fast_forward_note),
    cancelReason: text(row.cancel_reason), startedAt: String(row.started_at), finishedAt: text(row.finished_at),
  }
}

export type PromotionRow = ReturnType<typeof mapPromotion>
