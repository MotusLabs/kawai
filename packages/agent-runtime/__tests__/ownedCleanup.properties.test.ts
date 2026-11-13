// Seeded property for the shared test-cleanup owner (helpers/ownedCleanup.ts,
// task-666e5edd) on PURE MODEL owners: scripted bodies over gates, no driver.
// Seed 0xC1EA2026, 256 cases in every run (default and full alike), 1-6
// predeclared owners, at most 24 operations per case.
//
// The oracle is an independent model of the join semantics, stepped at
// quiescence (after each operation every microtask has run): a barrier is
// reserved by the first join and shared until it settles; a pass starts every
// live owner's body at once and completes when all of them settled; owners
// registered meanwhile wait for a later pass; on an empty set the barrier
// settles in the same step that saw it empty. Reported failures are the
// rejected owners not asserted with that exact value (no assertion never
// matches, so an unasserted undefined is reported), in pass order; one
// rejects raw, several as an AggregateError. A finalization hook registers an
// owner and joins in a microtask queued by a held owner's settlement (the
// a681127c class): it runs after the drain's continuation, so it gets a new
// barrier when that pass emptied the set and the pending one otherwise. A
// reentrant body calls run() and join() synchronously (the d52 class).
//
// The model predicts barrier identity (same or new) itself; the test only
// maps the model's barrier to the first promise a join returned and checks
// every later prediction against it. Every gate is released and every
// barrier and owner joined in finally.
import { expect, test } from 'bun:test'
import { ownedAggregate, ownedOnce, type OwnedOnce } from './helpers/ownedCleanup.js'

const SEED = 0xc1ea2026
const CASES = 256
const MAX_OWNERS = 6
const MAX_OPS = 24

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

/** Quiescence: every queued microtask has run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

interface Config {
  held: boolean
  rejects: boolean
  value: unknown
  assert: 'none' | 'exact' | 'mismatch'
  registered: boolean
  reenter: boolean
}

type Op =
  | { kind: 'join' }
  | { kind: 'release' | 'register' | 'run'; owner: number }
  | { kind: 'hook'; owner: number; late: number }

// ---- The independent model (no helper code, no observed promises). ----

interface ModelBarrier {
  pass: number[]
  failures: unknown[]
  settled: boolean
}

class Model {
  live: number[] = []
  active: number | null = null
  barriers: ModelBarrier[] = []
  started: boolean[]
  released: boolean[]
  registered: boolean[]
  claimed: boolean[]
  hooks: Array<number | null>
  innerJoin: Array<number | null>
  hookJoin: Array<number | null>
  /** Whether a fired hook's join started a new barrier (the emptied-pass case). */
  hookNew: Array<boolean | null>

  constructor(readonly configs: Config[]) {
    const n = configs.length
    this.started = Array(n).fill(false)
    this.released = Array(n).fill(false)
    this.registered = configs.map((c) => c.registered)
    this.claimed = Array(n).fill(false)
    this.hooks = Array(n).fill(null)
    this.innerJoin = Array(n).fill(null)
    this.hookJoin = Array(n).fill(null)
    this.hookNew = Array(n).fill(null)
    configs.forEach((c, i) => c.registered && this.live.push(i))
  }

  done(i: number): boolean {
    return this.started[i]! && (!this.configs[i]!.held || this.released[i]!)
  }

  start(i: number): void {
    if (this.started[i]) return
    this.started[i] = true
    if (this.configs[i]!.reenter) this.innerJoin[i] = this.join()
  }

  join(): number {
    if (this.active !== null) return this.active
    const id = this.barriers.push({ pass: [], failures: [], settled: false }) - 1
    this.active = id
    this.nextPass(id)
    return id
  }

  nextPass(id: number): void {
    const b = this.barriers[id]!
    if (this.live.length === 0) {
      b.settled = true
      this.active = null
      return
    }
    b.pass = [...this.live]
    for (const i of b.pass) this.start(i)
  }

  reported(i: number): boolean {
    const c = this.configs[i]!
    return c.rejects && c.assert !== 'exact'
  }

  quiesce(): void {
    while (this.active !== null) {
      const id = this.active
      const b = this.barriers[id]!
      if (!b.pass.every((i) => this.done(i))) return
      const pass = b.pass
      this.live = this.live.filter((i) => !pass.includes(i))
      for (const i of pass) if (this.reported(i)) b.failures.push(this.configs[i]!.value)
      const fired = pass.filter((i) => this.hooks[i] !== null)
      this.nextPass(id)
      for (const j of fired) {
        const k = this.hooks[j]!
        this.hooks[j] = null
        this.registered[k] = true
        this.live.push(k)
        this.hookNew[k] = this.active === null
        this.hookJoin[k] = this.join()
      }
    }
  }

  apply(op: Op): void {
    if (op.kind === 'join') this.join()
    else if (op.kind === 'release') this.released[op.owner] = true
    else if (op.kind === 'register') {
      this.registered[op.owner] = true
      this.live.push(op.owner)
    } else if (op.kind === 'run') this.start(op.owner)
    else if (op.kind === 'hook') {
      this.hooks[op.owner] = op.late
      this.claimed[op.late] = true
    }
    this.quiesce()
  }

  /** Valid operations now (the generator draws from these). */
  choices(): Op[] {
    const n = this.configs.length
    const ops: Op[] = [{ kind: 'join' }, { kind: 'join' }]
    const pass = this.active === null ? [] : this.barriers[this.active]!.pass
    const free = [...Array(n).keys()].filter((k) => !this.registered[k] && !this.claimed[k])
    for (let i = 0; i < n; i++) {
      if (this.configs[i]!.held && !this.released[i]) ops.push({ kind: 'release', owner: i })
      if (free.includes(i)) ops.push({ kind: 'register', owner: i })
      if (!this.started[i]) ops.push({ kind: 'run', owner: i })
      const lastHeld = pass.includes(i) && !this.done(i) && pass.every((p) => p === i || this.done(p))
      if (lastHeld && this.hooks[i] === null) for (const k of free) ops.push({ kind: 'hook', owner: i, late: k }, { kind: 'hook', owner: i, late: k })
    }
    return ops
  }
}

function configs(rand: () => number): Config[] {
  const n = 1 + Math.floor(rand() * MAX_OWNERS)
  return [...Array(n).keys()].map((i) => {
    const raws: unknown[] = [new Error(`owner ${i} failed`), undefined, null, 'raw', 0]
    const r = rand()
    return {
      held: rand() < 0.5,
      rejects: rand() < 0.6,
      value: raws[Math.floor(rand() * raws.length)],
      assert: r < 0.5 ? 'none' : r < 0.8 ? 'exact' : 'mismatch',
      registered: rand() < 0.7,
      reenter: rand() < 0.25,
    }
  })
}

// ---- The real owners under the helper. ----

interface Owner {
  once: OwnedOnce<void>
  body: () => Promise<void>
  release(): void
  runs: number
  asserted: { error: unknown } | null
  innerRun: Promise<void> | null
  innerJoin: Promise<void> | null
  hookJoin: Promise<void> | null
}

const stats = { cases: 0, ops: 0, aggregates: 0, raw: 0, unassertedUndefined: 0, suppressed: 0, hooksNew: 0, hooksShared: 0, reentries: 0 }

async function runCase(index: number, rand: () => number): Promise<void> {
  const cfg = configs(rand)
  const model = new Model(cfg)
  const aggregate = ownedAggregate<Owner, void>({
    join: (o) => o.once.run(o.body),
    failures: (o, outcome) =>
      outcome.status === 'rejected' && (o.asserted === null || o.asserted.error !== outcome.reason) ? [outcome.reason] : [],
    message: 'property cleanups failed',
  })
  const owners: Owner[] = cfg.map((c) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const o: Owner = {
      once: ownedOnce<void>(),
      release,
      runs: 0,
      asserted: c.assert === 'none' ? null : { error: c.assert === 'exact' ? c.value : c.value === undefined ? null : undefined },
      innerRun: null,
      innerJoin: null,
      hookJoin: null,
      body: () => {
        o.runs++
        if (c.reenter) {
          o.innerRun = o.once.run(o.body)
          o.innerJoin = aggregate.join()
          // Observed later by its model barrier; a handler now keeps an early rejection from being unhandled.
          void o.innerJoin.catch(() => {})
        }
        const outcome = () => (c.rejects ? Promise.reject(c.value) : Promise.resolve())
        return c.held ? gate.then(outcome) : outcome()
      },
    }
    return o
  })
  cfg.forEach((c, i) => c.registered && aggregate.add(owners[i]!))

  const actual = new Map<number, Promise<void>>()
  const settled = new Map<number, boolean>()
  const trace: string[] = []
  const observe = (id: number | null, promise: Promise<void> | null) => {
    if (id === null || promise === null) return
    const known = actual.get(id)
    if (known) return expect(promise).toBe(known)
    for (const other of actual.values()) expect(promise).not.toBe(other)
    actual.set(id, promise)
    settled.set(id, false)
    void promise.then(() => settled.set(id, true), () => settled.set(id, true))
  }
  const real = (op: Op) => {
    if (op.kind === 'join') return aggregate.join()
    const o = owners[op.owner]!
    if (op.kind === 'release') o.release()
    else if (op.kind === 'register') aggregate.add(o)
    else if (op.kind === 'run') void o.once.run(o.body)
    else if (op.kind === 'hook') {
      const late = owners[op.late]!
      const fire = () =>
        queueMicrotask(() => {
          aggregate.add(late)
          late.hookJoin = aggregate.join()
          void late.hookJoin.catch(() => {})
        })
      void o.once.current!.then(fire, fire)
    }
    return null
  }
  const step = async (op: Op) => {
    trace.push(JSON.stringify(op))
    stats.ops++
    const predicted = op.kind === 'join' ? (model.active ?? model.barriers.length) : null
    model.apply(op)
    // Observed at once: its settlement handler exists before any rejection.
    observe(predicted, real(op))
    await tick()
    owners.forEach((o, i) => {
      observe(model.innerJoin[i]!, o.innerJoin)
      observe(model.hookJoin[i]!, o.hookJoin)
    })
    await tick()
    expect({ case: index, trace, view: view() }).toEqual({ case: index, trace, view: expected() })
  }
  const view = () => ({
    barriers: model.barriers.map((_, id) => settled.get(id) ?? 'unobserved'),
    pending: aggregate.pending === null ? null : [...actual].find(([, p]) => p === aggregate.pending)?.[0] ?? 'unknown',
    runs: owners.map((o) => o.runs),
    live: owners.map((o) => aggregate.has(o)),
    size: aggregate.size,
    reentry: owners.map((o) => (o.innerRun === null ? null : o.innerRun === o.once.current)),
  })
  const expected = () => ({
    barriers: model.barriers.map((b) => b.settled),
    pending: model.active,
    runs: model.started.map((s) => (s ? 1 : 0)),
    live: cfg.map((_, i) => model.live.includes(i)),
    size: model.live.length,
    reentry: cfg.map((c, i) => (c.reenter && model.started[i] ? true : null)),
  })

  try {
    const budget = MAX_OPS - cfg.length - 1
    const ops = Math.floor(rand() * (budget + 1))
    for (let n = 0; n < ops; n++) {
      const choices = model.choices()
      await step(choices[Math.floor(rand() * choices.length)]!)
    }
    for (let i = 0; i < cfg.length; i++) if (cfg[i]!.held && !model.released[i]) await step({ kind: 'release', owner: i })
    await step({ kind: 'join' })
    expect([model.live.length, aggregate.size, model.active]).toEqual([0, 0, null])
    for (const [id, b] of model.barriers.entries()) {
      const promise = actual.get(id)!
      const got = await promise.then(() => ({ rejected: false, reason: undefined as unknown }), (reason: unknown) => ({ rejected: true, reason }))
      if (b.failures.length === 0) expect({ index, trace, id, got }).toEqual({ index, trace, id, got: { rejected: false, reason: undefined } })
      else if (b.failures.length === 1) {
        stats.raw++
        if (b.failures[0] === undefined) stats.unassertedUndefined++
        expect({ index, trace, id, rejected: got.rejected, raw: Object.is(got.reason, b.failures[0]) }).toEqual({ index, trace, id, rejected: true, raw: true })
      } else {
        stats.aggregates++
        const errors = got.reason instanceof AggregateError ? got.reason.errors : null
        expect({ index, trace, id, message: (got.reason as Error | undefined)?.message, count: errors?.length }).toEqual({ index, trace, id, message: 'property cleanups failed', count: b.failures.length })
        b.failures.forEach((f, n) => expect({ index, trace, id, n, same: Object.is(errors![n], f) }).toEqual({ index, trace, id, n, same: true }))
      }
    }
    stats.suppressed += cfg.filter((c, i) => c.rejects && c.assert === 'exact' && model.started[i] && model.registered[i]).length
    stats.reentries += cfg.filter((c, i) => c.reenter && model.started[i]).length
    for (const fresh of model.hookNew) if (fresh !== null) stats[fresh ? 'hooksNew' : 'hooksShared']++
    stats.cases++
  } finally {
    for (const o of owners) o.release()
    await Promise.allSettled([...actual.values(), ...owners.map((o) => o.once.current), aggregate.join()])
  }
}

test('model: seeded owned-cleanup property (0xC1EA2026, 256 cases, 1-6 owners, at most 24 operations)', async () => {
  const seeds = mulberry32(SEED)
  for (let index = 0; index < CASES; index++) {
    await runCase(index, mulberry32(Math.floor(seeds() * 2 ** 32)))
  }
  expect(stats.cases).toBe(CASES)
  // The draw reaches every class this property claims.
  expect({
    aggregates: stats.aggregates > 0,
    raw: stats.raw > 0,
    unassertedUndefined: stats.unassertedUndefined > 0,
    suppressed: stats.suppressed > 0,
    hooks: stats.hooksNew + stats.hooksShared > 0,
    reentries: stats.reentries > 0,
  }).toEqual({ aggregates: true, raw: true, unassertedUndefined: true, suppressed: true, hooks: true, reentries: true })
  console.log(`owned-cleanup property: ${JSON.stringify(stats)}`)
})
