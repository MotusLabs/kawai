// The caller's Codex quota-read claim (CodexDriverOptions.claimRateLimitsRead,
// the owner-approved additive exception to the task 1.2 freeze; design §6)
// through the public factory and the owned fake app-server over stdio. Every
// expected count comes from the caller fixture's own answers and the wire the
// fake received ($CODEX_HOME/received.jsonl, shared by the drivers of one
// home), never from the driver:
// - Omitted: one account/rateLimits/read per driver, none after a respawn.
// - Supplied: asked once per started generation, after its checkpoint
//   persisted; `true` permits that generation's one read, `false` none. The
//   caller's own state (a set of claimed homes, a report it already holds)
//   decides sharing between drivers and homes; the package keeps no store.
// - A denied read reports nothing, and pushed updates are still reported; a
//   read unanswered when its generation exits reports nothing.
// - A held persistence holds the claim; a refused one never consults it.
// - A throwing claim denies the read and is the stop's one raw cause; a
//   claim that kills its own driver is refused instead of joining itself,
//   and no read follows.
// A turn after start is the barrier: the fake handles lines in order, so a
// read sent at readiness is on the wire before the turn completes.
import { afterEach, describe, expect, test } from 'bun:test'
import type { QuotaReport } from '../src/usage/types.js'
import { codexDriver, sent, stopDrivers, waitFor, type CodexRoot, type HarnessOptions } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

const snapshot = (usedPercent: number) => ({ limitId: null, limitName: null, primary: { usedPercent, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: null, credits: null, planType: null, rateLimitReachedType: null })
/** The fake answers account/rateLimits/read with this percent. */
const answering = (usedPercent: number) => ({ FAKE_CODEX_RATELIMITS: JSON.stringify(snapshot(usedPercent)) })
const reads = (root: CodexRoot) => sent(root, 'account/rateLimits/read').length
const reported = (quotas: QuotaReport[]) => quotas.map((q) => [q.source, q.windows[0]?.percentUsed ?? null])

function recorded(options: HarnessOptions = {}) {
  const quotas: QuotaReport[] = []
  const given = options.callbacks?.onQuotaReport
  const h = codexDriver({ ...options, callbacks: { ...options.callbacks, onQuotaReport: (q) => (quotas.push(q), given?.(q)) } })
  return { ...h, quotas }
}

async function barrier(h: { driver: { send(text: string): Promise<{ result: Promise<unknown> }> } }, text = 'barrier') {
  await (await h.driver.send(text)).result
}

describe('Codex quota-read claim', () => {
  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Codex quota read
  test('omitted: one read per driver, and a respawn after an unexpected exit reads nothing more', async () => {
    const h = recorded({ env: answering(42) })
    await h.driver.start()
    await waitFor(() => h.quotas.length === 1)
    await barrier(h, '/exit 1')
    await waitFor(() => h.ends.length === 1)
    await h.driver.start()
    await barrier(h)
    expect(reads(h.root)).toBe(1)
    expect(reported(h.quotas)).toEqual([['report', 42]])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Codex quota read
  test('a false claim sends no read and reports nothing, and a pushed update is still reported', async () => {
    const asked: string[] = []
    const h = recorded({ env: answering(42), claimRateLimitsRead: () => (asked.push('claim'), false) })
    await h.driver.start()
    expect(asked).toEqual(['claim'])
    const push = { method: 'account/rateLimits/updated', params: { rateLimits: snapshot(7) } }
    await barrier(h, `/script ${JSON.stringify({ notes: [push] })}`)
    await waitFor(() => h.quotas.length > 0)
    expect(reads(h.root)).toBe(0)
    expect(reported(h.quotas)).toEqual([['push', 7]])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Codex quota read
  test('a true claim sends one read, reported once', async () => {
    const asked: string[] = []
    const h = recorded({ env: answering(42), claimRateLimitsRead: () => (asked.push('claim'), true) })
    await h.driver.start()
    expect(asked).toEqual(['claim'])
    await barrier(h)
    await waitFor(() => h.quotas.length > 0)
    expect(reads(h.root)).toBe(1)
    expect(reported(h.quotas)).toEqual([['report', 42]])
  })
})
