// @reads: packages/agent-runtime/__tests__/fixtures/**
// The Claude driver against the lifecycle decision table (task 4.1): every
// reachable state/operation pair of the 56 is driven through the real
// ClaudeSession (turn binder, requests, events and lifecycle), with only the
// SDK's query() replaced by a controlled one. `exit` ends the generation's
// stream, `ready` is the initialize response (stale when the generation is
// past it), `result` a result frame, and `native` a CLI init that no
// submission opened. Controls: M-native (dropping the agent-started open, or
// opening one outside idle) fails L24/L26. The real-CLI rows live in
// claudeSession.test.ts.
//
// Qualifications (correction A2):
// - The unstarted rows here are virgin: no query exists yet.
// - In stopped and exited, the query's stream has already ended, so the
//   L16, L20 and L26 frames are never delivered. Those rows check only that
//   nothing changes.
// - Frames delivered from a live, retired generation (a failed initialize
//   keeps its query), both while unstarted and under a successor's active
//   turn, are in claudeGenerations.test.ts.
// - L18 calls the lifecycle seam directly with the current generation.
//   A stale initialize response cannot be produced through the query.
import { describe, expect, test } from 'bun:test'
import { AgentRuntimeError } from '../src/errors.js'
import { driver, type Driver } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'
import { LIFECYCLE_ROWS, expandPairs, type LifecycleOperation, type LifecycleState } from './oracles/lifecycleInputs.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<AgentRuntimeError> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    return error as AgentRuntimeError
  }
  throw new Error('expected a rejection')
}

async function pending(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => (done = true), () => (done = true))
  await tick(5)
  return !done
}

/** Drive a fresh driver into `state` through public operations and controlled frames only. */
async function inState(state: LifecycleState): Promise<Driver> {
  const f = driver()
  if (state === 'unstarted') return f
  f.starting = f.d.start()
  f.starting.catch(() => {})
  while (f.queries.length === 0) await tick()
  if (state === 'starting') return f
  f.q().ready()
  await f.starting
  if (state === 'idle') return f
  if (state === 'active') {
    f.handle = await f.d.send('first')
    return f
  }
  if (state === 'exited') {
    f.q().exit()
    while (f.d.state !== 'exited') await tick()
    return f
  }
  f.q().holdOnClose = true
  f.stop = f.d.kill()
  f.stop.catch(() => {})
  if (state === 'stopping') return f
  f.q().exit()
  await f.stop
  return f
}

type Check = (f: Driver, state: LifecycleState) => Promise<void>

const CHECKS: Record<string, Check> = {
  L01: async (f) => {
    const start = f.d.start()
    expect(f.d.state).toBe('starting')
    expect(f.queries).toHaveLength(0) // the SDK loads first; nothing has spawned synchronously
    while (f.queries.length === 0) await tick()
    f.q().ready()
    await start
    expect([f.d.state, f.queries.length, f.q().prompts.length]).toEqual(['idle', 1, 0])
  },
  L02: async (f) => {
    const start = f.d.start()
    while (f.queries.length < 2) await tick()
    f.q().ready()
    await start
    expect(f.d.state).toBe('idle')
    // The same saved conversation resumes on both generations, never a fresh one.
    expect(f.queries.map((q) => q.options.resume)).toEqual(['sess-saved', 'sess-saved'])
  },
  L03: async (f) => {
    expect(f.d.start()).toBe(f.starting!)
    while (f.queries.length === 0) await tick()
    await tick(5)
    expect(f.queries).toHaveLength(1)
  },
  L04: async (f, state) => {
    const before = f.events.length
    await f.d.start()
    expect([f.d.state, f.queries.length, f.events.length]).toEqual([state, 1, before])
  },
  L05: async (f, state) => {
    expect((await rejection(f.d.send('nope'))).category).toBe('not-ready')
    expect(f.types()).not.toContain('user_message')
    expect(f.d.state).toBe(state)
  },
  L06: async (f) => {
    const send = f.d.send('waits')
    expect(await pending(send)).toBe(true)
    while (f.queries.length === 0) await tick()
    f.q().ready()
    const handle = await send
    await tick()
    expect(f.q().prompts.map((p): string | undefined => p.uuid)).toEqual([handle.messageUuid])
    expect(f.d.state).toBe('active')
  },
  L07: async (f) => {
    const handle = await f.d.send('hello', { messageUuid: '00000000-0000-4000-8000-0000000000a7' })
    expect(handle.messageUuid).toBe('00000000-0000-4000-8000-0000000000a7')
    expect(f.d.state).toBe('active')
    expect(f.types()).toEqual(['turn_started', 'user_message'])
    await tick()
    expect(f.q().prompts.map((p) => [p.uuid, p.message.content])).toEqual([[handle.messageUuid, 'hello']])
  },
  L08: async (f) => {
    expect((await rejection(f.d.send('second'))).category).toBe('busy')
    await tick()
    expect(f.q().prompts).toHaveLength(1)
    expect(f.types().filter((t) => t === 'turn_started')).toHaveLength(1)
  },
  L09: async (f, state) => {
    expect(await f.d.interrupt()).toEqual({ outcome: 'no-active-turn', processExit: false })
    expect(f.queries.flatMap((q) => q.interrupts)).toEqual([])
    expect(f.d.state).toBe(state)
  },
  L10: async (f, state) => {
    if (state === 'starting') {
      const waiting = f.d.send('waits')
      expect(await f.d.interrupt()).toEqual({ outcome: 'requested', processExit: false })
      while (f.queries.length === 0) await tick()
      f.q().ready()
      const error = await rejection(waiting)
      expect([error.category, error.code]).toEqual(['not-ready', 'interrupted'])
      return
    }
    expect(await f.d.interrupt()).toEqual({ outcome: 'requested', processExit: false })
    const result = await f.handle!.result
    expect([result.outcome, result.error?.category]).toEqual(['interrupted', 'stopped'])
    expect(f.d.state).toBe('idle')
    expect(f.types().filter((t) => t === 'turn_interrupted')).toHaveLength(1)
    await tick()
    expect(f.q().interrupts).toEqual([{ cancelQueued: true }])
    // The interrupted turn's late result (L20) completes nothing.
    f.q().push(frames.result([f.handle!.messageUuid]))
    await f.q().drain()
    expect(f.types()).not.toContain('turn_completed')
    expect(f.results).toHaveLength(1)
  },
  L11: async (f, state) => {
    const receipt = await f.d.kill()
    expect(receipt).toMatchObject({ scope: 'agent-processes', mode: 'kill', js: 'settled' })
    expect(f.d.state).toBe('stopped')
    expect((await rejection(f.d.send('after'))).category).toBe('stopped')
    if (state === 'active') {
      const result = await f.handle!.result
      expect([result.outcome, result.error?.category]).toEqual(['interrupted', 'stopped'])
      expect(f.types().filter((t) => t === 'turn_interrupted')).toHaveLength(1)
    }
    expect(f.ends).toHaveLength(state === 'exited' ? 1 : 0)
  },
  L12: async (f, state) => {
    const again = f.d.shutdown()
    if (state === 'stopping') f.q().exit()
    expect((await again).mode).toBe('kill')
    expect(f.queries).toHaveLength(1)
  },
  L13: async (f, state) => {
    expect((await rejection(f.d.start())).category).toBe('stopped')
    expect((await rejection(f.d.send('x'))).category).toBe('stopped')
    expect((await rejection(f.d.interrupt())).category).toBe('stopped')
    expect([f.d.state, f.queries.length]).toEqual([state, 1])
  },
  L14: async (f, state) => {
    if (state === 'starting') while (f.queries.length === 0) await tick()
    f.q().exit()
    while (f.d.state !== 'exited') await tick()
    let startFailure: unknown = null
    if (state === 'starting') {
      startFailure = await rejection(f.starting!)
      expect((startFailure as AgentRuntimeError).category).toBe('transport')
    }
    if (state === 'active') {
      const result = await f.handle!.result
      expect(result.outcome).toBe('process-ended')
      const completed = f.events.filter((e) => e.type === 'turn_completed')
      expect(completed.map((e) => e.type === 'turn_completed' && [e.subtype, e.isError])).toEqual([['process_ended', true]])
    }
    await tick()
    expect(f.ends).toHaveLength(1)
    expect(f.events.filter((e) => e.type === 'error').map((e) => e.type === 'error' && e.error.category)).toEqual(['transport'])
    expect(f.d.state).toBe('exited')
    if (state === 'starting') {
      // A3: the failed start is retained; the later stop reports that very error.
      const stop = await rejection(f.d.kill())
      expect([stop.category, stop.causes]).toEqual(['stop', [startFailure]])
      stopChecked.add(f)
    }
  },
  L15: async (f) => {
    f.q().exit()
    await f.stop
    expect(f.ends).toEqual([])
    expect(f.d.state).toBe('stopped')
  },
  L16: async (f) => {
    const ends = f.ends.length
    const errors = f.types().filter((t) => t === 'error').length
    f.q().exit()
    await tick(5)
    expect([f.ends.length, f.types().filter((t) => t === 'error').length]).toEqual([ends, errors])
  },
  L17: async (f) => {
    const waiting = f.d.send('waits')
    while (f.queries.length === 0) await tick()
    f.q().ready()
    await f.starting
    expect(['idle', 'active']).toContain(f.d.state)
    await waiting
    expect(f.d.state).toBe('active')
  },
  L18: async (f, state) => {
    const before = f.events.length
    expect(f.d.lifecycle.ready(f.d.lifecycle.generation)).toBe(false)
    expect([f.d.state, f.events.length]).toEqual([state, before])
  },
  L19: async (f) => {
    f.q().push(frames.text('answer'), frames.result([f.handle!.messageUuid], 'answer'))
    const result = await f.handle!.result
    expect(result).toMatchObject({ turnId: f.handle!.turnId, messageUuid: f.handle!.messageUuid, outcome: 'success', finalText: 'answer', error: null })
    await f.q().drain()
    expect(f.results).toEqual([result])
    expect(f.d.state).toBe('idle')
    f.q().push(frames.result([f.handle!.messageUuid], 'again'))
    await f.q().drain()
    expect(f.results).toHaveLength(1)
  },
  L20: async (f, state) => {
    if (state === 'starting') while (f.queries.length === 0) await tick()
    const before = f.events.length
    f.q().push(frames.result(['00000000-0000-4000-8000-00000000dead']), frames.result([]))
    await f.q().drain()
    expect(f.events.slice(before).map((e) => e.type)).toEqual([])
    expect(f.results).toEqual([])
    expect(f.d.state).toBe(state)
  },
  L24: async (f) => {
    f.q().push(frames.taskNotification('task-1'), frames.init(), frames.text('woke up'))
    await f.q().drain()
    expect(f.d.state).toBe('active')
    const started = f.events.filter((e) => e.type === 'turn_started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ trigger: { kind: 'task', tasks: [{ taskId: 'task-1', status: 'completed', summary: 'task done' }] } })
    expect(f.types()).not.toContain('user_message')
    f.q().push(frames.result([], 'woke up'))
    await f.q().drain()
    expect(f.results).toHaveLength(1)
    expect(f.results[0]).toMatchObject({ turnId: (started[0] as { turnId: string }).turnId, messageUuid: null, outcome: 'success', finalText: 'woke up' })
    expect(f.d.state).toBe('idle')
    // Without held notifications the trigger is `resumed`.
    f.q().push(frames.init())
    await f.q().drain()
    expect(f.events.filter((e) => e.type === 'turn_started').at(-1)).toMatchObject({ trigger: { kind: 'resumed' } })
  },
  L25: async (f) => {
    f.q().push(frames.init())
    await f.q().drain()
    expect(f.types().filter((t) => t === 'turn_started')).toHaveLength(1)
    expect(f.d.lifecycle.activeTurnId).toBe(f.handle!.turnId)
    f.q().push(frames.result([f.handle!.messageUuid]))
    expect((await f.handle!.result).turnId).toBe(f.handle!.turnId)
  },
  L26: async (f, state) => {
    if (state === 'starting') while (f.queries.length === 0) await tick()
    const before = f.events.length
    f.q().push(frames.init(), frames.result([]))
    await f.q().drain()
    expect(f.events.slice(before).map((e) => e.type)).toEqual([])
    expect(f.results).toEqual([])
    expect(f.d.state).toBe(state)
  },
}

/** Fixtures whose check already ran (and asserted) the terminal stop. */
const stopChecked = new WeakSet<object>()

describe('Claude driver: lifecycle table (56 pairs)', () => {
  const rows = new Map(LIFECYCLE_ROWS.map((row) => [row.id, row]))
  for (const [pair, [rowId]] of expandPairs(LIFECYCLE_ROWS)) {
    const [state, operation] = pair.split('+') as [LifecycleState, LifecycleOperation]
    if (rows.get(rowId!)?.unreachable) continue
    test(`claude ${rowId} ${state}+${operation}`, async () => {
      const f = await inState(state)
      await CHECKS[rowId!]!(f, state)
      if (f.d.state !== 'stopped' && !stopChecked.has(f)) {
        for (const q of f.queries) {
          q.holdOnClose = false
          if (q.closed) q.exit()
        }
        await f.d.kill()
      }
    })
  }

  test('every reachable row has a driver check', () => {
    const reachable = LIFECYCLE_ROWS.filter((row) => !row.unreachable).map((row) => row.id)
    expect(reachable.filter((id) => !CHECKS[id])).toEqual([])
  })
})
