// codex-capacity-retry properties P1-P3 (design "Acceptance oracles", task
// 2.3): seeded command sequences of up to 100 events drawn from the lifecycle
// rows (capacity, other and success completions, duplicate and late frames of
// retired attempts, upstream retries, early, due, late and oversleeping
// wakeups, wall-clock jumps, Stop, urgent interruption, human input, refused
// and deferred continuation starts, and crashes with a resumed successor)
// drive the real package session over the scripted app-server and fake clock.
// The reference is oracles/capacityModel.ts, written from the tables, never
// the production reducer. Crashes land before and after continuation dispatch
// and before and after final emission; Stop lands between dispatch and the
// start response, whose reply may be withheld past newer input and arrive
// before or after its own turn/started (start ownership, L1). 1,000 declared cases each (propertyCases: a quarter in
// local and hook runs, all under CI and --full-properties).
import { afterEach, expect, test } from 'bun:test'
import { propertyCases } from './helpers/propertyCases.js'
import { CODEX_CAPACITY_CONTINUATION } from '../src/codex/continuation.js'
import { CapacityModel } from './oracles/capacityModel.js'
import { frames, scriptedCodex, THREAD, type ClientRequest, type Scripted } from './helpers/scriptedCodex.js'
import { LIVE, scripted, stopScripted } from './helpers/capacitySteps.js'

afterEach(stopScripted)

const CASES = 1000
const STEPS = 100

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Weights = Record<string, number>
const BASE: Weights = { release: 3, capacity: 6, other: 1, success: 2, upstream: 2, stale: 2, small: 3, due: 4, late: 2, early: 2, wall: 1, stop: 1, urgent: 1, steer: 1, crash: 1, reject: 1, defer: 2 }
const TIMING: Weights = { ...BASE, capacity: 9, due: 6, late: 4, early: 3, wall: 3, stop: 0.3, urgent: 0.3, steer: 0.3, crash: 0.3 }
const CANCEL: Weights = { ...BASE, stop: 3, urgent: 3, steer: 3, crash: 2, defer: 4, stale: 4 }

function pick(random: () => number, weights: Weights, allowed: string[]): string {
  const total = allowed.reduce((sum, key) => sum + (weights[key] ?? 0), 0)
  let draw = random() * total
  for (const key of allowed) if ((draw -= weights[key] ?? 0) <= 0) return key
  return allowed.at(-1)!
}

interface Run {
  s: Scripted
  model: CapacityModel
  /** The running attempt's native id, or null while unbound, in backoff or idle. */
  attempt: string | null
  /** A dispatched continuation still awaiting its turn/start reply. */
  pending: ClientRequest | null
  /** A Stop-cancelled continuation whose reply (carrying `id`) the app-server has not sent yet. */
  withheld: { request: ClientRequest; id: string } | null
  random: () => number
  seenStarts: number
  ids: number
  /** Every continuation request of every session generation, with its write time. */
  continuations: ClientRequest[]
  interrupts: string[]
  terminals: number
  trace: string[]
  /** Each session generation's event types, for failure reports. */
  types: string[]
  /** Native ids bound in the current session generation (a stale frame names only these). */
  bound: string[]
}

const isContinuation = (r: ClientRequest) => r.params.input?.[0]?.text === CODEX_CAPACITY_CONTINUATION

/** Collect the session's new turn/starts: a human turn is answered and bound at once, a continuation is held. */
async function collect(run: Run): Promise<void> {
  await run.s.flush()
  const starts = run.s.turnStarts()
  for (const request of starts.slice(run.seenStarts)) {
    if (isContinuation(request)) {
      run.continuations.push(request)
      run.pending = request
    } else {
      // turn/started may precede the reply (it names no request).
      const id = `n${++run.ids}`
      if (run.random() < 0.5) run.s.notify(...frames.started(id))
      run.s.reply(request.id, { turn: { id } })
      run.s.notify(...frames.started(id))
      run.attempt = id
      run.bound.push(id)
    }
  }
  run.seenStarts = starts.length
  await run.s.flush()
}

/** The withheld reply of a cancelled continuation arrives, before or after its own turn/started. */
async function release(run: Run): Promise<void> {
  const { request, id } = run.withheld!
  run.withheld = null
  if (run.random() < 0.5) run.s.notify(...frames.started(id))
  run.s.reply(request.id, { turn: { id } })
  run.s.notify(...frames.started(id))
  run.bound.push(id)
  return collect(run)
}

function sessionTotals(run: Run) {
  run.interrupts.push(...run.s.interrupts().map((r) => r.params.turnId as string))
  run.terminals += run.s.events.filter((e) => e.type === 'turn_completed' || e.type === 'turn_interrupted').length
  run.types.push(run.s.types().join(' '))
}

/** The crashed backend's successor: a new session resuming the thread, on the same monotonic clock. */
async function fresh(run: Run): Promise<void> {
  run.s = scriptedCodex({ capacityRecovery: 'bounded', clock: run.s.clock, resume: THREAD })
  LIVE.push(run.s)
  run.seenStarts = 0
  run.bound = []
  await run.s.driver.start()
}

async function step(run: Run, random: () => number, weights: Weights): Promise<void> {
  const { model } = run
  const s = () => run.s
  const waiting = run.withheld !== null && model.phase === 'running' && run.attempt === null && !run.pending
  const allowed = waiting ? ['release', 'stop', 'crash', 'small'] : [...(run.withheld ? ['release'] : []), ...(
    model.phase === 'idle' ? ['send', 'crash', 'stale', 'early', 'small'] :
    model.phase === 'backoff' ? ['small', 'due', 'late', 'early', 'wall', 'stop', 'urgent', 'steer', 'crash', 'stale', 'upstream'] :
    run.pending ? ['defer', 'reject', 'stop', 'urgent', 'crash', 'small'] :
    ['capacity', 'other', 'success', 'upstream', 'stale', 'small', 'stop', 'urgent', 'steer', 'crash'])]
  const event = pick(random, { ...weights, send: 1 }, allowed)
  run.trace.push(`${event}@${run.s.clock.now}:${model.phase}`)
  const clock = s().clock
  switch (event) {
    case 'send':
      model.open()
      await s().driver.send(`work ${run.ids}`)
      return collect(run)
    case 'capacity': {
      const r = random()
      // The only draw this failure may consume: one an expired failure left unread must not reach a later one.
      clock.randoms.splice(0, clock.randoms.length, r)
      model.capacityFailure(clock.now, r)
      s().notify(...frames.failed(run.attempt!, 'serverOverloaded'))
      run.attempt = null
      return collect(run)
    }
    case 'other':
    case 'success':
      model.end()
      if (event === 'other') s().notify(...frames.failed(run.attempt!, random() < 0.5 ? 'contextWindowExceeded' : { serverOverloaded: {} }))
      else s().notify(...frames.completed(run.attempt!))
      run.attempt = null
      return collect(run)
    case 'upstream':
      s().notify(...frames.retryError(run.attempt ?? 'n0', 'serverOverloaded', random() < 0.5))
      return collect(run)
    case 'stale':
      // Duplicate and late frames of retired or ended attempts (L1, L19).
      for (const id of run.bound.slice(-2)) if (id !== run.attempt) {
        s().notify(...frames.failed(id, 'serverOverloaded'))
        s().notify(...frames.started(id))
      }
      return collect(run)
    case 'small':
    case 'due':
    case 'late': {
      const due = model.due ?? clock.now
      const ms = event === 'small' ? Math.floor(random() * 900) : event === 'due' ? Math.max(0, due - clock.now) + (random() < 0.5 ? 0 : 1) : 600_000 * random()
      model.advance(clock.now, clock.now + ms)
      clock.advance(ms)
      return collect(run)
    }
    case 'early':
    case 'wall': {
      // An oversleeping or early callback (only `now` decides), or a wall-clock jump.
      if (event === 'wall') clock.wallOffset += Math.floor((random() - 0.5) * 7_200_000)
      else clock.now += random() < 0.3 ? Math.floor(random() * 700_000) : 0
      if (event === 'early' && model.phase === 'backoff') model.wake(clock.now)
      if (event === 'early') clock.fireAll()
      return collect(run)
    }
    case 'defer':
    case 'reject': {
      const request = run.pending!
      run.pending = null
      if (event === 'reject') {
        model.end()
        s().fail(request.id, 'turn refused', 'serverOverloaded')
        return collect(run)
      }
      const id = `n${++run.ids}`
      if (random() < 0.5) s().notify(...frames.started(id))
      s().reply(request.id, { turn: { id } })
      s().notify(...frames.started(id))
      run.attempt = id
      run.bound.push(id)
      return collect(run)
    }
    case 'stop':
    case 'urgent': {
      const pending = run.pending
      const cleanup = pending ? `n${++run.ids}` : run.attempt
      model.cancel(cleanup)
      await s().driver.interrupt()
      // Stop between dispatch and the start response: the late reply supplies the cancelled attempt's id,
      // now or (withheld) after newer input, in either order with its turn/started.
      if (pending && !run.withheld && random() < 0.5) run.withheld = { request: pending, id: cleanup! }
      else if (pending) {
        s().reply(pending.id, { turn: { id: cleanup } })
        s().notify(...frames.started(cleanup!))
        run.bound.push(cleanup!)
      }
      run.pending = null
      run.attempt = null
      if (event === 'urgent') {
        model.open()
        await s().driver.send('<peer-message from="lead">urgent</peer-message>')
      }
      return collect(run)
    }
    case 'steer': {
      if (model.phase === 'backoff') {
        model.end()
        model.open()
        await s().driver.send('human', { continuation: 'steer' }).catch(() => s().driver.send('human'))
      } else {
        await s().driver.send('human', { continuation: 'steer' })
      }
      return collect(run)
    }
    case 'release':
      return release(run)
    case 'crash': {
      // Crash before or after dispatch and before or after final emission: the successor resumes nothing.
      if (model.phase !== 'idle') model.cancel(null)
      await s().driver.kill()
      await s().flush()
      sessionTotals(run)
      // The backend ended before the cancelled attempt's id was known: no cleanup interrupt is owed.
      if (run.withheld) model.forget(run.withheld.id)
      run.withheld = null
      run.pending = null
      run.attempt = null
      return fresh(run)
    }
  }
}

function check(run: Run): void {
  const { s, model } = run
  // P1: at most one pending wakeup, and none while an attempt runs.
  expect(s.clock.pending).toBe(model.phase === 'backoff' ? 1 : 0)
  expect(run.continuations.length).toBe(model.continuations)
  expect(run.pending === null || s.clock.pending === 0).toBe(true)
}

async function property(seed: number, weights: Weights, after: (run: Run) => void): Promise<void> {
  for (let index = 0; index < propertyCases(CASES); index++) {
    const random = mulberry32(seed + index * 0x9e3779b1)
    const run: Run = { s: scripted('bounded'), model: new CapacityModel(), attempt: null, pending: null, withheld: null, random, seenStarts: 0, ids: 0, continuations: [], interrupts: [], terminals: 0, trace: [], types: [], bound: [] }
    await run.s.driver.start()
    const steps = 1 + Math.floor(random() * STEPS)
    for (let i = 0; i < steps; i++) {
      await step(run, random, weights)
      try {
        check(run)
      } catch (error) {
        throw new Error(`seed ${seed} case ${index} step ${i} [${run.trace.join(' ')}]: ${(error as Error).message}`)
      }
    }
    if (run.withheld) await release(run)
    sessionTotals(run)
    // One terminal publication per logical turn the model ended.
    if (run.terminals !== run.model.terminals) throw new Error(`seed ${seed} case ${index}: ${run.terminals} terminal events, the model ${run.model.terminals} [${run.trace.join(' ')}] types [${run.types.join(' | ')}]`)
    after(run)
    await stopScripted()
  }
}

test('P1: at most one capacity continuation is pending or active (seed 0xCA9AC17, 1,000 cases)', async () => {
  await property(0xca9ac17, BASE, (run) => {
    expect(run.continuations.length).toBe(run.model.continuations)
  })
}, 600_000)

test('P2: no continuation starts at or after the original monotonic deadline (seed 0xCA9AC18, 1,000 cases)', async () => {
  await property(0xca9ac18, TIMING, (run) => {
    expect(run.continuations.map((r) => r.at)).toEqual(run.model.dispatches.map((d) => d.at))
    for (const { at, deadline } of run.model.dispatches) expect(at).toBeLessThan(deadline)
  })
}, 600_000)

test('P3: invalidation prevents every old generation from dispatching later work (seed 0xCA9AC19, 1,000 cases)', async () => {
  await property(0xca9ac19, CANCEL, (run) => {
    // Cleanup interrupts target exactly the cancelled running attempts, once each, never a newer one.
    expect(run.interrupts).toEqual(run.model.interrupts)
    expect(run.continuations.length).toBe(run.model.continuations)
  })
}, 600_000)
