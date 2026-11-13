// The Claude stop's termination aggregate at its internal error boundary
// (task-f5001d7f A12/A13). owned.terminate() may reject by contract: a leader
// or group that survives SIGKILL for killMs rejects with a stop error. These
// units drive the actual terminateGenerations with owners whose terminations
// reject, are held, or fulfil, and observe every mark, abort, input end,
// terminate and query close. Every termination must settle and every close be
// attempted before the stop settles; outcomes are judged by status. They
// supplement the public-factory I1 (claudeStopOrder.test.ts) and claim
// nothing about native SIGKILL failure reachability.
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

/**
 * A generation over the actual Generation record. Its owner's terminate is
 * the given function (none for an ownerless one); its query records each
 * close attempt and may throw. Marks, aborts, input ends, terminates and
 * closes are logged in the order the function performs them.
 */
function generation(number: number, events: string[], terminate: (() => Promise<ProcessExitFact>) | null, closeThrows = false): Generation {
  const g = newGeneration(number, sdk, null)
  if (terminate) {
    g.owned = {
      markTermination: () => events.push(`mark ${number}`),
      terminate: () => (events.push(`terminate ${number}`), terminate()),
    } as unknown as OwnedProcess
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
function observe(generations: Generation[], token: object = {}) {
  const box: { settled: Settled | null } = { settled: null }
  const stop = terminateGenerations(generations, 'kill', {}, token).then(
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
