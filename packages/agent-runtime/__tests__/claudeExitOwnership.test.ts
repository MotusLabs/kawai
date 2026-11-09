// Turn ownership at an unexpected Claude process end (task 471, the Claude
// unexpected-exit portion of 2.2/4.4; L14-L16). The production ClaudeSession
// runs on a controlled query; its exit() is the process ending while the
// driver is active, with an opened turn and a queued one that never opened.
//
// L14: one transport error and one onProcessEnd. The opened turn ends with
// one process_ended completion and outcome process-ended. A queued turn that
// never opened settles once with the same outcome and no turn event. The
// state becomes exited. Those results are fixed once the exit is classified:
// a stop or interrupt reentered from any publication that follows
// (onState('exited'), request_resolved, error, turn_completed, onTurnResult)
// cannot replace them.
import { describe, expect, test } from 'bun:test'
import type { DriverState, TurnResult } from '../src/contract.js'
import type { AgentErrorInfo } from '../src/errors.js'
import type { AgentEvent } from '../src/events.js'
import { assigned, idle, stopError, tick } from './helpers/checkpointHarness.js'
import type { Driver, DriverHooks } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'

const ENDED: AgentErrorInfo = { category: 'transport', message: 'the agent process exited unexpectedly' }
const ids = (f: Driver, type: string) => f.events.flatMap((e) => (e.type === type ? [(e as { turnId: string }).turnId] : []))
const errors = (f: Driver) => f.events.flatMap((e) => (e.type === 'error' ? [e.error.category] : []))

/** An active turn T0, a queued T1 that never opened, and a pending request; then the process ends. */
async function crashWithWork(hooks: DriverHooks, bind: (f: Driver) => void = () => {}, arm: () => void = () => {}) {
  const f = await idle({ resume: null, unansweredRequests: 'wait', ...hooks })
  bind(f)
  const t0 = await f.d.send('first')
  const t1 = await f.d.send('second', { continuation: 'queue' })
  f.q().push(frames.init('sess-new'))
  await f.q().drain()
  const asked = f.q().options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [], toolUseID: 'toolu_1' } as never)
  await tick()
  expect(f.d.pendingRequests()).toHaveLength(1)
  arm()
  f.q().exit()
  const results = await Promise.all([t0.result, t1.result])
  await asked
  while (f.ends.length === 0) await tick()
  return { f, t0, t1, results }
}

function expectOwnedEnd(f: Driver, t0: { turnId: string }, t1: { turnId: string }, results: TurnResult[]): void {
  expect(results.map((r) => [r.turnId, r.outcome, r.error])).toEqual([[t0.turnId, 'process-ended', ENDED], [t1.turnId, 'process-ended', ENDED]])
  // One onTurnResult per handle, with the decided result.
  expect(f.results.map((r) => [r.turnId, r.outcome, r.error?.category])).toEqual([[t0.turnId, 'process-ended', 'transport'], [t1.turnId, 'process-ended', 'transport']])
  // Turn events for the opened turn only; the queued turn appears in no event.
  expect([ids(f, 'turn_started'), ids(f, 'turn_completed'), ids(f, 'turn_interrupted')]).toEqual([[t0.turnId], [t0.turnId], []])
  expect(f.events.filter((e) => 'turnId' in e && (e as { turnId: string }).turnId === t1.turnId)).toEqual([])
  expect(errors(f)).toEqual(['transport'])
  expect(f.ends).toEqual([{ generation: 1, code: null, signal: null, reason: null }])
}

describe('Claude unexpected exit: turn ownership (L14)', () => {
  // @covers: agent-runtime › Unexpected process end is reported › Crash during a turn
  test('L14: an exit with an opened and a queued turn settles both once as process-ended, with a completion event for the opened turn only', async () => {
    const { f, t0, t1, results } = await crashWithWork({})
    expectOwnedEnd(f, t0, t1, results)
    expect(f.d.state).toBe('exited')
    expect(f.states).toContain('exited')
    await f.d.kill()
  })

  const TRIGGERS = ['onState:exited', 'request_resolved', 'error', 'turn_completed', 'onTurnResult'] as const
  const ACTIONS = ['interrupt', 'shutdown', 'kill'] as const
  for (const trigger of TRIGGERS) {
    for (const action of ACTIONS) {
      test(`L14: ${action}() reentered from ${trigger} after the exit cannot replace the process-ended results`, async () => {
        let f: Driver | null = null
        let reentered: Promise<unknown> | null = null
        // Armed once the exit is pushed, so only the exit's publications reenter.
        let armed = false
        const reenter = () => {
          if (armed && reentered === null && f) reentered = (f.d[action]() as Promise<unknown>).catch((e: unknown) => e)
        }
        const hooks: DriverHooks =
          trigger === 'onState:exited' ? { onState: (s: DriverState) => s === 'exited' && reenter() }
            : trigger === 'onTurnResult' ? { onTurnResult: reenter }
              : { onEvent: (e: AgentEvent) => e.type === trigger && reenter() }
        const run = await crashWithWork(hooks, (driver) => (f = driver), () => (armed = true))
        expect(reentered).not.toBeNull()
        const outcome: unknown = await assigned(reentered)
        // Every trigger runs inside the generation's consuming job: a stop from there starts the stop but
        // that caller is refused (no self-join); an interrupt after the exit has nothing left to interrupt.
        if (action === 'interrupt') expect(outcome).toEqual({ outcome: 'no-active-turn', processExit: false })
        else expect((outcome as { category?: string }).category).toBe('internal')
        expectOwnedEnd(run.f, run.t0, run.t1, run.results)
        await stopError(run.f.d.kill())
      })
    }
  }

  test('L14: an idle exit reports one transport error and one process end, publishes exited, and no turn event', async () => {
    const f = await idle({ resume: null })
    f.q().exit()
    while (f.ends.length === 0) await tick()
    expect([errors(f), f.ends.length, f.d.state, f.states.at(-1)]).toEqual([['transport'], 1, 'exited', 'exited'])
    expect(f.events.filter((e) => e.type.startsWith('turn_'))).toEqual([])
    await stopError(f.d.kill())
  })

  test('L14/L16: a restart started from onState(exited) runs new work on generation 2; the old turns stay process-ended and the old generation reports nothing more', async () => {
    let f: Driver | null = null
    let armed = false
    let restart: Promise<void> | null = null
    let queriesAtProcessEnd = -1
    const run = await crashWithWork({ onState: (s: DriverState) => {
      if (armed && s === 'exited' && restart === null && f) restart = f.d.start()
    }, onProcessEnd: () => (queriesAtProcessEnd = f!.queries.length) }, (driver) => (f = driver), () => (armed = true))
    expect(restart).not.toBeNull()
    // The restart awaits the SDK load before its query exists: the old generation's request, frame and
    // turn cleanup, all synchronous in its end, ran before any generation-2 work could exist.
    expect(queriesAtProcessEnd).toBe(1)
    while (run.f.queries.length < 2) await tick()
    run.f.q().ready()
    await restart
    const t2 = await run.f.d.send('third')
    run.f.q().push(frames.init('sess-new'), frames.result([t2.messageUuid], 'two'))
    const r2 = await t2.result
    expect([r2.outcome, r2.finalText]).toEqual(['success', 'two'])
    expect(run.results.map((r) => r.outcome)).toEqual(['process-ended', 'process-ended'])
    // The old generation's frames reach nothing; one process end in all.
    run.f.queries[0]!.push(frames.result([t2.messageUuid], 'stale'))
    await tick()
    expect(run.f.results.map((r) => [r.turnId, r.outcome])).toEqual([[run.t0.turnId, 'process-ended'], [run.t1.turnId, 'process-ended'], [t2.turnId, 'success']])
    expect(run.f.ends).toHaveLength(1)
    expect([ids(run.f, 'turn_started'), ids(run.f, 'turn_completed')]).toEqual([[run.t0.turnId, t2.turnId], [run.t0.turnId, t2.turnId]])
    await stopError(run.f.d.kill())
  })

  test('L15: a stop requested before the process ends keeps its priority: no transport error or process end, the turns end as stopped', async () => {
    const f = await idle({ resume: null })
    const t0 = await f.d.send('first')
    const t1 = await f.d.send('second', { continuation: 'queue' })
    f.q().push(frames.init('sess-new'))
    await f.q().drain()
    await stopError(f.d.shutdown())
    const results = await Promise.all([t0.result, t1.result])
    expect(results.map((r) => [r.outcome, r.error?.category])).toEqual([['interrupted', 'stopped'], ['interrupted', 'stopped']])
    expect([errors(f), f.ends]).toEqual([[], []])
    expect([ids(f, 'turn_interrupted'), ids(f, 'turn_completed')]).toEqual([[t0.turnId], []])
  })

  test('L14: a read failure ends the generation the same way, and the raw failure stays owned through a stop reentered from onState(exited)', async () => {
    let f: Driver | null = null
    let armed = false
    let reentered: Promise<unknown> | null = null
    const failure = new Error('stream read failed')
    const g = await idle({ resume: null, onState: (s: DriverState) => {
      if (armed && s === 'exited' && reentered === null && f) reentered = f.d.kill().catch((e: unknown) => e)
    } })
    f = g
    const t0 = await g.d.send('first')
    g.q().push(frames.init('sess-new'))
    await g.q().drain()
    armed = true
    g.q().failRead(failure)
    const r0 = await t0.result
    expect([r0.outcome, r0.error]).toEqual(['process-ended', ENDED])
    expect(((await assigned(reentered)) as { category?: string }).category).toBe('internal')
    // The external join reports the raw read failure by identity.
    const stop = await stopError(g.d.kill())
    expect(stop?.category).toBe('stop')
    expect(stop?.causes).toContain(failure)
    expect([ids(g, 'turn_completed'), errors(g), g.ends.length]).toEqual([[t0.turnId], ['transport'], 1])
  })
})

