// The live Codex effort reader (CodexDriverOptions.getEffort, owner amendment
// R2 of task-7811b455; design §2/§5) through the public factory and the owned
// fake app-server over stdio. Expected efforts come from the caller fixture's
// own answers and the turn/start params the fake received, never from the
// driver:
// - Supplied, the reader is asked as each new turn/start is sent and its
//   answer of that moment rides on that request, on the same process; it
//   takes precedence over the scalar option; undefined and a number send none.
// - Omitted, the scalar option rides on every turn, as before.
// - A refused submission and a steer never read it.
// - A throwing reader refuses that turn with its raw error and sends nothing;
//   a reader that kills its own driver sends nothing either.
import { afterEach, describe, expect, test } from 'bun:test'
import { AgentRuntimeError } from '../src/errors.js'
import type { Effort } from '../src/options.js'
import { codexDriver, pids, sent, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

const efforts = (h: { root: Parameters<typeof sent>[0] }) => sent(h.root, 'turn/start').map((message) => message.params?.effort ?? null)

async function turn(h: { driver: { send(text: string): Promise<{ result: Promise<unknown> }> } }, text = 'go') {
  await (await h.driver.send(text)).result
}

describe('Codex live effort', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Live Codex turn effort
  test('a supplied reader is read per new turn on the same process and its answer of that moment is sent', async () => {
    let live: Effort | undefined = 'low'
    const asked: Array<Effort | undefined> = []
    const h = codexDriver({ effort: 'medium', getEffort: () => (asked.push(live), live) })
    await h.driver.start()
    expect(asked).toEqual([])
    await turn(h)
    live = 'high'
    await turn(h)
    live = undefined
    await turn(h)
    live = 3
    await turn(h)
    expect(asked).toEqual(['low', 'high', undefined, 3])
    expect(efforts(h)).toEqual(['low', 'high', null, null])
    expect(pids(h.root.home)).toHaveLength(1)
  })

  test('omitted: the scalar effort rides on every turn', async () => {
    const h = codexDriver({ effort: 'high' })
    await h.driver.start()
    await turn(h)
    await turn(h)
    expect(efforts(h)).toEqual(['high', 'high'])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Live Codex turn effort
  test('a refused submission never reads the effort', async () => {
    const asked: string[] = []
    const h = codexDriver({ getEffort: () => (asked.push('read'), 'low'), beforeSubmit: (s) => (s.text === 'no' ? { accepted: false, reason: 'refused' } : { accepted: true }) })
    await h.driver.start()
    const refused = await h.driver.send('no').then(() => null, (error: unknown) => error)
    expect(refused).toBeInstanceOf(AgentRuntimeError)
    expect(asked).toEqual([])
    await turn(h)
    expect(asked).toEqual(['read'])
    expect(efforts(h)).toEqual(['low'])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Live Codex turn effort
  test('a steer joins the active turn without reading the effort', async () => {
    const asked: string[] = []
    const h = codexDriver({ getEffort: () => (asked.push('read'), 'low') })
    await h.driver.start()
    const opening = await h.driver.send('/hold')
    await waitFor(() => sent(h.root, 'turn/start').length === 1)
    const steered = await h.driver.send('more', { continuation: 'steer' })
    await Promise.all([opening.result, steered.result])
    expect(asked).toEqual(['read'])
    expect(sent(h.root, 'turn/steer')).toHaveLength(1)
    expect(sent(h.root, 'turn/steer')[0]!.params.effort).toBeUndefined()
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Live Codex turn effort
  test('a throwing reader refuses that turn with its raw error and sends no turn/start', async () => {
    const boom = new Error('effort store down')
    let fail = true
    const h = codexDriver({ getEffort: () => { if (fail) throw boom; return 'low' } })
    await h.driver.start()
    const refused = await h.driver.send('first').then(() => null, (error: unknown) => error)
    expect(refused).toBeInstanceOf(AgentRuntimeError)
    expect((refused as AgentRuntimeError).category).toBe('configuration')
    expect((refused as AgentRuntimeError).causes).toEqual([boom])
    expect(efforts(h)).toEqual([])
    fail = false
    await turn(h)
    expect(efforts(h)).toEqual(['low'])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Live Codex turn effort
  test('a reader that kills its own driver sends no turn/start and the kill completes', async () => {
    const holder: { kill?: Promise<unknown> } = {}
    const h = codexDriver({ getEffort: () => ((holder.kill = h.driver.kill()), 'low') })
    await h.driver.start()
    const refused = await h.driver.send('go').then(() => null, (error: unknown) => error)
    expect(refused).toBeInstanceOf(AgentRuntimeError)
    expect((refused as AgentRuntimeError).category).toBe('stopped')
    const receipt = (await holder.kill) as { scope: string }
    expect(receipt.scope).toBe('agent-processes')
    expect(efforts(h)).toEqual([])
  })
})
