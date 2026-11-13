// Codex turn ownership against reentrant callbacks (findings F1/F2 on
// e6b7399e; L11/I1 and the decide-before-publication rule). Through the
// public factory and the owned fake app-server:
// - F1: a kill reentered from the wire recorder while turn/start is being
//   written still finds the accepted turn: the stop settles its handle once,
//   nothing opens after the stop, and no turn event is published for it.
// - F2: an interrupt reentered from the final limit observer of a failed
//   turn cannot replace the runtime's failed/quota outcome; the final limit
//   event is still reported once.
import { afterEach, describe, expect, test } from 'bun:test'
import type { TurnResult } from '../src/contract.js'
import type { LimitEvent } from '../src/usage/types.js'
import { codexDriver, stopDrivers } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

const within = <T>(promise: Promise<T>, ms = 1000) => Promise.race([promise, new Promise<'unsettled'>((resolve) => setTimeout(() => resolve('unsettled'), ms))])

describe('Codex turn ownership before reentrant callbacks', () => {
  test('F1: a kill from the wire recorder during turn/start settles the accepted handle once and opens nothing after the stop', async () => {
    let armed = false
    let stop = null as Promise<string> | null
    const h = codexDriver({
      wire: {
        record(frame) {
          if (armed && stop === null && frame.direction === 'out' && (JSON.parse(frame.text) as { method?: string }).method === 'turn/start') {
            stop = h.driver.kill().then(() => 'ok', () => 'rejected')
          }
        },
      },
    })
    await h.driver.start()
    armed = true
    const handle = await h.driver.send('wire stop')
    expect(await stop).toBe('ok')
    const result = await within(handle.result)
    expect(result).not.toBe('unsettled')
    expect(result).toMatchObject({ outcome: 'interrupted', error: { category: 'stopped' } })
    expect(h.driver.state).toBe('stopped')
    expect(h.results.map((r: TurnResult) => r.turnId)).toEqual([handle.turnId])
    // The turn never opened: no turn or user event for it, before or after the stop.
    expect(h.events.filter((e) => 'turnId' in e && e.turnId === handle.turnId)).toEqual([])
    expect((await within(h.driver.send('late').then(() => 'accepted', (e: { category?: string }) => e.category ?? 'unknown')))).toBe('stopped')
  })

  // @covers: agent-runtime › Session start and turn results are distinct › Failed or interrupted turn
  test('F2: an interrupt from the final limit observer cannot replace the failed quota outcome; the final event is reported once', async () => {
    const limits: LimitEvent[] = []
    const receipts: unknown[] = []
    const h = codexDriver({
      callbacks: {
        onLimitEvent: (event) => {
          limits.push(event)
          if (event.type === 'failure' && event.final) void h.driver.interrupt().then((r) => receipts.push(r), (e) => receipts.push(e))
        },
      },
    })
    await h.driver.start()
    const result = await (await h.driver.send('/fail usageLimitExceeded')).result
    expect([result.outcome, result.error?.category]).toEqual(['failed', 'quota'])
    expect(limits.filter((e) => e.type === 'failure' && e.final)).toHaveLength(1)
    await within(new Promise((resolve) => setTimeout(resolve, 20)))
    expect(receipts).toEqual([expect.objectContaining({ outcome: 'no-active-turn' })])
    expect(h.events.filter((e) => e.type === 'turn_interrupted')).toEqual([])
    expect(h.events.filter((e) => e.type === 'turn_completed')).toEqual([expect.objectContaining({ isError: true })])
    // The driver stays usable: the next turn runs normally.
    expect((await (await h.driver.send('next')).result).outcome).toBe('success')
  })
})
