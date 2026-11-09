// @reads: packages/agent-runtime/__tests__/fixtures/**
// The private Codex RPC transport on a real owned fake app-server (task 311,
// A1/A2/I1): exact launch env and cwd with a poisoned host marker absent,
// initialize with the supplied clientInfo/capabilities, correlation of
// concurrent out-of-order replies by id, settle-once against late, duplicate,
// malformed and uncorrelated lines, deadline timers cleared at settlement,
// notifications and server requests, raw error replies, an absent or throwing
// wire, and the unsolicited end (spawn failure, exit with pending requests).
// Control (correlation wiring): settling the oldest pending entry instead of
// the one the id names fails the seeded out-of-order table.
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerRpcError } from '../src/codex/appServerTransport.js'
import type { WireFrame } from '../src/options.js'
import type { LeaderExit } from '../src/process/ownedProcess.js'
import { alive, fake, rejection, settled, stopAll } from './helpers/appServerHarness.js'

afterEach(stopAll)
afterAll(stopAll)

describe('launch and initialize (A1)', () => {
  test('the child gets exactly the launch env and cwd, the poisoned host marker absent, and the supplied handshake', async () => {
    process.env.AR_CODEX_POISON = 'host-secret'
    try {
      const capabilities = { experimentalApi: true, requestAttestation: false, custom: { nested: [1, 2] } }
      const f = fake({ clientInfo: { name: 'host', title: 'Host App', version: '9.9.9' }, capabilities })
      f.transport.start()
      const result = (await f.transport.initialize()) as { env: Record<string, string>; cwd: string }
      expect(result.env).toEqual(f.childEnv)
      expect(result.cwd).toBe(f.root)
      expect(process.cwd()).not.toBe(f.root)
      expect(f.received()).toEqual([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'host', title: 'Host App', version: '9.9.9' }, capabilities } },
      ])
    } finally {
      delete process.env.AR_CODEX_POISON
    }
  })

  test('requests before start are refused not-ready; a second start is refused', async () => {
    const f = fake()
    expect((await rejection(f.transport.request('echo'))).category).toBe('not-ready')
    f.transport.start()
    expect(() => f.transport.start()).toThrow('already started')
  })

  test('a missing default executable is a dependency error before any spawn', () => {
    const f = fake({ command: undefined }, { PATH: '/nonexistent-agent-runtime-path' })
    expect(() => f.transport.start()).toThrow(expect.objectContaining({ category: 'dependency' }))
    expect(f.transport.process).toBeNull()
  })
})

describe('correlation and settle-once (A2)', () => {
  // Control (correlation wiring): a mutant settling by arrival order fails these values.
  test('seeded concurrent requests with random delays each resolve with their own value', async () => {
    const f = fake()
    f.transport.start()
    let state = 0x311
    const next = (n: number) => {
      state = (state * 1103515245 + 12345) >>> 0
      return (state >>> 16) % n
    }
    for (let round = 0; round < 3; round++) {
      const sent = Array.from({ length: 12 }, (_, i) => ({ ms: next(60), value: `r${round}-${i}` }))
      const results = await Promise.all(sent.map((s) => f.transport.request('delay', s)))
      expect(results).toEqual(sent.map((s) => s.value))
    }
    expect(f.transport.pendingCount).toBe(0)
    expect(f.transport.counters).toEqual({ stray: 0, malformed: 0, droppedReplies: 0 })
  })

  test('malformed, stray, null-id and string-id lines settle no other request; the real reply still does', async () => {
    const f = fake({ requestTimeoutMs: 0 })
    f.transport.start()
    const held = [f.transport.request('never'), f.transport.request('never')]
    expect(await f.transport.request('garbage')).toEqual({ ok: true })
    expect(await settled(Promise.race(held), 50)).toBe(false)
    expect(f.transport.pendingCount).toBe(2)
    // Per held id: a string id and an unknown id (stray) and a reply with neither result nor error (malformed);
    // plus the null-id error (stray), 'not json', '[1,2]' and a numeric method (malformed).
    expect(f.transport.counters).toEqual({ stray: 5, malformed: 5, droppedReplies: 0 })
  })

  test('a duplicate reply and a reply after the deadline settle nothing; timers are cleared at settlement', async () => {
    const f = fake({ requestTimeoutMs: 1000 })
    f.transport.start()
    const created: ReturnType<typeof setTimeout>[] = []
    const setSpy = spyOn(globalThis, 'setTimeout')
    const request = f.transport.request('late', { ms: 10 })
    created.push(setSpy.mock.results.at(-1)?.value as ReturnType<typeof setTimeout>)
    setSpy.mockRestore()
    const clearSpy = spyOn(globalThis, 'clearTimeout')
    expect(await request).toBe('first')
    const cleared = clearSpy.mock.calls.map((call) => call[0])
    clearSpy.mockRestore()
    expect(cleared).toContain(created[0])
    await Bun.sleep(30)
    expect(f.transport.counters.stray).toBe(1)

    const g = fake({ requestTimeoutMs: 40 })
    g.transport.start()
    const timedOut = await rejection(g.transport.request('late', { ms: 120 }))
    expect([timedOut.category, timedOut.message]).toEqual(['transport', 'app-server request 1 (late) had no reply within 40 ms'])
    expect(g.transport.pendingCount).toBe(0)
    expect(await g.transport.request('echo', { value: 'after' })).toBe('after')
    await Bun.sleep(120)
    expect(g.transport.counters.stray).toBe(2)
  })

  test('an error reply rejects with the raw error object (I1)', async () => {
    const f = fake()
    f.transport.start()
    const error = await rejection(f.transport.request('fail'))
    expect(error).toBeInstanceOf(AppServerRpcError)
    expect([error.method, error.id, error.error]).toEqual(['fail', 1, { code: -32000, message: 'boom', data: { raw: true } }])
  })
})

describe('notifications and server requests', () => {
  test('notifications arrive in order; a throwing observer changes no reply and fails the stop with its error', async () => {
    const ticks: unknown[] = []
    const thrown = new Error('observer')
    const f = fake({
      onNotification: (method, params) => {
        ticks.push([method, params])
        if (params.n === 1) throw thrown
      },
    })
    f.transport.start()
    expect(await f.transport.request('notify', { count: 3 })).toEqual({ sent: 3 })
    expect(await f.transport.request('echo', { value: 2 })).toBe(2)
    expect(ticks).toEqual([['tick', { n: 0 }], ['tick', { n: 1 }], ['tick', { n: 2 }]])
    const stop = await rejection(f.transport.stop())
    expect([stop.category, stop.causes]).toEqual(['stop', [thrown]])
  })

  test('a handler value, undefined, throw and absent handler each become the reply with the request id', async () => {
    const answers: Record<string, () => unknown> = {
      value: () => ({ decision: 'accept' }),
      none: () => undefined,
      throws: () => {
        throw new Error('handler refused')
      },
    }
    const f = fake({ onServerRequest: async (method) => answers[method]!() })
    f.transport.start()
    const ask = (method: string, id: number | string) => f.transport.request('ask', { method, id, params: { q: method } })
    expect(await ask('value', 'srv-1')).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: { decision: 'accept' } })
    expect(await ask('none', 7)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
    expect(await ask('throws', 8)).toEqual({ jsonrpc: '2.0', id: 8, error: { code: -32603, message: 'handler refused' } })
    const bare = fake()
    bare.transport.start()
    expect(await bare.transport.request('ask', { method: 'x', id: 9 })).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32601, message: 'no handler for server request x' },
    })
  })
})

describe('wire observation (A1)', () => {
  test('a recorder sees both directions; a throwing recorder changes no answer and its throws fail the stop', async () => {
    const frames: WireFrame[] = []
    const f = fake({ wire: { record: (frame) => void frames.push(frame) } })
    f.transport.start()
    expect(await f.transport.request('echo', { value: 'seen' })).toBe('seen')
    expect(frames.filter((x) => x.direction !== 'lifecycle').map((x) => [x.direction, JSON.parse(x.text)])).toEqual([
      ['out', { jsonrpc: '2.0', id: 1, method: 'echo', params: { value: 'seen' } }],
      ['in', { jsonrpc: '2.0', id: 1, result: 'seen' }],
    ])
    expect((await f.transport.stop()).state).toBe('exited')

    const boom = new Error('recorder')
    const g = fake({
      wire: {
        record: () => {
          throw boom
        },
      },
    })
    g.transport.start()
    expect(await g.transport.request('echo', { value: 'still' })).toBe('still')
    const stop = await rejection(g.transport.stop())
    expect(stop.category).toBe('stop')
    expect(stop.causes.length).toBeGreaterThan(0)
    expect(stop.causes.every((cause: unknown) => cause === boom)).toBe(true)
  })
})

describe('unsolicited end', () => {
  test('an exit rejects every pending request once with the exit and stderr, reports onExit once, then refuses', async () => {
    const exits: LeaderExit[] = []
    const f = fake({ onExit: (exit) => void exits.push(exit), requestTimeoutMs: 0 })
    f.transport.start()
    const held = f.transport.request('never')
    void f.transport.request('exit', { code: 3, stderr: 'bad thing' }).catch(() => {})
    const error = await rejection(held)
    expect([error.category, error.message]).toEqual(['transport', 'the Codex app-server exited with code 3 (last stderr: bad thing)'])
    expect(exits).toEqual([{ kind: 'exited', code: 3, signal: null }])
    expect((await rejection(f.transport.request('echo'))).message).toBe(error.message)
    expect(() => f.transport.notify('x')).toThrow(error.message)
    expect(await f.transport.stop()).toMatchObject({ state: 'exited', code: 3, escalated: false, groupCleared: true })
    expect(exits).toHaveLength(1)
  })

  test('an exit while a helper holds stdout rejects pending at the drain bound, not never; the stop still clears the helper', async () => {
    const exits: LeaderExit[] = []
    const tick = join(realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-codex-tick-'))), 'ticks')
    const f = fake({ onExit: (exit) => void exits.push(exit), requestTimeoutMs: 0, drainBoundMs: 150 })
    f.transport.start()
    const { helper } = (await f.transport.request('helper', { file: tick })) as { helper: number }
    const held = rejection(f.transport.request('never'))
    const exitAt = Date.now()
    void f.transport.request('exit', { code: 0 }).catch(() => {})
    const error = await held
    expect(Date.now() - exitAt).toBeGreaterThanOrEqual(150)
    expect([error.category, error.message]).toEqual(['transport', 'the Codex app-server exited with code 0'])
    expect(exits).toEqual([{ kind: 'exited', code: 0, signal: null }])
    expect(alive(helper)).toBe(true)
    expect(await f.transport.stop()).toMatchObject({ state: 'exited', code: 0, groupCleared: true })
    expect(alive(helper)).toBe(false)
  })

  test('a spawn failure rejects initialize with the original error kept, and stop reports never-started', async () => {
    const exits: LeaderExit[] = []
    const f = fake({ command: '/nonexistent-agent-runtime/codex', onExit: (exit) => void exits.push(exit) })
    f.transport.start()
    const error = await rejection(f.transport.initialize())
    expect([error.category, error.message]).toEqual(['transport', 'the Codex app-server failed to start'])
    expect(error.causes[0]).toBeInstanceOf(Error)
    expect(exits.map((exit) => exit.kind)).toEqual(['spawn-failed'])
    expect(await f.transport.stop()).toEqual({ generation: 1, state: 'never-started' })
  })
})
