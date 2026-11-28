// Table S equivalence classes (process-quota-history-and-incident-advice
// D2, decision-ed5e5e77): the executable evidence for the reachable classes
// of the Table S completeness test (quotaReaderTableSCompleteness.test.ts)
// that no literal row S1–S14 already exercises — the B3 drain, a joined
// request, a second team, agent-only lifecycle, session-reason failures, a
// late answer to an abandoned request, a partial unsubscribe, a restart
// without workers and a credential change on a busy key. Production
// ManagerQuota and reader service over a fresh database, injected fetch and
// fake clock; P4 after every case.
import { afterEach, expect, jest, test } from 'bun:test'
import { QUOTA_TIMEOUT_MS, QuotaReaderService, type QuotaPull, type QuotaSettlement } from '../chat/quota/QuotaReaderService'
import {
  BODY_MARKER, CADENCE_MS, HOST_ONLY, QUOTA_TOKEN, QUOTA_TOKEN_B, ZAI, ZAI_B,
  serviceHarness, step, liveTrace, storedRows, sub, type ServiceHarness,
} from './helpers/quotaServiceHarness'

const MIN = 60_000
let h: ServiceHarness | null = null

afterEach(() => {
  if (!h) return
  const haystack = [...storedRows(h), ...h.logs].join('\n')
  for (const secret of [QUOTA_TOKEN, QUOTA_TOKEN_B, BODY_MARKER]) expect(haystack).not.toContain(secret)
  // The live trace keeps compatible wire labels but never a credential.
  const liveText = liveTrace(h).join('\n')
  for (const secret of [QUOTA_TOKEN, QUOTA_TOKEN_B]) expect(liveText).not.toContain(secret)
  h.close()
  h = null
})

function harness(): ServiceHarness {
  h = serviceHarness()
  return h
}

test('subscribe during a drained request joins it, then arms the timer', async () => {
  const h = harness()
  await h.reconcile([sub('team-a', ZAI)])
  await h.reconcile([])
  // None + standalone + in flight (the B3 drain): the new subscription joins it (B1 under P1).
  await h.reconcile([sub('team-a', ZAI)])
  expect(h.requests).toHaveLength(1)
  await h.answerOldest(request => request.ok())
  expect(h.settlements).toHaveLength(1)
  expect(h.quota.service.workerArmed(ZAI)).toBe(true)
  await step(CADENCE_MS)
  expect(h.requests).toHaveLength(2)
})

test('a new worker key a same-key session cadence holds polls once, joining a request in flight, then the session cadence serves it', async () => {
  const h = harness()
  h.live.set('zai', ZAI)
  h.quota.service.armSession('zai')
  // Busy: a session tick's request is in flight; the worker subscription joins it.
  h.quota.service.refreshSession('zai')
  await h.reconcile([sub('team-a', ZAI)])
  expect(h.requests).toHaveLength(1)
  await h.answerOldest(request => request.ok())
  expect(h.settlements[0]!.teams.sort()).toEqual(['team-a', 'team-live'])
  // Idle: a new worker key polls now (B1), then the session cadence serves it (B6).
  await h.reconcile([])
  h.auto = request => request.ok()
  await h.reconcile([sub('team-a', ZAI)])
  expect(h.requests).toHaveLength(2)
  await step(CADENCE_MS + 2_000)
  expect(h.requests).toHaveLength(3)
  expect(h.settlements.at(-1)?.reason).toBe('both')
})

test('a second team subscribing while a request is in flight is added to that settlement', async () => {
  const h = harness()
  await h.reconcile([sub('team-a', ZAI)])
  await h.reconcile([sub('team-a', ZAI), sub('team-b', ZAI)])
  expect(h.requests).toHaveLength(1)
  await h.answerOldest(request => request.ok())
  expect(h.settlements[0]!.teams.sort()).toEqual(['team-a', 'team-b'])
})

test('agent-only lifecycle: each team, a removal and re-add, a restart and a configuration change record one unsupported observation; nothing is requested', async () => {
  const h = harness()
  const count = () => h.settlements.filter(s => s.outcome === 'unsupported').length
  await h.reconcile([sub('team-a', HOST_ONLY)])
  expect(count()).toBe(1)
  await h.reconcile([sub('team-a', HOST_ONLY), sub('team-b', HOST_ONLY)])
  expect(count()).toBe(2)
  await h.reconcile([sub('team-a', HOST_ONLY), sub('team-b', HOST_ONLY)])
  expect(count()).toBe(2)
  await h.reconcile([sub('team-b', HOST_ONLY)])
  await h.reconcile([sub('team-a', HOST_ONLY), sub('team-b', HOST_ONLY)])
  expect(count()).toBe(3)
  // A restart is a new process: each configuration reports once more.
  const before = h.settlements.length
  h.restart()
  await step(1_000)
  expect(h.settlements.slice(before).filter(s => s.outcome === 'unsupported')).toHaveLength(2)
  expect(storedRows(h).filter(row => row.includes('"unsupported"'))).toHaveLength(5)
  // A changed configuration is a new key: reported once for its team.
  await h.reconcile([sub('team-a', { ...HOST_ONLY, token: 'rotated-host-token' })])
  expect(storedRows(h).filter(row => row.includes('"unsupported"'))).toHaveLength(6)
  await step(2 * CADENCE_MS)
  expect(h.requests).toHaveLength(0)
})

test('a session-reason request abandoned at the bound keeps the fixed cadence with no backoff', async () => {
  const h = harness()
  h.live.set('zai', ZAI)
  h.quota.service.armSession('zai')
  h.quota.service.refreshSession('zai')
  expect(h.requests).toHaveLength(1)
  await step(QUOTA_TIMEOUT_MS)
  expect(h.settlements.map(s => [s.reason, s.outcome])).toEqual([['session', 'failed']])
  // No 1-minute backoff: the next request is the cadence tick.
  await step(2 * MIN)
  expect(h.requests).toHaveLength(1)
  h.auto = request => request.ok()
  await step(CADENCE_MS - QUOTA_TIMEOUT_MS - 2 * MIN + 1_000)
  expect(h.requests).toHaveLength(2)
})

test('a drained request that times out is recorded as a failure with its original reason and schedules nothing', async () => {
  const h = harness()
  await h.reconcile([sub('team-a', ZAI)])
  await h.reconcile([])
  await step(QUOTA_TIMEOUT_MS)
  expect(h.settlements.map(s => [s.reason, s.outcome, s.teams])).toEqual([['worker', 'failed', ['team-a']]])
  await step(3 * CADENCE_MS)
  expect(h.requests).toHaveLength(1)
})

test('a late answer to an abandoned request is dropped while the current request settles normally', async () => {
  // A read that ignores its bound (the service's own race decides, S4).
  jest.useFakeTimers()
  try {
    const reads: Array<(pull: QuotaPull) => void> = []
    const settled: QuotaSettlement[] = []
    const service = new QuotaReaderService({
      read: () => new Promise(resolve => reads.push(resolve)), cadenceMs: CADENCE_MS, random: () => 0.5,
      sessionTarget: () => undefined, sessionTeams: () => [], onSessionPull: () => {}, onSettled: s => settled.push(s),
    })
    const ok = (percentUsed: number): QuotaPull => ({ ok: true, report: { status: 'allowed', source: 'provider', receivedAt: new Date().toISOString(), windows: [{ key: 'zai:time_limit', label: 'Tool calls', percentUsed, resetsAt: null }] } })
    service.reconcileWorkers([sub('team-a', ZAI)])
    await step(QUOTA_TIMEOUT_MS)
    expect(settled.map(s => s.outcome)).toEqual(['failed'])
    await step(MIN)
    expect(reads).toHaveLength(2)
    // The abandoned attempt answers while the current one is in flight: dropped.
    reads[0]!(ok(12))
    await step(1_000)
    expect(settled).toHaveLength(1)
    expect(service.inFlightFor(ZAI)).toBe(true)
    reads[1]!(ok(40))
    await step(1_000)
    expect(settled.map(s => s.outcome)).toEqual(['failed', 'supported'])
    expect(settled[1]!.pull).toMatchObject({ ok: true, report: { windows: [{ percentUsed: 40 }] } })
    service.shutdown()
  } finally {
    jest.useRealTimers()
  }
})

test('removing one of two teams keeps polling the key for the other team only', async () => {
  const h = harness()
  h.auto = request => request.ok()
  await h.reconcile([sub('team-a', ZAI), sub('team-b', ZAI)])
  await h.reconcile([sub('team-b', ZAI)])
  expect(h.requests).toHaveLength(1)
  await step(CADENCE_MS)
  expect(h.requests).toHaveLength(2)
  expect(h.settlements.at(-1)!.teams).toEqual(['team-b'])
})

test('a restart with no configured worker polls nothing and keeps history', async () => {
  const h = harness()
  h.auto = request => request.ok()
  await h.reconcile([sub('team-a', ZAI)])
  expect(storedRows(h)).toHaveLength(1)
  h.desired = []
  h.restart()
  await step(2 * CADENCE_MS)
  expect(h.requests).toHaveLength(1)
  expect(storedRows(h)).toHaveLength(1)
  expect(h.usage.get('zai')).toBeNull()
})

test('a credential change during an old-key request polls the new key once and the old settlement keeps its identity', async () => {
  const h = harness()
  await h.reconcile([sub('team-a', ZAI)])
  await h.reconcile([sub('team-a', ZAI_B)])
  expect(h.requests.map(request => request.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN_B])
  h.requests[1]!.ok(40)
  await step(1_000)
  h.requests[0]!.ok(12)
  await step(1_000)
  expect(h.settlements.map(s => [s.target.token === QUOTA_TOKEN_B ? 'K2' : 'K1', s.outcome])).toEqual([['K2', 'supported'], ['K1', 'supported']])
  // The retired key's answer is history under its own scope, never the live report (B5).
  expect(new Set(storedRows(h).map(row => JSON.parse(row).account_scope)).size).toBe(2)
  expect(h.usage.get('zai')?.windows[0]?.percentUsed).toBe(40)
})
