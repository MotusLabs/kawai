// @reads: packages/agent-runtime/__tests__/fixtures/**
// The Codex transport's terminal stop on a real owned fake app-server (task
// 311, A3): admission and writes close, pending requests reject once, the
// stop joins the actual native group exit (a helper holding stdout, a
// SIGTERM-ignoring server) and every admitted handler, a held handler's late
// reply is never written, concurrent and reentrant stops share one terminal
// operation, a handler's own stop is refused `internal`, and a recorder that
// reenters stop at the spawn frame finds the process owned. A stop reentered
// from a teardown callback (an abort listener) gets the same terminal promise,
// and a raw stdout error after stop began stays in the stop's causes.
// Control (premature join): a stop resolving before its held handler settles
// fails the ordering assertion below.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessExitFact } from '../src/contract.js'
import type { AgentRuntimeError } from '../src/errors.js'
import type { AppServerTransport } from '../src/codex/appServerTransport.js'
import { alive, fake, rejection, settled, stopAll, until } from './helpers/appServerHarness.js'

afterEach(stopAll)
afterAll(stopAll)

describe('terminal stop (A3)', () => {
  test('stop rejects pending once, closes admission, and resolves with the actual exit', async () => {
    const f = fake({ requestTimeoutMs: 0 })
    f.transport.start()
    await f.transport.initialize()
    const pid = f.transport.process!.pid!
    let rejections = 0
    const held = f.transport.request('never').catch((error: AgentRuntimeError) => {
      rejections++
      return error
    })
    await until(() => f.received().some((line) => line.method === 'never'))
    const stop = f.transport.stop()
    expect(f.transport.stop()).toBe(stop)
    expect((await rejection(f.transport.request('echo'))).category).toBe('stopped')
    expect(() => f.transport.notify('x')).toThrow(expect.objectContaining({ category: 'stopped' }))
    const fact = await stop
    expect(fact).toEqual({ generation: 1, state: 'exited', pid, code: null, signal: 'SIGTERM', escalated: false, groupCleared: true })
    expect([((await held) as AgentRuntimeError).category, rejections]).toEqual(['stopped', 1])
    expect(alive(pid)).toBe(false)
    expect(f.received().map((line) => line.method)).toEqual(['initialize', 'never'])
  })

  // Control (premature join): resolving the stop without joining handlers breaks this order.
  test('stop joins a held handler after aborting its signal; its late reply is dropped, never written', async () => {
    const order: string[] = []
    let release!: () => void
    const f = fake({
      requestTimeoutMs: 0,
      onServerRequest: (_method, _params, signal) =>
        new Promise((resolve) => {
          order.push('handler')
          signal.addEventListener('abort', () => {
            order.push('aborted')
            release = () => {
              order.push('handler-settled')
              resolve({ late: true })
            }
          })
        }),
    })
    f.transport.start()
    void f.transport.request('ask', { method: 'approval', id: 'srv-held' }).catch(() => {})
    await until(() => order.includes('handler'))
    const stop = f.transport.stop().then((fact) => {
      order.push('stop')
      return fact
    })
    await until(() => order.includes('aborted'))
    expect(await settled(stop, 150)).toBe(false)
    release()
    expect((await stop).state).toBe('exited')
    expect(order).toEqual(['handler', 'aborted', 'handler-settled', 'stop'])
    expect(f.transport.counters.droppedReplies).toBe(1)
    expect(f.received().filter((line) => line.id === 'srv-held')).toEqual([])
  })

  test('a held handler released with a raw error after stop writes nothing and fails the stop with that error', async () => {
    const raw = new Error('handler body failed late')
    let release!: () => void
    let entered = false
    const f = fake({
      requestTimeoutMs: 0,
      onServerRequest: () =>
        new Promise((_resolve, reject) => {
          entered = true
          release = () => reject(raw)
        }),
    })
    f.transport.start()
    void f.transport.request('ask', { method: 'tool', id: 'srv-raw' }).catch(() => {})
    await until(() => entered)
    const stop = rejection(f.transport.stop())
    expect(await settled(stop, 150)).toBe(false)
    release()
    const error = await stop
    expect([error.category, error.causes]).toEqual(['stop', [raw]])
    expect(f.transport.counters.droppedReplies).toBe(1)
    expect(f.received().filter((line) => line.id === 'srv-raw')).toEqual([])
  })

  test("a handler rejecting with its aborted signal's reason is the stop's own cancellation", async () => {
    let entered = false
    const f = fake({
      requestTimeoutMs: 0,
      onServerRequest: (_method, _params, signal) =>
        new Promise((_resolve, reject) => {
          entered = true
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    })
    f.transport.start()
    void f.transport.request('ask', { method: 'tool', id: 'srv-abort' }).catch(() => {})
    await until(() => entered)
    expect((await f.transport.stop()).state).toBe('exited')
  })

  test('a server request whose job is admitted just before stop never reaches host code and is joined', async () => {
    let invoked = 0
    let stop: Promise<ProcessExitFact> | null = null
    const f = fake({
      requestTimeoutMs: 0,
      onServerRequest: () => {
        invoked++
        return {}
      },
      // The notification on the same chunk stops the transport before the handler's turn.
      onNotification: () => {
        stop ??= f.transport.stop()
      },
    })
    f.transport.start()
    void f.transport.request('askThenNotify', { id: 'srv-admitted' }).catch(() => {})
    await until(() => stop !== null)
    expect((await stop!).state).toBe('exited')
    expect([invoked, f.transport.counters.droppedReplies]).toEqual([0, 1])
    expect(f.received().filter((line) => line.id === 'srv-admitted')).toEqual([])
  })

  test("a recorder stopping the transport from a request's own 'out' frame leaves that line unsent", async () => {
    let transport!: AppServerTransport
    let stop: Promise<ProcessExitFact> | null = null
    const f = fake({
      wire: {
        record: (frame) => {
          if (frame.direction === 'out' && frame.text.includes('"stopHere"')) stop ??= transport.stop()
        },
      },
    })
    transport = f.transport
    transport.start()
    expect(await transport.request('echo', { value: 'before' })).toBe('before')
    const request = rejection(transport.request('echo', { value: 'stopHere' }))
    expect(stop).not.toBeNull()
    expect((await request).category).toBe('stopped')
    expect((await stop!).state).toBe('exited')
    expect(f.received().map((line) => line.params?.value)).toEqual(['before'])
  })

  // PC1: the shared terminal promise exists before teardown callbacks run.
  test("a stop reentered from a handler's abort listener during teardown returns the same terminal promise", async () => {
    let release!: () => void
    let entered = false
    let nested: Promise<ProcessExitFact> | null = null
    const f = fake({
      requestTimeoutMs: 0,
      onServerRequest: (_method, _params, signal) =>
        new Promise((resolve) => {
          entered = true
          release = () => resolve({ done: true })
          signal.addEventListener('abort', () => {
            nested = f.transport.stop()
          })
        }),
    })
    f.transport.start()
    void f.transport.request('ask', { method: 'tool', id: 'srv-reenter' }).catch(() => {})
    await until(() => entered)
    const outer = f.transport.stop()
    const shared = nested === outer
    release()
    expect(shared).toBe(true)
    expect((await outer).state).toBe('exited')
    expect(f.received().filter((line) => line.id === 'srv-reenter')).toEqual([])
  })

  // PC2: a read error after stop began is not the stop's own cancellation.
  test('an independent stdout error after stop began fails the stop with that error by identity', async () => {
    let release!: () => void
    let entered = false
    const raw = new Error('independent read failure')
    const f = fake({
      requestTimeoutMs: 0,
      onServerRequest: () =>
        new Promise((resolve) => {
          entered = true
          release = () => resolve({ done: true })
        }),
    })
    f.transport.start()
    void f.transport.request('ask', { method: 'tool', id: 'srv-read-error' }).catch(() => {})
    await until(() => entered)
    const stop = rejection(f.transport.stop())
    f.transport.process!.stdout.emit('error', raw)
    release()
    const error = await stop
    expect(error.category).toBe('stop')
    expect(error.causes.filter((cause: unknown) => cause === raw)).toHaveLength(1)
  })

  test('stop joins the whole native group: a helper holding stdout is cleared before the receipt', async () => {
    const tick = join(mkdtempSync(join(tmpdir(), 'agent-runtime-codex-tick-')), 'ticks')
    const f = fake()
    f.transport.start()
    const { helper } = (await f.transport.request('helper', { file: tick })) as { helper: number }
    await until(() => f.transport.counters.malformed > 0)
    expect(alive(helper)).toBe(true)
    const fact = await f.transport.stop()
    expect(fact).toMatchObject({ state: 'exited', groupCleared: true })
    expect(alive(helper)).toBe(false)
  })

  test('a SIGTERM-ignoring server keeps the stop pending until SIGKILL ends it', async () => {
    const f = fake({ terminate: { graceMs: 300, killMs: 2000 } })
    f.transport.start()
    await f.transport.request('ignoreTerm')
    const pid = f.transport.process!.pid!
    const stop = f.transport.stop()
    expect(await settled(stop, 150)).toBe(false)
    expect(alive(pid)).toBe(true)
    expect(await stop).toMatchObject({ state: 'exited', signal: 'SIGKILL', escalated: true })
    expect(alive(pid)).toBe(false)
  })

  test("a handler's own stop is refused internal while the shared stop it started joins that handler", async () => {
    let inner: Promise<ProcessExitFact> | null = null
    let innerError: any
    const f = fake({
      requestTimeoutMs: 0,
      onServerRequest: async () => {
        inner = f.transport.stop()
        innerError = await rejection(inner)
        return { answered: true }
      },
    })
    f.transport.start()
    const asked = rejection(f.transport.request('ask', { method: 'tool', id: 'srv-stop' }))
    await until(() => innerError !== undefined)
    expect(innerError.category).toBe('internal')
    const outer = f.transport.stop()
    expect(outer).not.toBe(inner)
    expect((await outer).state).toBe('exited')
    expect((await asked).category).toBe('stopped')
    expect(f.transport.counters.droppedReplies).toBe(1)
  })

  test('a recorder reentering stop at the spawn frame finds the process owned and stops it', async () => {
    let transport!: AppServerTransport
    let reentered: Promise<ProcessExitFact> | null = null
    const f = fake({
      wire: {
        record: (frame) => {
          if (frame.direction === 'lifecycle' && JSON.parse(frame.text).event === 'spawn') reentered ??= transport.stop()
        },
      },
    })
    transport = f.transport
    transport.start()
    expect(reentered).not.toBeNull()
    const fact = await reentered!
    expect(fact).toMatchObject({ state: 'exited', pid: transport.process!.pid })
    expect(alive(transport.process!.pid!)).toBe(false)
  })

  test('stop before start reports never-started and refuses a later start', async () => {
    const f = fake()
    expect(await f.transport.stop()).toEqual({ generation: 1, state: 'never-started' })
    expect(() => f.transport.start()).toThrow(expect.objectContaining({ category: 'stopped' }))
  })

  test('a notification observer may stop the transport; lines after stop began are not dispatched', async () => {
    const seen: unknown[] = []
    let stop: Promise<ProcessExitFact> | null = null
    const f = fake({
      onNotification: (_method, params) => {
        seen.push(params.n)
        stop ??= f.transport.stop()
      },
    })
    f.transport.start()
    const request = rejection(f.transport.request('notify', { count: 5 }))
    await until(() => stop !== null)
    expect((await stop!).state).toBe('exited')
    expect(seen).toEqual([0])
    expect((await request).category).toBe('stopped')
  })
})
