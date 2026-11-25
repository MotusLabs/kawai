// The manager's incident advice composition (process-quota-history-and-
// incident-advice D4–D6, tasks 3.5 and 4.2–4.4). It turns the two incident
// commits Kawai already makes into advice episodes:
//
// - a final limit event (`LimitEventStore.subscribe`) is a quota incident.
//   While the team's quota recommendation for that provider is unresolved,
//   later final events of the provider join it (one episode, re-evaluated);
// - a context-exhausted flag is a context incident, keyed by the existing
//   episode's attention id `context-exhausted:<session>:<flaggedAt>`, so the
//   advice attaches to it (D6) instead of raising another alert.
//
// A quota incident on a task of a plan change with a stall alert attaches to
// that alert's attention id (`plan-stall:<execution>:<change>:<episode>`,
// R6); a stall raised after the episode opened is attached on the next limit
// event, quota history write or startup. The routing facts are frozen from
// `TeamCapacity.readTeam` — read-only and fetch-free (I4) — when the incident
// commits (`snapshot_basis` `incident`). The limit event commits before its
// subscriber runs, so a crash in between leaves a durable final event with no
// recommendation: at startup, and again once each session's team resolves,
// every final event still in force and every flagged context is replayed
// through the same path (`reconstructed`, idempotent per episode, R5). Quota
// history writes and limit updates re-evaluate the team's open episodes. Nothing here sends mail,
// routes, or changes a login (X3, I1).
import type { Database } from 'bun:sqlite'
import type { TeamCapacityAnswer } from '../../../shared/teamCapacity'
import type { ChatSessionRecord } from '../../db'
import { logger } from '../../logger'
import type { LimitEvent } from '../../../shared/routing'
import type { IncidentCandidate, WriterFacts } from '../../metrics/recommendations/evaluator'
import { ProcessAdviceService, type AdviceServiceDeps } from '../../metrics/recommendations/service'
import { incidentSnapshot } from '../../metrics/recommendations/snapshot'
import { RecommendationStore, type StoredRecommendation } from '../../metrics/recommendations/store'
import type { QuotaObservationStore } from '../../metrics/observations/quotaObservations'
import { LIMIT_EVENT_READ_WINDOW_MS } from '../../team/routing/limitEvents'

/** A durable `profile_limit_events` row (the limit store's own table). */
interface LimitEventRow {
  id: string; profile_id: string; session_id: string; group_id: string | null; at: string; kind: LimitEvent['kind']; final: number
  status: number | null; message: string | null; resets_at: string | null; provider_id: string | null; limit_window: string | null
}

const limitEventOf = (row: LimitEventRow): LimitEvent => ({
  id: row.id, profileId: row.profile_id, sessionId: row.session_id, groupId: row.group_id, at: row.at, kind: row.kind,
  final: row.final === 1, status: row.status, message: row.message, resetsAt: row.resets_at, providerId: row.provider_id,
  window: row.limit_window,
})

export interface ManagerAdviceDeps {
  db: Database
  history: QuotaObservationStore
  limits: {
    subscribe: (listener: (event: LimitEvent) => void) => () => void
    forProvider: (providerId: string) => LimitEvent[]
    cooldownFor: (profileId: string, providerId: string | null) => { until: string | null }
  }
  record: (sessionId: string) => ChatSessionRecord | undefined
  /** Every tracked record (startup reconstruction of flagged sessions). */
  records: () => Iterable<ChatSessionRecord>
  teamOf: (sessionId: string) => string | null
  /** The session's team capacity as `team_capacity` reads it; null without a team catalog. */
  capacity: (sessionId: string) => TeamCapacityAnswer | null
  providerOf: (profileId: string, projectPath: string) => string
  /** A profile's account scope at a project path in this process (B12); null when unresolved. */
  scopeOf: (profileId: string, projectPath: string) => string | null
  /** The task and hard restrictions of the group message the session holds. */
  heldWork: (sessionId: string) => { taskId: string | null; restriction: (profileId: string) => IncidentCandidate['restriction'] }
  /** Staffing's writer facts for the session's worktree: every spawned holder (the session itself included) and pending reservations. */
  writerSlot: (sessionId: string) => { occupants: string[]; pending: number }
  onChange?: (teamId: string) => void
  now?: () => number
  /** Test seam: the evaluator (production: `evaluateIncident`). */
  evaluate?: AdviceServiceDeps['evaluate']
}

export class ManagerAdvice {
  readonly store: RecommendationStore
  readonly service: ProcessAdviceService
  private readonly unsubscribe: () => void
  private stopped = false

  constructor(private readonly deps: ManagerAdviceDeps) {
    this.store = new RecommendationStore(deps.db, deps.now)
    this.service = new ProcessAdviceService({
      store: this.store,
      history: deps.history,
      limitsFor: providers => providers.flatMap(providerId => deps.limits.forProvider(providerId))
        .map(event => ({ id: event.id, providerId: event.providerId, at: event.at, final: event.final, window: event.window })),
      isOpen: (rec, cutoff) => this.isOpen(rec, cutoff),
      comparisons: (teamId, cutoffIso) => (deps.db.prepare(`SELECT COUNT(*) AS n FROM team_messages
        WHERE team_id = ? AND handoff IS NOT NULL AND delivered_at IS NOT NULL AND delivered_at <= ?`).get(teamId, cutoffIso) as { n: number }).n,
      ...(deps.onChange ? { onChange: deps.onChange } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.evaluate ? { evaluate: deps.evaluate } : {}),
    })
    this.unsubscribe = deps.limits.subscribe(event => this.guard(() => this.limitEvent(event)))
  }

  /** Startup: reconstruct incidents in force without a recommendation, then enqueue the open ones (R5). */
  start(): void {
    this.guard(() => {
      for (const record of this.deps.records()) this.reconstruct(record.sessionId)
      this.service.reconcile()
    })
  }

  /**
   * The session's team is now known (startup resolution is asynchronous):
   * reconstruct its incidents still in force (R5) and attach stalls (R6).
   */
  teamResolved(sessionId: string): void {
    this.guard(() => this.reconstruct(sessionId))
  }

  /** The session's turn ended context-exhausted and the flag was just set. */
  contextFlagged(sessionId: string): void {
    this.guard(() => this.contextIncident(sessionId, 'incident'))
  }

  /** Quota history was written for these teams: their open episodes may change. */
  historyWritten(teams: string[]): void {
    for (const teamId of teams) {
      this.guard(() => this.attachStalls(teamId))
      this.service.enqueueTeam(teamId)
    }
  }

  shutdown(): void {
    this.stopped = true
    this.unsubscribe()
    this.service.shutdown()
  }

  private guard(run: () => void): void {
    if (this.stopped) return
    try {
      run()
    } catch (error) {
      logger.warn('process_advice_hook_failed', { error: error instanceof Error ? error.name : 'unknown' })
    }
  }

  private limitEvent(event: LimitEvent): void {
    const teamId = this.deps.teamOf(event.sessionId)
    if (!teamId) return
    if (!event.final) {
      this.attachStalls(teamId)
      this.service.enqueueTeam(teamId)
      return
    }
    this.quotaIncident(teamId, event, 'incident')
  }

  /**
   * Replay the session's incidents still in force: its context flag, and its
   * final limit events whose cooldown still runs, oldest first, so they
   * coalesce exactly as they did live. An episode that already has a
   * recommendation is left alone.
   */
  private reconstruct(sessionId: string): void {
    const teamId = this.deps.teamOf(sessionId)
    if (!teamId) return
    const record = this.deps.record(sessionId)
    if (record?.contextExhausted && !record.archivedAt) this.contextIncident(sessionId, 'reconstructed')
    const since = new Date(this.now() - LIMIT_EVENT_READ_WINDOW_MS).toISOString()
    const rows = this.deps.db.prepare(`SELECT * FROM profile_limit_events
      WHERE session_id = ? AND final = 1 AND at >= ? ORDER BY at, id`).all(sessionId, since) as LimitEventRow[]
    for (const row of rows) {
      const event = limitEventOf(row)
      const until = this.deps.limits.cooldownFor(event.profileId, event.providerId).until
      if (until === null || Date.parse(until) <= this.now()) continue
      this.quotaIncident(teamId, event, 'reconstructed')
    }
    this.attachStalls(teamId)
  }

  /** Attach the team's unresolved quota advice to its task's current plan stall (R6), whichever came first. */
  private attachStalls(teamId: string): void {
    let changed = false
    for (const rec of this.store.unresolved()) {
      if (rec.teamId !== teamId || rec.kind !== 'quota') continue
      const attention = this.planStallAttention(rec.taskId)
      if (attention && this.store.attach(rec.id, attention)) changed = true
    }
    if (changed) this.deps.onChange?.(teamId)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private quotaIncident(teamId: string, event: LimitEvent, basis: 'incident' | 'reconstructed'): void {
    const record = this.deps.record(event.sessionId)
    const projectPath = record?.projectPath ?? ''
    const providerId = event.providerId ?? this.deps.providerOf(event.profileId, projectPath)
    const episodeKey = `quota:${providerId}:${event.id}`
    const open = this.store.openFor(teamId, 'quota', providerId)
    if (open) {
      // A later final limit joins the open episode; a stall raised since it opened attaches now (R6).
      const attention = this.planStallAttention(open.taskId)
      if (attention && this.store.attach(open.id, attention)) this.deps.onChange?.(teamId)
      this.service.enqueue(open.id)
      return
    }
    if (basis === 'reconstructed' && this.store.byEpisode(teamId, 'quota', episodeKey)) return
    const held = this.deps.heldWork(event.sessionId)
    this.service.incident({
      teamId, kind: 'quota', episodeKey, sessionId: event.sessionId, taskId: held.taskId,
      groupId: event.groupId, profileId: event.profileId, providerId, attentionId: this.planStallAttention(held.taskId),
      cutoff: event.at, snapshotBasis: basis,
      snapshot: incidentSnapshot({
        limited: { profileId: event.profileId, providerId, window: event.window, resetsAt: event.resetsAt },
        groupId: event.groupId, capacity: this.deps.capacity(event.sessionId),
        scopeOf: profileId => this.deps.scopeOf(profileId, projectPath), restriction: held.restriction,
        writer: this.writerFacts(event.sessionId, held.taskId !== null),
      }),
    })
  }

  private contextIncident(sessionId: string, basis: 'incident' | 'reconstructed'): void {
    const record = this.deps.record(sessionId)
    const teamId = this.deps.teamOf(sessionId)
    if (!record?.contextExhausted || !teamId) return
    const profileId = record.claudeProfileId ?? 'default'
    const providerId = this.deps.providerOf(profileId, record.projectPath)
    const attentionId = `context-exhausted:${sessionId}:${record.contextExhausted.at}`
    const held = this.deps.heldWork(sessionId)
    this.service.incident({
      teamId, kind: 'context', episodeKey: attentionId, sessionId, taskId: held.taskId, groupId: record.groupId ?? null,
      profileId, providerId, attentionId, cutoff: record.contextExhausted.at, snapshotBasis: basis,
      snapshot: incidentSnapshot({
        limited: { profileId, providerId, window: null, resetsAt: null },
        groupId: record.groupId ?? null, capacity: this.deps.capacity(sessionId),
        scopeOf: id => this.deps.scopeOf(id, record.projectPath), restriction: held.restriction,
        writer: this.writerFacts(sessionId, held.taskId !== null),
      }),
    })
  }

  /** The writer slot as routing counts it (occupants + pending), split into other holders and the incident's own hold (E5). */
  private writerFacts(sessionId: string, required: boolean): WriterFacts {
    const slot = this.deps.writerSlot(sessionId)
    return {
      required, occupants: slot.occupants.filter(id => id !== sessionId), pending: slot.pending,
      heldByIncident: slot.occupants.includes(sessionId),
    }
  }

  private isOpen(rec: StoredRecommendation, cutoff: number): boolean {
    if (rec.kind === 'context') {
      const flag = rec.sessionId ? this.deps.record(rec.sessionId)?.contextExhausted : null
      return flag ? `context-exhausted:${rec.sessionId}:${flag.at}` === rec.episodeKey : false
    }
    const { profileId, providerId } = rec.snapshot.limited
    const until = this.deps.limits.cooldownFor(profileId, providerId).until
    return until !== null && Date.parse(until) > cutoff
  }

  /** The newest stall alert of the plan change that owns the task (R6), as its attention id. */
  private planStallAttention(taskId: string | null): string | null {
    if (!taskId) return null
    try {
      const row = this.deps.db.prepare(`SELECT a.execution_id, a.change, a.episode_key FROM plan_stall_alerts a
        JOIN plan_execution_changes c ON c.execution_id = a.execution_id AND c.change = a.change
        WHERE c.task_id = ? ORDER BY a.raised_at DESC LIMIT 1`).get(taskId) as { execution_id: string; change: string; episode_key: string } | null
      return row ? `plan-stall:${row.execution_id}:${row.change}:${row.episode_key}` : null
    } catch {
      return null
    }
  }
}
