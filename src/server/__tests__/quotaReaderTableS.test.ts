// @reads: openspec/changes/process-quota-history-and-incident-advice/design.md
// Table S (process-quota-history-and-incident-advice D2, bindings B1–B6) at
// the service seam: the production ManagerQuota and reader service over a
// fresh database, reading through the production Z.AI pull with an injected
// fetch and fake clock. Each row runs as written in design.md; the row text
// below is checked against the design so the table stays verbatim (V1). P4
// (no stored row or log line holds the credential or the body) runs after
// every row. Composition rows (a real ChatSessionManager) live in
// quotaReaderComposition.test.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { QUOTA_TIMEOUT_MS } from '../chat/quota/QuotaReaderService'
import {
  BODY_MARKER, CADENCE_MS, HOST_ONLY, QUOTA_TOKEN, QUOTA_TOKEN_B, ROUTER, ZAI, ZAI_B,
  flush, serviceHarness, step, storedRows, sub, type ServiceHarness,
} from './helpers/quotaServiceHarness'

const DESIGN = path.join(import.meta.dir, '../../../openspec/changes/process-quota-history-and-incident-advice/design.md')

let h!: ServiceHarness
let live = false
afterEach(() => {
  if (!live) return
  live = false
  // P4 over every row: nothing stored or logged carries the credential or the body.
  const haystack = [...storedRows(h), ...h.logs].join('\n')
  for (const secret of [QUOTA_TOKEN, QUOTA_TOKEN_B, BODY_MARKER]) expect(haystack).not.toContain(secret)
  h.close()
})

const MIN = 60_000

interface Row {
  id: string
  text: string
  run: () => Promise<void>
}

const ROWS: Row[] = [
  {
    id: 'S1', text: '| S1 | none→worker | standalone | no | subscribe | one request now; timer armed |',
    async run() {
      await h.reconcile([sub('team-a', ZAI)])
      expect(h.requests).toHaveLength(1)
      expect(h.requests[0]!.auth).toBe(QUOTA_TOKEN)
      await h.answerOldest(request => request.ok())
      expect(h.quota.service.workerArmed(ZAI)).toBe(true)
      expect(h.settlements.map(s => [s.reason, s.outcome, s.teams])).toEqual([['worker', 'supported', ['team-a']]])
    },
  },
  {
    id: 'S2', text: '| S2 | worker | standalone | no | tick | one request; next at cadence ± jitter |',
    async run() {
      // Jitter draw 0 → the cadence minus 10%; draw 0.99 → plus 9.8%.
      h.random = 0
      h.auto = request => request.ok()
      await h.reconcile([sub('team-a', ZAI)])
      await step(CADENCE_MS * 0.9 - 1_000)
      expect(h.requests).toHaveLength(1)
      h.random = 0.99
      await step(1_000)
      expect(h.requests).toHaveLength(2)
      await step(CADENCE_MS * 0.9)
      expect(h.requests).toHaveLength(2)
      await step(Math.round(CADENCE_MS * 0.198) + 1_000)
      expect(h.requests).toHaveLength(3)
    },
  },
  {
    id: 'S3', text: '| S3 | worker | standalone | yes | tick | no new request |',
    async run() {
      h.auto = request => request.ok()
      await h.reconcile([sub('team-a', ZAI)])
      h.auto = null
      // A spawn pull for the same key is in flight when the worker tick comes.
      await step(CADENCE_MS - 2_000)
      void h.quota.service.request(ZAI)
      await flush()
      expect(h.requests).toHaveLength(2)
      await step(5_000)
      expect(h.requests).toHaveLength(2)
      expect(h.open(ZAI)).toHaveLength(1)
    },
  },
  {
    id: 'S4', text: '| S4 | worker | standalone | yes | timeout (10 s) | request abandoned; failure counted; backoff |',
    async run() {
      await h.reconcile([sub('team-a', ZAI)])
      const held = h.requests[0]!
      await step(QUOTA_TIMEOUT_MS)
      // The transport is aborted at the bound; the settlement records a failure.
      expect(held.signal.aborted).toBe(true)
      expect(h.settlements.map(s => s.outcome)).toEqual(['failed'])
      expect(h.quota.service.inFlightFor(ZAI)).toBe(false)
      // First failure: backoff 1 minute, not the cadence.
      await step(MIN - 1_000)
      expect(h.requests).toHaveLength(1)
      await step(1_000)
      expect(h.requests).toHaveLength(2)
    },
  },
  {
    id: 'S5', text: '| S5 | worker | standalone | no | 3rd consecutive failure | next delay 4 min (bounded at 30) |',
    async run() {
      h.auto = request => request.fail()
      await h.reconcile([sub('team-a', ZAI)])
      // Failures 1, 2 → delays 1, 2 min; the 3rd failure → 4 min (B2, not jittered).
      await step(MIN)
      await step(2 * MIN)
      expect(h.requests).toHaveLength(3)
      await step(4 * MIN - 1_000)
      expect(h.requests).toHaveLength(3)
      await step(1_000)
      expect(h.requests).toHaveLength(4)
      // Failures 4, 5 → 8, 16 min; from the 6th on, 30 min.
      await step(8 * MIN)
      await step(16 * MIN)
      expect(h.requests).toHaveLength(6)
      await step(30 * MIN - 1_000)
      expect(h.requests).toHaveLength(6)
      await step(1_000)
      expect(h.requests).toHaveLength(7)
      await step(30 * MIN)
      expect(h.requests).toHaveLength(8)
      expect(h.settlements.every(s => s.outcome === 'failed')).toBe(true)
    },
  },
  {
    id: 'S6', text: '| S6 | worker | standalone | no | success after failures | backoff reset; windows replaced only if newer |',
    async run() {
      h.auto = request => request.fail()
      await h.reconcile([sub('team-a', ZAI)])
      await step(MIN)
      expect(h.requests).toHaveLength(2)
      h.auto = request => request.ok(55)
      await step(2 * MIN)
      expect(h.requests).toHaveLength(3)
      expect(h.usage.get('zai')?.windows[0]?.percentUsed).toBe(55)
      // Reset: the next delay is the cadence, not 4 minutes.
      await step(4 * MIN)
      expect(h.requests).toHaveLength(3)
      await step(CADENCE_MS - 4 * MIN)
      expect(h.requests).toHaveLength(4)
      // A newer report already held is never replaced by an older one.
      const held = h.usage.get('zai')!
      h.usage.record('zai', { ...held, receivedAt: new Date(Date.parse(held.receivedAt) - 1).toISOString(), windows: [{ ...held.windows[0]!, percentUsed: 1 }] })
      expect(h.usage.get('zai')?.windows[0]?.percentUsed).toBe(55)
    },
  },
  {
    id: 'S7', text: '| S7 | worker→none | standalone | * | unsubscribe | timer removed; no further request |',
    async run() {
      h.auto = request => request.ok()
      await h.reconcile([sub('team-a', ZAI)])
      await h.reconcile([])
      expect(h.quota.service.workerArmed(ZAI)).toBe(false)
      expect(h.quota.service.workerKeys()).toEqual([])
      await step(3 * CADENCE_MS)
      expect(h.requests).toHaveLength(1)
      // In flight at the unsubscribe: drained and recorded with its reason (B3).
      h.auto = null
      await h.reconcile([sub('team-a', ZAI)])
      expect(h.requests).toHaveLength(2)
      await h.reconcile([])
      await h.answerOldest(request => request.ok())
      expect(h.settlements.at(-1)).toMatchObject({ reason: 'worker', outcome: 'supported', teams: ['team-a'] })
      await step(3 * CADENCE_MS)
      expect(h.requests).toHaveLength(2)
    },
  },
  {
    id: 'S8', text: '| S8 | both→session | standalone | * | worker removed | cadence continues (session reason) |',
    async run() {
      h.auto = request => request.ok()
      h.live.set('zai', ZAI)
      h.quota.service.armSession('zai')
      await h.reconcile([sub('team-a', ZAI)])
      expect(h.requests).toHaveLength(1)
      // Both reasons: one request per cadence (the session cadence serves the key).
      await step(CADENCE_MS)
      expect(h.requests).toHaveLength(2)
      expect(h.settlements.at(-1)?.reason).toBe('both')
      await h.reconcile([])
      await step(CADENCE_MS)
      expect(h.requests).toHaveLength(3)
      expect(h.settlements.at(-1)?.reason).toBe('session')
      expect(h.sessionPulls).toHaveLength(2)
    },
  },
  {
    id: 'S9', text: '| S9 | worker | agent-only | no | subscribe | no request; one `unsupported` observation; no agent launched |',
    async run() {
      await h.reconcile([sub('team-a', HOST_ONLY), sub('team-a', ROUTER)])
      await h.reconcile([sub('team-a', HOST_ONLY), sub('team-a', ROUTER)])
      await step(2 * CADENCE_MS)
      expect(h.requests).toHaveLength(0)
      expect(h.settlements.map(s => [s.target.providerId, s.outcome])).toEqual([['hostonly', 'unsupported'], ['router', 'unsupported']])
      expect(h.quota.service.workerKeys()).toEqual([])
    },
  },
  {
    id: 'S10', text: '| S10 | session | agent-only | * | spawn pull | today\'s spawn pull unchanged |',
    async run() {
      // The service never polls a session target without a base URL; the SDK
      // spawn pull is the manager's own path (providerUsage session tests).
      h.live.set('hostonly', null)
      h.quota.service.armSession('hostonly')
      h.quota.service.refreshSession('hostonly')
      await step(2 * CADENCE_MS)
      expect(h.requests).toHaveLength(0)
      expect(h.settlements).toHaveLength(0)
    },
  },
  {
    id: 'S11', text: '| S11 | * | * | yes | shutdown | timer cancelled; in-flight result discarded, nothing published |',
    async run() {
      h.live.set('zai', ZAI)
      h.quota.service.armSession('zai')
      await h.reconcile([sub('team-a', ZAI)])
      expect(h.requests).toHaveLength(1)
      h.quota.shutdown()
      // Transport is not aborted (B4); its late answer publishes nothing.
      expect(h.requests[0]!.signal.aborted).toBe(false)
      await h.answerOldest(request => request.ok())
      await step(3 * CADENCE_MS)
      expect(h.requests).toHaveLength(1)
      expect(h.settlements).toHaveLength(0)
      expect(h.sessionPulls).toHaveLength(0)
      expect(h.usage.get('zai')).toBeNull()
      expect(storedRows(h)).toHaveLength(0)
    },
  },
  {
    id: 'S12', text: '| S12 | worker | standalone | no | restart | `UsageLimitStore` empty; one startup poll; history rows intact |',
    async run() {
      // The service seam: a fresh service over the same database. The manager
      // restart (a new ChatSessionManager) is in quotaReaderComposition.
      h.auto = request => request.ok()
      await h.reconcile([sub('team-a', ZAI)])
      expect(storedRows(h)).toHaveLength(1)
      let restartReads = 0
      h.quota.shutdown()
      const { ManagerQuota } = await import('../chat/quota/managerQuota')
      const { UsageLimitStore } = await import('../chat/usageLimits')
      const usage = new UsageLimitStore()
      const reborn = new ManagerQuota({
        db: h.db.db, cadenceMs: CADENCE_MS, read: async () => { restartReads += 1; return { ok: false, outcome: 'unreachable', reason: 'unreachable' } },
        sessionTarget: () => undefined, sessionTeams: () => [], onSessionPull: () => {}, publishWorkerReport: (p, r) => usage.record(p, r),
        configuredWorkers: () => [sub('team-a', ZAI)],
      })
      expect(usage.get('zai')).toBeNull()
      reborn.start()
      await flush()
      expect(restartReads).toBe(1)
      expect(storedRows(h)).toHaveLength(2)
      reborn.shutdown()
    },
  },
  {
    id: 'S13', text: '| S13 | worker (two teams, one key) | standalone | no | tick | one request; both teams\' histories get it |',
    async run() {
      h.auto = request => request.ok()
      await h.reconcile([sub('team-a', ZAI), sub('team-b', ZAI)])
      await step(CADENCE_MS)
      expect(h.requests).toHaveLength(2)
      expect(h.settlements.map(s => s.teams.sort())).toEqual([['team-a', 'team-b'], ['team-a', 'team-b']])
      const teams = h.db.db.prepare('SELECT team_id FROM process_quota_observations ORDER BY team_id').all() as Array<{ team_id: string }>
      expect(teams.map(row => row.team_id)).toEqual(['team-a', 'team-a', 'team-b', 'team-b'])
    },
  },
  {
    id: 'S14', text: '| S14 | worker | standalone | * | config change of credential | old key unsubscribed, new key polled once |',
    async run() {
      h.auto = request => request.ok()
      await h.reconcile([sub('team-a', ZAI)])
      await h.reconcile([sub('team-a', ZAI_B)])
      expect(h.requests.map(request => request.auth)).toEqual([QUOTA_TOKEN, QUOTA_TOKEN_B])
      expect(h.quota.service.workerArmed(ZAI)).toBe(false)
      expect(h.quota.service.workerArmed(ZAI_B)).toBe(true)
      await h.reconcile([sub('team-a', ZAI_B)])
      expect(h.requests).toHaveLength(2)
    },
  },
]

async function runRow(id: string): Promise<void> {
  h = serviceHarness()
  live = true
  await ROWS.find(row => row.id === id)!.run()
}

describe('Table S at the service seam', () => {
  test('the rows are Table S verbatim', () => {
    const design = fs.readFileSync(DESIGN, 'utf8')
    const table = design.split('\n').filter(line => /^\| S\d+ \|/.test(line))
    expect(ROWS.map(row => row.text)).toEqual(table)
  })

  test('S1: one request now; timer armed', () => runRow('S1'))
  test('S2: one request; next at cadence ± jitter', () => runRow('S2'))
  test('S3: no new request', () => runRow('S3'))
  test('S4: request abandoned; failure counted; backoff', () => runRow('S4'))
  // @covers: chat-usage-limits › Background quota observation is bounded and credential-safe › Failing reader backs off
  test('S5: next delay 4 min (bounded at 30)', () => runRow('S5'))
  test('S6: backoff reset; windows replaced only if newer', () => runRow('S6'))
  // @covers: chat-usage-limits › Background quota observation is bounded and credential-safe › Removing the last reason stops polling
  test('S7: timer removed; no further request', () => runRow('S7'))
  test('S8: cadence continues (session reason)', () => runRow('S8'))
  test('S9: no request; one `unsupported` observation; no agent launched', () => runRow('S9'))
  test('S10: today\'s spawn pull unchanged', () => runRow('S10'))
  test('S11: timer cancelled; in-flight result discarded, nothing published', () => runRow('S11'))
  test('S12: `UsageLimitStore` empty; one startup poll; history rows intact', () => runRow('S12'))
  // @covers: chat-usage-limits › Background quota observation is bounded and credential-safe › Shared account polled once
  test('S13: one request; both teams\' histories get it', () => runRow('S13'))
  test('S14: old key unsubscribed, new key polled once', () => runRow('S14'))
})

describe('background observation outcomes', () => {
  // @covers: chat-usage-limits › Background quota observation is bounded and credential-safe › Failing reader backs off
  test('failed refreshes after a success keep the held windows at their original observation time', async () => {
    h = serviceHarness()
    live = true
    h.auto = request => request.ok(30)
    await h.reconcile([sub('team-a', ZAI)])
    const held = h.usage.get('zai')!
    h.auto = request => request.fail()
    await step(CADENCE_MS * 1.1)
    await step(MIN)
    await step(2 * MIN)
    const rows = h.quota.history.list('team-a')
    expect(rows.map(row => row.outcome)).toEqual(['supported', 'failed', 'failed', 'failed'])
    expect(rows.slice(1).every(row => row.windows.length === 0)).toBe(true)
    expect(rows[0]!.windows[0]!.observedAt).toBe(held.receivedAt)
    expect(h.usage.get('zai')).toEqual(held)
  })

  // @covers: chat-usage-limits › Background quota observation is bounded and credential-safe › Refused credentials are not stored
  test('an authentication refusal records auth-refused without the body or the credential and starts nothing', async () => {
    h = serviceHarness()
    live = true
    h.auto = request => request.fail(401)
    await h.reconcile([sub('team-a', ZAI)])
    const rows = h.quota.history.list('team-a')
    expect(rows.map(row => [row.outcome, row.status, row.windows.length, row.source])).toEqual([['auth-refused', null, 0, 'none']])
    expect(h.usage.get('zai')).toBeNull()
    // Backs off as a failure (1 minute), and only the quota endpoint was called.
    await step(MIN)
    expect(h.requests.map(request => new URL(request.url).pathname)).toEqual([new URL(h.requests[0]!.url).pathname, new URL(h.requests[0]!.url).pathname])
    expect(h.requests.every(request => request.url.startsWith('https://zai.test/'))).toBe(true)
  })
})
