// Durable-source recovery (process-observability D10): reads committed task,
// status, assignment, result, finding, mailbox-transition, profile-limit and
// completed-turn rows after the operational transaction and records one fact
// per source row under a stable key, so a recording failure is retried from
// the source and never undoes the operation. Append-only tables advance a
// rowid cursor; pruned tables (limits, usage) are found by their missing key,
// so rowid reuse after pruning cannot lose a row. Never transcript inference.
import type { Database } from 'bun:sqlite'
import {
  InvalidObservationError,
  OBSERVATION_VERSION,
  type Measurement,
  type ObservationIdentity,
  type ObservationKind,
} from '../../../shared/processObservations'
import { logger } from '../../logger'
import { ObservationRecorder } from './recorder'

type Row = Record<string, unknown>

const BATCH = 200
const SOURCES = [
  'team_tasks',
  'team_task_status_events',
  'team_task_assignments',
  'team_task_results',
  'team_task_findings',
  'team_message_events',
  'profile_limit_events',
  'chat_turn_usage',
] as const
type Source = (typeof SOURCES)[number]

const UNKEYED_USAGE = `SELECT rowid AS observation_rowid,* FROM chat_turn_usage u
  WHERE NOT EXISTS (SELECT 1 FROM process_observation_keys k WHERE k.source_key='usage:'||u.session_id||':'||u.turn_id)
  ORDER BY ended_at LIMIT ${BATCH}`
const UNKEYED_LIMITS = `SELECT rowid AS observation_rowid,* FROM profile_limit_events e
  WHERE NOT EXISTS (SELECT 1 FROM process_observation_keys k WHERE k.source_key='source:profile_limit_events:'||e.id)
  ORDER BY at LIMIT ${BATCH}`
const UNKEYED_ACCEPTANCES = `SELECT r.*,t.created_at AS task_created FROM team_task_results r JOIN team_tasks t ON t.id=r.task_id
  WHERE r.accepted_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM process_observation_keys k WHERE k.source_key='acceptance:'||r.id)
  ORDER BY r.accepted_at,r.id LIMIT ${BATCH}`
const TASK_ACCEPTANCES = `SELECT r.*, t.created_at AS task_created FROM team_task_results r JOIN team_tasks t ON t.id=r.task_id
  WHERE r.task_id=? AND r.accepted_at IS NOT NULL ORDER BY r.accepted_at,r.id LIMIT ${BATCH}`
const LANDING_OF_RESULT = `SELECT l.mechanism FROM plan_change_landings l
  JOIN plan_execution_changes c ON c.execution_id=l.execution_id AND c.change=l.change
  JOIN plan_execution_rounds r ON r.execution_id=l.execution_id AND r.change=l.change AND r.commit_sha=l.head_sha
  WHERE c.task_id=? AND r.result_id=? LIMIT 1`

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
const time = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null

function acceptanceMechanism(landing: Row | null, acceptedBy: unknown): string {
  if (landing?.mechanism === 'integration-branch') return 'integration-landing'
  if (landing) return 'direct-landing'
  if (acceptedBy === 'human') return 'manual'
  if (acceptedBy === 'agent') return 'creator'
  return 'unknown-legacy'
}

export class ObservationReconciler {
  constructor(
    private readonly db: Database,
    private readonly recorder: ObservationRecorder,
  ) {}

  /** At most 200 rows/source per pass. Cursor and observations commit together. */
  run(): void {
    for (const source of SOURCES) {
      this.recorder.safe(() =>
        this.db.transaction(() => {
          for (const row of this.pending(source)) {
            this.skipInvalid(this.sourceKey(source, row), () => this.fromSource(source, row))
            this.recorder.store.setCheckpoint(`cursor:${source}`, String(row.observation_rowid))
          }
        })(),
      )
    }
    this.recorder.safe(() => this.acceptances())
  }

  /** A post-commit task/result/assignment notification also finds acceptance updates to older rows; the caller runs the source pass once after. */
  task(taskId: string): void {
    this.recorder.safe(() => {
      for (const row of this.db.prepare(TASK_ACCEPTANCES).all(taskId) as Row[]) {
        this.skipInvalid(`acceptance:${row.id}`, () => this.accept(row))
      }
    })
  }

  private pending(source: Source): Row[] {
    if (source === 'chat_turn_usage') return this.db.prepare(UNKEYED_USAGE).all() as Row[]
    if (source === 'profile_limit_events') return this.db.prepare(UNKEYED_LIMITS).all() as Row[]
    const cursor = Number(this.recorder.store.checkpoint(`cursor:${source}`) ?? 0)
    return this.db
      .prepare(`SELECT rowid AS observation_rowid,* FROM ${source} WHERE rowid>? ORDER BY rowid LIMIT ${BATCH}`)
      .all(cursor) as Row[]
  }

  /** A row whose fact fails validation would roll its batch back on every pass; reserve its key and move on. */
  private skipInvalid(sourceKey: string, work: () => void): void {
    try {
      work()
    } catch (error) {
      if (!(error instanceof InvalidObservationError)) throw error
      this.db
        .prepare('INSERT OR IGNORE INTO process_observation_keys VALUES (?, ?)')
        .run(sourceKey, OBSERVATION_VERSION)
      logger.warn('process_observation_source_row_skipped', { sourceKey, error: error.message })
    }
  }

  private sourceKey(source: Source, row: Row): string {
    if (source === 'chat_turn_usage') return `usage:${row.session_id}:${row.turn_id}`
    const id = row.id ?? (source === 'team_message_events' ? `${row.message_id}:${row.seq}` : row.observation_rowid)
    return `source:${source}:${id}`
  }

  private identity(row: Row): ObservationIdentity {
    return {
      teamId: str(row.team_id),
      taskId: str(row.task_id),
      taskRevision: row.task_revision == null ? null : Number(row.task_revision),
      sessionId: str(row.session_id),
      turnId: str(row.turn_id),
      startId: str(row.start_id),
      groupId: str(row.group_id),
      profileId: str(row.profile_id),
      model: str(row.model),
      actorSession: str(row.actor_session),
    }
  }

  private fromSource(source: Source, row: Row): void {
    const identity = this.identity(row)
    const write = (kind: ObservationKind, at: unknown, data: Measurement, extra: ObservationIdentity = {}) => {
      const observedAt = time(at)
      if (!observedAt) return
      this.recorder.store.record({
        ...identity,
        ...extra,
        sourceKey: this.sourceKey(source, row),
        kind,
        observedAt,
        data,
      })
    }
    switch (source) {
      case 'team_tasks': {
        const first = this.db
          .prepare('SELECT revision FROM team_task_revisions WHERE task_id=? ORDER BY revision LIMIT 1')
          .get(row.id as string) as { revision: number } | null
        const revision = first?.revision ?? null
        write('task', row.created_at, { revision }, { taskId: str(row.id), taskRevision: revision })
        break
      }
      case 'team_task_status_events':
        write('status', row.at, {
          from: str(row.from_status),
          to: str(row.to_status),
          actorKind: str(row.actor_kind),
        })
        break
      case 'team_task_assignments':
        write(
          'assignment',
          row.created_at,
          { handoffKind: str(row.handoff_kind), targetKind: str(row.target_kind) },
          {
            assignmentId: str(row.id),
            resultId: str(row.result_id),
            taskRevision: this.resultRevision(row.result_id),
          },
        )
        break
      case 'team_task_results':
        write(
          'result',
          row.created_at,
          { revision: Number(row.task_revision) },
          { resultId: str(row.id), actorSession: str(row.submitted_by_session) },
        )
        break
      case 'team_task_findings':
        write(
          'finding',
          row.created_at,
          { verdict: str(row.verdict), reviewKind: str(row.kind) },
          {
            resultId: str(row.result_id),
            assignmentId: str(row.handoff_id),
            actorSession: str(row.author_session),
            taskRevision: this.resultRevision(row.result_id),
          },
        )
        break
      case 'team_message_events': {
        const mail = this.db.prepare('SELECT task_id FROM team_messages WHERE id=?').get(row.message_id as string) as
          | Row
          | null
        const assignment = this.db
          .prepare('SELECT id,result_id FROM team_task_assignments WHERE message_id=?')
          .get(row.message_id as string) as Row | null
        write(
          'mail',
          row.created_at,
          { transition: str(row.kind), actorKind: str(row.actor) },
          {
            taskId: str(mail?.task_id),
            assignmentId: str(assignment?.id),
            resultId: str(assignment?.result_id),
            taskRevision: this.resultRevision(assignment?.result_id),
          },
        )
        break
      }
      case 'profile_limit_events': {
        const session = this.db
          .prepare('SELECT team_id FROM team_session_directory WHERE session_id=? LIMIT 1')
          .get(row.session_id as string) as Row | null
        write(
          'limit',
          row.at,
          { final: Number(row.final) === 1, status: row.status === null ? null : Number(row.status) },
          { teamId: str(session?.team_id) },
        )
        break
      }
      case 'chat_turn_usage':
        write('usage', row.ended_at, {
          input: Number(row.input_tokens),
          output: Number(row.output_tokens),
          cacheRead: Number(row.cache_read_tokens),
          cacheCreation: Number(row.cache_creation_tokens),
          steps: Number(row.num_turns),
          outcome: Number(row.ok) ? 'success' : 'failed',
          scope: 'completed-main-loop',
        })
        break
    }
  }

  private resultRevision(id: unknown): number | null {
    if (typeof id !== 'string') return null
    const result = this.db.prepare('SELECT task_revision FROM team_task_results WHERE id=?').get(id) as {
      task_revision: number
    } | null
    return result?.task_revision ?? null
  }

  private accept(row: Row): void {
    const observedAt = time(row.accepted_at)
    if (!observedAt) return
    const first = this.db
      .prepare('SELECT id FROM team_task_results WHERE task_id=? AND accepted_at IS NOT NULL ORDER BY accepted_at,id LIMIT 1')
      .get(row.task_id as string) as Row
    const landing =
      row.accepted_by_kind === 'system'
        ? (this.db.prepare(LANDING_OF_RESULT).get(row.task_id as string, row.id as string) as Row | null)
        : null
    const mechanism = acceptanceMechanism(landing, row.accepted_by_kind)
    this.db.transaction(() => {
      const firstKey = `first-acceptance:${row.task_id}`
      const isFirst =
        first.id === row.id &&
        !this.db.prepare('SELECT 1 FROM process_observation_keys WHERE source_key=?').get(firstKey)
      if (isFirst) this.db.prepare('INSERT INTO process_observation_keys VALUES (?,1)').run(firstKey)
      this.recorder.store.record({
        ...this.identity(row),
        resultId: str(row.id),
        actorSession: str(row.accepted_by_session),
        taskRevision: Number(row.task_revision),
        sourceKey: `acceptance:${row.id}`,
        kind: 'acceptance',
        observedAt,
        data: {
          revision: Number(row.task_revision),
          actorKind: str(row.accepted_by_kind),
          mechanism,
          first: isFirst,
          durationSeconds: Math.max(0, (Date.parse(observedAt) - Date.parse(String(row.task_created))) / 1000),
        },
      })
    })()
  }

  private acceptances(): void {
    const rows = this.db.prepare(UNKEYED_ACCEPTANCES).all() as Row[]
    this.db.transaction(() => {
      for (const row of rows) this.skipInvalid(`acceptance:${row.id}`, () => this.accept(row))
    })()
  }
}
