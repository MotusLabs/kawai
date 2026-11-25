// @reads: openspec/changes/process-quota-history-and-incident-advice/design.md
// Table F (process-quota-history-and-incident-advice D3, bindings B7–B12):
// may a quota value establish routed headroom at a cutoff? Each row writes
// its history through the production path — a worker poll of the injected
// Z.AI endpoint, or an agent report recorded by ManagerQuota — reads it back
// from the store, and evaluates it with `headroomEvidence` at the cutoff. The
// row text is checked against design.md (V1). P4 runs after every row: no
// stored row or log line carries the credential or the body.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatUsageReport } from '../../shared/chat'
import { HEADROOM_FRESH_MS, headroomEvidence, type HeadroomEvidence, type HeadroomLimit } from '../metrics/observations/headroom'
import {
  BODY_MARKER, OTHER, QUOTA_TOKEN, QUOTA_TOKEN_B, ZAI, ZAI_B,
  serviceHarness, step, storedRows, sub, type ServiceHarness,
} from './helpers/quotaServiceHarness'

const DESIGN = path.join(import.meta.dir, '../../../openspec/changes/process-quota-history-and-incident-advice/design.md')
const MIN = 60_000

let h!: ServiceHarness
let live = false
afterEach(() => {
  if (!live) return
  live = false
  const haystack = [...storedRows(h), ...h.logs].join('\n')
  for (const secret of [QUOTA_TOKEN, QUOTA_TOKEN_B, BODY_MARKER]) expect(haystack).not.toContain(secret)
  h.close()
})

/** One worker poll of ZAI answered with `percent` (reset `resetMs`); returns its window's observation time. */
async function poll(percent = 40, resetMs?: number): Promise<number> {
  await h.reconcile([sub('team-a', ZAI)])
  await h.answerOldest(request => request.ok(percent, resetMs))
  await h.reconcile([])
  // The window's own observation time is the report's receipt (B11).
  return Date.parse(h.quota.history.list('team-a').at(-1)!.windows[0]!.observedAt)
}

function evidence(cutoff: number, options: { limits?: HeadroomLimit[]; scope?: string | null; providerId?: string } = {}): HeadroomEvidence {
  return headroomEvidence({
    providerId: options.providerId ?? 'zai',
    accountScope: options.scope === undefined ? h.quota.scopeOf(ZAI) : options.scope,
    cutoff,
    observations: h.quota.history.list('team-a'),
    limits: options.limits ?? [],
  })
}

function agentReport(at: number, windows: ChatUsageReport['windows'], status: ChatUsageReport['status'] = 'allowed'): ChatUsageReport {
  return { source: 'push', status, windows, receivedAt: new Date(at).toISOString() } as ChatUsageReport
}

interface Row { id: string; text: string; run: () => Promise<void> }

const ROWS: Row[] = [
  {
    id: 'F1', text: '| F1 | ≤ 10 min | no | no | routed provider | yes |',
    async run() {
      const at = await poll(40)
      // Exactly 10 minutes is fresh (B7); below 100% has room.
      const result = evidence(at + HEADROOM_FRESH_MS)
      expect(result).toMatchObject({ valid: true, reason: 'fresh', accountAlias: 'zai@zai.test' })
      expect(result.windows.map(w => [w.key, w.percentUsed, w.ageMs])).toEqual([['zai:time_limit', 40, HEADROOM_FRESH_MS], ['zai:unknown', 1, HEADROOM_FRESH_MS]])
      // 100% used shows no room.
      await step(MIN)
      const full = await poll(100)
      expect(evidence(full + MIN)).toMatchObject({ valid: false, reason: 'exhausted' })
      // B12: another or an unknown credential at the same provider@host never counts.
      expect(evidence(full + MIN, { scope: h.quota.scopeOf(ZAI_B) })).toMatchObject({ valid: false, reason: 'other-account' })
      expect(evidence(full + MIN, { scope: null })).toMatchObject({ valid: false, reason: 'other-account' })
    },
  },
  {
    id: 'F2', text: '| F2 | > 10 min | * | * | * | no (stale) |',
    async run() {
      const at = await poll(40)
      expect(evidence(at + HEADROOM_FRESH_MS + 1)).toMatchObject({ valid: false, reason: 'stale' })
    },
  },
  {
    id: 'F3', text: '| F3 | * | yes | * | * | no |',
    async run() {
      const reset = Date.now() + 5 * MIN
      const at = await poll(40, reset)
      // A reset at the cutoff has passed (B8); one before it has not.
      expect(evidence(reset)).toMatchObject({ valid: false, reason: 'reset-passed' })
      expect(evidence(reset - 1)).toMatchObject({ valid: true })
      expect(reset - at).toBeLessThan(HEADROOM_FRESH_MS)
    },
  },
  {
    id: 'F4', text: '| F4 | * | * | yes | * | no |',
    async run() {
      const at = await poll(40)
      // A final limit of the provider at or after the window vetoes it (ties veto).
      expect(evidence(at + MIN, { limits: [{ providerId: 'zai', at: new Date(at).toISOString(), final: true, window: null }] }))
        .toMatchObject({ valid: false, reason: 'later-failure' })
      // A model-scoped limit vetoes only the window with its key.
      expect(evidence(at + MIN, { limits: [{ providerId: 'zai', at: new Date(at + 1).toISOString(), final: true, window: 'seven_day_opus' }] }))
        .toMatchObject({ valid: true })
      // Another provider's limit, a non-final limit, or one after the cutoff never vetoes.
      expect(evidence(at + MIN, { limits: [
        { providerId: 'other', at: new Date(at + 1).toISOString(), final: true, window: null },
        { providerId: 'zai', at: new Date(at + 1).toISOString(), final: false, window: null },
        { providerId: 'zai', at: new Date(at + 2 * MIN).toISOString(), final: true, window: null },
      ] })).toMatchObject({ valid: true })
      // Another account's failure never vetoes.
      h.auto = request => request.fail()
      await h.reconcile([sub('team-a', OTHER)])
      await h.reconcile([])
      expect(evidence(at + 2 * MIN)).toMatchObject({ valid: true })
      // A failed poll of the same account after the window vetoes it, whatever its credential (alias-wide, B9/B12).
      await step(MIN)
      await h.reconcile([sub('team-a', ZAI_B)])
      await h.reconcile([])
      expect(evidence(at + 3 * MIN)).toMatchObject({ valid: false, reason: 'later-failure' })
    },
  },
  {
    id: 'F5', text: '| F5 | * | * | * | unrelated host login | no |',
    async run() {
      const at = Date.now()
      h.quota.recordAgentReport('team-a', { providerId: 'zai', baseUrl: ZAI.baseUrl }, 'host-login',
        agentReport(at, [{ key: 'five_hour', label: '5h', percentUsed: 10, resetsAt: null }]))
      expect(h.quota.history.list('team-a')).toHaveLength(1)
      expect(evidence(at + MIN)).toMatchObject({ valid: false, reason: 'host-login' })
      // Its source stays recorded (B10).
      expect(h.quota.history.list('team-a')[0]).toMatchObject({ accountBasis: 'host-login', reason: 'agent', source: 'push' })
    },
  },
  {
    id: 'F6', text: '| F6 | status-only push, windows 20 min old | no | no | routed | no (window age kept) |',
    async run() {
      const target = { providerId: 'zai', baseUrl: ZAI.baseUrl, token: QUOTA_TOKEN }
      const at = Date.now()
      h.quota.recordAgentReport('team-a', target, 'routed', agentReport(at, [{ key: 'five_hour', label: '5h', percentUsed: 10, resetsAt: null }]))
      await step(19 * MIN)
      h.quota.recordAgentReport('team-a', target, 'routed', agentReport(Date.now(), [], 'warning'))
      const rows = h.quota.history.list('team-a')
      expect(rows.map(row => row.windows.length)).toEqual([1, 0])
      const result = evidence(at + 20 * MIN, { scope: h.quota.scopeOf(target) })
      expect(result).toMatchObject({ valid: false, reason: 'stale', observationId: rows[0]!.id })
      expect(result.windows[0]!.ageMs).toBe(20 * MIN)
    },
  },
]

describe('Table F through quota history', () => {
  test('the rows are Table F verbatim', () => {
    const design = fs.readFileSync(DESIGN, 'utf8')
    expect(ROWS.map(row => row.text)).toEqual(design.split('\n').filter(line => /^\| F\d+ \|/.test(line)))
  })

  test('F1: yes', () => runRow('F1'))
  test('F2: no (stale)', () => runRow('F2'))
  test('F3: no', () => runRow('F3'))
  test('F4: no', () => runRow('F4'))
  test('F5: no', () => runRow('F5'))
  test('F6: no (window age kept)', () => runRow('F6'))
})

async function runRow(id: string): Promise<void> {
  h = serviceHarness()
  live = true
  await ROWS.find(row => row.id === id)!.run()
}
