// Integration store (integration-candidates design D3): the only SQL writer
// of the integration tables. Its primitives carry no policy:
// - the branch record;
// - candidates, with their state transitions;
// - promotions, with their step, moves, and finish;
// - promotion effects, through the `PromotionEffectStore` base class.
// The mechanism and the promotion service compose these primitives inside
// their own transactions. Every multi-row write here is itself a
// transaction, and a constraint error never leaves this file raw; it becomes
// an `IntegrationConflict`:
// - two candidates racing for one `seq` → `seq-taken` (the next seq is read
//   and inserted under one IMMEDIATE transaction, so concurrent writers
//   serialize);
// - a second running promotion of a plan → `no-promotion`, from the
//   partial unique index;
// - a Promote recorded under the same command id → `promotion-replay`.
// Candidate transitions follow `CANDIDATE_TRANSITIONS`, and an illegal one
// is refused as `illegal-transition`. These records need no user docs
// beyond this header.
import type { CandidateKind, CandidateState, IntegrationBranchRecord, IntegrationCandidate, OutsideCommit, PromotionOutcome, PromotionStep } from '../../../../shared/planIntegration'
import { CANDIDATE_TRANSITIONS, IntegrationConflict, mapBranch, mapCandidate, mapIntegrationConstraint, mapPromotion, type PromotionRow } from './integrationRows'
import { PromotionEffectStore } from './promotionEffectStore'

export { IntegrationConflict, type IntegrationConflictKind, type PromotionRow } from './integrationRows'

export interface NewCandidate {
  teamId: string
  branch: string
  kind: CandidateKind
  executionId?: string | null
  change?: string | null
  resultId?: string | null
  roundId?: string | null
  promotionId?: string | null
  baselineSha: string
  commitSha: string
  treeSha: string
  outside?: OutsideCommit[] | null
  state: Extract<CandidateState, 'verifying' | 'passed'>
}

export interface NewPromotion {
  teamId: string
  planId: string
  branch: string
  commandId: string
  fromSha: string
  throughSeq: number
  targetBranch: string
  floor: unknown
}

/** The promotion fields a step may set while it runs (D10). */
export interface PromotionPatch {
  step?: PromotionStep | null
  prNumber?: number | null
  prUrl?: string | null
  headSha?: string | null
  ci?: unknown
  rerunAt?: string | null
  ciWindowFrom?: string | null
  mergeSha?: string | null
  treeVerified?: boolean | null
  fastForwarded?: boolean | null
  fastForwardNote?: string | null
  cancelReason?: string | null
}

const PROMOTION_COLUMNS: Record<keyof PromotionPatch, string> = {
  step: 'step', prNumber: 'pr_number', prUrl: 'pr_url', headSha: 'head_sha', ci: 'ci_json', rerunAt: 'rerun_at',
  ciWindowFrom: 'ci_window_from', mergeSha: 'merge_sha', treeVerified: 'tree_verified', fastForwarded: 'fast_forwarded',
  fastForwardNote: 'fast_forward_note', cancelReason: 'cancel_reason',
}

function promotionValue(key: keyof PromotionPatch, value: unknown): string | number | null {
  if (value === null) return null
  if (key === 'ci') return JSON.stringify(value)
  if (key === 'treeVerified' || key === 'fastForwarded') return value ? 1 : 0
  return value as string | number
}

export class IntegrationStore extends PromotionEffectStore {
  /** Run `fn` as one transaction; nested calls become savepoints. */
  atomically<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // --- the branch record ---

  branch(teamId: string, branch: string): IntegrationBranchRecord | null {
    const row = this.db.prepare('SELECT * FROM plan_integration_branches WHERE team_id = ? AND branch = ?').get(teamId, branch) as Record<string, unknown> | null
    return row ? mapBranch(row) : null
  }

  branchesOfPlan(planId: string): IntegrationBranchRecord[] {
    return (this.db.prepare('SELECT * FROM plan_integration_branches WHERE plan_id = ? ORDER BY created_at, rowid').all(planId) as Array<Record<string, unknown>>).map(mapBranch)
  }

  /**
   * A creation (D4). The first one inserts the row. A creation again, after
   * the branch was deleted, keeps the row (its plan and target) and updates
   * only its creation fields.
   */
  recordCreation(input: { teamId: string; branch: string; planId: string; targetBranch: string; executionId: string; sha: string }): IntegrationBranchRecord {
    this.db.prepare(`INSERT INTO plan_integration_branches (team_id, branch, plan_id, target_branch, created_by, created_sha, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (team_id, branch) DO UPDATE SET created_by = excluded.created_by, created_sha = excluded.created_sha, created_at = excluded.created_at`)
      .run(input.teamId, input.branch, input.planId, input.targetBranch, input.executionId, input.sha, this.iso())
    return this.branch(input.teamId, input.branch)!
  }

  // --- candidates ---

  /** Insert a candidate with the branch's next `seq`, read and written under one IMMEDIATE transaction. */
  insertCandidate(input: NewCandidate): IntegrationCandidate {
    const id = `cand-${crypto.randomUUID()}`
    const insert = this.db.transaction(() => {
      const next = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM plan_integration_candidates WHERE team_id = ? AND branch = ?')
        .get(input.teamId, input.branch) as { seq: number }).seq
      this.insertCandidateAt(id, next, input)
    })
    try {
      if (this.db.inTransaction) insert()
      else insert.immediate()
    } catch (error) {
      mapIntegrationConstraint(error)
    }
    return this.candidate(id)!
  }

  /** The raw insert under a given `seq`; exported for the race test, never called with a guessed `seq` elsewhere. */
  insertCandidateAt(id: string, seq: number, input: NewCandidate): void {
    try {
      this.db.prepare(`INSERT INTO plan_integration_candidates (id, team_id, branch, seq, kind, execution_id, change, result_id, round_id, promotion_id,
        baseline_sha, commit_sha, tree_sha, outside_json, state, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.teamId, input.branch, seq, input.kind, input.executionId ?? null, input.change ?? null, input.resultId ?? null,
        input.roundId ?? null, input.promotionId ?? null, input.baselineSha, input.commitSha, input.treeSha,
        input.outside && input.outside.length > 0 ? JSON.stringify(input.outside) : null, input.state, this.iso(),
        input.state === 'passed' ? this.iso() : null,
      )
    } catch (error) {
      mapIntegrationConstraint(error)
    }
  }

  candidate(id: string): IntegrationCandidate | null {
    const row = this.db.prepare('SELECT * FROM plan_integration_candidates WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? mapCandidate(row) : null
  }

  candidates(teamId: string, branch: string): IntegrationCandidate[] {
    return (this.db.prepare('SELECT * FROM plan_integration_candidates WHERE team_id = ? AND branch = ? ORDER BY seq').all(teamId, branch) as Array<Record<string, unknown>>).map(mapCandidate)
  }

  /** The change's newest candidate of an execution, if any. */
  candidateOf(executionId: string, change: string): IntegrationCandidate | null {
    const row = this.db.prepare('SELECT * FROM plan_integration_candidates WHERE execution_id = ? AND change = ? ORDER BY seq DESC LIMIT 1').get(executionId, change) as Record<string, unknown> | null
    return row ? mapCandidate(row) : null
  }

  /** Move a candidate along `CANDIDATE_TRANSITIONS`; the expected state guards the write, and an illegal move is refused. */
  transitionCandidate(id: string, to: CandidateState): IntegrationCandidate {
    return this.atomically(() => {
      const current = this.candidate(id)
      if (current === null) throw new IntegrationConflict('illegal-transition', `No candidate ${id}.`)
      if (!CANDIDATE_TRANSITIONS[current.state].includes(to)) {
        throw new IntegrationConflict('illegal-transition', `Candidate ${current.seq} cannot go from ${current.state} to ${to}.`)
      }
      this.db.prepare('UPDATE plan_integration_candidates SET state = ?, decided_at = ? WHERE id = ? AND state = ?').run(to, this.iso(), id, current.state)
      return this.candidate(id)!
    })
  }

  // --- promotions ---

  promotion(id: string): PromotionRow | null {
    const row = this.db.prepare('SELECT * FROM plan_promotions WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? mapPromotion(row) : null
  }

  promotionsOf(planId: string): PromotionRow[] {
    return (this.db.prepare('SELECT * FROM plan_promotions WHERE plan_id = ? ORDER BY number').all(planId) as Array<Record<string, unknown>>).map(mapPromotion)
  }

  runningPromotion(planId: string): PromotionRow | null {
    const row = this.db.prepare("SELECT * FROM plan_promotions WHERE plan_id = ? AND state = 'running'").get(planId) as Record<string, unknown> | null
    return row ? mapPromotion(row) : null
  }

  promotionByCommand(planId: string, commandId: string): PromotionRow | null {
    const row = this.db.prepare('SELECT * FROM plan_promotions WHERE plan_id = ? AND command_id = ?').get(planId, commandId) as Record<string, unknown> | null
    return row ? mapPromotion(row) : null
  }

  /** Insert a running promotion with the plan's next `number`, named `<branch>--promote-<number>` (D9). */
  insertPromotion(input: NewPromotion): PromotionRow {
    const id = `promo-${crypto.randomUUID()}`
    return this.atomically(() => {
      const number = (this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM plan_promotions WHERE plan_id = ?').get(input.planId) as { n: number }).n
      try {
        this.db.prepare(`INSERT INTO plan_promotions (id, team_id, plan_id, branch, number, command_id, from_sha, through_seq, target_branch,
          promotion_branch, floor_json, step, moves, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'branch', 0, 'running', ?)`).run(
          id, input.teamId, input.planId, input.branch, number, input.commandId, input.fromSha, input.throughSeq,
          input.targetBranch, `${input.branch}--promote-${number}`, JSON.stringify(input.floor), this.iso(),
        )
      } catch (error) {
        mapIntegrationConstraint(error)
      }
      return this.promotion(id)!
    })
  }

  /** Patch a running promotion; a finished one is never written again. Returns false when nothing was written. */
  patchPromotion(id: string, patch: PromotionPatch): boolean {
    const keys = (Object.keys(patch) as Array<keyof PromotionPatch>).filter(key => patch[key] !== undefined)
    if (keys.length === 0) return false
    const sets = keys.map(key => `${PROMOTION_COLUMNS[key]} = ?`).join(', ')
    const values = keys.map(key => promotionValue(key, patch[key]))
    return this.db.prepare(`UPDATE plan_promotions SET ${sets} WHERE id = ? AND state = 'running'`).run(...values, id).changes === 1
  }

  /** The target moved (D10 step 6): one more move counted; returns the new count. */
  countMove(id: string): number {
    this.db.prepare("UPDATE plan_promotions SET moves = moves + 1 WHERE id = ? AND state = 'running'").run(id)
    return this.promotion(id)?.moves ?? 0
  }

  /** Finish a running promotion with its outcome; false when it had already finished. */
  finishPromotion(id: string, outcome: PromotionOutcome, detail: Record<string, unknown> | null = null): boolean {
    return this.db.prepare(`UPDATE plan_promotions SET state = 'finished', outcome = ?, outcome_detail_json = ?, finished_at = ?, step = NULL
      WHERE id = ? AND state = 'running'`).run(outcome, detail === null ? null : JSON.stringify(detail), this.iso(), id).changes === 1
  }
}
