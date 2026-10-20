// Decision store (plan-supervision design D3): the only SQL writer of the
// decision tables — `plan_decision_cards`, `plan_decisions`, and
// `plan_fix_tasks`. Its primitives carry no policy; `DecisionService` and
// `fixTasks.ts` compose them inside their own transactions. Every read is
// scoped by team, so another team's rows read as not found. A constraint
// error never leaves this file raw; it becomes a `DecisionConflict` naming
// the row that won:
// - `UNIQUE (card_id, seq)` → `card-decided`, naming the winning decision
//   and its decider;
// - `UNIQUE (plan_id, command_id)` → `command-replay`, carrying the decision
//   recorded under that command id (null agent command ids never collide);
// - `UNIQUE (source_kind, source_id)` → `fix-source-taken`, carrying the fix
//   or correction task already recorded for that override or promotion.
// These records need no user docs beyond this header.
import type { Database } from 'bun:sqlite'
import type { DecisionCard, DecisionKind, DecisionParty, FixSourceKind, PlanDecision, PlanFixTask } from '../../../shared/planDecisions'

export type DecisionConflictKind = 'card-decided' | 'command-replay' | 'fix-source-taken'

export class DecisionConflict extends Error {
  constructor(
    readonly kind: DecisionConflictKind,
    message: string,
    readonly decision: PlanDecision | null = null,
    readonly fixTask: PlanFixTask | null = null,
  ) {
    super(message)
    this.name = 'DecisionConflict'
  }
}

export type NewCard = Omit<DecisionCard, 'id' | 'createdAt'> & { id?: string }

export interface NewDecision {
  id?: string
  cardId: string
  planId: string
  teamId: string
  seq: number
  kind: DecisionKind
  choice: string
  optionIndex?: number | null
  rationale?: string | null
  decidedBy: DecisionParty
  affected: string[]
  commandId?: string | null
  /** The compared payload of a human command. */
  payload?: Record<string, unknown> | null
  replyMessageId?: string | null
}

type Row = Record<string, unknown>
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const int = (value: unknown): number | null => (typeof value === 'number' ? value : null)

export function mapCard(row: Row): DecisionCard {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    planId: String(row.plan_id),
    revision: int(row.revision),
    change: text(row.change),
    taskId: text(row.task_id),
    question: String(row.question),
    options: JSON.parse(String(row.options_json)) as string[],
    context: text(row.context),
    askedBy: { session: String(row.asked_by_session), group: text(row.asked_by_group), profile: text(row.asked_by_profile) },
    addressedTo: String(row.addressed_to) as DecisionCard['addressedTo'],
    addressedGroup: text(row.addressed_group),
    messageId: text(row.message_id),
    createdAt: String(row.created_at),
  }
}

export function mapDecision(row: Row): PlanDecision {
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    planId: String(row.plan_id),
    teamId: String(row.team_id),
    seq: Number(row.seq),
    kind: String(row.kind) as DecisionKind,
    choice: String(row.choice),
    optionIndex: int(row.option_index),
    rationale: text(row.rationale),
    decidedBy: {
      kind: String(row.decided_by_kind) as DecisionParty['kind'],
      session: text(row.decided_by_session),
      group: text(row.decided_by_group),
      profile: text(row.decided_by_profile),
    },
    affected: JSON.parse(String(row.affected_json)) as string[],
    commandId: text(row.command_id),
    replyMessageId: text(row.reply_message_id),
    createdAt: String(row.created_at),
  }
}

export function mapFixTask(row: Row): PlanFixTask {
  return {
    taskId: String(row.task_id),
    teamId: String(row.team_id),
    planId: String(row.plan_id),
    sourceKind: String(row.source_kind) as FixSourceKind,
    sourceId: String(row.source_id),
    createdAt: String(row.created_at),
  }
}

const decider = (decision: PlanDecision): string =>
  decision.decidedBy.kind === 'human' ? 'the owner' : `${decision.decidedBy.session ?? 'an agent'}${decision.decidedBy.group ? ` (${decision.decidedBy.group})` : ''}`

export class DecisionStore {
  constructor(readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  /** Run `fn` as one transaction; nested calls become savepoints. */
  atomically<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // --- cards ---

  insertCard(input: NewCard): DecisionCard {
    const id = input.id ?? `card-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_decision_cards (id, team_id, plan_id, revision, change, task_id, question, options_json, context,
      asked_by_session, asked_by_group, asked_by_profile, addressed_to, addressed_group, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.teamId, input.planId, input.revision, input.change, input.taskId, input.question, JSON.stringify(input.options),
      input.context, input.askedBy.session, input.askedBy.group, input.askedBy.profile, input.addressedTo, input.addressedGroup,
      input.messageId, this.iso(),
    )
    return this.card(input.teamId, id)!
  }

  card(teamId: string, id: string): DecisionCard | null {
    const row = this.db.prepare('SELECT * FROM plan_decision_cards WHERE id = ? AND team_id = ?').get(id, teamId) as Row | null
    return row ? mapCard(row) : null
  }

  /** The card whose question is `messageId` (the reply guard's lookup, D9). */
  cardByMessage(teamId: string, messageId: string): DecisionCard | null {
    const row = this.db.prepare('SELECT * FROM plan_decision_cards WHERE message_id = ? AND team_id = ?').get(messageId, teamId) as Row | null
    return row ? mapCard(row) : null
  }

  cardsOfPlan(teamId: string, planId: string): DecisionCard[] {
    return (this.db.prepare('SELECT * FROM plan_decision_cards WHERE plan_id = ? AND team_id = ? ORDER BY created_at, rowid').all(planId, teamId) as Row[]).map(mapCard)
  }

  // --- decisions ---

  /**
   * Insert one decision. A lost `(card_id, seq)` race is refused naming the
   * winner; a known `(plan_id, command_id)` is refused carrying the decision
   * recorded under it, so the caller can compare payloads and replay.
   */
  insertDecision(input: NewDecision): PlanDecision {
    const id = input.id ?? `decision-${crypto.randomUUID()}`
    try {
      this.db.prepare(`INSERT INTO plan_decisions (id, card_id, plan_id, team_id, seq, kind, choice, option_index, rationale, decided_by_kind,
        decided_by_session, decided_by_group, decided_by_profile, affected_json, command_id, payload_json, reply_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.cardId, input.planId, input.teamId, input.seq, input.kind, input.choice, input.optionIndex ?? null, input.rationale ?? null,
        input.decidedBy.kind, input.decidedBy.session, input.decidedBy.group, input.decidedBy.profile, JSON.stringify(input.affected),
        input.commandId ?? null, input.payload ? JSON.stringify(input.payload) : null, input.replyMessageId ?? null, this.iso(),
      )
    } catch (error) {
      this.mapDecisionConstraint(error, input)
    }
    return this.decision(input.teamId, id)!
  }

  setReplyMessage(teamId: string, decisionId: string, messageId: string): void {
    this.db.prepare('UPDATE plan_decisions SET reply_message_id = ? WHERE id = ? AND team_id = ?').run(messageId, decisionId, teamId)
  }

  decision(teamId: string, id: string): PlanDecision | null {
    const row = this.db.prepare('SELECT * FROM plan_decisions WHERE id = ? AND team_id = ?').get(id, teamId) as Row | null
    return row ? mapDecision(row) : null
  }

  /** A card's decisions, oldest first (`seq` order). */
  decisionsOfCard(teamId: string, cardId: string): PlanDecision[] {
    return (this.db.prepare('SELECT * FROM plan_decisions WHERE card_id = ? AND team_id = ? ORDER BY seq').all(cardId, teamId) as Row[]).map(mapDecision)
  }

  decisionsOfPlan(teamId: string, planId: string): PlanDecision[] {
    return (this.db.prepare('SELECT * FROM plan_decisions WHERE plan_id = ? AND team_id = ? ORDER BY card_id, seq').all(planId, teamId) as Row[]).map(mapDecision)
  }

  /** The decision a human command recorded, with its compared payload. */
  decisionByCommand(teamId: string, planId: string, commandId: string): { decision: PlanDecision; payload: Record<string, unknown> | null } | null {
    const row = this.db.prepare('SELECT * FROM plan_decisions WHERE plan_id = ? AND command_id = ? AND team_id = ?').get(planId, commandId, teamId) as Row | null
    if (!row) return null
    return { decision: mapDecision(row), payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) as Record<string, unknown> : null }
  }

  // --- fix and correction tasks ---

  insertFixTask(input: Omit<PlanFixTask, 'createdAt'>): PlanFixTask {
    try {
      this.db.prepare('INSERT INTO plan_fix_tasks (task_id, team_id, plan_id, source_kind, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.taskId, input.teamId, input.planId, input.sourceKind, input.sourceId, this.iso())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('UNIQUE constraint failed: plan_fix_tasks.source_kind, plan_fix_tasks.source_id')) {
        const existing = this.fixTaskBySource(input.teamId, input.sourceKind, input.sourceId)
        throw new DecisionConflict('fix-source-taken', `The ${input.sourceKind} ${input.sourceId} already has task ${existing?.taskId ?? '(another team)'}.`, null, existing)
      }
      throw error
    }
    return this.fixTask(input.teamId, input.taskId)!
  }

  fixTask(teamId: string, taskId: string): PlanFixTask | null {
    const row = this.db.prepare('SELECT * FROM plan_fix_tasks WHERE task_id = ? AND team_id = ?').get(taskId, teamId) as Row | null
    return row ? mapFixTask(row) : null
  }

  fixTaskBySource(teamId: string, sourceKind: FixSourceKind, sourceId: string): PlanFixTask | null {
    const row = this.db.prepare('SELECT * FROM plan_fix_tasks WHERE source_kind = ? AND source_id = ? AND team_id = ?').get(sourceKind, sourceId, teamId) as Row | null
    return row ? mapFixTask(row) : null
  }

  fixTasksOfPlan(teamId: string, planId: string): PlanFixTask[] {
    return (this.db.prepare('SELECT * FROM plan_fix_tasks WHERE plan_id = ? AND team_id = ? ORDER BY created_at, rowid').all(planId, teamId) as Row[]).map(mapFixTask)
  }

  fixTasksOfTeam(teamId: string): PlanFixTask[] {
    return (this.db.prepare('SELECT * FROM plan_fix_tasks WHERE team_id = ? ORDER BY created_at, rowid').all(teamId) as Row[]).map(mapFixTask)
  }

  private mapDecisionConstraint(error: unknown, input: NewDecision): never {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('UNIQUE constraint failed: plan_decisions.card_id, plan_decisions.seq')) {
      const row = this.db.prepare('SELECT * FROM plan_decisions WHERE card_id = ? AND seq = ?').get(input.cardId, input.seq) as Row | null
      const winner = row ? mapDecision(row) : null
      throw new DecisionConflict('card-decided', winner
        ? `Card ${input.cardId} was already decided by ${decider(winner)} (decision ${winner.id}: ${winner.choice}).`
        : `Card ${input.cardId} was already decided.`, winner)
    }
    if (message.includes('UNIQUE constraint failed: plan_decisions.plan_id, plan_decisions.command_id')) {
      const prior = input.commandId ? this.decisionByCommand(input.teamId, input.planId, input.commandId)?.decision ?? null : null
      throw new DecisionConflict('command-replay', `A decision was already recorded under command ${input.commandId}.`, prior)
    }
    throw error
  }

  private iso(): string {
    return this.now().toISOString()
  }
}
