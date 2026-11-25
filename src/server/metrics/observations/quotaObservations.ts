// Durable quota history (process-quota-history-and-incident-advice D3, task
// 3.4; created by migration 31, recommendations/schema.ts): one row per team and observation, with the provider, the account
// alias (`provider@host`, never a credential), whether the data describes
// the routed provider's account or an unrelated host login, the reason that
// polled it, the outcome, and each window with its own observation time. A
// status-only report stores no windows, so it never freshens a window's age
// (Table F row F6). No response body, error text or credential is ever
// stored (I2): outcomes are an enum and windows are numbers and times.
// Rows are detail: they prune with the foundation's interval retention
// (14 d), and recommendation evidence keeps its own frozen summaries (R9).
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { ChatUsageReport, ChatUsageStatus } from '../../../shared/chat'

export const QUOTA_OBSERVATION_OUTCOMES = ['supported', 'unavailable', 'auth-refused', 'failed', 'unsupported'] as const
export type QuotaObservationOutcome = (typeof QUOTA_OBSERVATION_OUTCOMES)[number]
export type QuotaObservationReason = 'session' | 'worker' | 'both' | 'agent'
/** `routed`: the provider's own account; `host-login`: an agent report that may describe the host Claude login (F5). */
export type QuotaAccountBasis = 'routed' | 'host-login'

export interface QuotaWindowObservation {
  key: string
  label: string
  percentUsed: number
  resetsAt: string | null
  periodMs?: number
  /** When this window's value was observed (receipt time: providers send no clock). */
  observedAt: string
}

export interface QuotaObservation {
  id: string
  teamId: string
  providerId: string
  accountAlias: string
  /**
   * The effective account as this process knows it: an HMAC of the in-memory
   * account key under a per-process random salt (binding B12). It matches a
   * candidate only within the process that observed it, so a rotated
   * credential or a restart never inherits another credential's headroom.
   */
  accountScope: string
  accountBasis: QuotaAccountBasis
  /** The report shape (`provider`, `push`, `report`, `pull`), or `none` without data. */
  source: string
  reason: QuotaObservationReason
  outcome: QuotaObservationOutcome
  status: ChatUsageStatus | null
  windows: QuotaWindowObservation[]
  timeBasis: 'receipt' | 'provider'
  observedAt: string
  recordedAt: string
}

export const QUOTA_OBSERVATIONS_SQL = `
CREATE TABLE process_quota_observations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  account_basis TEXT NOT NULL CHECK (account_basis IN ('routed','host-login')),
  source TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('session','worker','both','agent')),
  outcome TEXT NOT NULL CHECK (outcome IN ('supported','unavailable','auth-refused','failed','unsupported')),
  status TEXT,
  windows_json TEXT NOT NULL,
  time_basis TEXT NOT NULL CHECK (time_basis IN ('receipt','provider')),
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX process_quota_observations_team ON process_quota_observations (team_id, provider_id, observed_at);
CREATE INDEX process_quota_observations_recorded ON process_quota_observations (recorded_at);
`

export interface NewQuotaObservation {
  teams: string[]
  providerId: string
  accountAlias: string
  accountScope: string
  accountBasis: QuotaAccountBasis
  reason: QuotaObservationReason
  outcome: QuotaObservationOutcome
  /** The report, when the outcome carried one; its windows are stored with its receipt time. */
  report: ChatUsageReport | null
  observedAt: string
}

export const QUOTA_PRUNE_BATCH = 500

interface Row {
  id: string; team_id: string; provider_id: string; account_alias: string; account_scope: string; account_basis: QuotaAccountBasis
  source: string; reason: QuotaObservationReason; outcome: QuotaObservationOutcome; status: string | null
  windows_json: string; time_basis: 'receipt' | 'provider'; observed_at: string; recorded_at: string
}

function mapRow(row: Row): QuotaObservation {
  return {
    id: row.id, teamId: row.team_id, providerId: row.provider_id, accountAlias: row.account_alias, accountScope: row.account_scope,
    accountBasis: row.account_basis, source: row.source, reason: row.reason, outcome: row.outcome,
    status: row.status as ChatUsageStatus | null, windows: JSON.parse(row.windows_json) as QuotaWindowObservation[],
    timeBasis: row.time_basis, observedAt: row.observed_at, recordedAt: row.recorded_at,
  }
}

export class QuotaObservationStore {
  constructor(readonly db: Database, private readonly now: () => number = Date.now) {}

  /** One row per team; returns the ids written. Only whitelisted fields of the report are kept. */
  record(input: NewQuotaObservation): string[] {
    const report = input.report
    const observedAt = report?.receivedAt ?? input.observedAt
    const windows: QuotaWindowObservation[] = (report?.windows ?? []).map(window => ({
      key: String(window.key),
      label: String(window.label),
      percentUsed: Number(window.percentUsed),
      resetsAt: window.resetsAt ?? null,
      ...(typeof window.periodMs === 'number' ? { periodMs: window.periodMs } : {}),
      observedAt,
    }))
    const recordedAt = new Date(this.now()).toISOString()
    const insert = this.db.prepare(`INSERT INTO process_quota_observations
      (id, team_id, provider_id, account_alias, account_scope, account_basis, source, reason, outcome, status, windows_json, time_basis, observed_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receipt', ?, ?)`)
    const ids: string[] = []
    this.db.transaction(() => {
      for (const teamId of new Set(input.teams)) {
        const id = `quota-${randomUUID()}`
        insert.run(id, teamId, input.providerId, input.accountAlias, input.accountScope, input.accountBasis, report?.source ?? 'none',
          input.reason, input.outcome, report?.status ?? null, JSON.stringify(windows), observedAt, recordedAt)
        ids.push(id)
      }
    })()
    return ids
  }

  /** A team's observations at or before `until` (ISO), oldest first; optionally one provider. */
  list(teamId: string, options: { providerId?: string; until?: string; since?: string } = {}): QuotaObservation[] {
    const rows = this.db.prepare(`SELECT * FROM process_quota_observations
      WHERE team_id = $team AND ($provider IS NULL OR provider_id = $provider)
        AND ($until IS NULL OR observed_at <= $until) AND ($since IS NULL OR observed_at >= $since)
      ORDER BY observed_at, recorded_at, id`).all({
      $team: teamId, $provider: options.providerId ?? null, $until: options.until ?? null, $since: options.since ?? null,
    }) as Row[]
    return rows.map(mapRow)
  }

  get(teamId: string, id: string): QuotaObservation | null {
    const row = this.db.prepare('SELECT * FROM process_quota_observations WHERE team_id = ? AND id = ?').get(teamId, id) as Row | null
    return row ? mapRow(row) : null
  }

  /** Delete at most one batch recorded before the cutoff; returns how many went. */
  prune(cutoffIso: string, batch = QUOTA_PRUNE_BATCH): number {
    return this.db.prepare(`DELETE FROM process_quota_observations WHERE id IN
      (SELECT id FROM process_quota_observations WHERE recorded_at < ? LIMIT ?)`).run(cutoffIso, batch).changes
  }
}
