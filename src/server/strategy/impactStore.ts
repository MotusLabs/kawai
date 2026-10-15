// Strategy impact records (strategy-revision-impact design D1): agent
// proposals, owner decisions, and assessment requests, in their own tables
// beside the strategy tables (`strategyStore.ts` is full). The store is
// policy-free primitives: ImpactService decides who may write what and
// composes these inside `atomically`. Decisions form one chain per (review,
// plan) — each names the effective decision it replaced — and the effective
// decision is the chain head, the one nothing supersedes. A unique-constraint
// hit (command id or chain) surfaces as `ImpactUniqueError`, so the service
// can roll back and resolve the request as a replay or a stale predecessor
// without branching on which index SQLite named. Change notifications go out
// after commit through `announce`, never from inside a transaction.
import type { Database } from 'bun:sqlite'
import type { ImpactDecision, ImpactDisposition, ImpactProposal, ImpactRequest, ImpactRevisionPin } from '../../shared/strategyImpact'
import { CREATE_IMPACT_TABLES_SQL, mapDecision, mapProposal, mapRequest, rowPayload } from './impactSchema'

/** A decision or request insert hit a unique constraint; the transaction rolls back. */
export class ImpactUniqueError extends Error {
  constructor() { super('strategy impact unique constraint') }
}

export interface NewImpactDecision {
  strategyId: string
  reviewId: string
  planId: string
  disposition: ImpactDisposition
  rationale: string
  proposalId: string | null
  supersedesDecisionId: string | null
  planSnapshot: ImpactRevisionPin[]
  commandId: string
  payload: Record<string, unknown>
}

const nowIso = () => new Date().toISOString()
const isUnique = (error: unknown) => String(error).includes('UNIQUE constraint failed')

export class ImpactStore {
  private readonly listeners = new Set<(strategyId: string) => void>()

  constructor(private readonly db: Database) {
    db.exec(CREATE_IMPACT_TABLES_SQL)
  }

  /** Every committed impact write, by strategy id. */
  subscribe(listener: (strategyId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Announce a committed write (call after the transaction). */
  announce(strategyId: string): void {
    for (const listener of this.listeners) listener(strategyId)
  }

  /** Run writes as one transaction. */
  atomically<T>(write: () => T): T {
    return this.db.transaction(write)()
  }

  insertProposal(input: { strategyId: string; reviewId: string; planId: string; disposition: ImpactDisposition; rationale: string; authorSession: string },
    now = nowIso()): ImpactProposal {
    const id = `impact-proposal-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO strategy_impact_proposals (id, strategy_id, review_id, plan_id, disposition, rationale, author_session, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.strategyId, input.reviewId, input.planId, input.disposition, input.rationale, input.authorSession, now)
    return this.proposal(id)!
  }

  proposal(id: string): ImpactProposal | null {
    const row = this.db.prepare('SELECT * FROM strategy_impact_proposals WHERE id = ?').get(id)
    return row ? mapProposal(row as Record<string, unknown>) : null
  }

  /** A strategy's proposals, oldest first. */
  proposals(strategyId: string): ImpactProposal[] {
    return (this.db.prepare('SELECT * FROM strategy_impact_proposals WHERE strategy_id = ? ORDER BY created_at, rowid').all(strategyId) as Record<string, unknown>[])
      .map(mapProposal)
  }

  /** Insert a decision; a command-id or chain collision raises ImpactUniqueError. */
  insertDecision(input: NewImpactDecision, now = nowIso()): ImpactDecision {
    const id = `impact-decision-${crypto.randomUUID()}`
    try {
      this.db.prepare(`INSERT INTO strategy_impact_decisions
        (id, strategy_id, review_id, plan_id, disposition, rationale, proposal_id, supersedes_decision_id, plan_snapshot_json, actor_kind, command_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?)`).run(
        id, input.strategyId, input.reviewId, input.planId, input.disposition, input.rationale, input.proposalId,
        input.supersedesDecisionId, JSON.stringify(input.planSnapshot), input.commandId, JSON.stringify(input.payload), now,
      )
    } catch (error) {
      if (isUnique(error)) throw new ImpactUniqueError()
      throw error
    }
    return this.decision(id)!
  }

  decision(id: string): ImpactDecision | null {
    const row = this.db.prepare('SELECT * FROM strategy_impact_decisions WHERE id = ?').get(id)
    return row ? mapDecision(row as Record<string, unknown>) : null
  }

  /** A strategy's decisions, oldest first. */
  decisions(strategyId: string): ImpactDecision[] {
    return (this.db.prepare('SELECT * FROM strategy_impact_decisions WHERE strategy_id = ? ORDER BY created_at, rowid').all(strategyId) as Record<string, unknown>[])
      .map(mapDecision)
  }

  /** The effective decision for (review, plan): the chain head nothing supersedes; null before the first. */
  chainHead(reviewId: string, planId: string): ImpactDecision | null {
    const row = this.db.prepare(`SELECT * FROM strategy_impact_decisions d WHERE d.review_id = ? AND d.plan_id = ?
      AND NOT EXISTS (SELECT 1 FROM strategy_impact_decisions s WHERE s.review_id = d.review_id AND s.plan_id = d.plan_id
        AND s.supersedes_decision_id = d.id)
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`).get(reviewId, planId)
    return row ? mapDecision(row as Record<string, unknown>) : null
  }

  /** The decision recorded under a command id of this strategy, with its compared payload. */
  decisionByCommand(strategyId: string, commandId: string): { decision: ImpactDecision; payload: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT * FROM strategy_impact_decisions WHERE strategy_id = ? AND command_id = ?').get(strategyId, commandId) as Record<string, unknown> | null
    return row ? { decision: mapDecision(row), payload: rowPayload(row) } : null
  }

  /** Insert a request; a used command id raises ImpactUniqueError. */
  insertRequest(input: { strategyId: string; reviewId: string; targetGroup: string; messageId: string; commandId: string; payload: Record<string, unknown> },
    now = nowIso()): ImpactRequest {
    const id = `impact-request-${crypto.randomUUID()}`
    try {
      this.db.prepare(`INSERT INTO strategy_impact_requests (id, strategy_id, review_id, target_group, message_id, command_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.strategyId, input.reviewId, input.targetGroup, input.messageId, input.commandId, JSON.stringify(input.payload), now)
    } catch (error) {
      if (isUnique(error)) throw new ImpactUniqueError()
      throw error
    }
    return mapRequest(this.db.prepare('SELECT * FROM strategy_impact_requests WHERE id = ?').get(id) as Record<string, unknown>)
  }

  /** A strategy's requests, oldest first. */
  requests(strategyId: string): ImpactRequest[] {
    return (this.db.prepare('SELECT * FROM strategy_impact_requests WHERE strategy_id = ? ORDER BY created_at, rowid').all(strategyId) as Record<string, unknown>[])
      .map(mapRequest)
  }

  /** The request recorded under a command id of this strategy, with its compared payload. */
  requestByCommand(strategyId: string, commandId: string): { request: ImpactRequest; payload: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT * FROM strategy_impact_requests WHERE strategy_id = ? AND command_id = ?').get(strategyId, commandId) as Record<string, unknown> | null
    return row ? { request: mapRequest(row), payload: rowPayload(row) } : null
  }
}
