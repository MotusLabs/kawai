// I1 for Codex (design §Invariants: 0xA601, 300 sequences of 1..60
// operations; task 2.2 Codex ownership). Each sequence drives one public
// driver over the owned fake app-server with operations issued without
// awaiting their results: turns, held turns, steers, interrupts, crashes and
// restarts, a helper child left in the app-server's process group, held host
// tool handlers and waiting requests, and a kill or shutdown at a seeded
// point. At the moment the stop settles (resolved or rejected), every process
// any generation recorded is gone (leaders and group members), every host
// handler that started has finished, a resolved receipt reports every
// spawned leader as exited, and afterwards every accepted handle has settled
// exactly once.
//
// Batch B (task 4.2/2.2, U2): the cold-start sequences above issue their
// operations while the first generation is still booting, and in this
// environment their stops all land before the fake app-server runs. The
// second describe replays the same seeds and operations after the first
// start() resolved, so every sequence drives a booted generation: turns,
// held handlers, crashes and /child helpers in the group. A helper outlives
// its leader as a zombie when the container's PID 1 does not reap it;
// alive() counts a zombie as dead, as the production group check does
// (zombieLiveness.test.ts).
//
// Cleanup (batch B F2): every driver here is owned by one file-local
// ownedCodexDrivers (helpers/ownedCodexDrivers.ts), never by the shared
// stopDrivers registry. Each sequence reopens admission, admits its driver
// before constructing it, asserts its verdict, and only then authorizes the
// one stop rejection it asserted exactly (by its original value) before
// closing; any other rejection fails the cleanup with its raw value.
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexAgentDriver, ProcessExitReceipt, TurnHandle, TurnResult } from '../src/contract.js'
import type { ToolSet } from '../src/options.js'
import { alive, codexDriver, pids } from './helpers/codexDriverHarness.js'
import { ownedCodexDrivers } from './helpers/ownedCodexDrivers.js'

const drivers = ownedCodexDrivers()
afterEach(() => drivers.close())

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

/** The app-server leaders spawned for this home (each logs its env once). */
const leaders = (home: string): number[] => {
  try {
    return readFileSync(join(home, 'envs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { pid: number }).pid)
  } catch {
    return []
  }
}

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

/** What a sequence actually reached on its processes (ready variant reach). */
interface Reach {
  leaders: number
  helpers: number
  handlers: number
  rejected: boolean
  /** A rejected stop's error category and each cause as `category:message`. */
  failure: { category: unknown; causes: string[] } | null
}

/** The sequence's stop as the driver settled it: its original rejection value, if it rejected. */
interface Stop {
  driver: CodexAgentDriver
  rejected: boolean
  error: unknown
}

async function run(seed: number, ready = false): Promise<{ verdict: Verdict; reach: Reach; stop: Stop }> {
  const { ops, ticks } = generateOps(seed)
  let started = 0
  let finished = 0
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
  // A new sequence: admission reopens only after the previous close settled.
  drivers.open()
  const admission = drivers.admit()
  let h: ReturnType<typeof codexDriver>
  try {
    h = codexDriver({ tools, unansweredRequests: 'wait', enroll: (driver) => admission.enroll(driver) })
  } catch (error) {
    admission.abandon(error)
    throw error
  }
  const handles: TurnHandle[] = []
  const settled = new Set<string>()
  const track = (promise: Promise<TurnHandle>) =>
    void promise.then((handle) => {
      handles.push(handle)
      void handle.result.then(() => settled.add(`${handle.turnId}:${handle.messageUuid}`))
    }, () => {})
  if (ready) await h.driver.start()
  else void h.driver.start().catch(() => {})
  let stop: Promise<unknown> | null = null
  let verdictAtStop: { live: number[]; open: number } | null = null
  let receipt: ProcessExitReceipt | null = null
  let stopError: unknown = null
  let stopRejected = false
  const terminal = (mode: 'kill' | 'shutdown') => {
    const s = h.driver[mode]()
    const observe = () => {
      verdictAtStop ??= { live: pids(h.root.home).filter(alive), open: started - finished }
    }
    void s.then((r) => {
      receipt ??= r
      observe()
    }, (error: unknown) => {
      if (!stopRejected) {
        stopRejected = true
        stopError = error
      }
      observe()
    })
    stop ??= s.then(() => 'ok', () => 'rejected')
  }
  for (const [i, op] of ops.entries()) {
    switch (op) {
      case 'send': track(h.driver.send(`m${i}`)); break
      case 'hold': track(h.driver.send('/hold')); break
      case 'steer': track(h.driver.send(`s${i}`, { continuation: 'steer' })); break
      case 'interrupt': void h.driver.interrupt().catch(() => {}); break
      case 'crash': track(h.driver.send('/exit 5')); break
      case 'child': track(h.driver.send('/child')); break
      case 'restart': void h.driver.start().catch(() => {}); break
      case 'tool': track(h.driver.send(`/tool ${JSON.stringify({ namespace: 'host', tool: 'slow', arguments: { ms: 5 + (i % 4) * 10 } })}`)); break
      case 'ask': track(h.driver.send('/ask item/commandExecution/requestApproval {}')); break
      case 'answer': for (const r of h.driver.pendingRequests()) h.driver.resolveApproval(r.requestId, 'allow'); break
      case 'tick': await tick(5 * ticks[i]!); break
      case 'kill':
      case 'shutdown': terminal(op); break
    }
    await tick(ticks[i]!)
  }
  terminal(ops.includes('shutdown') && !ops.includes('kill') ? 'shutdown' : 'kill')
  await stop
  await tick(0)
  const recorded = pids(h.root.home).length
  const spawned = leaders(h.root.home).length
  const failed = stopError as { category?: unknown; causes?: readonly { category?: unknown; message?: unknown }[] } | null
  const reach: Reach = {
    leaders: spawned,
    helpers: recorded - spawned,
    handlers: started,
    rejected: (await stop) === 'rejected',
    failure: failed ? { category: failed.category, causes: (failed.causes ?? []).map((c) => `${String(c?.category)}:${String(c?.message)}`) } : null,
  }
  const counts = new Map<string, number>()
  for (const r of h.results as TurnResult[]) counts.set(r.turnId, (counts.get(r.turnId) ?? 0) + 1)
  const verdict: Verdict = {
    ops,
    liveAtStop: verdictAtStop!.live,
    handlersOpenAtStop: verdictAtStop!.open,
    unreported: receipt ? leaders(h.root.home).filter((pid) => !(receipt as ProcessExitReceipt).processes.some((p) => p.state === 'exited' && p.pid === pid)) : [],
    unsettledHandles: handles.filter((handle) => !settled.has(`${handle.turnId}:${handle.messageUuid}`)).length,
    duplicateResults: [...counts].filter(([, c]) => c > 1).map(([id]) => id),
  }
  return { verdict, reach, stop: { driver: h.driver, rejected: stopRejected, error: stopError } }
}

describe('Codex stop: I1 over fixed-seed operation sequences', () => {
  // 0xA601, 300 sequences, in twenty slices so each test stays within its timeout.
  for (let slice = 0; slice < 20; slice++) {
    test(`I1: the stop settles only after every owned process exited and every admitted handler finished (sequences ${slice * 15}-${slice * 15 + 14})`, async () => {
      for (let i = slice * 15; i < slice * 15 + 15; i++) {
        const { verdict } = await run(0xa601 + i * 7919)
        expect({ i, ...verdict }).toEqual({ i, ops: verdict.ops, liveAtStop: [], handlersOpenAtStop: 0, unreported: [], unsettledHandles: 0, duplicateResults: [] })
        await drivers.close()
      }
    })
  }

  test('I1: the 300 sequences reach every operation, and both stop modes', () => {
    const seen = new Set<Op>()
    for (let i = 0; i < 300; i++) for (const op of generateOps(0xa601 + i * 7919).ops) seen.add(op)
    expect(OPS.filter((op) => !seen.has(op))).toEqual([])
  })
})

describe('Codex stop: I1 after readiness over the same fixed-seed sequences', () => {
  const reached: Reach[] = []
  // 0xA601, the same 300 sequences, in sixty slices of five. Each slice is a
  // literal title (so a coverage citation resolves it), in slice order.
  const readySlice = async (n: number) => {
    for (let i = n * 5; i < n * 5 + 5; i++) {
      const { verdict, reach, stop } = await run(0xa601 + i * 7919, true)
      reached[i] = reach
      expect({ i, ...verdict }).toEqual({ i, ops: verdict.ops, liveAtStop: [], handlersOpenAtStop: 0, unreported: [], unsettledHandles: 0, duplicateResults: [] })
      // A rejected stop is expected only from a crash: its one retained native exit, nothing else.
      expect(reach.rejected).toBe(reach.failure !== null)
      if (reach.failure) {
        expect({ i, crashed: verdict.ops.includes('crash'), category: reach.failure.category, causes: reach.failure.causes.length }).toEqual({ i, crashed: true, category: 'stop', causes: 1 })
        expect(reach.failure.causes[0]).toMatch(/^transport:agent process generation 1 exited with code 5 (before the stop|after the stop began)$/)
      }
      // Only now, after the exact assertions above, may that one original rejection be expected.
      if (stop.rejected) drivers.authorize(stop.driver, stop.error)
      await drivers.close()
    }
  }
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 0-4)', () => readySlice(0))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 5-9)', () => readySlice(1))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 10-14)', () => readySlice(2))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 15-19)', () => readySlice(3))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 20-24)', () => readySlice(4))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 25-29)', () => readySlice(5))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 30-34)', () => readySlice(6))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 35-39)', () => readySlice(7))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 40-44)', () => readySlice(8))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 45-49)', () => readySlice(9))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 50-54)', () => readySlice(10))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 55-59)', () => readySlice(11))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 60-64)', () => readySlice(12))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 65-69)', () => readySlice(13))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 70-74)', () => readySlice(14))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 75-79)', () => readySlice(15))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 80-84)', () => readySlice(16))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 85-89)', () => readySlice(17))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 90-94)', () => readySlice(18))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 95-99)', () => readySlice(19))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 100-104)', () => readySlice(20))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 105-109)', () => readySlice(21))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 110-114)', () => readySlice(22))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 115-119)', () => readySlice(23))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 120-124)', () => readySlice(24))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 125-129)', () => readySlice(25))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 130-134)', () => readySlice(26))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 135-139)', () => readySlice(27))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 140-144)', () => readySlice(28))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 145-149)', () => readySlice(29))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 150-154)', () => readySlice(30))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 155-159)', () => readySlice(31))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 160-164)', () => readySlice(32))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 165-169)', () => readySlice(33))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 170-174)', () => readySlice(34))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 175-179)', () => readySlice(35))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 180-184)', () => readySlice(36))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 185-189)', () => readySlice(37))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 190-194)', () => readySlice(38))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 195-199)', () => readySlice(39))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 200-204)', () => readySlice(40))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 205-209)', () => readySlice(41))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 210-214)', () => readySlice(42))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 215-219)', () => readySlice(43))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 220-224)', () => readySlice(44))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 225-229)', () => readySlice(45))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 230-234)', () => readySlice(46))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 235-239)', () => readySlice(47))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 240-244)', () => readySlice(48))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 245-249)', () => readySlice(49))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 250-254)', () => readySlice(50))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 255-259)', () => readySlice(51))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 260-264)', () => readySlice(52))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 265-269)', () => readySlice(53))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 270-274)', () => readySlice(54))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 275-279)', () => readySlice(55))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 280-284)', () => readySlice(56))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 285-289)', () => readySlice(57))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 290-294)', () => readySlice(58))
  test('I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences 295-299)', () => readySlice(59))

  test('I1 after readiness: every sequence booted its app-server, and the sequences reached helpers, handlers and a crash-caused rejection', () => {
    expect(reached.filter(Boolean)).toHaveLength(300)
    expect(reached.filter((r) => r.leaders < 1)).toEqual([])
    expect(reached.some((r) => r.helpers > 0)).toBe(true)
    expect(reached.some((r) => r.handlers > 0)).toBe(true)
    expect(reached.some((r) => r.rejected)).toBe(true)
  })
})
