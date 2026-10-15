// Durable plans (durable-plans design D1): the team-scoped plan record, its
// numbered immutable revisions, CAS-guarded drafts, and the append-only
// event log, in the server's SQLite database beside `team_tasks` and the
// strategy tables. Revisions change status only; nothing rewrites their
// content or deletes one. The store is policy-free primitives: PlanService
// composes them inside `atomically` and decides who may do what. Change
// notifications go out after commit through `announce`, never from inside
// a transaction. The DDL and row mappers live in `planSchema.ts`.
import type { Database } from 'bun:sqlite'
import type {
  Plan,
  PlanActor,
  PlanContent,
  PlanDetail,
  PlanDraft,
  PlanEvent,
  PlanLifecycle,
  PlanLinkedTask,
  PlanRevision,
  PlanRevisionStatus,
  PlanStrategyPin,
  PlanSummary,
} from '../../shared/plans'
import { planDisplayState, planProgress } from '../../shared/plans'
import { CREATE_PLAN_TABLES_SQL, mapPlan, mapPlanDraft, mapPlanEvent, mapPlanRevision } from './planSchema'

export interface NewPlanEvent {
  kind: string
  revision?: number | null
  contentHash?: string | null
  actor: PlanActor | { kind: 'system'; sessionId: null }
  reason?: string | null
  /** Human commands only (D7); null for agent tool events. */
  commandId?: string | null
  /** The compared command payload, or event facts such as a draft id. */
  payload?: Record<string, unknown> | null
}

export interface DraftWrite {
  draftId: string
  author: PlanActor
  /** Normalized content and its draft hash. */
  content: PlanContent
  contentHash: string
  /** CAS (D5): the stored draft's hash the caller overwrites; null = create. */
  expectedDraftHash: string | null
  /** CAS: the base revision the caller believes the draft sits on; undefined = unchecked. */
  expectedBaseRevision?: number | null
}

export type DraftWriteOutcome =
  | { ok: true; draft: PlanDraft }
  | { ok: false; reason: 'conflict'; message: string; stored: PlanDraft | null }

/** Thrown by `insertEvent` when the command id is already recorded for the plan. */
export class PlanCommandRaceError extends Error {
  constructor(readonly commandId: string) { super(`plan command race: ${commandId}`) }
}

/** Thrown by `setRevisionStatus` when the one-approved index refuses a second approved row. */
export class PlanApprovedRaceError extends Error {
  constructor() { super('another revision of this plan is already approved') }
}

const nowIso = () => new Date().toISOString()
const isUnique = (error: unknown) => String(error).includes('UNIQUE constraint failed')

export class PlanStore {
  private readonly listeners = new Set<(plan: Plan) => void>()

  constructor(private readonly db: Database) {
    db.exec(CREATE_PLAN_TABLES_SQL)
  }

  /** Every committed change, with the plan as it is now. */
  subscribe(listener: (plan: Plan) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Announce a committed change (call after the transaction). */
  announce(planId: string): void {
    const plan = this.get(planId)
    if (!plan) return
    for (const listener of this.listeners) listener(plan)
  }

  /** Run writes as one transaction. */
  atomically<T>(write: () => T): T {
    return this.db.transaction(write)()
  }

  insertPlan(input: { teamId: string; title: string; creator: PlanActor }, now = nowIso()): string {
    const id = `plan-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plans (id, team_id, title, lifecycle, current_approved_revision, creator_kind, creator_session, created_at, updated_at)
      VALUES (?, ?, ?, 'open', NULL, ?, ?, ?, ?)`).run(id, input.teamId, input.title, input.creator.kind, input.creator.sessionId, now, now)
    return id
  }

  get(id: string): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id)
    return row ? mapPlan(row as Record<string, unknown>) : null
  }

  /** The plan if it belongs to the team; another team's id reads as absent. */
  forTeam(teamId: string, id: string): Plan | null {
    const plan = this.get(id)
    return plan && plan.teamId === teamId ? plan : null
  }

  /** A team's plans, oldest first, with their derived state (D8). */
  list(teamId: string): PlanSummary[] {
    return (this.db.prepare('SELECT * FROM plans WHERE team_id = ? ORDER BY created_at, rowid').all(teamId) as Record<string, unknown>[])
      .map(row => this.summary(mapPlan(row)))
  }

  /** Contract C2: the team's open plans. */
  openPlans(teamId: string): Plan[] {
    return (this.db.prepare(`SELECT * FROM plans WHERE team_id = ? AND lifecycle = 'open' ORDER BY created_at, rowid`).all(teamId) as Record<string, unknown>[])
      .map(mapPlan)
  }

  /** Contract C2: every revision pinned to a strategy, with its plan id. */
  revisionsPinnedTo(strategyId: string): Array<{ planId: string; revision: PlanRevision }> {
    return (this.db.prepare('SELECT * FROM plan_revisions WHERE strategy_id = ? ORDER BY plan_id, revision').all(strategyId) as Record<string, unknown>[])
      .map(row => ({ planId: String(row.plan_id), revision: mapPlanRevision(row) }))
  }

  summary(plan: Plan): PlanSummary {
    const linkedTaskCount = (this.db.prepare('SELECT COUNT(*) AS n FROM team_tasks WHERE plan_id = ?').get(plan.id) as { n: number }).n
    const approved = plan.currentApprovedRevision === null ? null : this.revision(plan.id, plan.currentApprovedRevision)
    return { ...plan, state: planDisplayState(plan, linkedTaskCount), pin: approved?.pin ?? null, linkedTaskCount }
  }

  detail(id: string): PlanDetail | null {
    const plan = this.get(id)
    if (!plan) return null
    const revisions = this.revisions(id)
    const linkedTasks = this.linkedTasks(id)
    const approved = revisions.find(revision => revision.revision === plan.currentApprovedRevision)
    return {
      plan: this.summary(plan),
      revisions,
      drafts: this.drafts(id),
      events: this.events(id),
      linkedTasks,
      progress: approved ? planProgress(approved.content, linkedTasks) : null,
    }
  }

  revisions(planId: string): PlanRevision[] {
    return (this.db.prepare('SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision').all(planId) as Record<string, unknown>[])
      .map(mapPlanRevision)
  }

  revision(planId: string, revision: number): PlanRevision | null {
    const row = this.db.prepare('SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = ?').get(planId, revision)
    return row ? mapPlanRevision(row as Record<string, unknown>) : null
  }

  /** The current approved revision, if any. */
  approvedRevision(planId: string): PlanRevision | null {
    const plan = this.get(planId)
    return plan?.currentApprovedRevision == null ? null : this.revision(planId, plan.currentApprovedRevision)
  }

  /** An `in_review` or `approved` revision with this hash (D6 step 5: a retried submit is a no-op). */
  standingRevisionWithHash(planId: string, hash: string): PlanRevision | null {
    const row = this.db.prepare(`SELECT * FROM plan_revisions WHERE plan_id = ? AND content_hash = ? AND status IN ('in_review', 'approved')
      ORDER BY revision DESC LIMIT 1`).get(planId, hash)
    return row ? mapPlanRevision(row as Record<string, unknown>) : null
  }

  insertRevision(planId: string, input: { content: PlanContent; contentHash: string; pin: PlanStrategyPin | null; author: PlanActor }, now = nowIso()): number {
    const max = (this.db.prepare('SELECT MAX(revision) AS max FROM plan_revisions WHERE plan_id = ?').get(planId) as { max: number | null }).max
    const next = (max ?? 0) + 1
    this.db.prepare(`INSERT INTO plan_revisions
      (plan_id, revision, status, content_json, content_hash, strategy_id, strategy_revision, strategy_hash, author_kind, author_session, created_at)
      VALUES (?, ?, 'in_review', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      planId, next, JSON.stringify(input.content), input.contentHash,
      input.pin?.strategyId ?? null, input.pin?.revision ?? null, input.pin?.hash ?? null,
      input.author.kind, input.author.sessionId, now,
    )
    this.touch(planId, now)
    return next
  }

  /** Move a revision's status; a second `approved` row raises PlanApprovedRaceError. */
  setRevisionStatus(planId: string, revision: number, status: PlanRevisionStatus): void {
    try {
      this.db.prepare('UPDATE plan_revisions SET status = ? WHERE plan_id = ? AND revision = ?').run(status, planId, revision)
    } catch (error) {
      if (isUnique(error)) throw new PlanApprovedRaceError()
      throw error
    }
  }

  setCurrentApproved(planId: string, revision: number | null, now = nowIso()): void {
    this.db.prepare('UPDATE plans SET current_approved_revision = ?, updated_at = ? WHERE id = ?').run(revision, now, planId)
  }

  setLifecycle(planId: string, lifecycle: PlanLifecycle, now = nowIso()): void {
    this.db.prepare('UPDATE plans SET lifecycle = ?, updated_at = ? WHERE id = ?').run(lifecycle, now, planId)
  }

  touch(planId: string, now = nowIso()): void {
    this.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now, planId)
  }

  drafts(planId: string): PlanDraft[] {
    return (this.db.prepare('SELECT * FROM plan_drafts WHERE plan_id = ? ORDER BY updated_at, rowid').all(planId) as Record<string, unknown>[])
      .map(mapPlanDraft)
  }

  getDraft(planId: string, draftId: string): PlanDraft | null {
    const row = this.db.prepare('SELECT * FROM plan_drafts WHERE plan_id = ? AND draft_id = ?').get(planId, draftId)
    return row ? mapPlanDraft(row as Record<string, unknown>) : null
  }

  /**
   * Upsert a draft under CAS (D5): an existing draft must still carry
   * `expectedDraftHash` (and sit on `expectedBaseRevision` when given); a
   * missing one must be expected missing. A mismatch writes nothing and
   * returns the stored draft. A save records its author, so a replacement
   * continuing a draft by id becomes its author. Run inside a transaction.
   */
  writeDraft(planId: string, input: DraftWrite, now = nowIso()): DraftWriteOutcome {
    const stored = this.getDraft(planId, input.draftId)
    if (stored) {
      if (input.expectedBaseRevision !== undefined && input.expectedBaseRevision !== stored.baseRevision) {
        return {
          ok: false, reason: 'conflict', stored,
          message: `Draft ${input.draftId} is based on revision ${stored.baseRevision ?? 'none'}, not ${input.expectedBaseRevision ?? 'none'}; nothing was saved. Reconcile with the stored draft.`,
        }
      }
      if (input.expectedDraftHash !== stored.contentHash) {
        return {
          ok: false, reason: 'conflict', stored,
          message: `Draft ${input.draftId} changed since you read it (expected hash ${input.expectedDraftHash ?? 'none'}, stored ${stored.contentHash}); nothing was saved. Reconcile with the stored draft and save with its hash.`,
        }
      }
      this.db.prepare(`UPDATE plan_drafts SET content_json = ?, content_hash = ?, author_kind = ?, author_session = ?, updated_at = ?
        WHERE plan_id = ? AND draft_id = ?`).run(JSON.stringify(input.content), input.contentHash, input.author.kind, input.author.sessionId, now, planId, input.draftId)
      this.touch(planId, now)
      return { ok: true, draft: this.getDraft(planId, input.draftId)! }
    }
    if (input.expectedDraftHash !== null) {
      return { ok: false, reason: 'conflict', stored: null, message: `Draft ${input.draftId} does not exist (it may have been discarded); save without expected_draft_hash to start it.` }
    }
    this.db.prepare(`INSERT INTO plan_drafts (plan_id, draft_id, base_revision, author_kind, author_session, content_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      planId, input.draftId, this.get(planId)?.currentApprovedRevision ?? null, input.author.kind, input.author.sessionId,
      JSON.stringify(input.content), input.contentHash, now,
    )
    this.touch(planId, now)
    return { ok: true, draft: this.getDraft(planId, input.draftId)! }
  }

  deleteDraft(planId: string, draftId: string): boolean {
    return this.db.prepare('DELETE FROM plan_drafts WHERE plan_id = ? AND draft_id = ?').run(planId, draftId).changes === 1
  }

  events(planId: string): PlanEvent[] {
    return (this.db.prepare('SELECT * FROM plan_events WHERE plan_id = ? ORDER BY created_at, rowid').all(planId) as Record<string, unknown>[])
      .map(mapPlanEvent)
  }

  /** The recorded command (D7 replay): the event and its compared payload. */
  eventByCommand(planId: string, commandId: string): { event: PlanEvent; payload: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT * FROM plan_events WHERE plan_id = ? AND command_id = ?').get(planId, commandId) as Record<string, unknown> | null
    if (!row) return null
    return { event: mapPlanEvent(row), payload: row.payload_json ? JSON.parse(String(row.payload_json)) as Record<string, unknown> : {} }
  }

  /** Append an event; a used command id raises PlanCommandRaceError. */
  insertEvent(planId: string, event: NewPlanEvent, now = nowIso()): PlanEvent {
    const id = `plan-event-${crypto.randomUUID()}`
    try {
      this.db.prepare(`INSERT INTO plan_events (id, plan_id, kind, revision, content_hash, actor_kind, actor_session, reason, command_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, planId, event.kind, event.revision ?? null, event.contentHash ?? null, event.actor.kind, event.actor.sessionId,
        event.reason ?? null, event.commandId ?? null, event.payload ? JSON.stringify(event.payload) : null, now,
      )
    } catch (error) {
      if (isUnique(error) && event.commandId) throw new PlanCommandRaceError(event.commandId)
      throw error
    }
    return mapPlanEvent(this.db.prepare('SELECT * FROM plan_events WHERE id = ?').get(id) as Record<string, unknown>)
  }

  /** Every task linked to the plan, oldest first (D10's input). */
  linkedTasks(planId: string): PlanLinkedTask[] {
    return (this.db.prepare('SELECT id, title, status, plan_change FROM team_tasks WHERE plan_id = ? ORDER BY created_at, rowid').all(planId) as Record<string, unknown>[])
      .map(row => ({ id: String(row.id), title: String(row.title), status: String(row.status) as PlanLinkedTask['status'], planChange: String(row.plan_change) }))
  }
}
