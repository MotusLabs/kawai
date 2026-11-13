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
// operations while the first generation is still booting; a cold stop may
// land before or after the fake app-server runs, so a cold sequence may boot
// and crash generations too. The second describe replays the same seeds and operations after the first
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
//
// Stop oracle (task-3c3e3658 R5, A15-A17): both variants share checkStop().
// Expected native exits come only from the fixture's opt-in EXIT INTENT trace
// (FAKE_CODEX_EXIT_TRACE=1: {pid, code} appended just before the server
// exits itself), on recorded leader pids, in envs.jsonl order. Each launch
// carries a unique I1_LAUNCH_TOKEN; envs.jsonl maps pid to token and onSpawn
// maps token to generation, and the mapping must be a bijection. No nonzero
// intent requires a resolved stop; otherwise the stop rejects with category
// 'stop' and exactly those NativeExitFailure causes, in order, unflattened.
// Residual (disclosed): an intent records what the server meant to do, not
// what the owner observed. A kill landing between the append and io.exit
// would leave an intent with an owned signal exit and no cause; the check
// then fails and the design reopens. Mismatches are never filtered.
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexAgentDriver, ProcessExitReceipt, TurnHandle, TurnResult } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { SpawnInfo, ToolSet } from '../src/options.js'
import { NativeExitFailure } from '../src/process/nativeVerdict.js'
import { alive, codexDriver, codexRoot, pids } from './helpers/codexDriverHarness.js'
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

/** Every record of a JSONL file; a missing file is empty, any other read or parse error throws. */
function readJsonl(file: string): unknown[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown)
}

/** One native exit the stop must report: a leader's nonzero exit intent at its exact generation. */
interface Crash {
  pid: number
  code: number
  generation: number
}

/** A launch the driver reported through onSpawn: its generation and the token its childEnv carried. */
interface Spawned {
  generation: number
  token: unknown
}

const isInt = (value: unknown): value is number => Number.isInteger(value)

/**
 * The expected native exits, in leader (envs.jsonl) order. Throws on a
 * malformed record or a pid/token/generation mapping that is not a bijection.
 */
function expectedCrashes(intents: readonly unknown[], leaderRecords: readonly unknown[], spawns: readonly Spawned[]): Crash[] {
  const leaders = leaderRecords.map((record, k) => {
    const { pid, env } = (record ?? {}) as { pid?: unknown; env?: { I1_LAUNCH_TOKEN?: unknown } }
    const token = env?.I1_LAUNCH_TOKEN
    if (!isInt(pid) || typeof token !== 'string') throw new Error(`malformed leader record ${k}: ${JSON.stringify(record)}`)
    return { pid, token }
  })
  const unique = (values: unknown[], what: string) => {
    if (new Set(values).size !== values.length) throw new Error(`duplicate ${what}: ${JSON.stringify(values)}`)
  }
  unique(leaders.map((l) => l.pid), 'leader pid')
  unique(leaders.map((l) => l.token), 'leader token')
  for (const [k, s] of spawns.entries()) if (!isInt(s.generation) || typeof s.token !== 'string') throw new Error(`malformed spawn ${k}: ${JSON.stringify(s)}`)
  unique(spawns.map((s) => s.token), 'spawn token')
  unique(spawns.map((s) => s.generation), 'spawn generation')
  const generationOf = new Map(spawns.map((s) => [s.token as string, s.generation]))
  const codeOf = new Map<number, number>()
  for (const [k, record] of intents.entries()) {
    const { pid, code } = (record ?? {}) as { pid?: unknown; code?: unknown }
    if (!isInt(pid) || !isInt(code)) throw new Error(`malformed exit intent ${k}: ${JSON.stringify(record)}`)
    if (!leaders.some((l) => l.pid === pid)) throw new Error(`exit intent ${k} from a pid no leader recorded: ${pid}`)
    if (codeOf.has(pid)) throw new Error(`duplicate exit intent for pid ${pid}`)
    codeOf.set(pid, code)
  }
  const crashes: Crash[] = []
  for (const { pid, token } of leaders) {
    const generation = generationOf.get(token)
    if (generation === undefined) throw new Error(`leader ${pid} token ${token} has no onSpawn generation`)
    const code = codeOf.get(pid)
    if (code !== undefined && code !== 0) crashes.push({ pid, code, generation })
  }
  return crashes
}

/** Every way the stop differs from exactly the expected native exits; empty when it matches. */
function stopMismatch(expected: readonly Crash[], stop: { rejected: boolean; error: unknown }): string[] {
  if (expected.length === 0) return stop.rejected ? [`expected a resolved stop, got a rejection: ${String(stop.error)}`] : []
  if (!stop.rejected) return [`expected a rejected stop with ${expected.length} native exit(s), got a resolved stop`]
  const error = stop.error
  if (!(error instanceof AgentRuntimeError) || error.category !== 'stop') return [`expected a stop-category AgentRuntimeError, got ${String(error)}`]
  const problems: string[] = []
  if (error.causes.length !== expected.length) problems.push(`expected ${expected.length} cause(s), got ${error.causes.length}`)
  for (const [k, cause] of error.causes.entries()) {
    const want = expected[k]
    if (!want) continue
    if (!(cause instanceof NativeExitFailure)) {
      problems.push(`cause ${k} is not a NativeExitFailure: ${String(cause)}`)
      continue
    }
    const { facts } = cause
    const got: Record<string, unknown> = { category: cause.category, pid: facts.pid, code: facts.code, generation: facts.generation, signal: facts.signal }
    const wanted: Record<string, unknown> = { category: 'transport', pid: want.pid, code: want.code, generation: want.generation, signal: null }
    for (const key of Object.keys(wanted)) if (!Object.is(got[key], wanted[key])) problems.push(`cause ${k} ${key}: expected ${String(wanted[key])}, got ${String(got[key])}`)
    if (typeof facts.observedBeforeStop !== 'boolean') {
      problems.push(`cause ${k} observedBeforeStop is not a boolean: ${String(facts.observedBeforeStop)}`)
      continue
    }
    const phrase = `agent process generation ${want.generation} exited with code ${want.code}${facts.observedBeforeStop ? ' before the stop' : ' after the stop began'}`
    if (cause.message !== phrase) problems.push(`cause ${k} message: expected ${JSON.stringify(phrase)}, got ${JSON.stringify(cause.message)}`)
  }
  return problems
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

/** The raw trace a sequence left: exit intents, leader records and onSpawn launches. */
interface Trace {
  intents: unknown[]
  leaders: unknown[]
  spawns: Spawned[]
}

async function run(seed: number, ready = false): Promise<{ verdict: Verdict; reach: Reach; stop: Stop; trace: Trace }> {
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
  const spawns: Spawned[] = []
  try {
    const root = codexRoot()
    let launches = 0
    const launch = () => root.launch({ FAKE_CODEX_EXIT_TRACE: '1', I1_LAUNCH_TOKEN: `${seed}:${ready ? 'ready' : 'cold'}:${++launches}` })
    const onSpawn = (info: SpawnInfo) => void spawns.push({ generation: info.generation, token: info.childEnv.I1_LAUNCH_TOKEN })
    h = codexDriver({ root, launch, callbacks: { onSpawn }, tools, unansweredRequests: 'wait', enroll: (driver) => admission.enroll(driver) })
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
  const trace: Trace = { intents: readJsonl(join(h.root.home, 'exit-intents.jsonl')), leaders: readJsonl(join(h.root.home, 'envs.jsonl')), spawns }
  return { verdict, reach, stop: { driver: h.driver, rejected: stopRejected, error: stopError }, trace }
}

/**
 * Both variants: the stop must report exactly the expected native exits;
 * only then is that one original rejection value authorized.
 */
function checkStop(i: number, stop: Stop, trace: Trace): void {
  const mismatch = stopMismatch(expectedCrashes(trace.intents, trace.leaders, trace.spawns), stop)
  expect({ i, mismatch }).toEqual({ i, mismatch: [] })
  if (stop.rejected) drivers.authorize(stop.driver, stop.error)
}

describe('Codex stop: I1 over fixed-seed operation sequences', () => {
  // 0xA601, 300 sequences, in twenty slices so each test stays within its timeout.
  for (let slice = 0; slice < 20; slice++) {
    test(`I1: the stop settles only after every owned process exited and every admitted handler finished (sequences ${slice * 15}-${slice * 15 + 14})`, async () => {
      for (let i = slice * 15; i < slice * 15 + 15; i++) {
        const { verdict, stop, trace } = await run(0xa601 + i * 7919)
        expect({ i, ...verdict }).toEqual({ i, ops: verdict.ops, liveAtStop: [], handlersOpenAtStop: 0, unreported: [], unsettledHandles: 0, duplicateResults: [] })
        checkStop(i, stop, trace)
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
      const { verdict, reach, stop, trace } = await run(0xa601 + i * 7919, true)
      reached[i] = reach
      expect({ i, ...verdict }).toEqual({ i, ops: verdict.ops, liveAtStop: [], handlersOpenAtStop: 0, unreported: [], unsettledHandles: 0, duplicateResults: [] })
      expect(reach.rejected).toBe(reach.failure !== null)
      // A rejected stop is expected only as exactly its traced native exits; only then is it authorized.
      checkStop(i, stop, trace)
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

describe('Codex stop: the exact native-exit stop oracle', () => {
  test('I1 stop oracle: zero, one and multiple exact native exits pass; every listed mismatch and malformed trace fails', () => {
    const exit = (generation: number, pid: number, code: number, observedBeforeStop: boolean | null = true, signal: NodeJS.Signals | null = null) =>
      new NativeExitFailure({ generation, pid, code, signal, observedBeforeStop }, [])
    const rejected = (causes: unknown[], category: 'stop' | 'transport' = 'stop') => ({ rejected: true, error: new AgentRuntimeError({ category, message: 'stop failed' }, causes) })
    const resolved = { rejected: false, error: null }
    const one: Crash[] = [{ pid: 101, code: 5, generation: 1 }]
    const two: Crash[] = [{ pid: 101, code: 5, generation: 1 }, { pid: 202, code: 5, generation: 3 }]
    const rephrased = exit(1, 101, 5)
    Object.defineProperty(rephrased, 'message', { value: 'agent process generation 1 exited with code 5 after the stop began' })
    const stops: [string, Crash[], { rejected: boolean; error: unknown }, boolean][] = [
      ['zero expected, resolved', [], resolved, true],
      ['one expected, before the stop', one, rejected([exit(1, 101, 5)]), true],
      ['one expected, after the stop began', one, rejected([exit(1, 101, 5, false)]), true],
      ['multiple expected, in order', two, rejected([exit(1, 101, 5), exit(3, 202, 5, false)]), true],
      ['zero expected, rejected', [], rejected([exit(1, 101, 5)]), false],
      ['one expected, resolved', one, resolved, false],
      ['missing cause', two, rejected([exit(1, 101, 5)]), false],
      ['extra cause', one, rejected([exit(1, 101, 5), exit(3, 202, 5)]), false],
      ['duplicate pid', two, rejected([exit(1, 101, 5), exit(3, 101, 5)]), false],
      ['wrong pid', one, rejected([exit(1, 102, 5)]), false],
      ['wrong code', one, rejected([exit(1, 101, 6)]), false],
      ['wrong generation', one, rejected([exit(2, 101, 5)]), false],
      ['wrong signal', one, rejected([exit(1, 101, 5, true, 'SIGTERM')]), false],
      ['wrong order', two, rejected([exit(3, 202, 5), exit(1, 101, 5)]), false],
      ['non-native cause', one, rejected([new AgentRuntimeError({ category: 'transport', message: 'agent process generation 1 exited with code 5 before the stop' })]), false],
      ['nested native cause', one, rejected([new AgentRuntimeError({ category: 'stop', message: 'inner' }, [exit(1, 101, 5)])]), false],
      ['non-stop error category', one, rejected([exit(1, 101, 5)], 'transport'), false],
      ['no exit evidence', one, rejected([exit(1, 101, 5, null)]), false],
      ['wrong timing phrase', one, rejected([rephrased]), false],
    ]
    const leader = (pid: number, token: string) => ({ pid, cwd: '/w', env: { I1_LAUNCH_TOKEN: token } })
    const spawns: Spawned[] = [{ generation: 1, token: 'a' }, { generation: 2, token: 'b' }, { generation: 3, token: 'c' }]
    const ab = [leader(101, 'a'), leader(202, 'c')]
    const traces: [string, unknown[], unknown[], Spawned[], Crash[] | 'throws'][] = [
      ['no intents', [], ab, spawns, []],
      ['one nonzero intent', [{ pid: 101, code: 5 }], ab, spawns, one],
      ['multiple nonzero intents, leader order', [{ pid: 202, code: 5 }, { pid: 101, code: 5 }], ab, spawns, two],
      ['a zero intent is no crash', [{ pid: 101, code: 0 }], ab, spawns, []],
      ['malformed intent', [{ pid: 101, code: '5' }], ab, spawns, 'throws'],
      ['intent from no leader', [{ pid: 303, code: 5 }], ab, spawns, 'throws'],
      ['duplicate intent', [{ pid: 101, code: 5 }, { pid: 101, code: 5 }], ab, spawns, 'throws'],
      ['malformed leader', [], [{ pid: 101, env: {} }], spawns, 'throws'],
      ['duplicate leader pid', [], [leader(101, 'a'), leader(101, 'c')], spawns, 'throws'],
      ['duplicate leader token', [], [leader(101, 'a'), leader(202, 'a')], spawns, 'throws'],
      ['leader token without onSpawn', [], [leader(101, 'z')], spawns, 'throws'],
      ['token in two spawns', [], ab, [...spawns, { generation: 4, token: 'a' }], 'throws'],
      ['duplicate generation', [], ab, [...spawns, { generation: 1, token: 'd' }], 'throws'],
      ['malformed spawn token', [], ab, [...spawns, { generation: 4, token: undefined }], 'throws'],
    ]
    const stopOutcomes = stops.map(([name, expected, stop]) => [name, stopMismatch(expected, stop).length === 0])
    expect(stopOutcomes).toEqual(stops.map(([name, , , passes]) => [name, passes]))
    const traceOutcomes = traces.map(([name, intents, leaders, s]) => {
      try {
        return [name, expectedCrashes(intents, leaders, s)]
      } catch {
        return [name, 'throws']
      }
    })
    expect(traceOutcomes).toEqual(traces.map(([name, , , , want]) => [name, want]))
  })
})
