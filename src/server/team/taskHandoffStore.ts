// Handoff rows (owner-publication-handoff D1, D5): reads, the request
// insert, and guarded transitions with their append-only event rows. Every
// transition's UPDATE is guarded by `state IN ('open','stale')`, so an ended
// handoff never changes (U4); a guarded update that matches nothing returns
// false and writes no event. The two revision facts H-PUB and the restart
// sweep read — the task-scoped association (any key) and the prepared-key
// row — are separate reads here and never inferred from each other (D3).
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import {
  handoffPayloadInput, preparedKey, type HandoffActor, type HandoffPreparedFields, type HandoffState, type TaskHandoff,
} from '../../shared/taskHandoffs'

/** The payload hash (D10): sha256 of the canonical prepared fields and notify choice. */
export const handoffPayloadHash = (fields: HandoffPreparedFields): string =>
  createHash('sha256').update(handoffPayloadInput(fields)).digest('hex')

export interface NewHandoff extends HandoffPreparedFields {
  teamId: string
  taskId: string
  baseRevision: number
  baseContractHash: string | null
  baseCommit: string | null
  evidenceRefs: string[]
  requesterSession: string
  requesterGroup: string | null
  requestKey: string
}

export interface HandoffTransition {
  reason?: string | null
  actor: HandoffActor
  revision?: number | null
  publishedPayloadHash?: string | null
  supersededBy?: string | null
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

function handoffOf(row: Record<string, unknown>): TaskHandoff {
  const actorKind = text(row.state_actor_kind)
  return {
    id: String(row.id), teamId: String(row.team_id), taskId: String(row.task_id),
    baseRevision: Number(row.base_revision), baseContractHash: text(row.base_contract_hash),
    direction: text(row.direction), acceptance: text(row.acceptance), contract: text(row.contract_text),
    rationale: String(row.rationale), notify: Number(row.notify) === 1, payloadHash: String(row.payload_hash),
    baseCommit: text(row.base_commit), evidenceRefs: JSON.parse(String(row.evidence_refs ?? '[]')) as string[],
    requesterSession: String(row.requester_session), requesterGroup: text(row.requester_group),
    requestKey: String(row.request_key), state: String(row.state) as HandoffState, stateReason: text(row.state_reason),
    stateActor: actorKind ? { kind: actorKind as HandoffActor['kind'], sessionId: text(row.state_actor_session) } : null,
    publishedRevision: row.published_revision === null || row.published_revision === undefined ? null : Number(row.published_revision),
    publishedPayloadHash: text(row.published_payload_hash), supersededBy: text(row.superseded_by),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

export class TaskHandoffStore {
  constructor(readonly db: Database) {}

  get(id: string): TaskHandoff | null {
    const row = this.db.prepare('SELECT * FROM team_task_handoffs WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? handoffOf(row) : null
  }

  byKey(taskId: string, requestKey: string): TaskHandoff | null {
    const row = this.db.prepare('SELECT * FROM team_task_handoffs WHERE task_id = ? AND request_key = ?').get(taskId, requestKey) as Record<string, unknown> | null
    return row ? handoffOf(row) : null
  }

  /** The task's one open or stale handoff (U2), or null. */
  pendingOf(taskId: string): TaskHandoff | null {
    const row = this.db.prepare("SELECT * FROM team_task_handoffs WHERE task_id = ? AND state IN ('open', 'stale')").get(taskId) as Record<string, unknown> | null
    return row ? handoffOf(row) : null
  }

  pendingForTeam(teamId: string): TaskHandoff[] {
    return (this.db.prepare("SELECT * FROM team_task_handoffs WHERE team_id = ? AND state IN ('open', 'stale') ORDER BY created_at, id").all(teamId) as Record<string, unknown>[])
      .map(handoffOf)
  }

  /** Insert an `open` handoff with its first event; the caller holds the transaction. */
  insert(input: NewHandoff, now: string): TaskHandoff {
    const id = `handoff-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO team_task_handoffs (id, team_id, task_id, base_revision, base_contract_hash, direction, acceptance,
      contract_text, rationale, notify, payload_hash, base_commit, evidence_refs, requester_session, requester_group, request_key,
      state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(
      id, input.teamId, input.taskId, input.baseRevision, input.baseContractHash, input.direction, input.acceptance,
      input.contract, input.rationale, input.notify ? 1 : 0, handoffPayloadHash(input), input.baseCommit,
      JSON.stringify(input.evidenceRefs), input.requesterSession, input.requesterGroup, input.requestKey, now, now,
    )
    this.event(id, null, 'open', { actor: { kind: 'agent', sessionId: input.requesterSession } }, now)
    return this.get(id)!
  }

  /**
   * Move a pending handoff to `to` (guarded, U4). False when it is no longer
   * pending: nothing is written.
   */
  transition(id: string, to: HandoffState, change: HandoffTransition, now: string): boolean {
    const before = this.get(id)
    if (!before) return false
    const updated = this.db.prepare(`UPDATE team_task_handoffs SET state = ?, state_reason = ?, state_actor_kind = ?, state_actor_session = ?,
      published_revision = COALESCE(?, published_revision), published_payload_hash = COALESCE(?, published_payload_hash),
      superseded_by = COALESCE(?, superseded_by), updated_at = ? WHERE id = ? AND state IN ('open', 'stale')`).run(
      to, change.reason ?? null, change.actor.kind, change.actor.sessionId,
      to === 'published' ? change.revision ?? null : null, change.publishedPayloadHash ?? null, change.supersededBy ?? null, now, id,
    )
    if (updated.changes === 0) return false
    this.event(id, before.state, to, change, now)
    return true
  }

  /** The revision of the task whose server-written association is this handoff, whatever its key (D3). */
  associatedRevision(taskId: string, handoffId: string): number | null {
    const row = this.db.prepare('SELECT revision FROM team_task_revisions WHERE task_id = ? AND handoff_id = ?').get(taskId, handoffId) as { revision: number } | null
    return row ? Number(row.revision) : null
  }

  /** The revision stored under the handoff's prepared key, with its association (replay and orphan evidence only). */
  preparedKeyRevision(taskId: string, handoffId: string): { revision: number; handoffId: string | null } | null {
    const row = this.db.prepare('SELECT revision, handoff_id FROM team_task_revisions WHERE task_id = ? AND request_key = ?')
      .get(taskId, preparedKey(handoffId)) as { revision: number; handoff_id: string | null } | null
    return row ? { revision: Number(row.revision), handoffId: row.handoff_id } : null
  }

  /** Write the association on a revision row inside the publication transaction. */
  associate(taskId: string, revision: number, handoffId: string): void {
    this.db.prepare('UPDATE team_task_revisions SET handoff_id = ? WHERE task_id = ? AND revision = ?').run(handoffId, taskId, revision)
  }

  events(id: string): Array<{ seq: number; from: HandoffState | null; to: HandoffState; reason: string | null; revision: number | null }> {
    return (this.db.prepare('SELECT * FROM team_task_handoff_events WHERE handoff_id = ? ORDER BY seq').all(id) as Record<string, unknown>[])
      .map(row => ({
        seq: Number(row.seq), from: text(row.from_state) as HandoffState | null, to: String(row.to_state) as HandoffState,
        reason: text(row.reason), revision: row.revision === null ? null : Number(row.revision),
      }))
  }

  private event(id: string, from: HandoffState | null, to: HandoffState, change: HandoffTransition, now: string): void {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM team_task_handoff_events WHERE handoff_id = ?').get(id) as { seq: number }).seq
    this.db.prepare(`INSERT INTO team_task_handoff_events (handoff_id, seq, from_state, to_state, actor_kind, actor_session, reason, revision, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, seq, from, to, change.actor.kind, change.actor.sessionId, change.reason ?? null, change.revision ?? null, now)
  }
}
