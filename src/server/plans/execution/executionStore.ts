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
import { logger } from '../../logger'
import type { AttemptKind, AttemptManifest, CiCheck, ExecutionOutcome } from '../../../shared/planExecution'
import {
  changeHolderId, mapAttempt, mapChange, mapExecution, mapLanding, mapRound, mapSlot,
  type AttemptRow, type ChangeRow, type ExecutionRow, type LandingRow, type RoundRow, type SlotRow,
} from './executionRows'
import { ExecutionConflict, mapConstraint, patchAssignments, type ChangeGuard, type ChangePatch, type NewExecution } from './executionPatch'
import { ExecutionEffectStore } from './executionEffectStore'

// The write vocabulary lives in `executionPatch.ts` and the effect rows in
// `executionEffectStore.ts` (the base class), so this file stays under 500
// lines; both are re-exported or inherited unchanged for every importer.
export {
  type ExecutionConflictKind, ExecutionConflict, type NewExecution,
  type ChangePatch, type ChangeGuard, mapConstraint,
} from './executionPatch'

/** A mechanism-added slot holder kind's liveness check (X6): true while its holder still needs the slot. */
export type SlotHolderCheck = (holderId: string) => boolean

export class ExecutionStore extends ExecutionEffectStore {
  private readonly holderChecks = new Map<string, SlotHolderCheck>()
  private readonly holderLabels = new Map<string, (holderId: string) => string>()
  private readonly listeners = new Set<(teamId: string) => void>()

  /** A committed execution write (D17): the team's plan views re-push. */
  subscribe(listener: (teamId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(teamId: string): void {
    for (const listener of this.listeners) listener(teamId)
  }

  /** Register a mechanism's slot holder kind (X6); `change` is built in. */
  registerHolderKind(kind: string, check: SlotHolderCheck, label?: (holderId: string) => string): void {
    if (kind === 'change') throw new Error('the change holder kind is built in')
    this.holderChecks.set(kind, check)
    if (label) this.holderLabels.set(kind, label)
  }

  /** Who holds the team's slot, as a waiting change shows it: a change's id, or the kind's own label (a promotion's branch). */
  slotHolderLabel(teamId: string): string | null {
    const slot = this.slot(teamId)
    if (slot === null) return null
    return this.holderLabels.get(slot.holderKind)?.(slot.holderId) ?? slot.holderId
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
      this.changed(input.teamId)
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

  /** Finished executions still holding a `landing` change: a merge running at Stop settles after it (D12). */
  settlingForTeam(teamId: string): ExecutionRow[] {
    return (this.db.prepare(`SELECT * FROM plan_executions e WHERE team_id = ? AND state <> 'running'
      AND EXISTS (SELECT 1 FROM plan_execution_changes c WHERE c.execution_id = e.id AND c.state = 'landing') ORDER BY started_at, rowid`)
      .all(teamId) as Array<Record<string, unknown>>).map(mapExecution)
  }

  /** Run `body` in one transaction on the store's connection (Stop's commit, D12). */
  atomically<T>(body: () => T): T {
    return this.db.transaction(body)()
  }

  /** Every team holding a running execution (the runtime's boot wake, D5). */
  runningTeams(): string[] {
    return (this.db.prepare("SELECT DISTINCT team_id FROM plan_executions WHERE state = 'running'").all() as Array<{ team_id: string }>)
      .map(row => row.team_id)
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
      const teamId = String((this.db.prepare('SELECT team_id FROM plan_executions WHERE id = ?').get(id) as { team_id: string }).team_id)
      this.db.prepare('UPDATE plan_execution_changes SET owns = 0, updated_at = ? WHERE execution_id = ? AND owns = 1').run(at, id)
      this.db.prepare("DELETE FROM plan_landing_slots WHERE holder_kind = 'change' AND holder_id LIKE ? ESCAPE '\\'")
        .run(`${id.replace(/[\\%_]/g, char => `\\${char}`)}:%`)
      this.changed(teamId)
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
      for (const [column, value] of patchAssignments(patch)) {
        sets.push(`${column} = ?`)
        values.push(value)
      }
      if (next === 'landed' || next === 'cancelled') sets.push('owns = 0')
      this.db.prepare(`UPDATE plan_execution_changes SET ${sets.join(', ')} WHERE execution_id = ? AND change = ?`)
        .run(...values, executionId, change)
      if (current.state !== 'landing' && next === 'landing') this.takeSlot(current.teamId, changeHolderId(executionId, change), at)
      if (current.state === 'landing' && next !== 'landing') this.releaseSlot(current.teamId, changeHolderId(executionId, change))
      const updated = this.change(executionId, change)
      if (updated !== null) this.changed(current.teamId)
      return updated
    })()
  }

  // --- the landing slot ---

  slot(teamId: string): SlotRow | null {
    const row = this.db.prepare('SELECT * FROM plan_landing_slots WHERE team_id = ?').get(teamId) as Record<string, unknown> | null
    return row ? mapSlot(row) : null
  }

  private takeSlot(teamId: string, holderId: string, at: string, kind = 'change'): void {
    const insert = () => this.db.prepare('INSERT INTO plan_landing_slots (team_id, holder_kind, holder_id, since) VALUES (?, ?, ?, ?)')
      .run(teamId, kind, holderId, at)
    try {
      insert()
    } catch (error) {
      // Found taken: an orphan is cleared and the take tried once more.
      if (!(error instanceof Error) || !error.message.includes('plan_landing_slots.team_id') || this.clearOrphanSlots(teamId).length === 0) mapConstraint(error)
      try { insert() } catch (again) { mapConstraint(again) }
    }
  }

  private releaseSlot(teamId: string, holderId: string, kind = 'change'): void {
    this.db.prepare('DELETE FROM plan_landing_slots WHERE team_id = ? AND holder_kind = ? AND holder_id = ?').run(teamId, kind, holderId)
  }

  /**
   * A registered holder kind takes the team's slot (integration-candidates
   * D10 step 3): true when it now holds it (or already did), false while a
   * live holder keeps it — an orphan is cleared first, as for a change.
   */
  takeSlotFor(teamId: string, kind: string, holderId: string): boolean {
    if (!this.holderChecks.has(kind)) throw new Error(`unregistered slot holder kind ${kind}`)
    const held = this.slot(teamId)
    if (held !== null && held.holderKind === kind && held.holderId === holderId) return true
    try {
      this.takeSlot(teamId, holderId, this.iso(), kind)
      return true
    } catch (error) {
      if (error instanceof ExecutionConflict && error.kind === 'slot-taken') return false
      throw error
    }
  }

  /** A registered holder kind gives the slot back; a slot it does not hold is untouched. */
  releaseSlotFor(teamId: string, kind: string, holderId: string): void {
    this.releaseSlot(teamId, holderId, kind)
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

  /** The team's landing facts since `since` (the summary window, plan-supervision D13). */
  landingsSince(teamId: string, since: string): LandingRow[] {
    return (this.db.prepare('SELECT * FROM plan_change_landings WHERE team_id = ? AND landed_at >= ? ORDER BY landed_at, rowid')
      .all(teamId, since) as Array<Record<string, unknown>>).map(mapLanding)
  }

  /** The team's change rows stopped since `since` (the summary window, plan-supervision D13), with their execution's plan. */
  stoppedChangesSince(teamId: string, since: string): Array<ChangeRow & { planId: string }> {
    return (this.db.prepare(`SELECT c.*, e.plan_id AS plan_id FROM plan_execution_changes c JOIN plan_executions e ON e.id = c.execution_id
      WHERE c.team_id = ? AND c.state = 'stopped' AND c.updated_at >= ? ORDER BY c.updated_at, c.rowid`)
      .all(teamId, since) as Array<Record<string, unknown>>).map(row => ({ ...mapChange(row), planId: String(row.plan_id) }))
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
      // The CI window opens at the push (markRoundPushed), not here: a push
      // that backs off must not eat into the round's 30 minutes (D10).
      this.db.prepare(`INSERT INTO plan_execution_rounds (id, execution_id, change, attempt_id, number, result_id, commit_sha, fix_round)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.executionId, input.change, input.attemptId, number, input.resultId, input.commitSha, input.fixRound ? 1 : 0,
      )
      if (prior && prior.outcome === null) {
        // Any verdict stops counting (D9): a passed round waiting for the slot
    // is superseded as well as an open one.
    this.db.prepare(`UPDATE plan_execution_rounds SET outcome = 'superseded', decided_at = ? WHERE id = ? AND (outcome IS NULL OR outcome != 'superseded')`).run(at, prior.id)
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
    // Any verdict stops counting (D9): a passed round waiting for the slot
    // is superseded as well as an open one.
    this.db.prepare(`UPDATE plan_execution_rounds SET outcome = 'superseded', decided_at = ? WHERE id = ? AND (outcome IS NULL OR outcome != 'superseded')`)
      .run(this.iso(), id)
  }

  /** D13's carried round: a clean base merge carries the verdict; CI runs on the new head. */
  insertCarriedRound(input: { executionId: string; change: string; attemptId: string; resultId: string; commitSha: string; carriedFrom: string; ciWindowFrom: string }): RoundRow {
    return this.db.transaction(() => {
      const prior = this.rounds(input.executionId, input.change).at(-1) ?? null
      const number = (prior?.number ?? 0) + 1
      const id = `round-${crypto.randomUUID()}`
      // GitHub's merge commit is on origin and keeps its source's review: only CI reruns (D13).
      const source = this.round(input.carriedFrom)
      this.db.prepare(`INSERT INTO plan_execution_rounds (id, execution_id, change, attempt_id, number, result_id, commit_sha, fix_round, carried_from, ci_window_from, pushed_at, review_assignment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.executionId, input.change, input.attemptId, number, input.resultId, input.commitSha,
        source?.fixRound === true ? 1 : 0, input.carriedFrom, input.ciWindowFrom, input.ciWindowFrom, source?.reviewAssignmentId ?? null,
      )
      if (prior && prior.outcome === null) {
        // Any verdict stops counting (D9): a passed round waiting for the slot
    // is superseded as well as an open one.
    this.db.prepare(`UPDATE plan_execution_rounds SET outcome = 'superseded', decided_at = ? WHERE id = ? AND (outcome IS NULL OR outcome != 'superseded')`).run(this.iso(), prior.id)
      }
      return this.round(id)!
    })()
  }

  /** Record base-branch CI on the landing fact as evidence (D13 step 6). */
  setLandingPostCi(planId: string, change: string, postCi: CiCheck[]): void {
    this.db.prepare('UPDATE plan_change_landings SET post_ci_json = ? WHERE plan_id = ? AND change = ?')
      .run(JSON.stringify(postCi), planId, change)
  }

  /** Decide the round (D11/D12): outcome, verdict findings, extra checks, time. */
  decideRound(id: string, outcome: 'pass' | 'fail', detail: { verdictFindingsId?: string; extra?: RoundRow['extra'] } = {}): void {
    this.db.prepare(`UPDATE plan_execution_rounds SET outcome = ?, verdict_findings_id = ?, extra_json = ?, decided_at = ? WHERE id = ?`)
      .run(outcome, detail.verdictFindingsId ?? null, detail.extra ? JSON.stringify(detail.extra) : null, this.iso(), id)
  }
}
