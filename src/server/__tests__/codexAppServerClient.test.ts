// §4.3 (codex-chat-sessions): the AppServerClient frames newline-delimited
// JSON-RPC over one spawned `app-server` child, correlates responses by id
// even when they arrive out of order, answers server requests from its
// handler, records every line in the wire log, and rejects pending requests
// when the child exits. The child is a scripted fake (behavior keyed by
// FAKE_MODE), never the host's codex.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppServerClient, type AppServerClientOptions } from '../chat/codex/appServerClient'
import type { ChatWireRecorder } from '../chat/wireTap'

const FAKE_SOURCE = `#!/usr/bin/env bun
// Scripted Codex app-server fake for the AppServerClient unit tests (4.3):
// behavior keyed by FAKE_MODE, not a protocol implementation (the
// transcript-replaying fake of 4.4 lives in tests/fixtures/).
const mode = process.env.FAKE_MODE ?? 'echo'
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const reversed = []
const handle = (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === undefined) return // a reply or stray response: nothing to replay
  const id = message.id
  switch (mode) {
    case 'reversed': {
      reversed.push(id)
      if (reversed.length === 2) {
        out({ id: reversed[1], result: { which: 'second' } })
        out({ id: reversed[0], result: { which: 'first' } })
      }
      break
    }
    case 'notify':
      out({ method: 'turn/plan/updated', params: { plan: ['a'] } })
      out({ id, result: {} })
      break
    case 'server-request':
      out({ jsonrpc: '2.0', id: 'srv-1', method: 'item/tool/call', params: { tool: 'x' } })
      out({ id, result: {} })
      break
    case 'torn':
      process.stdout.write('{"id":')
      setTimeout(() => process.stdout.write('1,"result":{"torn":true}}\\n'), 80)
      break
    case 'exit-pending':
      process.exit(3)
      break
    case 'self-exit':
      out({ id, result: {} })
      setTimeout(() => process.exit(0), 30)
      break
    case 'term-proof':
      process.on('SIGTERM', () => {})
      out({ id, result: {} })
      break
    case 'error':
      out({ id, error: { code: -32000, message: 'nope' } })
      break
    case 'hang':
      break // never answers: the request deadline decides
    case 'null-error':
      // A parse-level failure names no request: id null.
      out({ id: null, error: { code: -32700, message: 'parse error' } })
      break
    case 'pgid': {
      // /proc/self/stat: pid (comm) state ppid pgrp — pgrp is field 5.
      const stat = require('node:fs').readFileSync('/proc/self/stat', 'utf8')
      const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[2])
      out({ id, result: { pid: process.pid, pgrp } })
      break
    }
    case 'garbage':
      process.stdout.write('<!doctype html>\\n')
      out({ id, result: {} })
      break
    case 'flush-exit':
      // Answers and exits at once: the exit races the final flush, and the
      // client must still drain the response before it settles the exit.
      out({ id, result: {} })
      process.exit(0)
      break
    case 'orphan-grandchild': {
      // Answers, then exits while a grandchild that inherited the pipes
      // keeps them open: the exit must settle on the drain bound (R2-1),
      // not wait for the stream closes the grandchild controls.
      const { spawn } = require('node:child_process')
      spawn('sleep', ['2'], { stdio: ['ignore', 'inherit', 'inherit'] })
      out({ id, result: {} })
      setTimeout(() => process.exit(3), 20)
      break
    }
    default:
      out({ id, result: { method: message.method, sawAppServerArg: process.argv.includes('app-server'), receivedParams: message.params ?? null } })
  }
}
;(async () => {
  // The late-response mode (R2-1) owns stdin itself: on the first request
  // it exits without answering, while a grandchild that inherited stdout
  // writes the response a moment later and holds the pipe. The response
  // must still be routed: settling at the exit itself would reject a
  // request whose answer is already in flight. Two readers on one stream
  // race, so the plain loop below stands down for it.
  if (mode === 'late-response-grandchild') {
    let late = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      late += chunk
      let index
      while ((index = late.indexOf('\\n')) !== -1) {
        const line = late.slice(0, index)
        late = late.slice(index + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.id === undefined) continue
        const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'codex-late-'))
        const file = require('node:path').join(dir, 'response')
        require('node:fs').writeFileSync(file, JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { late: true } }) + '\\n')
        require('node:child_process').spawn('sh', ['-c', 'sleep 0.25; cat ' + file + '; rm -rf ' + dir + '; sleep 2'], { stdio: ['ignore', 'inherit', 'inherit'] })
        setTimeout(() => process.exit(7), 20)
        return
      }
    })
    return
  }
  let buffered = ''
  for await (const chunk of Bun.stdin.stream()) {
    buffered += new TextDecoder().decode(chunk)
    let index
    while ((index = buffered.indexOf('\\n')) !== -1) {
      handle(buffered.slice(0, index))
      buffered = buffered.slice(index + 1)
    }
  }
})()
`

let tempDir: string
let fakePath: string
const clients: AppServerClient[] = []


interface RecordedFrame {
  dir: string
  line: string
}

const recordingWire = (): ChatWireRecorder & { frames: RecordedFrame[] } => {
  const frames: RecordedFrame[] = []
  return { frames, record(dir, raw) { frames.push({ dir, line: raw }) } }
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-client-')))
  fakePath = path.join(tempDir, 'fake-app-server')
  fs.writeFileSync(fakePath, FAKE_SOURCE)
  fs.chmodSync(fakePath, 0o755)
})

afterEach(() => {
  for (const client of clients.splice(0)) client.end()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const startClient = (
  mode: string,
  overrides: Partial<Pick<AppServerClientOptions, 'onServerRequest' | 'killGraceMs' | 'requestTimeoutMs' | 'drainBoundMs'>> = {},
) => {
  const wire = recordingWire()
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const exits: Array<{ code: number | null; signal: string | null }> = []
  const client = new AppServerClient({
    executable: fakePath,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: mode },
    wire,
    onNotification: (method, params) => notifications.push({ method, params }),
    onServerRequest: overrides.onServerRequest ?? (async () => ({})),
    onExit: exit => exits.push(exit),
    killGraceMs: overrides.killGraceMs ?? 200,
    requestTimeoutMs: overrides.requestTimeoutMs,
    drainBoundMs: overrides.drainBoundMs,
  })
  client.start()
  clients.push(client)
  return { client, wire, notifications, exits }
}

const until = async (predicate: () => boolean, ms = 2_000): Promise<boolean> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) return false
    await Bun.sleep(10)
  }
  return true
}

test('a request resolves with the response result, argv, and params', async () => {
  const { client } = startClient('echo')
  const result = await client.request('thread/start', { cwd: '/tmp/x' }) as Record<string, unknown>
  expect(result.method).toBe('thread/start')
  expect(result.sawAppServerArg).toBe(true)
  expect(result.receivedParams).toEqual({ cwd: '/tmp/x' })
})

test('concurrent requests settle by id when responses arrive reversed', async () => {
  const { client } = startClient('reversed')
  const first = client.request('a') as Promise<Record<string, string>>
  const second = client.request('b') as Promise<Record<string, string>>
  expect(await second).toEqual({ which: 'second' })
  expect(await first).toEqual({ which: 'first' })
})

test('a notification reaches the handler before the response settles', async () => {
  const { client, notifications } = startClient('notify')
  await client.request('ping')
  expect(notifications).toEqual([{ method: 'turn/plan/updated', params: { plan: ['a'] } }])
})

test('a server request is answered with the handler result and the reply is recorded', async () => {
  const handled: Array<{ method: string; params: Record<string, unknown> }> = []
  const { client, wire } = startClient('server-request', {
    onServerRequest: async (method, params) => {
      handled.push({ method, params })
      return { decision: 'accept' }
    },
  })
  await client.request('turn/start', {})
  expect(await until(() => wire.frames.some(frame => frame.dir === 'out' && frame.line.includes('srv-1')))).toBe(true)
  expect(handled).toEqual([{ method: 'item/tool/call', params: { tool: 'x' } }])
  const reply = JSON.parse(wire.frames.find(frame => frame.dir === 'out' && frame.line.includes('srv-1'))!.line)
  expect(reply).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: { decision: 'accept' } })
})

test('a rejecting server-request handler replies with a JSON-RPC error', async () => {
  const { client, wire } = startClient('server-request', {
    onServerRequest: async () => {
      throw new Error('no')
    },
  })
  await client.request('turn/start', {})
  expect(await until(() => wire.frames.some(frame => frame.dir === 'out' && frame.line.includes('-32603')))).toBe(true)
  const reply = JSON.parse(wire.frames.find(frame => frame.dir === 'out' && frame.line.includes('-32603'))!.line)
  expect(reply.id).toBe('srv-1')
  expect(reply.error).toEqual({ code: -32603, message: 'no' })
})

test('a response split across writes still settles the request', async () => {
  const { client } = startClient('torn')
  expect(await client.request('x')).toEqual({ torn: true })
})

test('an error response rejects the request naming the error', async () => {
  const { client } = startClient('error')
  try {
    await client.request('turn/start')
    throw new Error('expected the rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('-32000')
    expect((error as Error).message).toContain('nope')
  }
})

test('a child exit rejects pending requests, fires onExit, and refuses later ones', async () => {
  const { client, exits } = startClient('exit-pending')
  const pending = client.request('turn/start')
  try {
    await pending
    throw new Error('expected the rejection')
  } catch (error) {
    expect((error as Error).message).toContain('exited with code 3')
    expect((error as Error).message).toContain('request 1 pending')
  }
  expect(exits).toEqual([{ code: 3, signal: null }])
  try {
    await client.request('later')
    throw new Error('expected the rejection')
  } catch (error) {
    expect((error as Error).message).toContain('already exited')
  }
})

test('end() stops the child with SIGTERM by default', async () => {
  const { client, exits } = startClient('echo')
  await client.request('ping')
  client.end()
  await client.whenExited()
  expect(exits).toEqual([{ code: null, signal: 'SIGTERM' }])
})

test('end() escalates to SIGKILL when the child ignores SIGTERM', async () => {
  const { client, exits } = startClient('term-proof', { killGraceMs: 150 })
  await client.request('ping')
  client.end()
  await client.whenExited()
  expect(exits).toEqual([{ code: null, signal: 'SIGKILL' }])
}, 10_000)

test('an unplanned clean exit fires onExit with the code', async () => {
  const { client, exits } = startClient('self-exit')
  await client.request('ping')
  await client.whenExited()
  expect(exits).toEqual([{ code: 0, signal: null }])
})

test('every line crosses the wire recorder, with spawn and exit lifecycle frames', async () => {
  const { client, wire } = startClient('echo')
  await client.request('thread/start', { cwd: '/tmp/x' })
  client.end()
  await client.whenExited()
  const dirs = wire.frames.map(frame => frame.dir)
  expect(dirs[0]).toBe('lifecycle')
  expect(JSON.parse(wire.frames[0]!.line)).toMatchObject({ event: 'spawn', command: fakePath, args: ['app-server'] })
  const out = wire.frames.filter(frame => frame.dir === 'out')
  expect(out).toHaveLength(1)
  expect(JSON.parse(out[0]!.line)).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: '/tmp/x' } })
  expect(dirs).toContain('lifecycle')
  const lifecycleExit = wire.frames.filter(frame => frame.dir === 'lifecycle').at(-1)!
  expect(JSON.parse(lifecycleExit.line)).toMatchObject({ event: 'exit' })
})

test('a request without a response times out naming the method (N5)', async () => {
  const { client } = startClient('hang', { requestTimeoutMs: 120 })
  try {
    await client.request('thread/start')
    throw new Error('expected the timeout')
  } catch (error) {
    expect((error as Error).message).toContain('thread/start')
    expect((error as Error).message).toContain('timed out after 120 ms')
  }
}, 5_000)

test('an error with id null rejects every pending request (N5)', async () => {
  const { client } = startClient('null-error', { requestTimeoutMs: 0 })
  const first = client.request('a')
  const second = client.request('b')
  const settled = await Promise.allSettled([first, second])
  expect(settled.map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
  for (const outcome of settled) {
    expect((outcome as PromiseRejectedResult).reason.message).toContain('-32700')
    expect((outcome as PromiseRejectedResult).reason.message).toContain('uncorrelated')
  }
  // Nothing stays pending: a later exit has nothing to reject.
  expect(client.exit).toBeNull()
}, 5_000)

test('the child leads its own process group, so end() reaches helper grandchildren (N5)', async () => {
  const { client } = startClient('pgid')
  const result = await client.request('x') as { pid: number; pgrp: number }
  // Detached spawn: the child is its own group leader. A detached:false
  // mutant shares the test runner's group and fails here.
  expect(result.pgrp).toBe(result.pid)
}, 5_000)

test('a non-JSON line is recorded raw and never dispatched (N5)', async () => {
  const { client, wire, notifications } = startClient('garbage')
  await client.request('x')
  const raw = wire.frames.find(frame => frame.dir === 'in' && frame.line.startsWith('<!doctype'))
  expect(raw).toBeDefined()
  expect(notifications).toEqual([])
}, 5_000)

test('a response that lands as the child exits still resolves, and stdout drains before the exit settles (N5)', async () => {
  const { client, wire } = startClient('flush-exit')
  // The exit settles only after the streams close, so the response is
  // dispatched and every 'in' frame is recorded before the lifecycle exit.
  const result = await client.request('x')
  expect(result).toEqual({})
  await client.whenExited()
  expect(client.exit).toEqual({ code: 0, signal: null })
  const inRecord = wire.frames.findIndex(frame => frame.dir === 'in')
  const exitRecord = wire.frames.findIndex(frame => frame.dir === 'lifecycle' && frame.line.includes('"event":"exit"'))
  expect(inRecord).toBeGreaterThanOrEqual(0)
  expect(exitRecord).toBeGreaterThan(inRecord)
}, 5_000)

test('an orphan grandchild holding the pipes cannot hold the exit open (R2-1)', async () => {
  // The child exits 3 while its grandchild (sleep 2, pipes inherited)
  // keeps both streams open: the exit settles on the ~250 ms drain bound,
  // not on the closes. The settle-only-on-closes shape this replaces can
  // only settle when the grandchild dies (~2 s), past this timeout.
  const { client } = startClient('orphan-grandchild', { drainBoundMs: 250 })
  await client.request('ping')
  const started = Date.now()
  const exit = await client.whenExited()
  expect(exit).toEqual({ code: 3, signal: null })
  expect(Date.now() - started).toBeLessThan(1_000)
}, 1_500)

test('a response a grandchild writes after the exit still resolves its request (R2-1)', async () => {
  // The parent exits 7 without answering; its grandchild writes the
  // response ~250 ms in, well inside the ~600 ms drain bound — the bound
  // must not outrun an answer that is already in flight. Settling at the
  // exit itself rejects the pending request before its answer lands, so
  // this kills the immediate-settle shape; waiting for the closes forever
  // hangs on whenExited, so it kills that shape too.
  const { client } = startClient('late-response-grandchild', { drainBoundMs: 600 })
  const result = await client.request('initialize') as { late?: boolean }
  expect(result.late).toBe(true)
  const exit = await client.whenExited()
  expect(exit).toEqual({ code: 7, signal: null })
}, 2_000)

test('initialize sends clientInfo and the experimental capability', async () => {
  const { client } = startClient('echo')
  const result = await client.initialize({ name: 'kawai-test', title: 'Kawai test', version: '0.0.0' }) as {
    receivedParams?: { clientInfo?: Record<string, unknown>; capabilities?: Record<string, unknown> }
  }
  expect(result.receivedParams?.clientInfo).toEqual({ name: 'kawai-test', title: 'Kawai test', version: '0.0.0' })
  expect(result.receivedParams?.capabilities).toEqual({ experimentalApi: true, requestAttestation: false })
})
