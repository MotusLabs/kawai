import type { Database } from 'bun:sqlite'
import type { DecisionPublicationReceipt, DecisionPublicationView, PublicationBindingRef } from '../../../shared/planDecisions'
import { canonicalJson } from '../../../shared/productStrategy'
import { sha256, type PublicationSnapshot } from './decisionPublicationBinding'

interface LinkRow {
  card_id: string
  task_id: string
  handoff_id: string
  base_revision: number
  payload_hash: string
  binding_hash: string
  snapshot_json: string
  decision_id: string | null
  receipt_json: string | null
  receipt_hash: string | null
}

function bindingRef(row: LinkRow): PublicationBindingRef {
  return {
    taskId: row.task_id, handoffId: row.handoff_id, baseRevision: row.base_revision,
    payloadHash: row.payload_hash, bindingHash: row.binding_hash,
  }
}

function view(row: LinkRow): DecisionPublicationView {
  const json = row.receipt_json
  const receipt = json !== null && sha256(json) === row.receipt_hash ? JSON.parse(json) as DecisionPublicationReceipt : null
  return { ...bindingRef(row), receipt }
}

export class DecisionPublicationStore {
  constructor(private readonly db: Database) {}

  views(teamId: string, planId: string): Map<string, DecisionPublicationView> {
    const rows = this.db.query<LinkRow, [string, string]>(
      'SELECT * FROM plan_decision_publications WHERE team_id = ? AND plan_id = ?',
    ).all(teamId, planId)
    return new Map(rows.map(row => [row.card_id, view(row)]))
  }

  byHandoff(teamId: string, handoffId: string): { cardId: string; link: PublicationBindingRef } | null {
    const row = this.db.query<LinkRow, [string, string]>(
      'SELECT * FROM plan_decision_publications WHERE team_id = ? AND handoff_id = ?',
    ).get(teamId, handoffId)
    return row ? { cardId: row.card_id, link: bindingRef(row) } : null
  }

  byCard(teamId: string, planId: string, cardId: string) {
    const row = this.db.query<LinkRow, [string, string, string]>(
      'SELECT * FROM plan_decision_publications WHERE team_id = ? AND plan_id = ? AND card_id = ?',
    ).get(teamId, planId, cardId)
    return row ? { link: view(row), snapshotJson: row.snapshot_json, decisionId: row.decision_id } : null
  }

  insert(snapshot: PublicationSnapshot, bindingHash: string): PublicationBindingRef {
    this.db.prepare(`INSERT INTO plan_decision_publications
      (card_id, team_id, plan_id, task_id, handoff_id, base_revision, payload_hash, binding_hash, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      snapshot.cardId, snapshot.teamId, snapshot.planId, snapshot.taskId, snapshot.handoffId, snapshot.baseRevision,
      snapshot.payloadHash, bindingHash, canonicalJson(snapshot),
    )
    return {
      taskId: snapshot.taskId, handoffId: snapshot.handoffId, baseRevision: snapshot.baseRevision,
      payloadHash: snapshot.payloadHash, bindingHash,
    }
  }

  recordReceipt(teamId: string, receipt: DecisionPublicationReceipt): void {
    const json = canonicalJson(receipt)
    const result = this.db.prepare(`UPDATE plan_decision_publications SET decision_id = ?, receipt_json = ?, receipt_hash = ?
      WHERE team_id = ? AND plan_id = ? AND card_id = ? AND decision_id IS NULL`).run(
      receipt.decisionId, json, sha256(json), teamId, receipt.planId, receipt.cardId,
    )
    if (result.changes !== 1) throw new Error('Publication receipt could not be recorded for the bound card')
  }
}
