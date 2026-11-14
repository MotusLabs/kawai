// The Claude stop's termination aggregate at its internal error boundary
// (task-f5001d7f A12/A13). owned.terminate() may reject by contract: a leader
// or group that survives SIGKILL for killMs rejects with a stop error. These
// units drive the actual terminateGenerations with owners whose terminations
// reject, are held, or fulfil, and observe every mark, abort, input end,
// terminate and query close. Every termination must settle and every close be
// attempted before the stop settles; outcomes are judged by status. They
// supplement the public-factory I1 (claudeStopOrder.test.ts) and claim
// nothing about native SIGKILL failure reachability. The K1 cases (task-a67abea1
// R2) log each kill-first send between the marks and the aborts; they prove
// the order and the joins at this boundary, not which signal ended a native
// process (claudeNativeStop.test.ts and claudeSession.test.ts do that).
import { describe, expect, test } from 'bun:test'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { newGeneration, terminateGenerations, type Generation, type SdkModule } from '../src/claude/generations.js'
import type { ProcessExitFact } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { OwnedProcess } from '../src/process/ownedProcess.js'

const sdk = { AbortError: class AbortError extends Error {} } as unknown as SdkModule

type Settled = { kind: 'resolved'; value: unknown } | { kind: 'rejected'; reason: unknown }

/** One held outcome: settled only when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

/** The owner's process state: its pid (null: never started), observed exit, and send result. */
interface OwnerState {
  pid?: number | null
  exited?: unknown
  /** What signal() does after logging: return a result or throw. */
  send?: () => boolean
}

/**
 * A generation over the actual Generation record. Its owner's terminate is
 * the given function (none for an ownerless one); its query records each
 * close attempt and may throw. Marks, sends, aborts, input ends, terminates
 * and closes are logged in the order the function performs them. The owner
 * is live (pid 100+n, no exit observed) unless `state` says otherwise.
 */
function generation(number: number, events: string[], terminate: (() => Promise<ProcessExitFact>) | null, closeThrows = false, state: OwnerState = {}): Generation {
  const g = newGeneration(number, sdk, null)
  if (terminate) {
    const owner = {
      pid: state.pid === undefined ? 100 + number : state.pid,
      exited: state.exited ?? null,
      leaderExit: new Promise(() => {}),
      markTermination: () => events.push(`mark ${number}`),
      signal: (signal: string) => (events.push(`signal ${number} ${signal}`), (state.send ?? (() => true))()),
      terminate: () => (events.push(`terminate ${number}`), terminate()),
    }
    g.owned = owner as unknown as OwnedProcess
  }
  g.abort.signal.addEventListener('abort', () => events.push(`abort ${number}`))
  const end = g.input.end.bind(g.input)
  g.input.end = () => (events.push(`input ${number}`), end())
  g.query = {
    close: () => {
      events.push(`close ${number}`)
      if (closeThrows) throw new Error('the transport is already closed')
    },
  } as unknown as Query
  return g
}

const fact = (n: number): ProcessExitFact => ({ generation: n, state: 'exited', pid: 100 + n, code: 0, signal: null, escalated: false }) as ProcessExitFact

/** Run the stop and record how it settled. */
function observe(generations: Generation[], token: object = {}, mode: 'kill' | 'shutdown' = 'kill') {
  const box: { settled: Settled | null } = { settled: null }
  const stop = terminateGenerations(generations, mode, { graceMs: 1 }, token).then(
    (value) => void (box.settled = { kind: 'resolved', value }),
    (reason: unknown) => void (box.settled = { kind: 'rejected', reason }),
  )
  return { box, stop }
}

/** Let every queued settlement run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

const closes = (events: string[]) => events.filter((e) => e.startsWith('close'))

describe('Claude terminateGenerations with a rejected owner beside a held peer', () => {
  test('the stop settles only after the held peer termination, closes every query, and rejects with the one raw terminate failure', async () => {
    const failure = new AgentRuntimeError({ category: 'stop', message: 'agent process 101 did not exit after SIGKILL' })
    const held = deferred<ProcessExitFact>()
    const events: string[] = []
    const generations = [generation(1, events, () => Promise.reject(failure)), generation(2, events, () => held.promise)]
    const token = {}
    const { box, stop } = observe(generations, token)
    try {
      await drain()
      // Both owners were asked to terminate; the peer's termination is still in flight.
      expect(events.filter((e) => e.startsWith('terminate'))).toEqual(['terminate 1', 'terminate 2'])
      expect({ settledBeforeRelease: box.settled, closesBeforeRelease: closes(events) }).toEqual({ settledBeforeRelease: null, closesBeforeRelease: [] })
    } finally {
      held.resolve(fact(2))
      await stop
    }
    expect(generations.map((g) => g.abort.signal.reason)).toEqual([token, token])
    expect(closes(events)).toEqual(['close 1', 'close 2'])
    expect(box.settled?.kind).toBe('rejected')
    expect((box.settled as { reason: unknown }).reason).toBe(failure)
  })

  test('several failures completing in reverse, supplied out of numeric order, reject once with every raw reason in supplied order', async () => {
    const same = new AgentRuntimeError({ category: 'stop', message: 'agent process group 101 kept live members after SIGKILL' })
    const inner = new Error('inner')
    const nested = new AgentRuntimeError({ category: 'stop', message: 'nested' }, [inner])
    // Supplied order 3, 1, 4, 2, 5; their reasons: nested, same, undefined, same again, null.
    const order = [3, 1, 4, 2, 5]
    const reasons: unknown[] = [nested, same, undefined, same, null]
    const holds = order.map(() => deferred<ProcessExitFact>())
    const events: string[] = []
    const generations = order.map((n, i) => generation(n, events, () => holds[i]!.promise))
    const { box, stop } = observe(generations)
    try {
      await drain()
      expect(events.filter((e) => e.startsWith('terminate'))).toEqual(order.map((n) => `terminate ${n}`))
      // Reverse completion: the last supplied fails first. One still held keeps the stop pending.
      for (let i = order.length - 1; i >= 1; i--) holds[i]!.reject(reasons[i])
      await drain()
      expect({ settled: box.settled, closes: closes(events) }).toEqual({ settled: null, closes: [] })
    } finally {
      holds[0]!.reject(reasons[0])
      await stop
    }
    expect(closes(events)).toEqual(order.map((n) => `close ${n}`))
    expect(box.settled?.kind).toBe('rejected')
    const error = (box.settled as { reason: unknown }).reason as AgentRuntimeError
    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect(error.category).toBe('stop')
    expect(error.causes).toHaveLength(reasons.length)
    reasons.forEach((reason, i) => expect(error.causes[i]).toBe(reason))
    // The nested error is kept as one cause, not flattened.
    expect((error.causes[0] as AgentRuntimeError).causes).toEqual([inner])
    expect((error.causes[0] as AgentRuntimeError).causes[0]).toBe(inner)
  })

  test('exactly one rejection with an undefined reason throws undefined, judged by status', async () => {
    const events: string[] = []
    const generations = [generation(1, events, () => Promise.resolve(fact(1))), generation(2, events, () => Promise.reject(undefined))]
    const { box, stop } = observe(generations)
    await stop
    expect(box.settled).toEqual({ kind: 'rejected', reason: undefined })
    expect(closes(events)).toEqual(['close 1', 'close 2'])
  })
})

describe('Claude terminateGenerations with every owner terminated', () => {
  test('marks, aborts, ends input, terminates and closes in order, attempts every close past a throwing one and an ownerless one, and returns the same facts by generation', async () => {
    const events: string[] = []
    const late = deferred<ProcessExitFact>()
    const two = fact(2)
    const one = fact(1)
    // Supplied 2, 3 (ownerless), 1; generation 2's close throws; generation 1 terminates last.
    const generations = [generation(2, events, () => Promise.resolve(two), true), generation(3, events, null), generation(1, events, () => late.promise)]
    const token = {}
    const { box, stop } = observe(generations, token)
    try {
      await drain()
      expect({ settled: box.settled, closes: closes(events) }).toEqual({ settled: null, closes: [] })
    } finally {
      late.resolve(one)
      await stop
    }
    expect(events).toEqual([
      'mark 2', 'mark 1',
      'signal 2 SIGKILL', 'signal 1 SIGKILL',
      'abort 2', 'input 2', 'abort 3', 'input 3', 'abort 1', 'input 1',
      'terminate 2', 'terminate 1',
      'close 2', 'close 3', 'close 1',
    ])
    expect(generations.map((g) => g.abort.signal.reason)).toEqual([token, token, token])
    expect(box.settled?.kind).toBe('resolved')
    const facts = (box.settled as { value: ProcessExitFact[] }).value
    expect(facts).toHaveLength(2)
    expect(facts[0]).toBe(one)
    expect(facts[1]).toBe(two)
  })
})

describe('Claude terminateGenerations kill-first send (K1)', () => {
  const sends = (events: string[]) => events.filter((e) => e.startsWith('signal'))

  test('kill marks every owner, then sends SIGKILL to each live owner, then aborts and ends every input, with no await between', () => {
    const events: string[] = []
    const generations = [generation(1, events, () => Promise.resolve(fact(1))), generation(2, events, () => Promise.resolve(fact(2)))]
    const token = {}
    // Observed synchronously: nothing after the call's first await has run yet.
    const { stop } = observe(generations, token)
    expect(events).toEqual(['mark 1', 'mark 2', 'signal 1 SIGKILL', 'signal 2 SIGKILL', 'abort 1', 'input 1', 'abort 2', 'input 2', 'terminate 1', 'terminate 2'])
    expect(generations.map((g) => g.abort.signal.reason)).toEqual([token, token])
    return stop
  })

  test('shutdown sends no signal of its own', async () => {
    const events: string[] = []
    const generations = [generation(1, events, () => Promise.resolve(fact(1))), generation(2, events, () => Promise.resolve(fact(2)))]
    const { box, stop } = observe(generations, {}, 'shutdown')
    await stop
    expect(sends(events)).toEqual([])
    expect(events.slice(0, 6)).toEqual(['mark 1', 'mark 2', 'abort 1', 'input 1', 'abort 2', 'input 2'])
    expect(box.settled?.kind).toBe('resolved')
  })

  test('an exited, a never-started and an ownerless generation get no send but are still terminated, closed and accounted', async () => {
    const events: string[] = []
    const failure = new Error('the never-started owner keeps its spawn failure')
    const exited = fact(1)
    const generations = [
      generation(1, events, () => Promise.resolve(exited), false, { exited: { kind: 'exited', code: 0, signal: null } }),
      generation(2, events, () => Promise.reject(failure), false, { pid: null, exited: null }),
      generation(3, events, null),
      generation(4, events, () => Promise.resolve(fact(4))),
    ]
    const { box, stop } = observe(generations)
    await stop
    expect(sends(events)).toEqual(['signal 4 SIGKILL'])
    expect(events.filter((e) => e.startsWith('terminate'))).toEqual(['terminate 1', 'terminate 2', 'terminate 4'])
    expect(closes(events)).toEqual(['close 1', 'close 2', 'close 3', 'close 4'])
    expect(box.settled).toEqual({ kind: 'rejected', reason: failure })
    expect((box.settled as { reason: unknown }).reason).toBe(failure)
  })

  test('the exited check runs immediately before each send: an exit observed during an earlier send skips that owner', async () => {
    const events: string[] = []
    const second = { exited: null as unknown }
    const generations = [
      generation(1, events, () => Promise.resolve(fact(1)), false, { send: () => ((second.exited = { kind: 'exited', code: null, signal: 'SIGKILL' }), true) }),
      generation(2, events, () => Promise.resolve(fact(2))),
    ]
    // Generation 2's owner reads its exit from the shared record at send time.
    Object.defineProperty(generations[1]!.owned!, 'exited', { get: () => second.exited })
    await observe(generations).stop
    expect(sends(events)).toEqual(['signal 1 SIGKILL'])
  })

  test('a send that reaches nothing fabricates no receipt: the stop stays pending on the held termination, then returns its fact', async () => {
    const events: string[] = []
    const held = deferred<ProcessExitFact>()
    const one = fact(1)
    const generations = [generation(1, events, () => held.promise, false, { send: () => false })]
    const { box, stop } = observe(generations)
    try {
      await drain()
      expect({ settled: box.settled, sends: sends(events), closes: closes(events) }).toEqual({ settled: null, sends: ['signal 1 SIGKILL'], closes: [] })
    } finally {
      held.resolve(one)
      await stop
    }
    const facts = (box.settled as { value: ProcessExitFact[] }).value
    expect(facts).toHaveLength(1)
    expect(facts[0]).toBe(one)
  })

  test('a throwing send skips no later send, abort, termination or close, and its raw error leads the joined failures by identity', async () => {
    const events: string[] = []
    const thrown = new Error('the send threw')
    const rejected = new Error('the termination rejected')
    const held = deferred<ProcessExitFact>()
    const generations = [
      generation(1, events, () => Promise.reject(rejected), false, { send: () => { throw thrown } }),
      generation(2, events, () => held.promise),
    ]
    const { box, stop } = observe(generations)
    try {
      await drain()
      expect(events.slice(0, 8)).toEqual(['mark 1', 'mark 2', 'signal 1 SIGKILL', 'signal 2 SIGKILL', 'abort 1', 'input 1', 'abort 2', 'input 2'])
      // The held peer keeps the stop pending even though a send already failed.
      expect({ settled: box.settled, closes: closes(events) }).toEqual({ settled: null, closes: [] })
    } finally {
      held.resolve(fact(2))
      await stop
    }
    expect(closes(events)).toEqual(['close 1', 'close 2'])
    const error = (box.settled as { reason: unknown }).reason as AgentRuntimeError
    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect(error.causes).toHaveLength(2)
    expect(error.causes[0]).toBe(thrown)
    expect(error.causes[1]).toBe(rejected)
  })

  test('a single throwing send with every termination fulfilled throws that raw error unchanged', async () => {
    const events: string[] = []
    const thrown = new Error('the only failure')
    const generations = [generation(1, events, () => Promise.resolve(fact(1)), false, { send: () => { throw thrown } })]
    const { box, stop } = observe(generations)
    await stop
    expect(box.settled).toEqual({ kind: 'rejected', reason: thrown })
    expect((box.settled as { reason: unknown }).reason).toBe(thrown)
    expect(closes(events)).toEqual(['close 1'])
  })
})
