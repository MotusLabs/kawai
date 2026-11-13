// @reads: packages/agent-runtime/__tests__/fixtures/**
// I1 for Claude (design §Invariants: 0xA601, 300 sequences of 1..60
// operations; task 2.2 Claude ownership). The same generator, seeds and
// operation list as codexStopOrder.test.ts. Each sequence drives one public
// createClaudeDriver over the pinned SDK, the owned spawner and the fake CLI
// (fixtures/fakeClaude.ts) with operations issued without awaiting their
// results: turns, held turns, queued messages, interrupts, crashes and
// restarts (a new generation beside the retired one), a late helper child
// left in the CLI's process group, held host tool handlers and waiting
// permission requests, and a kill or shutdown at a seeded point. Claude's
// one continuation is `queue`, so the generator's `steer` operation sends
// with `continuation: 'queue'`.
//
// At the moment the stop settles (resolved or rejected), every process any
// generation recorded is gone (leaders and helpers, a zombie counting as
// dead as in the production group check), every host handler that started
// has finished, a resolved receipt reports every spawned leader as exited,
// and afterwards every accepted handle has settled and no turn result was
// reported twice. A rejected stop is expected only from a crash: the
// fixture's exit code 3, as the native exit and the CLI read failure the
// pinned SDK raises for it; any other cause fails the sequence.
//
// A last case pins the fixture correction this file needed: the fake's
// interrupt result now carries the `errors` list the pinned SDK requires of
// every error result, so an interrupt the fake answers with that result no
// longer throws in the SDK's reader and ends the generation.
//
// Cleanup: each sequence's driver is admitted to one ownedAggregate before it
// is constructed; the sequence's own stop is the joined terminal, and only
// the one rejection a sequence asserted exactly is consumed before the
// close. Roots are removed after the join.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createClaudeDriver } from '../src/claude/driver.js'
import type { ClaudeAgentDriver, ProcessExitReceipt, TurnHandle, TurnResult } from '../src/contract.js'
import type { ToolSet } from '../src/options.js'
import { NativeExitFailure } from '../src/process/nativeVerdict.js'
import { alive } from './helpers/codexDriverHarness.js'
import { fakeClaudeHome, type FakeClaudeHome } from './helpers/fakeClaudeHome.js'
import { ownedAggregate } from './helpers/ownedCleanup.js'

type Op = 'send' | 'hold' | 'steer' | 'interrupt' | 'crash' | 'child' | 'restart' | 'tool' | 'ask' | 'answer' | 'tick' | 'kill' | 'shutdown'
const OPS: Op[] = ['send', 'send', 'hold', 'steer', 'interrupt', 'crash', 'child', 'restart', 'tool', 'ask', 'answer', 'tick', 'tick', 'kill', 'shutdown']

function generateOps(seed: number): { ops: Op[]; ticks: number[] } {
  let state = seed >>> 0
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) >>> 0
    return (state >>> 16) % n
  }
  const length = 1 + next(60)
  const ops = Array.from({ length }, () => OPS[next(OPS.length)]!)
  const ticks = ops.map(() => next(4))
  return { ops, ticks }
}

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Polls until `done` holds; a condition never reached fails the test. */
async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await tick(10)
  }
}

/** The helper children the fake's `child` prompt started (each appends its pid). */
const children = (home: FakeClaudeHome): number[] => {
  try {
    return readFileSync(join(home.root, 'home', 'child-pids'), 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

interface Verdict {
  ops: Op[]
  /** Recorded pids still alive when the stop settled. */
  liveAtStop: number[]
  /** Host handlers started but unfinished when the stop settled. */
  handlersOpenAtStop: number
  /** Spawned leaders the resolved receipt does not report as exited (a rejected stop reports none). */
  unreported: number[]
  unsettledHandles: number
  duplicateResults: string[]
}

interface Reach {
  leaders: number
  helpers: number
  handlers: number
  requests: number
  rejected: boolean
}

/** One sequence's driver, its root and the outcome its own stop settled with. */
interface Owned {
  /** Null until constructed: the entry is admitted before the driver exists. */
  driver: ClaudeAgentDriver | null
  home: FakeClaudeHome
  stop: Promise<ProcessExitReceipt> | null
  /** The one rejection value the sequence asserted exactly; consumed once at cleanup. */
  expected: { value: unknown } | null
}

interface Joined {
  stopped: { ok: true } | { ok: false; error: unknown }
  removal: { ok: true } | { ok: false; error: unknown }
}

/**
 * The file's one cleanup owner. An entry's join is its sequence's own stop
 * (or a kill when it never stopped), then the removal of its root, last.
 * Every raw failure is reported in order except one occurrence of the exact
 * value the sequence asserted, consumed once.
 */
const owned = ownedAggregate<Owned, Joined>({
  async join(entry) {
    const settle = entry.stop ?? (entry.driver ? entry.driver.kill() : Promise.resolve(null))
    const stopped = await settle.then(() => ({ ok: true }) as const, (error: unknown) => ({ ok: false, error }) as const)
    let removal: Joined['removal'] = { ok: true }
    try {
      rmSync(entry.home.root, { recursive: true, force: true })
    } catch (error) {
      removal = { ok: false, error }
    }
    return { stopped, removal }
  },
  failures(entry, outcome) {
    if (outcome.status === 'rejected') return [outcome.reason]
    const { stopped, removal } = outcome.value
    const raw: unknown[] = []
    if (!stopped.ok) {
      if (entry.expected && Object.is(stopped.error, entry.expected.value)) entry.expected = null
      else raw.push(stopped.error)
    }
    if (entry.expected) raw.push(new Error('an expected stop failure was never observed', { cause: entry.expected.value }))
    if (!removal.ok) raw.push(removal.error)
    return raw
  },
  message: 'the Claude stop-order cleanup failed',
})
afterEach(() => owned.join())

async function run(seed: number): Promise<{ verdict: Verdict; reach: Reach; failure: unknown; entry: Owned }> {
  const { ops, ticks } = generateOps(seed)
  let started = 0
  let finished = 0
  let requests = 0
  const tools: ToolSet = {
    namespace: 'host',
    tools: [{
      name: 'slow', description: 'Held handler', inputSchema: z.object({ ms: z.number() }),
      handler: async ({ ms }) => {
        started += 1
        await tick(ms as number)
        finished += 1
        return { content: 'done' }
      },
    }],
  }
  const home = fakeClaudeHome()
  const results: TurnResult[] = []
  // Admitted before construction: a refused or throwing construction still has its root removed.
  const entry: Owned = { driver: null, home, stop: null, expected: null }
  owned.add(entry)
  const d = createClaudeDriver({
    launch: home.launch(),
    logger,
    // The host tool and Edit are enabled; Edit still asks (a held permission request), the host tool runs.
    permissions: { mode: 'default', enabledTools: ['Edit', 'mcp__host__slow'], disallowedTools: [] },
    tools,
    unansweredRequests: 'wait',
    callbacks: {
      onEvent: () => {},
      onTurnResult: (r) => void results.push(r),
      onRequest: () => void (requests += 1),
    },
  })
  entry.driver = d
  const handles: TurnHandle[] = []
  const settled = new Set<string>()
  const track = (promise: Promise<TurnHandle>) =>
    void promise.then((handle) => {
      handles.push(handle)
      void handle.result.then(() => settled.add(`${handle.turnId}:${handle.messageUuid}`))
    }, () => {})
  await d.start()
  let verdictAtStop: { live: number[]; open: number } | null = null
  let receipt: ProcessExitReceipt | null = null
  let failure: unknown = null
  let rejected = false
  const terminal = (mode: 'kill' | 'shutdown') => {
    const s = d[mode]()
    entry.stop ??= s
    const observe = () => {
      verdictAtStop ??= { live: [...home.pids(), ...children(home)].filter(alive), open: started - finished }
    }
    void s.then((r) => {
      receipt ??= r
      observe()
    }, (error: unknown) => {
      if (!rejected) {
        rejected = true
        failure = error
      }
      observe()
    })
  }
  for (const [i, op] of ops.entries()) {
    switch (op) {
      case 'send': track(d.send(`m${i}`)); break
      case 'hold': track(d.send('hang')); break
      case 'steer': track(d.send(`q${i}`, { continuation: 'queue' })); break
      case 'interrupt': void d.interrupt().catch(() => {}); break
      case 'crash': track(d.send('crash')); break
      case 'child': track(d.send('child')); break
      case 'restart': void d.start().catch(() => {}); break
      case 'tool': track(d.send(`mcp host slow ${JSON.stringify({ ms: 5 + (i % 4) * 10 })}`)); break
      case 'ask': track(d.send('ask Edit {}')); break
      case 'answer': for (const r of d.pendingRequests()) d.resolveApproval(r.requestId, 'allow'); break
      case 'tick': await tick(5 * ticks[i]!); break
      case 'kill':
      case 'shutdown': terminal(op); break
    }
    await tick(ticks[i]!)
  }
  terminal(ops.includes('shutdown') && !ops.includes('kill') ? 'shutdown' : 'kill')
  await entry.stop!.then(() => {}, () => {})
  await tick(0)
  const spawned = home.pids()
  const counts = new Map<string, number>()
  for (const r of results) counts.set(r.turnId, (counts.get(r.turnId) ?? 0) + 1)
  const verdict: Verdict = {
    ops,
    liveAtStop: verdictAtStop!.live,
    handlersOpenAtStop: verdictAtStop!.open,
    unreported: receipt ? spawned.filter((pid) => !(receipt as ProcessExitReceipt).processes.some((p) => p.state === 'exited' && p.pid === pid)) : [],
    unsettledHandles: handles.filter((handle) => !settled.has(`${handle.turnId}:${handle.messageUuid}`)).length,
    duplicateResults: [...counts].filter(([, c]) => c > 1).map(([id]) => id),
  }
  const reach: Reach = { leaders: spawned.length, helpers: children(home).length, handlers: started, requests, rejected }
  return { verdict, reach, failure, entry }
}

/** A rejected stop's causes as the fixture's crash produces them, else the raw cause. */
function crashCause(cause: unknown): string {
  if (cause instanceof NativeExitFailure) return cause.facts.code === 3 && cause.facts.signal === null ? 'native exit 3' : `native ${JSON.stringify(cause.facts)}`
  const error = cause as { message?: unknown; errorClass?: unknown }
  if (error?.message === 'Claude Code process exited with code 3' && error.errorClass === 'process_exited_nonzero') return 'read failure exit 3'
  return `other: ${String(error?.message ?? cause)}`
}

describe('Claude stop: I1 over fixed-seed operation sequences', () => {
  const reached: Reach[] = []
  const slice = async (n: number) => {
    for (let i = n * 5; i < n * 5 + 5; i++) {
      const { verdict, reach, failure, entry } = await run(0xa601 + i * 7919)
      reached[i] = reach
      expect({ i, ...verdict }).toEqual({ i, ops: verdict.ops, liveAtStop: [], handlersOpenAtStop: 0, unreported: [], unsettledHandles: 0, duplicateResults: [] })
      if (reach.rejected) {
        const error = failure as { category?: unknown; causes?: readonly unknown[] }
        expect({ i, crashed: verdict.ops.includes('crash'), category: error.category }).toEqual({ i, crashed: true, category: 'stop' })
        const causes = (error.causes ?? []).map(crashCause)
        expect({ i, others: causes.filter((c) => !c.startsWith('native exit 3') && c !== 'read failure exit 3'), natives: causes.filter((c) => c === 'native exit 3').length > 0 })
          .toEqual({ i, others: [], natives: true })
        // Only now, after the exact assertions above, is this one original rejection expected.
        entry.expected = { value: failure }
      }
      await owned.join()
    }
  }
  // 0xA601, the same 300 sequences as Codex, in sixty slices of five; each slice is a literal title.
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 0-4)', () => slice(0))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 5-9)', () => slice(1))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 10-14)', () => slice(2))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 15-19)', () => slice(3))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 20-24)', () => slice(4))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 25-29)', () => slice(5))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 30-34)', () => slice(6))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 35-39)', () => slice(7))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 40-44)', () => slice(8))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 45-49)', () => slice(9))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 50-54)', () => slice(10))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 55-59)', () => slice(11))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 60-64)', () => slice(12))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 65-69)', () => slice(13))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 70-74)', () => slice(14))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 75-79)', () => slice(15))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 80-84)', () => slice(16))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 85-89)', () => slice(17))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 90-94)', () => slice(18))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 95-99)', () => slice(19))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 100-104)', () => slice(20))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 105-109)', () => slice(21))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 110-114)', () => slice(22))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 115-119)', () => slice(23))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 120-124)', () => slice(24))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 125-129)', () => slice(25))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 130-134)', () => slice(26))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 135-139)', () => slice(27))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 140-144)', () => slice(28))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 145-149)', () => slice(29))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 150-154)', () => slice(30))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 155-159)', () => slice(31))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 160-164)', () => slice(32))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 165-169)', () => slice(33))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 170-174)', () => slice(34))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 175-179)', () => slice(35))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 180-184)', () => slice(36))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 185-189)', () => slice(37))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 190-194)', () => slice(38))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 195-199)', () => slice(39))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 200-204)', () => slice(40))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 205-209)', () => slice(41))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 210-214)', () => slice(42))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 215-219)', () => slice(43))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 220-224)', () => slice(44))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 225-229)', () => slice(45))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 230-234)', () => slice(46))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 235-239)', () => slice(47))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 240-244)', () => slice(48))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 245-249)', () => slice(49))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 250-254)', () => slice(50))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 255-259)', () => slice(51))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 260-264)', () => slice(52))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 265-269)', () => slice(53))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 270-274)', () => slice(54))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 275-279)', () => slice(55))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 280-284)', () => slice(56))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 285-289)', () => slice(57))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 290-294)', () => slice(58))
  test('Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 295-299)', () => slice(59))

  test('Claude I1: every sequence spawned its CLI, and the sequences reached helpers, handlers, requests and a crash-caused rejection', () => {
    expect(reached.filter(Boolean)).toHaveLength(300)
    expect(reached.filter((r) => r.leaders < 1)).toEqual([])
    expect(reached.some((r) => r.helpers > 0)).toBe(true)
    expect(reached.some((r) => r.handlers > 0)).toBe(true)
    expect(reached.some((r) => r.requests > 0)).toBe(true)
    expect(reached.some((r) => r.rejected)).toBe(true)
  })

  test('Claude I1: the 300 sequences reach every operation, and both stop modes', () => {
    const seen = new Set<Op>()
    for (let i = 0; i < 300; i++) for (const op of generateOps(0xa601 + i * 7919).ops) seen.add(op)
    expect(OPS.filter((op) => !seen.has(op))).toEqual([])
  })
})

describe('Claude interrupt answered by an error result', () => {
  // The fake writes the interrupted turn's error result only once it has read
  // that turn's prompt, so the test waits for it first. The result carries
  // the `errors` list every SDKResultError has; without it the pinned SDK's
  // reader throws and the generation ends as an unexpected exit.
  test('the interrupted turn settles as interrupted, the generation keeps reading, and a kill resolves with its one exit', async () => {
    const home = fakeClaudeHome()
    const entry: Owned = { driver: null, home, stop: null, expected: null }
    owned.add(entry)
    const events: string[] = []
    const d = createClaudeDriver({
      launch: home.launch(),
      logger,
      permissions: { mode: 'default', enabledTools: [], disallowedTools: [] },
      callbacks: { onEvent: (e) => void events.push(e.type) },
    })
    entry.driver = d
    await d.start()
    const hung = await d.send('hang')
    await until(() => home.received().some((f) => f.type === 'user' && JSON.stringify(f.message).includes('hang')))
    expect(await d.interrupt()).toEqual({ outcome: 'requested', processExit: false })
    expect((await hung.result).outcome).toBe('interrupted')
    await until(() => home.received().some((f) => (f.request as { subtype?: string } | undefined)?.subtype === 'interrupt'))
    // The interrupted turn's own error result reaches the reader; the generation keeps reading.
    expect((await (await d.send('after')).result).finalText).toBe('echo: after')
    entry.stop = d.kill()
    const receipt = await entry.stop
    expect(receipt.processes.map((p) => [p.generation, p.state])).toEqual([[1, 'exited']])
    expect(home.pids()).toHaveLength(1)
    expect(events.filter((type) => type === 'error')).toEqual([])
  })
})
