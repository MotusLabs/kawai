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

async function run(seed: number): Promise<Verdict> {
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
  void h.driver.start().catch(() => {})
  let stop: Promise<unknown> | null = null
  let verdictAtStop: { live: number[]; open: number } | null = null
  let receipt: ProcessExitReceipt | null = null
  const terminal = (mode: 'kill' | 'shutdown') => {
    const s = h.driver[mode]()
    const observe = () => {
      verdictAtStop ??= { live: pids(h.root.home).filter(alive), open: started - finished }
    }
    void s.then((r) => {
      receipt ??= r
      observe()
    }, observe)
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
  const counts = new Map<string, number>()
  for (const r of h.results as TurnResult[]) counts.set(r.turnId, (counts.get(r.turnId) ?? 0) + 1)
  return {
    ops,
    liveAtStop: verdictAtStop!.live,
    handlersOpenAtStop: verdictAtStop!.open,
    unreported: receipt ? leaders(h.root.home).filter((pid) => !(receipt as ProcessExitReceipt).processes.some((p) => p.state === 'exited' && p.pid === pid)) : [],
    unsettledHandles: handles.filter((handle) => !settled.has(`${handle.turnId}:${handle.messageUuid}`)).length,
    duplicateResults: [...counts].filter(([, c]) => c > 1).map(([id]) => id),
  }
}

describe('Codex stop: I1 over fixed-seed operation sequences', () => {
  // 0xA601, 300 sequences, in twenty slices so each test stays within its timeout.
  for (let slice = 0; slice < 20; slice++) {
    test(`I1: the stop settles only after every owned process exited and every admitted handler finished (sequences ${slice * 15}-${slice * 15 + 14})`, async () => {
      for (let i = slice * 15; i < slice * 15 + 15; i++) {
        const verdict = await run(0xa601 + i * 7919)
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
