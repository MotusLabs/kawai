// Plan execution store (plan-execution design D3): the only SQL writer of
// execution rows. Policy-free primitives that ExecutionService and the
// executor compose inside their own transactions; each multi-row write here is
// itself a (nested, savepoint) transaction, so a refusal leaves nothing.
// The database arbitrates three races, and a constraint error never leaves
// this file raw — it becomes an `ExecutionConflict`:
// - one running execution per plan (`plan_executions_one_running`) → `one-execution`;
// - one owner per team and change, across plans (`plan_execution_changes_owner`) → `changes-unclaimed`;
// - one landing slot per team (the `plan_landing_slots` key) → `slot-taken`.
// Change transitions are guarded by the row's `state` and `generation` (a
// stale guard writes nothing and returns null) and bump the generation.
// Entering `landing` takes the slot row and leaving it deletes the row, in the
// same transaction. Because that pairing is a rule rather than a constraint,
// an orphan — a slot row held by a change that is not in `landing` — is
// cleared and logged at startup and whenever the slot is found taken. A
// holder kind a landing mechanism adds supplies its own liveness check (X6).
import type { Database } from 'bun:sqlite'
import { logger } from '../../logger'
import type { AttemptKind, AttemptManifest, ChangeState, ChangeStep, CiCheck, EffectKind, ExecutionOutcome, FloorMap, MergeMethod, StopDetail, StopReason } from '../../../shared/planExecution'
import {
  changeHolderId, mapAttempt, mapChange, mapEffect, mapExecution, mapLanding, mapRound, mapSlot,
  type AttemptRow, type ChangeRow, type EffectRow, type ExecutionRow, type LandingRow, type RoundRow, type SlotRow,
} from './executionRows'

export type ExecutionConflictKind = 'one-execution' | 'changes-unclaimed' | 'slot-taken'

/** A database race lost, named; the message is fit for a refusal. */
export class ExecutionConflict extends Error {
  constructor(readonly kind: ExecutionConflictKind, message: string) { super(message) }
}

export interface NewExecution {
  teamId: string
  planId: string
  revision: number
  contentHash: string
  reportId: string
  inputHash: string
  landingMode: string
  baseBranch: string
  baseCommit: string
  floor: { version: number; map: FloorMap }
  maxParallel: number
  mergeMethod: MergeMethod
  /** In content order; a change with a landing fact starts `landed` and owns nothing (D4). */
  changes: Array<{ change: string; landed: boolean }>
}

/** Fields a transition may set; `undefined` leaves a column as it is, `null` clears it. */
export interface ChangePatch {
  state?: ChangeState
  step?: ChangeStep | null
  stopReason?: StopReason | null
  stopDetail?: StopDetail | null
  taskId?: string | null
  worktree?: string | null
  branch?: string | null
  baselineCommit?: string | null
  prNumber?: number | null
  prUrl?: string | null
  prOpenedByKawai?: boolean | null
  fixRounds?: number
  passedAt?: string | null
}

export interface ChangeGuard { state: ChangeState; generation: number }

/** A mechanism-added slot holder kind's liveness check (X6): true while its holder still needs the slot. */
export type SlotHolderCheck = (holderId: string) => boolean

const PATCH_COLUMNS: Record<keyof ChangePatch, string> = {
  state: 'state', step: 'step', stopReason: 'stop_reason', stopDetail: 'stop_detail_json', taskId: 'task_id',
  worktree: 'worktree', branch: 'branch', baselineCommit: 'baseline_commit', prNumber: 'pr_number', prUrl: 'pr_url',
  prOpenedByKawai: 'pr_opened_by_kawai', fixRounds: 'fix_rounds', passedAt: 'passed_at',
}

function columnValue(key: keyof ChangePatch, value: unknown): string | number | null {
  if (value === null) return null
  if (key === 'stopDetail') return JSON.stringify(value)
  if (key === 'prOpenedByKawai') return value ? 1 : 0
  return value as string | number
}

/** Map a constraint error to its named conflict; anything else is rethrown as is. */
export function mapConstraint(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('UNIQUE constraint failed: plan_executions.plan_id')) {
    throw new ExecutionConflict('one-execution', 'The plan already has a running execution.')
  }
  if (message.includes('UNIQUE constraint failed: plan_execution_changes.team_id, plan_execution_changes.change')) {
    throw new ExecutionConflict('changes-unclaimed', 'A change of this plan is already owned by another running execution.')
  }
  if (message.includes('UNIQUE constraint failed: plan_landing_slots.team_id')) {
    throw new ExecutionConflict('slot-taken', "The team's landing slot is taken.")
  }
  throw error
}

export class ExecutionStore {
  private readonly holderChecks = new Map<string, SlotHolderCheck>()

  constructor(readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  private iso(): string { return this.now().toISOString() }

  /** Register a mechanism's slot holder kind (X6); `change` is built in. */
  registerHolderKind(kind: string, check: SlotHolderCheck): void {
    if (kind === 'change') throw new Error('the change holder kind is built in')
    this.holderChecks.set(kind, check)
  }

  // --- executions ---

  insertExecution(input: NewExecution): ExecutionRow {
    const id = `exec-${crypto.randomUUID()}`
    const at = this.iso()
    try {
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO plan_executions (id, team_id, plan_id, revision, content_hash, report_id, input_hash, landing_mode,
          base_branch, base_commit, floor_json, max_parallel, merge_method, state, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(
          id, input.teamId, input.planId, input.revision, input.contentHash, input.reportId, input.inputHash, input.landingMode,
          input.baseBranch, input.baseCommit, JSON.stringify(input.floor), input.maxParallel, input.mergeMethod, at,
        )
        const change = this.db.prepare(`INSERT INTO plan_execution_changes (execution_id, change, team_id, position, state, owns, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        input.changes.forEach((entry, position) => {
          change.run(id, entry.change, input.teamId, position, entry.landed ? 'landed' : 'waiting', entry.landed ? 0 : 1, at)
        })
      })()
    } catch (error) {
      mapConstraint(error)
    }
    return this.execution(id)!
  }

  execution(id: string): ExecutionRow | null {
    const row = this.db.prepare('SELECT * FROM plan_executions WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? mapExecution(row) : null
  }

  /** The plan's running execution, if any. */
  running(planId: string): ExecutionRow | null {
    const row = this.db.prepare("SELECT * FROM plan_executions WHERE plan_id = ? AND state = 'running'").get(planId) as Record<string, unknown> | null
    return row ? mapExecution(row) : null
  }

  runningForTeam(teamId: string): ExecutionRow[] {
    return (this.db.prepare("SELECT * FROM plan_executions WHERE team_id = ? AND state = 'running' ORDER BY started_at, rowid").all(teamId) as Array<Record<string, unknown>>)
      .map(mapExecution)
  }

  /** Every execution of a plan, newest first. */
  executionsOf(planId: string): ExecutionRow[] {
    return (this.db.prepare('SELECT * FROM plan_executions WHERE plan_id = ? ORDER BY started_at DESC, rowid DESC').all(planId) as Array<Record<string, unknown>>)
      .map(mapExecution)
  }

  /**
   * Finish a running execution: its changes give up ownership and any slot
   * row they hold, in one transaction. False when it was not running.
   */
  finishExecution(id: string, outcome: ExecutionOutcome, stopReason: string | null = null): boolean {
    return this.db.transaction(() => {
      const at = this.iso()
      const finished = this.db.prepare(`UPDATE plan_executions SET state = 'finished', outcome = ?, stop_reason = ?, finished_at = ?
        WHERE id = ? AND state = 'running'`).run(outcome, stopReason, at, id)
      if (finished.changes === 0) return false
      this.db.prepare('UPDATE plan_execution_changes SET owns = 0, updated_at = ? WHERE execution_id = ? AND owns = 1').run(at, id)
      this.db.prepare("DELETE FROM plan_landing_slots WHERE holder_kind = 'change' AND holder_id LIKE ? ESCAPE '\\'")
        .run(`${id.replace(/[\\%_]/g, char => `\\${char}`)}:%`)
      return true
    })()
  }

  // --- changes ---

  changes(executionId: string): ChangeRow[] {
    return (this.db.prepare('SELECT * FROM plan_execution_changes WHERE execution_id = ? ORDER BY position').all(executionId) as Array<Record<string, unknown>>)
      .map(mapChange)
  }

  change(executionId: string, change: string): ChangeRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_changes WHERE execution_id = ? AND change = ?').get(executionId, change) as Record<string, unknown> | null
    return row ? mapChange(row) : null
  }

  /** The row owning a change for the team, whatever the plan (D3, D7). */
  ownerOf(teamId: string, change: string): ChangeRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_changes WHERE team_id = ? AND change = ? AND owns = 1').get(teamId, change) as Record<string, unknown> | null
    return row ? mapChange(row) : null
  }

  /** The owning row whose task is this one, if any (D7's ownership guards). */
  ownerOfTask(taskId: string): ChangeRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_changes WHERE task_id = ? AND owns = 1').get(taskId) as Record<string, unknown> | null
    return row ? mapChange(row) : null
  }

  /** Every change the team's running executions own. */
  ownedChanges(teamId: string): ChangeRow[] {
    return (this.db.prepare('SELECT * FROM plan_execution_changes WHERE team_id = ? AND owns = 1 ORDER BY execution_id, position').all(teamId) as Array<Record<string, unknown>>)
      .map(mapChange)
  }

  /**
   * Move one change, guarded by its state and generation: null (nothing
   * written) when the guard is stale. Entering `landing` takes the team's
   * slot (an orphan is cleared first; a live holder throws `slot-taken`);
   * leaving it releases the slot. `landed` and `cancelled` give up ownership.
   */
  transition(executionId: string, change: string, guard: ChangeGuard, patch: ChangePatch): ChangeRow | null {
    return this.db.transaction(() => {
      const current = this.change(executionId, change)
      if (!current || current.state !== guard.state || current.generation !== guard.generation) return null
      const next = patch.state ?? current.state
      const at = this.iso()
      const sets = ['generation = generation + 1', 'updated_at = ?']
      const values: Array<string | number | null> = [at]
      for (const key of Object.keys(patch) as Array<keyof ChangePatch>) {
        if (patch[key] === undefined) continue
        sets.push(`${PATCH_COLUMNS[key]} = ?`)
        values.push(columnValue(key, patch[key]))
      }
      if (next === 'landed' || next === 'cancelled') sets.push('owns = 0')
      this.db.prepare(`UPDATE plan_execution_changes SET ${sets.join(', ')} WHERE execution_id = ? AND change = ?`)
        .run(...values, executionId, change)
      if (current.state !== 'landing' && next === 'landing') this.takeSlot(current.teamId, changeHolderId(executionId, change), at)
      if (current.state === 'landing' && next !== 'landing') this.releaseSlot(current.teamId, changeHolderId(executionId, change))
      return this.change(executionId, change)
    })()
  }

  // --- the landing slot ---

  slot(teamId: string): SlotRow | null {
    const row = this.db.prepare('SELECT * FROM plan_landing_slots WHERE team_id = ?').get(teamId) as Record<string, unknown> | null
    return row ? mapSlot(row) : null
  }

  private takeSlot(teamId: string, holderId: string, at: string): void {
    const insert = () => this.db.prepare("INSERT INTO plan_landing_slots (team_id, holder_kind, holder_id, since) VALUES (?, 'change', ?, ?)")
      .run(teamId, holderId, at)
    try {
      insert()
    } catch (error) {
      // Found taken: an orphan is cleared and the take tried once more.
      if (!(error instanceof Error) || !error.message.includes('plan_landing_slots.team_id') || this.clearOrphanSlots(teamId).length === 0) mapConstraint(error)
      try { insert() } catch (again) { mapConstraint(again) }
    }
  }

  private releaseSlot(teamId: string, holderId: string): void {
    this.db.prepare("DELETE FROM plan_landing_slots WHERE team_id = ? AND holder_kind = 'change' AND holder_id = ?").run(teamId, holderId)
  }

  /** Whether a slot row's holder still needs it; an unknown mechanism kind is kept (no check to judge it by). */
  private holderLive(slot: SlotRow): boolean {
    if (slot.holderKind !== 'change') return this.holderChecks.get(slot.holderKind)?.(slot.holderId) ?? true
    const split = slot.holderId.indexOf(':')
    const holder = split < 0 ? null : this.change(slot.holderId.slice(0, split), slot.holderId.slice(split + 1))
    return holder?.state === 'landing'
  }

  /** Delete and log slot rows whose holder is gone (startup: every team). Returns the cleared rows. */
  clearOrphanSlots(teamId?: string): SlotRow[] {
    return this.db.transaction(() => {
      const rows = (teamId === undefined
        ? this.db.prepare('SELECT * FROM plan_landing_slots').all()
        : this.db.prepare('SELECT * FROM plan_landing_slots WHERE team_id = ?').all(teamId)) as Array<Record<string, unknown>>
      const orphans = rows.map(mapSlot).filter(slot => !this.holderLive(slot))
      for (const slot of orphans) {
        this.db.prepare('DELETE FROM plan_landing_slots WHERE team_id = ? AND holder_id = ?').run(slot.teamId, slot.holderId)
        logger.warn('plan_landing_slot_orphan_cleared', { teamId: slot.teamId, holderKind: slot.holderKind, holderId: slot.holderId, since: slot.since })
      }
      return orphans
    })()
  }

  // --- attempts and landing facts ---

  insertAttempt(input: { executionId: string; change: string; kind: AttemptKind; assignmentId: string | null; manifest: AttemptManifest; manifestHash: string }): AttemptRow {
    const id = `attempt-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_execution_attempts (id, execution_id, change, number, kind, assignment_id, manifest_json, manifest_hash, created_at)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM plan_execution_attempts WHERE execution_id = ? AND change = ?), ?, ?, ?, ?, ?)`)
      .run(id, input.executionId, input.change, input.executionId, input.change, input.kind, input.assignmentId,
        JSON.stringify(input.manifest), input.manifestHash, this.iso())
    return mapAttempt(this.db.prepare('SELECT * FROM plan_execution_attempts WHERE id = ?').get(id) as Record<string, unknown>)
  }

  attempts(executionId: string, change: string): AttemptRow[] {
    return (this.db.prepare('SELECT * FROM plan_execution_attempts WHERE execution_id = ? AND change = ? ORDER BY number').all(executionId, change) as Array<Record<string, unknown>>)
      .map(mapAttempt)
  }

  /** Record a landing fact (X7): one per plan and change. */
  insertLanding(input: Omit<LandingRow, 'landedAt' | 'postCi'> & { postCi?: CiCheck[] | null }): LandingRow {
    this.db.prepare(`INSERT INTO plan_change_landings (plan_id, change, execution_id, team_id, mechanism, pr_number, pr_url, head_sha, base_sha,
      merge_sha, landed_at, tree_verified, post_ci_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.planId, input.change, input.executionId, input.teamId, input.mechanism, input.prNumber, input.prUrl, input.headSha, input.baseSha,
      input.mergeSha, this.iso(), input.treeVerified ? 1 : 0, input.postCi ? JSON.stringify(input.postCi) : null,
    )
    return this.landings(input.planId).find(landing => landing.change === input.change)!
  }

  landings(planId: string): LandingRow[] {
    return (this.db.prepare('SELECT * FROM plan_change_landings WHERE plan_id = ? ORDER BY landed_at, rowid').all(planId) as Array<Record<string, unknown>>)
      .map(mapLanding)
  }

  // --- rounds (D9/D10/D11) ---

  /**
   * Insert a round for a new result (D9): the previous round, open or not,
   * is superseded unless its merge has started (a `landing` change); the
   * change returns to `gating` and any slot it held is released — the
   * transition out of `landing` releases it. Returns the round and whether
   * the change moved.
   */
  insertRound(input: { executionId: string; change: string; attemptId: string; resultId: string; commitSha: string; fixRound: boolean }): { round: RoundRow; changeMoved: boolean } {
    return this.db.transaction(() => {
      const at = this.iso()
      const prior = this.rounds(input.executionId, input.change).at(-1) ?? null
      const number = (prior?.number ?? 0) + 1
      const id = `round-${crypto.randomUUID()}`
      this.db.prepare(`INSERT INTO plan_execution_rounds (id, execution_id, change, attempt_id, number, result_id, commit_sha, fix_round, ci_window_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.executionId, input.change, input.attemptId, number, input.resultId, input.commitSha, input.fixRound ? 1 : 0, at,
      )
      if (prior && prior.outcome === null) {
        this.db.prepare(`UPDATE plan_execution_rounds SET outcome = 'superseded', decided_at = ? WHERE id = ? AND outcome IS NULL`).run(at, prior.id)
      }
      // Back to gating (D9); leaving `landing` releases the slot (D3).
      const row = this.change(input.executionId, input.change)!
      const patch: ChangePatch = { state: 'gating', step: null }
      let changeMoved = false
      if (row.state === 'implementing' || row.state === 'gating' || row.state === 'landing') {
        changeMoved = this.transition(input.executionId, input.change, row, patch) !== null
      }
      return { round: this.round(id)!, changeMoved }
    })()
  }

  round(id: string): RoundRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_rounds WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? mapRound(row) : null
  }

  rounds(executionId: string, change: string): RoundRow[] {
    return (this.db.prepare('SELECT * FROM plan_execution_rounds WHERE execution_id = ? AND change = ? ORDER BY number').all(executionId, change) as Array<Record<string, unknown>>)
      .map(mapRound)
  }

  /** Record the push and open the CI window (D10). */
  markRoundPushed(id: string, at: string | null = null): void {
    this.db.prepare('UPDATE plan_execution_rounds SET pushed_at = ?, ci_window_from = COALESCE(ci_window_from, ?) WHERE id = ?')
      .run(at ?? this.iso(), at ?? this.iso(), id)
  }

  /** Record the CI read of the round's commit (D10). */
  setRoundCi(id: string, ci: CiCheck[], rerunAt: string | null): void {
    this.db.prepare('UPDATE plan_execution_rounds SET ci_json = ?, rerun_at = ? WHERE id = ?').run(JSON.stringify(ci), rerunAt, id)
  }

  /** Record the review assignment the round awaits (D11). */
  setRoundReview(id: string, assignmentId: string): void {
    this.db.prepare('UPDATE plan_execution_rounds SET review_assignment_id = ? WHERE id = ?').run(assignmentId, id)
  }

  /** Clear the round's review assignment — Retry's review-unavailable re-dispatch (D12). */
  clearRoundReview(id: string): void {
    this.db.prepare('UPDATE plan_execution_rounds SET review_assignment_id = NULL WHERE id = ?').run(id)
  }

  /** Reopen the round's CI window — Retry after a CI stop (D12). */
  reopenRoundWindow(id: string, from: string): void {
    this.db.prepare('UPDATE plan_execution_rounds SET ci_window_from = ?, pushed_at = ? WHERE id = ?').run(from, from, id)
  }

  /** Supersede an open round outright (D9's revision supersession). */
  supersedeRound(id: string): void {
    this.db.prepare(`UPDATE plan_execution_rounds SET outcome = 'superseded', decided_at = ? WHERE id = ? AND outcome IS NULL`)
      .run(this.iso(), id)
  }

  /** Decide the round (D11/D12): outcome, verdict findings, extra checks, time. */
  decideRound(id: string, outcome: 'pass' | 'fail', detail: { verdictFindingsId?: string; extra?: RoundRow['extra'] } = {}): void {
    this.db.prepare(`UPDATE plan_execution_rounds SET outcome = ?, verdict_findings_id = ?, extra_json = ?, decided_at = ? WHERE id = ?`)
      .run(outcome, detail.verdictFindingsId ?? null, detail.extra ? JSON.stringify(detail.extra) : null, this.iso(), id)
  }

  // --- effects (D14): recorded before they run, inspected before they repeat ---

  /**
   * Insert one effect row; idempotent by key — a step re-enqueued after a
   * restart returns the recorded row and never writes a second.
   */
  insertEffect(input: { executionId: string; change: string | null; roundId: string | null; kind: EffectKind; effectKey: string; command: Record<string, unknown> }): EffectRow {
    const existing = this.effectByKey(input.effectKey)
    if (existing) return existing
    const id = `effect-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_execution_effects (id, execution_id, change, round_id, kind, effect_key, command_json, state, tries, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`).run(
      id, input.executionId, input.change, input.roundId, input.kind, input.effectKey, JSON.stringify(input.command), this.iso(),
    )
    return this.effect(id)!
  }

  effect(id: string): EffectRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_effects WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? mapEffect(row) : null
  }

  effectByKey(effectKey: string): EffectRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_effects WHERE effect_key = ?').get(effectKey) as Record<string, unknown> | null
    return row ? mapEffect(row) : null
  }

  effectsOf(executionId: string): EffectRow[] {
    return (this.db.prepare('SELECT * FROM plan_execution_effects WHERE execution_id = ? ORDER BY created_at, rowid').all(executionId) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /** The team's due pending effects, oldest first, across its running executions (D5: one at a time per team). */
  dueEffects(teamId: string, now: string): EffectRow[] {
    return (this.db.prepare(`SELECT e.* FROM plan_execution_effects e
      JOIN plan_executions x ON x.id = e.execution_id
      WHERE x.team_id = ? AND x.state = 'running' AND e.state = 'pending' AND (e.next_at IS NULL OR e.next_at <= ?)
      ORDER BY e.created_at, e.rowid`).all(teamId, now) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  markEffectRunning(id: string): void {
    this.db.prepare("UPDATE plan_execution_effects SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(this.iso(), id)
  }

  /** Commit a settled outcome (done, failed, unknown, cancelled) with its facts. */
  setEffectOutcome(id: string, outcome: { state: 'done' | 'failed' | 'unknown' | 'cancelled'; outcome?: unknown; error?: string | null }): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = ?, outcome_json = ?, error = ?, finished_at = ? WHERE id = ?`).run(
      outcome.state, outcome.outcome === undefined ? null : JSON.stringify(outcome.outcome), outcome.error ?? null, this.iso(), id,
    )
  }

  /** A transient failure goes back to pending, one try counted, retrying at `nextAt` (D14's backoff). */
  scheduleEffectRetry(id: string, nextAt: string, error: string | null): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = 'pending', tries = tries + 1, next_at = ?, error = ? WHERE id = ?`).run(nextAt, error, id)
  }

  /** Stop cancels every pending effect of the execution (D12). */
  cancelEffects(executionId: string): void {
    this.db.prepare("UPDATE plan_execution_effects SET state = 'cancelled', finished_at = ? WHERE execution_id = ? AND state = 'pending'").run(this.iso(), executionId)
  }

  /** Startup recovery (D14): a `running` effect's process is gone — it becomes `unknown`, inspected before it repeats. */
  markRunningEffectsUnknown(): EffectRow[] {
    return this.db.transaction(() => {
      const rows = (this.db.prepare("SELECT * FROM plan_execution_effects WHERE state = 'running'").all() as Array<Record<string, unknown>>).map(mapEffect)
      const update = this.db.prepare("UPDATE plan_execution_effects SET state = 'unknown' WHERE id = ?")
      for (const row of rows) update.run(row.id)
      return rows
    })()
  }

  /**
   * The done provision effects that created `branch` (D6): a name that
   * exists is accepted only when one of these belongs to an execution of
   * the same plan.
   */
  doneProvisions(branch: string): Array<{ executionId: string; command: Record<string, unknown> }> {
    return (this.db.prepare(`SELECT * FROM plan_execution_effects WHERE kind = 'provision' AND state = 'done'`)
      .all() as Array<Record<string, unknown>>)
      .map(mapEffect)
      .filter(effect => effect.command.branch === branch)
      .map(effect => ({ executionId: effect.executionId, command: effect.command }))
  }

  /** The due `unknown` effects, oldest first — inspected before anything else for their change runs (D14). */
  dueUnknownEffects(now: string): EffectRow[] {
    return (this.db.prepare(`SELECT e.* FROM plan_execution_effects e
      JOIN plan_executions x ON x.id = e.execution_id
      WHERE x.state = 'running' AND e.state = 'unknown' AND (e.next_at IS NULL OR e.next_at <= ?)
      ORDER BY e.created_at, e.rowid`).all(now) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /** An inspection that found the work not done puts the effect back to pending, to run again (D14). */
  resetEffect(id: string): void {
    this.db.prepare("UPDATE plan_execution_effects SET state = 'pending', next_at = NULL WHERE id = ?").run(id)
  }

  /** An undecidable inspection stays `unknown`, one try counted, retrying at `nextAt` (D14). */
  scheduleInspectionRetry(id: string, nextAt: string, error: string | null): void {
    this.db.prepare("UPDATE plan_execution_effects SET state = 'unknown', tries = tries + 1, next_at = ?, error = ? WHERE id = ?").run(nextAt, error, id)
  }
}
