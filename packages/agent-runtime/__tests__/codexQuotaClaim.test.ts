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
// - A held persistence holds the claim; a refused one never consults it, and
//   neither does a generation that exited while its persistence was held.
// - A throwing claim denies the read and is the stop's one raw cause; a
//   claim that kills its own driver is refused instead of joining itself,
//   and no read follows.
// A turn after start is the barrier: the fake handles lines in order, so a
// read sent at readiness is on the wire before the turn completes.
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { AgentRuntimeError } from '../src/errors.js'
import type { QuotaReport } from '../src/usage/types.js'
import { codexDriver, codexRoot, deferred, refusal, sent, stopDrivers, waitFor, type CodexRoot, type HarnessOptions } from './helpers/codexDriverHarness.js'

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

/** A caller's claim over its own set of claimed homes: the first ask per home wins. */
function homeClaims() {
  const claimed = new Set<string>()
  const asked: string[] = []
  return { asked, claim: (home: () => string) => () => (asked.push(home()), claimed.has(home()) ? false : (claimed.add(home()), true)) }
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

  test('repeated start shares one initialization: one consultation and one read', async () => {
    const asked: string[] = []
    const h = recorded({ env: answering(42), claimRateLimitsRead: () => (asked.push('claim'), true) })
    await Promise.all([h.driver.start(), h.driver.start()])
    await h.driver.start()
    await barrier(h)
    expect(asked).toEqual(['claim'])
    expect(reads(h.root)).toBe(1)
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Codex quota read
  test('two drivers on one shared home with the caller claiming per home: one read in total, reported by one driver', async () => {
    const first = codexRoot()
    const second = codexRoot(first.home)
    const claims = homeClaims()
    const a = recorded({ root: first, env: answering(42), claimRateLimitsRead: claims.claim(() => first.home) })
    const b = recorded({ root: second, env: answering(42), claimRateLimitsRead: claims.claim(() => second.home) })
    await Promise.all([a.driver.start(), b.driver.start()])
    await Promise.all([barrier(a), barrier(b)])
    await waitFor(() => a.quotas.length + b.quotas.length > 0)
    expect(claims.asked).toEqual([first.home, first.home])
    expect(reads(first)).toBe(1)
    expect(reported([...a.quotas, ...b.quotas])).toEqual([['report', 42]])
  })

  test('a caller already holding a report for the home claims nothing: the second driver sends no read', async () => {
    const first = codexRoot()
    const second = codexRoot(first.home)
    const held = new Map<string, QuotaReport>()
    const a = recorded({ root: first, env: answering(42), claimRateLimitsRead: () => !held.has(first.home), callbacks: { onQuotaReport: (q) => void held.set(first.home, q) } })
    await a.driver.start()
    await waitFor(() => held.size === 1)
    const b = recorded({ root: second, env: answering(42), claimRateLimitsRead: () => !held.has(second.home) })
    await b.driver.start()
    await barrier(b)
    expect(reads(first)).toBe(1)
    expect(reported(a.quotas)).toEqual([['report', 42]])
    expect(b.quotas).toEqual([])
  })

  test('distinct homes claim separately: one read on each home', async () => {
    const roots = [codexRoot(), codexRoot()]
    const claims = homeClaims()
    const drivers = roots.map((root, i) => recorded({ root, env: answering(10 + i), claimRateLimitsRead: claims.claim(() => root.home) }))
    await Promise.all(drivers.map((h) => h.driver.start()))
    await Promise.all(drivers.map((h) => barrier(h)))
    await waitFor(() => drivers.every((h) => h.quotas.length > 0))
    expect(roots.map(reads)).toEqual([1, 1])
    expect(drivers.map((h) => reported(h.quotas))).toEqual([[['report', 10]], [['report', 11]]])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Codex quota read
  test('respawn: the claim is asked per generation, and the caller answers by the home its launch selected', async () => {
    const one = codexRoot()
    const two = codexRoot()
    const plan = [one, one, two]
    let generation = 0
    let selected = one
    const launch = () => {
      selected = plan[generation++]!
      // The caller moves its thread to the newly selected home before that generation resumes it.
      if (selected === two) cpSync(join(one.home, 'threads'), join(two.home, 'threads'), { recursive: true })
      return selected.launch(answering(selected === one ? 11 : 22))
    }
    const claims = homeClaims()
    const h = recorded({ root: one, launch, claimRateLimitsRead: claims.claim(() => selected.home) })
    await h.driver.start()
    await waitFor(() => h.quotas.length === 1)
    await barrier(h, '/exit 1')
    await waitFor(() => h.ends.length === 1)
    await h.driver.start()
    await barrier(h, '/exit 1')
    await waitFor(() => h.ends.length === 2)
    await h.driver.start()
    await barrier(h)
    await waitFor(() => h.quotas.length === 2)
    expect(claims.asked).toEqual([one.home, one.home, two.home])
    expect([reads(one), reads(two)]).toEqual([1, 1])
    expect(reported(h.quotas)).toEqual([['report', 11], ['report', 22]])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Codex quota read
  test('a held checkpoint persistence holds the claim until it persisted', async () => {
    const persisted = deferred()
    const asked: string[] = []
    const h = recorded({ env: answering(42), claimRateLimitsRead: () => (asked.push('claim'), true), callbacks: { onCheckpoint: () => persisted.promise } })
    const started = h.driver.start()
    await waitFor(() => h.checkpoints.length === 1)
    expect(asked).toEqual([])
    persisted.resolve()
    await started
    expect(asked).toEqual(['claim'])
    await barrier(h)
    expect(reads(h.root)).toBe(1)
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Codex quota read
  test('a generation that exits while its checkpoint persistence is held is never asked: the caller claim stays free for the successor', async () => {
    const root = codexRoot()
    let generation = 0
    const launch = () => root.launch(generation++ === 0 ? { ...answering(33), FAKE_CODEX_START: 'exit' } : answering(33))
    const persisted = deferred()
    const claims = homeClaims()
    const h = recorded({ root, launch, claimRateLimitsRead: claims.claim(() => root.home), callbacks: { onCheckpoint: () => (generation === 1 ? persisted.promise : undefined) } })
    const started = h.driver.start().then(
      () => null,
      (error: unknown) => error,
    )
    await waitFor(() => h.checkpoints.length === 1 && h.ends.length === 1)
    expect(h.ends).toHaveLength(1)
    persisted.resolve()
    await started
    // The exited generation was not eligible: no consultation, so the caller's claim for this home is unspent.
    expect(claims.asked).toEqual([])
    await h.driver.start()
    await barrier(h)
    await waitFor(() => h.quotas.length > 0)
    expect(claims.asked).toEqual([root.home])
    expect(reads(root)).toBe(1)
    expect(reported(h.quotas)).toEqual([['report', 33]])
  })

  test('a refused checkpoint persistence fails start before the claim: no consultation and no read', async () => {
    const asked: string[] = []
    const h = recorded({ env: answering(42), claimRateLimitsRead: () => (asked.push('claim'), true), callbacks: { onCheckpoint: () => Promise.reject(new Error('disk full')) } })
    const error = await refusal(h.driver.start())
    expect(error.category).toBe('checkpoint')
    expect(asked).toEqual([])
    await h.driver.kill().catch(() => {})
    expect(reads(h.root)).toBe(0)
  })

  test('a read still unanswered when its generation exits reports nothing; the successor claims and reports its own', async () => {
    const root = codexRoot()
    let generation = 0
    const launch = () => root.launch(generation++ === 0 ? { FAKE_CODEX_RATELIMITS: 'hold' } : answering(22))
    const asked: number[] = []
    const h = recorded({ root, launch, claimRateLimitsRead: () => (asked.push(generation), true) })
    await h.driver.start()
    await barrier(h, '/exit 1')
    await waitFor(() => h.ends.length === 1)
    expect(h.quotas).toEqual([])
    await h.driver.start()
    await barrier(h)
    await waitFor(() => h.quotas.length > 0)
    expect(asked).toEqual([1, 2])
    expect(reads(root)).toBe(2)
    expect(reported(h.quotas)).toEqual([['report', 22]])
    // The stop's only cause is the exit the test asked for: the closed held read fails nothing.
    const stop = await h.driver.shutdown().then(
      () => null,
      (error: AgentRuntimeError) => error,
    )
    expect(stop?.causes.map((cause) => (cause as Error).message)).toEqual(['agent process generation 1 exited with code 1 before the stop'])
  })

  // @covers: agent-runtime › Usage and quota reports remain observable › Caller-claimed Codex quota read
  test('a throwing claim denies the read; start and turns are unaffected, and the stop reports the raw error once', async () => {
    const boom = new Error('claim store unavailable')
    const h = recorded({
      env: answering(42),
      claimRateLimitsRead: () => {
        throw boom
      },
    })
    await h.driver.start()
    const result = (await (await h.driver.send('one')).result) as { outcome: string }
    expect(result.outcome).toBe('success')
    expect(reads(h.root)).toBe(0)
    expect(h.quotas).toEqual([])
    const stop = await h.driver.shutdown().then(
      () => 'resolved',
      (error: unknown) => error,
    )
    expect(stop).toBeInstanceOf(AgentRuntimeError)
    expect((stop as AgentRuntimeError).category).toBe('stop')
    // The raw throw itself, once: not wrapped as an optional-RPC refusal or reported by the logger only.
    expect((stop as AgentRuntimeError).causes).toHaveLength(1)
    expect((stop as AgentRuntimeError).causes[0]).toBe(boom)
  })

  test('a claim that kills its own driver: no read follows, that kill is refused instead of joining itself, and the stop completes', async () => {
    const reentry: { kill?: Promise<unknown> } = {}
    const h = recorded({
      env: answering(42),
      claimRateLimitsRead: () => {
        reentry.kill = h.driver.kill()
        return true
      },
    })
    const started = await refusal(h.driver.start())
    expect(started.category).toBe('stopped')
    const inner = await refusal(reentry.kill!)
    expect(inner.category).toBe('internal')
    expect((await h.driver.kill()).mode).toBe('kill')
    expect(reads(h.root)).toBe(0)
    expect(h.quotas).toEqual([])
  })
})
