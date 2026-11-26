// Recommendation, assessment and evidence storage (process-quota-history-
// and-incident-advice D5; tables from migration 31, schema.ts). Every read is
// team-scoped: another team's id reads as unknown (R7). A recommendation is
// created once per team, kind and episode (the unique key makes a replayed
// incident a no-op). Assessments only append (triggers refuse UPDATE and
// DELETE, I3): `append` writes version n+1 in one transaction, and writes
// nothing when the evidence hash equals the latest one (R2) or when the
// evaluation saw older evidence than the latest (a stale replay never
// becomes current). Evidence summaries are copied in, so they outlive the
// observations they cite; a summary whose observation was pruned is read
// back as expired (R9).
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  AssessmentState, EvidenceSummary, ProcessAdvice, ProcessAssessment, ProcessRecommendation, ProcessRecommendationDetail, RecommendationKind,
} from '../../../shared/processRecommendations'
import { EVALUATOR_VERSION, type Evaluation, type IncidentSnapshot } from './evaluator'

export interface NewRecommendation {
  teamId: string
  kind: RecommendationKind
  episodeKey: string
  sessionId: string | null
  taskId: string | null
  groupId: string | null
  profileId: string | null
  providerId: string | null
  attentionId: string | null
  cutoff: string
  snapshot: IncidentSnapshot
  snapshotBasis: 'incident' | 'reconstructed'
}

export interface StoredRecommendation extends Omit<ProcessRecommendation, 'current' | 'versions'> {
  snapshot: IncidentSnapshot
}

interface RecommendationRow {
  id: string; team_id: string; kind: RecommendationKind; episode_key: string; session_id: string | null; task_id: string | null
  group_id: string | null; profile_id: string | null; provider_id: string | null; attention_id: string | null; cutoff: string
  snapshot_json: string; snapshot_basis: 'incident' | 'reconstructed'; created_at: string
}

interface AssessmentRow {
  id: string; recommendation_id: string; version: number; evaluator_version: string; evidence_hash: string; source_position: string
  state: AssessmentState; cutoff: string; advice_json: string; created_at: string
}

function mapRecommendation(row: RecommendationRow): StoredRecommendation {
  return {
    id: row.id, teamId: row.team_id, kind: row.kind, episodeKey: row.episode_key, sessionId: row.session_id, taskId: row.task_id,
    groupId: row.group_id, profileId: row.profile_id, providerId: row.provider_id, attentionId: row.attention_id, cutoff: row.cutoff,
    snapshot: JSON.parse(row.snapshot_json) as IncidentSnapshot, snapshotBasis: row.snapshot_basis, createdAt: row.created_at,
  }
}

/** The newest-evidence part of a source position; older positions never become current. */
const newestOf = (position: string) => position.split('|')[0] ?? ''

export class RecommendationStore {
  constructor(readonly db: Database, private readonly now: () => number = Date.now) {}

  /** Create the episode's recommendation, or return the one that exists (`created` false). */
  create(input: NewRecommendation): { recommendation: StoredRecommendation; created: boolean } {
    const id = `rec-${randomUUID()}`
    const result = this.db.prepare(`INSERT OR IGNORE INTO process_recommendations
      (id, team_id, kind, episode_key, session_id, task_id, group_id, profile_id, provider_id, attention_id, cutoff, snapshot_json, snapshot_basis, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.teamId, input.kind, input.episodeKey, input.sessionId, input.taskId, input.groupId, input.profileId, input.providerId,
      input.attentionId, input.cutoff, JSON.stringify(input.snapshot), input.snapshotBasis, new Date(this.now()).toISOString())
    const row = this.db.prepare('SELECT * FROM process_recommendations WHERE team_id = ? AND kind = ? AND episode_key = ?')
      .get(input.teamId, input.kind, input.episodeKey) as RecommendationRow
    return { recommendation: mapRecommendation(row), created: result.changes > 0 }
  }

  /**
   * The team's advice attached to existing attention items (D6): attention id
   * to its newest recommendation id. The attention sources link to it; no
   * second alert is ever raised.
   */
  attachedAdvice(teamId: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT id, attention_id FROM process_recommendations
      WHERE team_id = ? AND attention_id IS NOT NULL ORDER BY created_at, id`).all(teamId) as Array<{ id: string; attention_id: string }>
    return new Map(rows.map(row => [row.attention_id, row.id]))
  }

  /**
   * Attach an unresolved recommendation to an attention item (D6, R6): a plan
   * stall raised after the quota episode opened. Only the attention link
   * moves; the frozen snapshot and every assessment stay as they are (I3).
   * Returns whether the link changed.
   */
  attach(id: string, attentionId: string): boolean {
    return this.db.prepare(`UPDATE process_recommendations SET attention_id = ?
      WHERE id = ? AND attention_id IS NOT ?`).run(attentionId, id, attentionId).changes > 0
  }

  /** The team's recommendation of an episode, or null. */
  byEpisode(teamId: string, kind: RecommendationKind, episodeKey: string): StoredRecommendation | null {
    const row = this.db.prepare('SELECT * FROM process_recommendations WHERE team_id = ? AND kind = ? AND episode_key = ?')
      .get(teamId, kind, episodeKey) as RecommendationRow | null
    return row ? mapRecommendation(row) : null
  }

  /**
   * When the team's episode was first recorded resolved (epoch ms, the
   * assessment's `created_at`), else null — the durable boundary after which
   * the episode admits no member (D5, R5). Assessments only append, so it
   * never moves once set.
   */
  resolvedAt(teamId: string, kind: RecommendationKind, episodeKey: string): number | null {
    const row = this.db.prepare(`SELECT a.created_at FROM process_assessments a JOIN process_recommendations r ON r.id = a.recommendation_id
      WHERE r.team_id = ? AND r.kind = ? AND r.episode_key = ? AND a.state = 'resolved' ORDER BY a.version LIMIT 1`)
      .get(teamId, kind, episodeKey) as { created_at: string } | null
    return row ? Date.parse(row.created_at) : null
  }

  /** One recommendation by id, any team (the evaluator's own read). */
  byId(id: string): StoredRecommendation | null {
    const row = this.db.prepare('SELECT * FROM process_recommendations WHERE id = ?').get(id) as RecommendationRow | null
    return row ? mapRecommendation(row) : null
  }

  /** The team's open episode of a kind for a provider (quota episodes coalesce while one is unresolved). */
  openFor(teamId: string, kind: RecommendationKind, providerId: string): StoredRecommendation | null {
    return this.unresolved().find(rec => rec.teamId === teamId && rec.kind === kind && rec.providerId === providerId) ?? null
  }

  /** Recommendations whose latest assessment is not `resolved` (or that have none), oldest first; every team. */
  unresolved(): StoredRecommendation[] {
    return (this.db.prepare(`SELECT r.* FROM process_recommendations r
      WHERE COALESCE((SELECT a.state FROM process_assessments a WHERE a.recommendation_id = r.id ORDER BY a.version DESC LIMIT 1), '') != 'resolved'
      ORDER BY r.created_at, r.id`).all() as RecommendationRow[]).map(mapRecommendation)
  }

  /** Recommendations with no assessment by the current evaluator version (startup reconciliation, R5). */
  unevaluated(): StoredRecommendation[] {
    return (this.db.prepare(`SELECT r.* FROM process_recommendations r
      WHERE NOT EXISTS (SELECT 1 FROM process_assessments a WHERE a.recommendation_id = r.id AND a.evaluator_version = ?)
      ORDER BY r.created_at, r.id`).all(EVALUATOR_VERSION) as RecommendationRow[]).map(mapRecommendation)
  }

  latest(recommendationId: string): ProcessAssessment | null {
    const row = this.db.prepare('SELECT * FROM process_assessments WHERE recommendation_id = ? ORDER BY version DESC LIMIT 1')
      .get(recommendationId) as AssessmentRow | null
    return row ? this.mapAssessment(row) : null
  }

  /**
   * Append the next assessment, or nothing (null) when the evidence is
   * unchanged from the latest or older than it. One transaction: the version
   * read, the checks and the writes cannot interleave with another append.
   */
  append(recommendationId: string, evaluation: Evaluation, cutoff: string, state: (previous: ProcessAdvice | null) => AssessmentState): ProcessAssessment | null {
    return this.db.transaction((): ProcessAssessment | null => {
      const latest = this.db.prepare('SELECT * FROM process_assessments WHERE recommendation_id = ? ORDER BY version DESC LIMIT 1')
        .get(recommendationId) as AssessmentRow | null
      if (latest && latest.evidence_hash === evaluation.evidenceHash && latest.evaluator_version === EVALUATOR_VERSION) return null
      if (latest && newestOf(evaluation.sourcePosition) < newestOf(latest.source_position)) return null
      const previous = latest ? JSON.parse(latest.advice_json) as ProcessAdvice : null
      const id = `asm-${randomUUID()}`
      const version = (latest?.version ?? 0) + 1
      const createdAt = new Date(this.now()).toISOString()
      this.db.prepare(`INSERT INTO process_assessments
        (id, recommendation_id, version, evaluator_version, evidence_hash, source_position, state, cutoff, advice_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, recommendationId, version, EVALUATOR_VERSION, evaluation.evidenceHash, evaluation.sourcePosition,
        state(previous), cutoff, JSON.stringify(evaluation.advice), createdAt)
      const insert = this.db.prepare(`INSERT INTO process_assessment_evidence (assessment_id, ordinal, observation_id, summary_json)
        VALUES (?, ?, ?, ?)`)
      for (const entry of evaluation.evidence) insert.run(id, entry.ordinal, entry.observationId, JSON.stringify(entry))
      return this.mapAssessment(this.db.prepare('SELECT * FROM process_assessments WHERE id = ?').get(id) as AssessmentRow)
    })()
  }

  /** The team's recommendations, newest first, each with its current assessment. */
  list(teamId: string, limit = 50): ProcessRecommendation[] {
    const rows = this.db.prepare('SELECT * FROM process_recommendations WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(teamId, Math.max(1, Math.min(200, Math.floor(limit)))) as RecommendationRow[]
    return rows.map(row => this.summary(mapRecommendation(row)))
  }

  /** One of the team's recommendations with every assessment; null for an unknown or another team's id (R7). */
  get(teamId: string, id: string): ProcessRecommendationDetail | null {
    const row = this.db.prepare('SELECT * FROM process_recommendations WHERE team_id = ? AND id = ?').get(teamId, id) as RecommendationRow | null
    if (!row) return null
    const assessments = (this.db.prepare('SELECT * FROM process_assessments WHERE recommendation_id = ? ORDER BY version')
      .all(id) as AssessmentRow[]).map(assessment => this.mapAssessment(assessment))
    return { ...this.summary(mapRecommendation(row)), assessments }
  }

  /** Record an evaluator failure (R4); never throws. */
  recordGap(teamId: string, episodeKey: string, errorKind: string): void {
    try {
      this.db.prepare('INSERT INTO process_recommendation_gaps (team_id, episode_key, error_kind, at) VALUES (?, ?, ?, ?)')
        .run(teamId, episodeKey, errorKind, new Date(this.now()).toISOString())
    } catch {
      // The database is gone (shutdown); a gap is advisory.
    }
  }

  gaps(teamId: string): Array<{ episodeKey: string; errorKind: string; at: string }> {
    return (this.db.prepare('SELECT episode_key, error_kind, at FROM process_recommendation_gaps WHERE team_id = ? ORDER BY id')
      .all(teamId) as Array<{ episode_key: string; error_kind: string; at: string }>)
      .map(row => ({ episodeKey: row.episode_key, errorKind: row.error_kind, at: row.at }))
  }

  private summary(rec: StoredRecommendation): ProcessRecommendation {
    const { snapshot: _snapshot, ...rest } = rec
    const versions = (this.db.prepare('SELECT COUNT(*) AS n FROM process_assessments WHERE recommendation_id = ?').get(rec.id) as { n: number }).n
    return { ...rest, current: this.latest(rec.id), versions }
  }

  private mapAssessment(row: AssessmentRow): ProcessAssessment {
    const evidence = (this.db.prepare(`SELECT e.summary_json, e.observation_id,
        (e.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM process_quota_observations o WHERE o.id = e.observation_id)) AS expired
      FROM process_assessment_evidence e WHERE e.assessment_id = ? ORDER BY e.ordinal`).all(row.id) as Array<{ summary_json: string; expired: number }>)
      .map(entry => ({ ...(JSON.parse(entry.summary_json) as Omit<EvidenceSummary, 'expired'>), expired: entry.expired === 1 }))
    return {
      id: row.id, recommendationId: row.recommendation_id, version: row.version, evaluatorVersion: row.evaluator_version,
      evidenceHash: row.evidence_hash, state: row.state, cutoff: row.cutoff, createdAt: row.created_at,
      advice: JSON.parse(row.advice_json) as ProcessAdvice, evidence,
    }
  }
}
