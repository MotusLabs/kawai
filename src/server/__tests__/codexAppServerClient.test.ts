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
    default:
      out({ id, result: { method: message.method, sawAppServerArg: process.argv.includes('app-server'), receivedParams: message.params ?? null } })
  }
}
;(async () => {
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
  overrides: Partial<Pick<AppServerClientOptions, 'onServerRequest' | 'killGraceMs'>> = {},
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

test('initialize sends clientInfo and the experimental capability', async () => {
  const { client } = startClient('echo')
  const result = await client.initialize({ name: 'kawai-test', title: 'Kawai test', version: '0.0.0' }) as {
    receivedParams?: { clientInfo?: Record<string, unknown>; capabilities?: Record<string, unknown> }
  }
  expect(result.receivedParams?.clientInfo).toEqual({ name: 'kawai-test', title: 'Kawai test', version: '0.0.0' })
  expect(result.receivedParams?.capabilities).toEqual({ experimentalApi: true, requestAttestation: false })
})
