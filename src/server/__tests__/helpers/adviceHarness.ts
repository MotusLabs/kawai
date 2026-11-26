// Advice harness (process-quota-history-and-incident-advice Tables E and R):
// the production ManagerAdvice — its incident hooks, snapshot builder,
// evaluation queue, evaluator and stores — over a fresh test database, with
// the production LimitEventStore and QuotaObservationStore. The routing reads
// the manager supplies (team capacity, account scopes, held work, writer
// occupancy, session records) are fixtures the test sets; a manager-level
// composition test covers the real ones.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatUsageReport } from '../../../shared/chat'
import type { TeamCapacityAnswer } from '../../../shared/teamCapacity'
import type { ChatSessionRecord, SessionDatabase } from '../../db'
import { ManagerAdvice, type ManagerAdviceDeps } from '../../chat/quota/managerAdvice'
import type { IncidentCandidate } from '../../metrics/recommendations/evaluator'
import { QuotaObservationStore } from '../../metrics/observations/quotaObservations'
import { LimitEventStore } from '../../team/routing/limitEvents'
import { freshTestDatabase } from './testDatabase'

export const TEAM = 'team-a'
export const T0 = Date.parse('2026-06-01T12:00:00.000Z')
export const MIN = 60_000

export interface Worker { model: string; provider: string; cap?: number | null; live?: number; cooldownUntil?: string | null }

export interface AdviceHarness {
  db: SessionDatabase
  clock: { now: number }
  limits: LimitEventStore
  history: QuotaObservationStore
  advice: ManagerAdvice
  records: Map<string, ChatSessionRecord>
  workers: Worker[]
  group: { max: number; live: number }
  sharesLoginWith: Record<string, string[]>
  /** Account scope per profile (B12); absent: unresolved. */
  scopes: Record<string, string>
  restrictions: Record<string, IncidentCandidate['restriction']>
  /** Staffing's worktree holders (s1 is the incident's own session) and pending reservations. */
  occupants: string[]
  pending: number
  changes: string[]
  /** Record a final limit of `profileId` on `providerId` for session s1 now. */
  limit(options?: { profileId?: string; providerId?: string; resetsAt?: string | null; window?: string | null; final?: boolean }): void
  /** Record a quota observation of `providerId` under `profileId`'s scope at `at`. */
  observe(profileId: string, providerId: string, at: number, options?: { percent?: number; outcome?: 'supported' | 'failed'; basis?: 'routed' | 'host-login'; resetsAt?: string | null }): string
  drain(): void
  close(): void
}

/** A harness over a fresh database, or `options.db` (a restart over the same data; left open on close). */
export function adviceHarness(options: { db?: SessionDatabase; evaluate?: ManagerAdviceDeps['evaluate'] } = {}): AdviceHarness {
  const root = options.db ? null : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-advice-')))
  const db = options.db ?? freshTestDatabase(path.join(root!, 'test.db'))
  const clock = { now: T0 }
  const now = () => clock.now
  const limits = new LimitEventStore(db.db, now)
  const history = new QuotaObservationStore(db.db, now)
  const h = {
    db, clock, limits, history, records: new Map<string, ChatSessionRecord>(),
    workers: [] as Worker[], group: { max: 4, live: 1 }, sharesLoginWith: {} as Record<string, string[]>,
    scopes: {} as Record<string, string>, restrictions: {} as Record<string, IncidentCandidate['restriction']>,
    occupants: [] as string[], pending: 0, changes: [] as string[],
  } as AdviceHarness
  h.records.set('s1', {
    sessionId: 's1', name: 'dev', projectPath: '/repo/wt', sdkSessionId: null, claudeProfileId: 'glm', groupId: 'devs', taskId: null,
  } as unknown as ChatSessionRecord)
  const capacity = (): TeamCapacityAnswer => ({
    computedAt: new Date(clock.now).toISOString(),
    groups: [{
      id: 'devs', max: h.group.max, live: h.group.live, strategy: 'first-available',
      workers: h.workers.map(worker => ({
        model: worker.model, provider: worker.provider, cap: worker.cap ?? null, live: worker.live ?? 0,
        cooldownUntil: worker.cooldownUntil !== undefined ? worker.cooldownUntil : limits.cooldownFor(worker.model, worker.provider).until,
      })),
    }],
    providers: [...new Set(h.workers.map(worker => worker.provider))].map(id => ({
      id, label: null, usage: null, cooldownUntil: null, sharesLoginWith: h.sharesLoginWith[id] ?? [],
    })),
  })
  h.advice = new ManagerAdvice({
    db: db.db, history, limits, now,
    record: id => h.records.get(id),
    records: () => h.records.values(),
    teamOf: id => (h.records.has(id) ? TEAM : null),
    capacity,
    providerOf: profileId => h.workers.find(worker => worker.model === profileId)?.provider ?? profileId,
    scopeOf: profileId => h.scopes[profileId] ?? null,
    heldWork: id => ({ taskId: h.records.get(id)?.taskId ?? null, restriction: profileId => h.restrictions[profileId] ?? null }),
    writerSlot: () => ({ occupants: h.occupants, pending: h.pending }),
    onChange: teamId => { h.changes.push(teamId) },
    ...(options.evaluate ? { evaluate: options.evaluate } : {}),
  })
  h.limit = (options = {}) => {
    limits.record({
      profileId: options.profileId ?? 'glm', sessionId: 's1', groupId: 'devs', kind: 'rate_limit', final: options.final ?? true,
      status: 429, message: null, resetsAt: options.resetsAt === undefined ? new Date(clock.now + 60 * MIN).toISOString() : options.resetsAt,
      providerId: options.providerId ?? 'zai', window: options.window ?? 'five_hour', at: new Date(clock.now).toISOString(),
    })
  }
  h.observe = (profileId, providerId, at, options = {}) => {
    const outcome = options.outcome ?? 'supported'
    const report: ChatUsageReport | null = outcome === 'supported' ? {
      source: 'pull', status: 'allowed', receivedAt: new Date(at).toISOString(),
      windows: [{ key: 'zai:time_limit', label: '5h', percentUsed: options.percent ?? 40, resetsAt: options.resetsAt ?? new Date(at + 5 * 60 * MIN).toISOString() }],
    } as ChatUsageReport : null
    const [id] = history.record({
      teams: [TEAM], providerId, accountAlias: `${providerId}@${providerId}.test`, accountScope: h.scopes[profileId] ?? 'unscoped',
      accountBasis: options.basis ?? 'routed', reason: 'worker', outcome, report, observedAt: new Date(at).toISOString(),
    })
    return id!
  }
  h.drain = () => h.advice.service.drain()
  h.close = () => {
    h.advice.shutdown()
    if (!root) return
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
  return h
}

/** The team's recommendations with every assessment, oldest first. */
export function recommendations(h: AdviceHarness) {
  return h.advice.store.list(TEAM, 200).reverse().map(rec => h.advice.store.get(TEAM, rec.id)!)
}
