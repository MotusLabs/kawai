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
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessExitReceipt, TurnHandle, TurnResult } from '../src/contract.js'
import type { ToolSet } from '../src/options.js'
import { alive, codexDriver, pids, stopDrivers } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

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

async function run(seed: number, ready = false): Promise<{ verdict: Verdict; reach: Reach }> {
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
  const h = codexDriver({ tools, unansweredRequests: 'wait' })
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
  const terminal = (mode: 'kill' | 'shutdown') => {
    const s = h.driver[mode]()
    const observe = () => {
      verdictAtStop ??= { live: pids(h.root.home).filter(alive), open: started - finished }
    }
    void s.then((r) => {
      receipt ??= r
      observe()
    }, (error: unknown) => {
      stopError ??= error
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
  return { verdict, reach }
}

describe('Codex stop: I1 over fixed-seed operation sequences', () => {
  // 0xA601, 300 sequences, in twenty slices so each test stays within its timeout.
  for (let slice = 0; slice < 20; slice++) {
    test(`I1: the stop settles only after every owned process exited and every admitted handler finished (sequences ${slice * 15}-${slice * 15 + 14})`, async () => {
      for (let i = slice * 15; i < slice * 15 + 15; i++) {
        const { verdict } = await run(0xa601 + i * 7919)
        await stopDrivers()
        expect({ i, ...verdict }).toEqual({ i, ops: verdict.ops, liveAtStop: [], handlersOpenAtStop: 0, unreported: [], unsettledHandles: 0, duplicateResults: [] })
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
  // 0xA601, the same 300 sequences, in sixty slices of five.
  for (let slice = 0; slice < 60; slice++) {
    test(`I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences ${slice * 5}-${slice * 5 + 4})`, async () => {
      for (let i = slice * 5; i < slice * 5 + 5; i++) {
        const { verdict, reach } = await run(0xa601 + i * 7919, true)
        await stopDrivers()
        reached[i] = reach
        expect({ i, ...verdict }).toEqual({ i, ops: verdict.ops, liveAtStop: [], handlersOpenAtStop: 0, unreported: [], unsettledHandles: 0, duplicateResults: [] })
        // A rejected stop is expected only from a crash: its one retained native exit, nothing else.
        expect(reach.rejected).toBe(reach.failure !== null)
        if (reach.failure) {
          expect({ i, crashed: verdict.ops.includes('crash'), category: reach.failure.category, causes: reach.failure.causes.length }).toEqual({ i, crashed: true, category: 'stop', causes: 1 })
          expect(reach.failure.causes[0]).toMatch(/^transport:agent process generation 1 exited with code 5 (before the stop|after the stop began)$/)
        }
      }
    })
  }

  test('I1 after readiness: every sequence booted its app-server, and the sequences reached helpers, handlers and a crash-caused rejection', () => {
    expect(reached.filter(Boolean)).toHaveLength(300)
    expect(reached.filter((r) => r.leaders < 1)).toEqual([])
    expect(reached.some((r) => r.helpers > 0)).toBe(true)
    expect(reached.some((r) => r.handlers > 0)).toBe(true)
    expect(reached.some((r) => r.rejected)).toBe(true)
  })
})
