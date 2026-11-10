// Codex usage, quota and limit-wait facts through the public factory and the
// owned fake app-server over stdio (tasks 5.2/5.3). The fake's `/script`
// turn sends exactly the notifications a test names, so each expected value
// is computed from those records, not read back from the driver.
// - Tokens: a turn's requests are the differences between the generation's
//   consecutive thread totals; a first update or a reset total counts its
//   `last`; a counter missing from the previous total is null, never the
//   whole running total. A turn with no update has usage null.
// - A successor turn reusing a tool item id has its own call and count.
// - Waits: a retrying limit error opens one wait; it ends resumed only on a
//   later item, delta or token update of that turn (or its success); a quota
//   push or an elapsed reset never ends it; a failed or interrupted turn and
//   a stop end it cancelled, an unexpected exit process-ended.
// - The one account/rateLimits/read is a `report` of the session's login;
//   a refused or unanswered read reports nothing and fails nothing.
// - An out-of-range reset epoch is unknown (null), never a thrown settlement.
import { afterEach, describe, expect, test } from 'bun:test'
import type { LimitEvent, QuotaReport } from '../src/usage/types.js'
import { codexDriver, sent, stopDrivers, waitFor, type HarnessOptions } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

type Note = { method: string; params?: Record<string, unknown> }
const script = (notes: Note[], end?: string) => `/script ${JSON.stringify({ notes, ...(end ? { end } : {}) })}`
const tokens = (total: Record<string, number> | null, last: Record<string, number> | null, window = 1000): Note => ({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total, last, modelContextWindow: window } } })
const retry = (info = 'rateLimitExceeded'): Note => ({ method: 'error', params: { willRetry: true, error: { message: 'retrying', codexErrorInfo: info, additionalDetails: null } } })
const delta = (text = 'hi'): Note => ({ method: 'item/agentMessage/delta', params: { itemId: 'm-delta', delta: text } })
const command = (id: string): Note[] => {
  const item = { type: 'commandExecution', id, command: 'ls', cwd: '/', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }
  return [{ method: 'item/started', params: { item } }, { method: 'item/completed', params: { item } }]
}
const snapshot = (usedPercent: number, resetsAt: number, reached: string | null = null) => ({ limitId: null, limitName: null, primary: { usedPercent, windowDurationMins: 300, resetsAt }, secondary: null, credits: null, planType: null, rateLimitReachedType: reached })

function recorded(options: HarnessOptions = {}) {
  const limits: LimitEvent[] = []
  const quotas: QuotaReport[] = []
  const h = codexDriver({ ...options, callbacks: { onLimitEvent: (e) => void limits.push(e), onQuotaReport: (q) => void quotas.push(q), ...options.callbacks } })
  return { ...h, limits, quotas, waits: () => limits.filter((e) => e.type !== 'failure') }
}

/** The usage a request breakdown names (Codex input includes the cached part). */
const usageOf = (b: { inputTokens: number; cachedInputTokens: number; outputTokens: number }) => ({ inputTokens: b.inputTokens - b.cachedInputTokens, outputTokens: b.outputTokens, cacheReadTokens: b.cachedInputTokens, cacheCreationTokens: null })

describe('Codex per-turn token, tool and compaction facts', () => {
  test('requests are the differences between totals; a reset counts last; a missing previous counter is null; no update is null', async () => {
    const h = recorded()
    await h.driver.start()
    const t1 = { totalTokens: 150, inputTokens: 100, cachedInputTokens: 40, outputTokens: 50 }
    const l1 = t1
    const t2 = { totalTokens: 400, inputTokens: 300, cachedInputTokens: 90, outputTokens: 100 }
    const first = await (await h.driver.send(script([tokens(t1, l1), tokens(t2, { totalTokens: 250, inputTokens: 200, cachedInputTokens: 50, outputTokens: 50 }), tokens(t2, null)]))).result
    // first update: its last; second: t2 - t1; the repeated total adds nothing.
    const d = { inputTokens: t2.inputTokens - t1.inputTokens, cachedInputTokens: t2.cachedInputTokens - t1.cachedInputTokens, outputTokens: t2.outputTokens - t1.outputTokens }
    const a = usageOf(l1)
    const b = usageOf(d)
    expect(first.usage).toEqual({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: null })

    // A total that went down is a reset: its own last counts, not a negative or zero difference.
    const l3 = { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 }
    const reset = await (await h.driver.send(script([tokens({ totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 }, l3)]))).result
    expect(reset.usage).toEqual(usageOf(l3))

    // The previous total lacks cachedInputTokens: that counter is unknown, not the running total.
    await (await h.driver.send(script([tokens({ totalTokens: 60, inputTokens: 40, outputTokens: 20 }, { totalTokens: 30, inputTokens: 20, outputTokens: 10 })]))).result
    const partial = await (await h.driver.send(script([tokens({ totalTokens: 90, inputTokens: 60, cachedInputTokens: 30, outputTokens: 30 }, { totalTokens: 30, inputTokens: 20, cachedInputTokens: 30, outputTokens: 10 })]))).result
    expect(partial.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: null, cacheCreationTokens: null })

    const none = await (await h.driver.send(script([]))).result
    expect(none.usage).toBeNull()
  })

  test('a successor turn that reuses a tool or compaction item id has its own event and count', async () => {
    const h = recorded()
    await h.driver.start()
    const compaction: Note = { method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'cmp-x' } } }
    const one = await (await h.driver.send(script([...command('cmd-x'), ...command('cmd-x'), compaction, compaction]))).result
    const two = await (await h.driver.send(script([...command('cmd-x'), compaction]))).result
    expect([one.toolCallCount, one.compactionCount, two.toolCallCount, two.compactionCount]).toEqual([1, 1, 1, 1])
    const calls = h.events.filter((e) => e.type === 'tool_call').map((e) => e.turnId)
    expect(calls).toEqual([one.turnId, two.turnId])
    expect(h.events.filter((e) => e.type === 'notice').length).toBe(2)
  })
})

describe('Codex limit waits', () => {
  test('a retried limit opens one wait per turn that ends resumed only at the turn\'s next progress', async () => {
    const h = recorded()
    await h.driver.start()
    const push: Note = { method: 'account/rateLimits/updated', params: { rateLimits: snapshot(100, Math.floor(Date.now() / 1000) - 60, 'rateLimitReached') } }
    const handle = await h.driver.send(script([retry(), push, retry(), delta()]))
    await handle.result
    const [start, end, ...rest] = h.waits()
    expect(rest).toEqual([])
    expect(start).toMatchObject({ type: 'wait-start', turnId: handle.turnId })
    expect(end).toEqual({ type: 'wait-end', waitId: (start as { waitId: string }).waitId, cause: 'resumed' })
    // The quota push between the retries changed no wait; both retries are non-final failures.
    expect(h.limits.filter((e) => e.type === 'failure').map((e) => (e as { final: boolean }).final)).toEqual([false, false])
    expect(h.limits.map((e) => e.type)).toEqual(['failure', 'wait-start', 'failure', 'wait-end'])
  })

  test('a failed turn ends its wait cancelled after the final limit; a quota push with a past reset does not resume it', async () => {
    const h = recorded()
    await h.driver.start()
    const past = Math.floor(Date.now() / 1000) - 3600
    const handle = await h.driver.send(script([retry('usageLimitExceeded'), { method: 'account/rateLimits/updated', params: { rateLimits: snapshot(100, past, 'rateLimitReached') } }], 'failed:"usageLimitExceeded"'))
    const result = await handle.result
    expect(result.outcome).toBe('failed')
    expect(h.limits.map((e) => [e.type, e.type === 'failure' ? e.final : e.type === 'wait-end' ? e.cause : e.turnId])).toEqual([
      ['failure', false], ['wait-start', handle.turnId], ['failure', true], ['wait-end', 'cancelled'],
    ])
  })

  test('an interrupt and a stop end open waits cancelled; an unexpected exit ends it process-ended', async () => {
    const h = recorded()
    await h.driver.start()
    const held = await h.driver.send(script([retry()], 'hold'))
    await waitFor(() => h.waits().length === 1)
    await h.driver.interrupt()
    expect((await held.result).outcome).toBe('interrupted')
    const exited = await h.driver.send(script([retry()], 'exit:7'))
    expect((await exited.result).outcome).toBe('process-ended')
    expect(h.waits().map((e) => (e.type === 'wait-end' ? e.cause : e.turnId))).toEqual([held.turnId, 'cancelled', exited.turnId, 'process-ended'])

    const s = recorded()
    await s.driver.start()
    const open = await s.driver.send(script([retry()], 'hold'))
    await waitFor(() => s.waits().length === 1)
    await s.driver.kill()
    expect((await open.result).outcome).toBe('interrupted')
    expect(s.waits().map((e) => (e.type === 'wait-end' ? e.cause : e.turnId))).toEqual([open.turnId, 'cancelled'])
  })

  test('a non-limit retry opens no wait', async () => {
    const h = recorded()
    await h.driver.start()
    await (await h.driver.send(script([retry('other'), delta()]))).result
    expect(h.limits).toEqual([])
  })
})

describe('Codex quota sources', () => {
  test('the one rate-limit read is a session-scoped report, asked once per driver', async () => {
    const reset = 1900000000
    const h = recorded({ env: { FAKE_CODEX_RATELIMITS: JSON.stringify(snapshot(42, reset)) } })
    await h.driver.start()
    await (await h.driver.send('one')).result
    await waitFor(() => h.quotas.length > 0)
    await (await h.driver.send('two')).result
    expect(sent(h.root, 'account/rateLimits/read')).toHaveLength(1)
    expect(h.quotas).toEqual([expect.objectContaining({ status: 'allowed', source: 'report', accountScope: 'session', windows: [{ key: 'codex:primary', label: '5-hour', percentUsed: 42, resetsAt: new Date(reset * 1000).toISOString(), periodMs: 300 * 60_000 }] })])
    await h.driver.shutdown()
  })

  for (const mode of ['fail', 'hold', undefined]) {
    test(`a ${mode ?? 'missing'} read reports nothing and the stop reports no failure`, async () => {
      const h = recorded(mode ? { env: { FAKE_CODEX_RATELIMITS: mode } } : {})
      await h.driver.start()
      await (await h.driver.send('one')).result
      await waitFor(() => sent(h.root, 'account/rateLimits/read').length === 1)
      expect(h.quotas).toEqual([])
      expect((await h.driver.shutdown()).processes.length).toBeGreaterThan(0)
    })
  }

  test('an out-of-range reset epoch is unknown and the turn still settles', async () => {
    const h = recorded()
    await h.driver.start()
    const huge = { limitId: null, limitName: null, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1e300 }, secondary: { usedPercent: 250, windowDurationMins: 60, resetsAt: 1 }, credits: null, planType: null, rateLimitReachedType: 'rateLimitReached' }
    const result = await (await h.driver.send(script([{ method: 'account/rateLimits/updated', params: { rateLimits: huge } }, retry()]))).result
    expect(result.outcome).toBe('success')
    // The out-of-range percent drops its window; the huge epoch is a null reset.
    expect(h.quotas.map((q) => q.windows)).toEqual([[{ key: 'codex:primary', label: '5-hour', percentUsed: 100, resetsAt: null, periodMs: 300 * 60_000 }]])
    expect(h.limits[0]).toMatchObject({ type: 'failure', resetsAt: null })
  })
})
