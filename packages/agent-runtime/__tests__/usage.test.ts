// @reads: packages/agent-runtime/__tests__/fixtures/**
// I7 over seeded streams (tasks 5.2/5.3; R01-R06/R08): results, counts,
// window and wait facts belong only to their actual identity, and unknown
// stays unknown. Both providers' production session, parsers and reducers
// run unchanged: Claude on the controlled query (the session core with only
// the SDK's query() replaced; claudeUsageFacts.test.ts covers the same facts
// through the default fake CLI), Codex through the production transport and
// session with the fake app-server served in-process behind the private
// spawn seam (inProcessCodex.ts; codexUsageFacts.test.ts keeps the owned
// process as the witness of the same guards). Each stream interleaves turns, idle
// and in-turn quota pushes, limit and non-limit retries, progress frames,
// subagent and foreign-turn frames, tool and boundary ids reused across
// turns, repeated token updates, Claude requests replayed by their native
// id (in their own turn or a later one), results with and without usage,
// and failed turns. The reference models (oracles/usageModels.ts) are told only what
// was sent; after the stop every result, the limit/wait signal sequence
// (with each wait-end's waitId naming its start) and the quota reports must
// equal theirs. The streams live in helpers/usageStreams.ts (I8 reuses them).
import { afterEach, describe, expect, test } from 'bun:test'
import type { QuotaReport } from '../src/usage/types.js'
import { driver } from './helpers/claudeDriverHarness.js'
import { codexDriver, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'
import { claudeStream, codexStream, exercised } from './helpers/usageStreams.js'

afterEach(stopDrivers)

const SHARED_CLASSES = ['failure', 'start', 'end:resumed', 'end:cancelled', 'quota:push', 'outcome:success', 'outcome:failed', 'usage:null', 'usage:known', 'tools:several', 'compaction', 'push-in-wait-unresumed']
const CLAUDE_CLASSES = [...SHARED_CLASSES, 'cost:known', 'model:null', 'usage:partial', 'delta-of-earlier-turn-request', 'replay-of-earlier-turn-request', 'usage:partial-after-earlier-turn-replay']
const CODEX_CLASSES = [...SHARED_CLASSES, 'quota:report', 'replay-in-wait-unresumed']
const claudeSeen: Set<string>[] = []
const codexSeen: Set<string>[] = []

describe('I7: facts belong only to their actual identity; unknown stays unknown', () => {
  // 0xA607, 300 streams per provider (mulberry32), in slices so each test stays within its timeout.
  for (let slice = 0; slice < 6; slice++) {
    test(`Claude: results, counts, waits and quota reports match the reference (streams ${slice * 50}-${slice * 50 + 49})`, async () => {
      const failures: string[] = []
      const seen = new Set<string>()
      for (let i = slice * 50; i < slice * 50 + 50; i++) {
        const run = await claudeStream(0xa607 + i * 7919)
        exercised(run.model, seen)
        const violations = run.violations
        if (violations.length > 0) failures.push(`stream ${i}: ${violations.join('; ')}`)
      }
      expect(failures).toEqual([])
      claudeSeen.push(seen)
    })
  }
  for (let slice = 0; slice < 15; slice++) {
    test(`Codex: results, counts, waits and quota reports match the reference (streams ${slice * 20}-${slice * 20 + 19})`, async () => {
      const failures: string[] = []
      const seen = new Set<string>()
      for (let i = slice * 20; i < slice * 20 + 20; i++) {
        const run = await codexStream(0xa607 + i * 7919)
        exercised(run.model, seen)
        const violations = run.violations
        if (violations.length > 0) failures.push(`stream ${i}: ${violations.join('; ')}`)
      }
      expect(failures).toEqual([])
      codexSeen.push(seen)
    })
  }
  test('each provider\'s 300 streams exercised every fact class', () => {
    const claude = new Set(claudeSeen.flatMap((set) => [...set]))
    const codex = new Set(codexSeen.flatMap((set) => [...set]))
    expect([claudeSeen.length, codexSeen.length]).toEqual([6, 15])
    expect(CLAUDE_CLASSES.filter((c) => !claude.has(c))).toEqual([])
    expect(CODEX_CLASSES.filter((c) => !codex.has(c))).toEqual([])
  })
})

describe('quota updates while idle', () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const reset = Math.floor(Date.now() / 1000) + 3600
  const facts = (quotas: QuotaReport[]) => quotas.map((q) => [q.status, q.source, q.accountScope, q.windows.map((w) => [w.key, w.percentUsed, w.resetsAt])])

  // @covers: agent-runtime › Usage and quota reports remain observable › Idle quota update
  test('Claude: a rate-limit push while idle reaches onQuotaReport with its window and opens no turn', async () => {
    const quotas: QuotaReport[] = []
    const f = driver({ resume: null, observers: { onQuotaReport: (q) => void quotas.push(q) } })
    const start = f.d.start()
    while (f.queries.length === 0) await tick()
    f.q().ready()
    await start
    f.q().push({ type: 'rate_limit_event', uuid: 'idle-push', session_id: 'sess-1', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day', utilization: 1 } } as never)
    await f.q().drain()
    expect(facts(quotas)).toEqual([['limited', 'push', 'session', [['seven_day', 100, new Date(reset * 1000).toISOString()]]]])
    expect([f.d.state, f.events.filter((e) => e.type === 'turn_started').length]).toEqual(['idle', 0])
    await f.d.kill()
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Idle quota update
  test('Codex: the rate-limit read answered while idle reaches onQuotaReport with its windows and opens no turn', async () => {
    const quotas: QuotaReport[] = []
    const snapshot = { limitId: null, limitName: null, primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: reset }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: reset + 60 }, credits: null, planType: null, rateLimitReachedType: null }
    const h = codexDriver({ env: { FAKE_CODEX_RATELIMITS: JSON.stringify(snapshot) }, callbacks: { onQuotaReport: (q) => void quotas.push(q) } })
    await h.driver.start()
    await waitFor(() => quotas.length > 0)
    expect(facts(quotas)).toEqual([['allowed', 'report', 'session', [['codex:primary', 42, new Date(reset * 1000).toISOString()], ['codex:secondary', 7, new Date((reset + 60) * 1000).toISOString()]]]])
    expect([h.driver.state, h.events.filter((e) => e.type === 'turn_started').length, h.results.length]).toEqual(['idle', 0, 0])
  })
})
