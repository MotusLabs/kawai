// The manager's quota composition (process-quota-history-and-incident-advice
// D1/D3): the one `QuotaReaderService`, the durable quota history it feeds,
// and the configured-worker reconciliation. The manager supplies narrow
// callbacks — its session targets and publish paths stay its own, so session
// behavior is unchanged — and this class turns every settlement into history
// rows for the teams it serves. A worker pull that returns data is also
// published to the live usage store, the way a session pull is, when it is
// the provider's current effective account (a retired key's is not). Worker
// subscriptions are recomputed from the teams' group files on every team
// resolution and once a minute, so an edited group file or provider catalog
// reaches the reader without a restart (S7, S14). History writes are
// isolated: a failed write is logged by name and never disturbs a pull.
import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import type { ChatUsageReport } from '../../../shared/chat'
import { logger } from '../../logger'
import { QuotaObservationStore, type QuotaAccountBasis } from '../../metrics/observations/quotaObservations'
import {
  QuotaReaderService, type QuotaPull, type QuotaSettlement, type WorkerSubscription,
} from './QuotaReaderService'
import { accountAliasOf, accountScopeOf, type QuotaTarget } from './quotaTarget'

export const WORKER_SWEEP_MS = 60_000

export interface ManagerQuotaDeps {
  db: Database
  cadenceMs: number
  read: (target: QuotaTarget) => Promise<QuotaPull>
  sessionTarget: (providerId: string) => QuotaTarget | null | undefined
  /** Teams of the provider's live sessions (asked only for a key a live session holds). */
  sessionTeams: (target: QuotaTarget) => string[]
  onSessionPull: (providerId: string, target: QuotaTarget, pull: QuotaPull) => void
  /** A worker-reason pull of the provider's current effective account that returned a quota report. */
  publishWorkerReport: (target: QuotaTarget, report: ChatUsageReport) => void
  /** Every configured team worker's effective target, as group files list them now. */
  configuredWorkers: () => WorkerSubscription[]
  /** History rows were written for these teams (advice re-evaluation trigger). */
  onHistory?: (teams: string[], providerId: string) => void
  now?: () => number
  random?: () => number
}

export class ManagerQuota {
  readonly service: QuotaReaderService
  readonly history: QuotaObservationStore
  private sweep: ReturnType<typeof setInterval> | null = null
  private pending: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** The per-process salt of every account scope this process writes (B12); never persisted. */
  private readonly salt = randomBytes(32)

  constructor(private readonly deps: ManagerQuotaDeps) {
    this.history = new QuotaObservationStore(deps.db, deps.now)
    this.service = new QuotaReaderService({
      read: deps.read,
      cadenceMs: deps.cadenceMs,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      sessionTarget: deps.sessionTarget,
      sessionTeams: deps.sessionTeams,
      onSessionPull: deps.onSessionPull,
      onSettled: settlement => this.settled(settlement),
    })
  }

  /** Begin worker reconciliation: now, after each team resolution, and once a minute. */
  start(): void {
    if (this.stopped || this.sweep) return
    this.sweep = setInterval(() => this.reconcile(), WORKER_SWEEP_MS)
    this.sweep.unref?.()
    this.reconcileSoon()
  }

  /** Coalesce reconciliation requests into one pass on a later turn. */
  reconcileSoon(): void {
    if (this.stopped || this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      this.reconcile()
    }, 0)
    this.pending.unref?.()
  }

  reconcile(): void {
    if (this.stopped) return
    let desired: WorkerSubscription[]
    try {
      desired = this.deps.configuredWorkers()
    } catch (error) {
      logger.warn('quota_worker_reconcile_failed', { error: error instanceof Error ? error.name : 'unknown' })
      return
    }
    this.service.reconcileWorkers(desired)
  }

  /** The account scope of a target in this process (B12). */
  scopeOf(target: QuotaTarget): string {
    return accountScopeOf(target, this.salt)
  }

  private settled(settlement: QuotaSettlement): void {
    const { target, reason, teams, outcome, pull } = settlement
    // Live publication only for the provider's current account (B5): a late
    // settlement of a retired key, or a sibling key's, is history only.
    if (reason !== 'session' && pull?.ok && !('remainingUsd' in pull) && pull.report.windows.length > 0 &&
      this.service.isCurrentAccount(target)) {
      this.deps.publishWorkerReport(target, pull.report)
    }
    if (teams.length === 0) return
    this.write(teams, target.providerId, () => this.history.record({
      teams, providerId: target.providerId, accountAlias: accountAliasOf(target), accountScope: this.scopeOf(target),
      accountBasis: 'routed',
      reason, outcome, report: pull?.ok ? pull.report : null,
      observedAt: new Date(settlement.settledAt).toISOString(),
    }))
  }

  /**
   * A report an agent pushed or pulled for a session (rate-limit frames,
   * `/usage`, the SDK pull). `host-login` when the session's profile routes
   * through a base URL, so the report may describe the host login (F5).
   */
  recordAgentReport(teamId: string | null, target: QuotaTarget, basis: QuotaAccountBasis, report: ChatUsageReport): void {
    if (this.stopped || !teamId) return
    this.write([teamId], target.providerId, () => this.history.record({
      teams: [teamId], providerId: target.providerId, accountAlias: accountAliasOf(target), accountScope: this.scopeOf(target),
      accountBasis: basis,
      reason: 'agent', outcome: 'supported', report, observedAt: report.receivedAt,
    }))
  }

  private write(teams: string[], providerId: string, run: () => unknown): void {
    try {
      run()
    } catch (error) {
      logger.warn('quota_history_write_failed', { providerId, error: error instanceof Error ? error.name : 'unknown' })
      return
    }
    this.deps.onHistory?.(teams, providerId)
  }

  shutdown(): void {
    this.stopped = true
    if (this.sweep) clearInterval(this.sweep)
    if (this.pending) clearTimeout(this.pending)
    this.sweep = null
    this.pending = null
    this.service.shutdown()
  }
}
