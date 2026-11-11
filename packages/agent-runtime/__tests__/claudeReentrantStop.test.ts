// @reads: packages/agent-runtime/__tests__/fixtures/**
// F1: a stop reentered before its transaction is published (task 4.1 R2,
// oracle hazard F1/L12/O2). The production composition: the real
// ClaudeSession, the pinned SDK's query(), the owned spawner and the fake CLI.
// A stop must reserve its terminal outcome and first mode before any
// external callback can run: the onState('stopping') publication, or the
// turn settlement inside its own teardown. A nested or repeated kill or
// shutdown then shares that one transaction. The test detects a duplicate
// transaction directly (teardown calls, receipt identity), not only through
// the eventual exit, and checks that the SDK's own abort of the hung query is
// never reported as an independent failure.
import { afterAll, describe, expect, test } from 'bun:test'
import { ClaudeSession } from '../src/claude/session.js'
import type { DriverState, ProcessExitReceipt, TurnResult } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import { DriverLifecycle } from '../src/lifecycle/lifecycle.js'
import { liveGroupMembers } from '../src/process/processGroup.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const sessions: ClaudeSession[] = []
afterAll(async () => {
  await Promise.allSettled(sessions.map((s) => s.kill()))
})

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Settles within `ms`, else rejects: a hanging stop must fail the test, not stall the suite. */
function within<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))])
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await tick(10)
  }
}

type Outcome = { ok: true; receipt: ProcessExitReceipt } | { ok: false; error: unknown }
const outcome = (promise: Promise<ProcessExitReceipt>): Promise<Outcome> =>
  within(promise).then((receipt) => ({ ok: true as const, receipt }), (error: unknown) => ({ ok: false as const, error }))

interface Hooks {
  onTurnResult?(s: ClaudeSession, result: TurnResult): void
  onState?(s: ClaudeSession, state: DriverState): void
}

/** A session on the fake CLI whose teardown calls are counted by mode. */
function session(hooks: Hooks) {
  const home = fakeClaudeHome()
  const states: DriverState[] = []
  const s: ClaudeSession = new ClaudeSession({
    launch: home.launch(),
    callbacks: {
      onEvent: () => {},
      onTurnResult: (r) => hooks.onTurnResult?.(s, r),
      onProcessEnd: () => {},
      onState: (state) => {
        states.push(state)
        hooks.onState?.(s, state)
      },
    },
    terminate: { graceMs: 300, killMs: 3000 },
  })
  sessions.push(s)
  const teardowns: string[] = []
  const raw = s as unknown as { teardown(mode: string): Promise<unknown> }
  const original = raw.teardown.bind(s)
  raw.teardown = (mode) => {
    teardowns.push(mode)
    return original(mode)
  }
  const owners = () => (s as unknown as { generations: Array<{ owned: { pid: number; exited: unknown } | null }> }).generations.map((g) => g.owned)
  return { s, states, teardowns, owners }
}

function joined(h: ReturnType<typeof session>) {
  for (const owned of h.owners()) {
    expect(owned).not.toBeNull()
    expect(owned!.exited).not.toBeNull()
    expect(alive(owned!.pid)).toBe(false)
    expect(liveGroupMembers(owned!.pid)).toEqual([])
  }
  expect(h.s.lifecycle.jobs.size).toBe(0)
}

/** One transaction: one teardown in the first mode, one 'stopped', every caller sharing the outcome. */
function oneTransaction(h: ReturnType<typeof session>, first: Outcome, others: Outcome[], mode: 'kill' | 'shutdown') {
  expect(h.teardowns).toEqual([mode])
  expect(h.states.filter((state) => state === 'stopping')).toEqual(['stopping'])
  expect(h.states.filter((state) => state === 'stopped')).toEqual(['stopped'])
  for (const other of others) {
    if (first.ok) {
      expect(other.ok).toBe(true)
      expect(other.ok && other.receipt).toBe(first.receipt)
    } else {
      expect(other.ok).toBe(false)
      expect(!other.ok && other.error).toBe(first.error)
    }
  }
}

describe('F1: a reentered stop shares the one transaction', () => {
  for (const nested of ['kill', 'shutdown'] as const) {
    test(`an external kill whose interrupted turn result calls ${nested}() unawaited shares the kill`, async () => {
      let inner: Promise<ProcessExitReceipt> | null = null
      const h = session({
        onTurnResult: (s, r) => {
          if (r.outcome !== 'interrupted' || inner) return
          inner = s[nested]()
          inner.catch(() => {})
        },
      })
      await h.s.start()
      const hung = await h.s.send('hang')
      await until(() => h.s.state === 'active')
      const first = await outcome(h.s.kill())
      expect(inner).not.toBeNull()
      const nestedOutcome = await outcome(inner!)
      const later = await outcome(h.s.shutdown())
      expect(first.ok ? null : first.error).toBeNull()
      expect(first.ok && first.receipt.mode).toBe('kill')
      oneTransaction(h, first, [nestedOutcome, later], 'kill')
      expect((await within(hung.result)).outcome).toBe('interrupted')
      joined(h)
    })
  }

  for (const turn of [false, true]) {
    test(`an onState('stopping') callback that calls shutdown() shares the kill (${turn ? 'hung turn' : 'no active turn'})`, async () => {
      let inner: Promise<ProcessExitReceipt> | null = null
      const h = session({
        onState: (s, state) => {
          if (state !== 'stopping' || inner) return
          inner = s.shutdown()
          inner.catch(() => {})
        },
      })
      await h.s.start()
      const hung = turn ? await h.s.send('hang') : null
      if (turn) await until(() => h.s.state === 'active')
      const first = await outcome(h.s.kill())
      expect(inner).not.toBeNull()
      const nestedOutcome = await outcome(inner!)
      expect(first.ok ? null : first.error).toBeNull()
      expect(first.ok && first.receipt.mode).toBe('kill')
      oneTransaction(h, first, [nestedOutcome], 'kill')
      if (hung) expect((await within(hung.result)).outcome).toBe('interrupted')
      joined(h)
    })
  }

  test('a nested kill from a throwing turn-result callback: the stop fails with that throw only, by identity', async () => {
    const thrown = new Error('turn-result callback failed')
    let inner: Promise<ProcessExitReceipt> | null = null
    const h = session({
      onTurnResult: (s, r) => {
        if (r.outcome !== 'interrupted' || inner) return
        inner = s.kill()
        inner.catch(() => {})
        throw thrown
      },
    })
    await h.s.start()
    const hung = await h.s.send('hang')
    await until(() => h.s.state === 'active')
    const first = await outcome(h.s.kill())
    const nestedOutcome = await outcome(inner!)
    expect(first.ok).toBe(false)
    const error = (first as { error: unknown }).error as AgentRuntimeError
    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect(error.category).toBe('stop')
    expect(error.causes).toEqual([thrown])
    expect(error.causes[0]).toBe(thrown)
    expect(h.teardowns).toEqual(['kill'])
    expect(!nestedOutcome.ok && nestedOutcome.error).toBe(error)
    expect((await within(hung.result)).outcome).toBe('interrupted')
    joined(h)
  })
})

describe('F1 at the lifecycle core', () => {
  test("a stop reentered from onState('stopping') shares the first transaction and mode; teardown runs once", async () => {
    const calls: string[] = []
    let inner: Promise<ProcessExitReceipt> | null = null
    const lifecycle: DriverLifecycle = new DriverLifecycle({
      continuations: new Set(),
      onState: (state) => {
        if (state !== 'stopping' || inner) return
        inner = lifecycle.stop('shutdown', async () => {
          calls.push('shutdown')
          return []
        })
        inner.catch(() => {})
      },
    })
    const outer = lifecycle.stop('kill', async () => {
      calls.push('kill')
      return []
    })
    const receipt = await within(outer)
    expect(inner).not.toBeNull()
    expect(await within(inner!)).toBe(receipt)
    expect(receipt.mode).toBe('kill')
    expect(calls).toEqual(['kill'])
    expect(lifecycle.state).toBe('stopped')
  })
})
