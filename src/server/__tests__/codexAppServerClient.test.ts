// §4.3 (codex-chat-sessions): the Codex app-server RPC transport frames
// newline-delimited JSON-RPC over one spawned `app-server` child, correlates
// responses by id even when they arrive out of order, answers server requests
// from its handler, records every line in the wire log, and rejects pending
// requests when the child exits. The child is a scripted fake (behavior keyed
// by FAKE_MODE), never the host's codex.
//
// These are the retired root AppServerClient's cases, run on the package's
// AppServerTransport over its default-owned stdio child (task-d52b6709): the
// client's initialize(info) became construction-time clientInfo/capabilities,
// end()/whenExited() the awaited stop() and its ProcessExitFact (onExit stays
// for unsolicited exits only), legacy error strings the typed RPC error fields.
// Two oracles changed by contract: a native exit rejects every pending request
// with the transport's one generic exit error, so the request ids come from the
// recorded wire, not the message (A8); the native lifecycle exit frame is
// recorded when the leader exits, so drain order is read from the received
// frame and the onExit report, not from that frame's position (A9).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DRAIN_BOUND_MS, AppServerRpcError } from '../../../packages/agent-runtime/src/codex/appServerTransport'
import { CAPABILITIES, CLIENT_INFO } from '../../../packages/agent-runtime/src/codex/generation'
import type { AgentRuntimeError } from '../../../packages/agent-runtime/src/errors'
import { transportCases, type RecordedFrame, type TransportCaseInput, type TransportCases } from './helpers/codexTransportHarness'

const FAKE_SOURCE = `#!/usr/bin/env bun
// Scripted Codex app-server fake for the app-server transport cases (4.3):
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
    case 'exit-two-pending':
      // Exits 3 once two requests are pending, answering neither.
      reversed.push(id)
      if (reversed.length === 2) process.exit(3)
      break
    case 'self-exit':
      out({ id, result: {} })
      setTimeout(() => process.exit(0), 30)
      break
    case 'term-proof':
      process.on('SIGTERM', () => {})
      // The transport's stop closes stdin before it signals; like the
      // package's own fake, stay alive past that EOF so only SIGKILL ends it.
      setInterval(() => {}, 1 << 30)
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
    case 'launch':
      // The child's actual cwd and complete environment, as it sees them.
      out({ id, result: { cwd: process.cwd(), env: { ...process.env } } })
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

let fakePath: string
let cases: TransportCases

beforeEach(() => {
  cases = transportCases('kawai-codex-client-')
  fakePath = path.join(cases.root, 'fake-app-server')
  fs.writeFileSync(fakePath, FAKE_SOURCE)
  fs.chmodSync(fakePath, 0o755)
})

afterEach(async () => {
  // Every transport's shared stop joins before the root is removed.
  await cases.cleanup()
})

/** One case over the package transport and the fake, spawned `<fake> app-server`. */
const startTransport = (
  mode: string,
  overrides: Partial<Pick<TransportCaseInput, 'onServerRequest' | 'graceMs' | 'requestTimeoutMs' | 'drainBoundMs' | 'clientInfo'>> = {},
) => cases.open({
  executable: fakePath,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: mode },
  clientInfo: overrides.clientInfo ?? CLIENT_INFO,
  capabilities: CAPABILITIES,
  onServerRequest: overrides.onServerRequest ?? (async () => ({})),
  graceMs: overrides.graceMs ?? 200,
  requestTimeoutMs: overrides.requestTimeoutMs,
  drainBoundMs: overrides.drainBoundMs,
})

const until = async (predicate: () => boolean, ms = 2_000): Promise<boolean> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) return false
    await Bun.sleep(10)
  }
  return true
}

/** The rejection of `promise`, failing when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the rejection')
}

/** The id and method of every request the transport wrote, from the recorded wire. */
const sentRequests = (frames: RecordedFrame[]) => frames
  .filter(frame => frame.dir === 'out')
  .map(frame => JSON.parse(frame.line) as { id?: unknown; method?: unknown })
  .filter(message => message.method !== undefined)
  .map(message => ({ id: message.id, method: message.method }))

test('a request resolves with the response result, argv, and params', async () => {
  const { transport } = startTransport('echo')
  const result = await transport.request('thread/start', { cwd: '/tmp/x' }) as Record<string, unknown>
  expect(result.method).toBe('thread/start')
  expect(result.sawAppServerArg).toBe(true)
  expect(result.receivedParams).toEqual({ cwd: '/tmp/x' })
})

test('the child runs in the cwd it inherits at launch with exactly the supplied environment', async () => {
  const launchedFrom = process.cwd()
  const { transport } = startTransport('launch')
  const result = await transport.request('x') as { cwd: string; env: Record<string, string> }
  expect(result).toEqual({ cwd: launchedFrom, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: 'launch' } })
})

test('concurrent requests settle by id when responses arrive reversed', async () => {
  const { transport } = startTransport('reversed')
  const first = transport.request('a') as Promise<Record<string, string>>
  const second = transport.request('b') as Promise<Record<string, string>>
  expect(await second).toEqual({ which: 'second' })
  expect(await first).toEqual({ which: 'first' })
})

test('a notification reaches the handler before the response settles', async () => {
  const { transport, notifications } = startTransport('notify')
  await transport.request('ping')
  expect(notifications).toEqual([{ method: 'turn/plan/updated', params: { plan: ['a'] } }])
})

test('a server request is answered with the handler result and the reply is recorded', async () => {
  const handled: Array<{ method: string; params: Record<string, unknown> }> = []
  const { transport, frames } = startTransport('server-request', {
    onServerRequest: async (method, params) => {
      handled.push({ method, params })
      return { decision: 'accept' }
    },
  })
  await transport.request('turn/start', {})
  expect(await until(() => frames.some(frame => frame.dir === 'out' && frame.line.includes('srv-1')))).toBe(true)
  expect(handled).toEqual([{ method: 'item/tool/call', params: { tool: 'x' } }])
  const reply = JSON.parse(frames.find(frame => frame.dir === 'out' && frame.line.includes('srv-1'))!.line)
  expect(reply).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: { decision: 'accept' } })
})

test('a rejecting server-request handler replies with a JSON-RPC error', async () => {
  const thrown = new Error('no')
  const { transport, frames, stopFailure } = startTransport('server-request', {
    onServerRequest: async () => {
      throw thrown
    },
  })
  await transport.request('turn/start', {})
  expect(await until(() => frames.some(frame => frame.dir === 'out' && frame.line.includes('-32603')))).toBe(true)
  const reply = JSON.parse(frames.find(frame => frame.dir === 'out' && frame.line.includes('-32603'))!.line)
  expect(reply.id).toBe('srv-1')
  expect(reply.error).toEqual({ code: -32603, message: 'no' })
  // The error reply answers the server; the throw stays the handler job's
  // owned failure, so the stop reports exactly that error, once.
  const failure = await stopFailure() as AgentRuntimeError
  expect([failure.category, failure.causes]).toEqual(['stop', [thrown]])
  expect(failure.causes[0]).toBe(thrown)
})

test('a response split across writes still settles the request', async () => {
  const { transport } = startTransport('torn')
  expect(await transport.request('x')).toEqual({ torn: true })
})

test('an error response rejects the request naming the error', async () => {
  const { transport } = startTransport('error')
  const error = await rejection(transport.request('turn/start'))
  expect(error).toBeInstanceOf(AppServerRpcError)
  expect({ message: error.message, method: error.method, id: error.id, error: error.error, uncorrelated: error.uncorrelated }).toEqual({
    message: 'app-server request 1 (turn/start) failed: nope',
    method: 'turn/start',
    id: 1,
    error: { code: -32000, message: 'nope' },
    uncorrelated: false,
  })
})

test('a child exit rejects pending requests, fires onExit, and refuses later ones', async () => {
  const { transport, exits, frames } = startTransport('exit-pending')
  const error = await rejection(transport.request('turn/start'))
  // A8: the transport's generic native-exit error; the failed request's id is the recorded one.
  expect([error.category, error.message]).toEqual(['transport', 'the Codex app-server exited with code 3'])
  expect(sentRequests(frames)).toEqual([{ id: 1, method: 'turn/start' }])
  expect(transport.pendingCount).toBe(0)
  expect(exits).toEqual([{ kind: 'exited', code: 3, signal: null }])
  const later = await rejection(transport.request('later'))
  expect([later.category, later.message]).toEqual(['transport', 'the Codex app-server exited with code 3'])
  // The refusal wrote nothing.
  expect(sentRequests(frames)).toEqual([{ id: 1, method: 'turn/start' }])
})

test('a native exit rejects each of two pending requests with the one shared exit error; their ids are the recorded ones (A8)', async () => {
  const { transport, exits, frames } = startTransport('exit-two-pending')
  const first = rejection(transport.request('a'))
  const second = rejection(transport.request('b'))
  const [one, two] = await Promise.all([first, second])
  expect([one.category, one.message]).toEqual(['transport', 'the Codex app-server exited with code 3'])
  // Not per-request diagnostics: both operations carry the same raw error object.
  expect(two).toBe(one)
  expect(sentRequests(frames)).toEqual([{ id: 1, method: 'a' }, { id: 2, method: 'b' }])
  expect(transport.pendingCount).toBe(0)
  expect(exits).toEqual([{ kind: 'exited', code: 3, signal: null }])
  // The later refusal carries the same exit facts, and writes nothing.
  const later = await rejection(transport.request('c'))
  expect([later.category, later.message]).toEqual(['transport', 'the Codex app-server exited with code 3'])
  expect(sentRequests(frames)).toHaveLength(2)
})

test('stop() ends the child with SIGTERM by default; a planned stop reports no onExit', async () => {
  const { transport, exits, stop } = startTransport('echo')
  await transport.request('ping')
  const fact = await stop()
  expect(fact).toEqual({ generation: 1, state: 'exited', pid: transport.process!.pid!, code: null, signal: 'SIGTERM', escalated: false, groupCleared: true })
  // onExit reports unsolicited exits only; the planned stop's fact is its receipt.
  expect(exits).toEqual([])
})

test('stop() escalates to SIGKILL when the child ignores SIGTERM', async () => {
  const { transport, exits, stop } = startTransport('term-proof', { graceMs: 150 })
  await transport.request('ping')
  const fact = await stop()
  expect(fact).toEqual({ generation: 1, state: 'exited', pid: transport.process!.pid!, code: null, signal: 'SIGKILL', escalated: true, groupCleared: true })
  expect(exits).toEqual([])
}, 10_000)

test('an unplanned clean exit fires onExit with the code', async () => {
  const { transport, exits, reportedExit } = startTransport('self-exit')
  await transport.request('ping')
  expect(await reportedExit).toEqual({ kind: 'exited', code: 0, signal: null })
  expect(exits).toHaveLength(1)
})

test('every line crosses the wire recorder, with spawn and exit lifecycle frames', async () => {
  const { transport, frames, stop } = startTransport('echo')
  await transport.request('thread/start', { cwd: '/tmp/x' })
  await stop()
  const dirs = frames.map(frame => frame.dir)
  expect(dirs[0]).toBe('lifecycle')
  expect(JSON.parse(frames[0]!.line)).toMatchObject({ event: 'spawn', command: fakePath, args: ['app-server'] })
  const out = frames.filter(frame => frame.dir === 'out')
  expect(out).toHaveLength(1)
  expect(JSON.parse(out[0]!.line)).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: '/tmp/x' } })
  expect(dirs).toContain('lifecycle')
  const lifecycleExit = frames.filter(frame => frame.dir === 'lifecycle').at(-1)!
  expect(JSON.parse(lifecycleExit.line)).toMatchObject({ event: 'exit' })
})

test('a request without a response times out naming the method (N5)', async () => {
  const { transport } = startTransport('hang', { requestTimeoutMs: 120 })
  const error = await rejection(transport.request('thread/start'))
  expect([error.category, error.message]).toEqual(['transport', 'app-server request 1 (thread/start) had no reply within 120 ms'])
}, 5_000)

test('an error with id null rejects every pending request (N5)', async () => {
  const { transport } = startTransport('null-error', { requestTimeoutMs: 0 })
  const first = transport.request('a')
  const second = transport.request('b')
  const settled = await Promise.allSettled([first, second])
  expect(settled.map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
  const reasons = settled.map(outcome => (outcome as PromiseRejectedResult).reason as AppServerRpcError)
  expect(reasons.map(reason => ({ message: reason.message, method: reason.method, id: reason.id, error: reason.error, uncorrelated: reason.uncorrelated }))).toEqual([
    { message: 'app-server request 1 (a) failed on an uncorrelated server error: parse error', method: 'a', id: 1, error: { code: -32700, message: 'parse error' }, uncorrelated: true },
    { message: 'app-server request 2 (b) failed on an uncorrelated server error: parse error', method: 'b', id: 2, error: { code: -32700, message: 'parse error' }, uncorrelated: true },
  ])
  // Nothing stays pending, and the child is still running.
  expect(transport.pendingCount).toBe(0)
  expect(transport.process!.exited).toBeNull()
}, 5_000)

test('the child leads its own process group, so end() reaches helper grandchildren (N5)', async () => {
  const { transport } = startTransport('pgid')
  const result = await transport.request('x') as { pid: number; pgrp: number }
  // Detached spawn: the child is its own group leader. A detached:false
  // mutant shares the test runner's group and fails here.
  expect(result.pgrp).toBe(result.pid)
  expect(transport.process!.pid).toBe(result.pid)
}, 5_000)

test('a non-JSON line is recorded raw and never dispatched (N5)', async () => {
  const { transport, frames, notifications } = startTransport('garbage')
  await transport.request('x')
  const raw = frames.find(frame => frame.dir === 'in' && frame.line.startsWith('<!doctype'))
  expect(raw).toBeDefined()
  expect(notifications).toEqual([])
  expect(transport.counters).toEqual({ stray: 0, malformed: 1, droppedReplies: 0 })
}, 5_000)

test('a response that lands as the child exits still resolves, and stdout drains before the exit settles (N5)', async () => {
  const { transport, timeline, reportedExit } = startTransport('flush-exit')
  const result = await transport.request('x')
  expect(result).toEqual({})
  expect(await reportedExit).toEqual({ kind: 'exited', code: 0, signal: null })
  // A9: the native lifecycle exit frame may come before the final stdout
  // line; the drain fact is that the response was received before the exit
  // was reported, and that both native facts were recorded.
  const received = timeline.findIndex(entry => entry.kind === 'frame' && entry.dir === 'in' && entry.line.includes('"id":1'))
  const reported = timeline.findIndex(entry => entry.kind === 'onExit')
  const nativeExit = timeline.findIndex(entry => entry.kind === 'frame' && entry.dir === 'lifecycle' && entry.line.includes('"event":"exit"'))
  expect(received).toBeGreaterThanOrEqual(0)
  expect(nativeExit).toBeGreaterThanOrEqual(0)
  expect(reported).toBeGreaterThan(received)
  expect(transport.pendingCount).toBe(0)
}, 5_000)

test('an orphan grandchild holding the pipes cannot hold the exit open (R2-1)', async () => {
  // The child exits 3 while its grandchild (sleep 2, pipes inherited)
  // keeps both streams open: the exit settles on the ~250 ms drain bound,
  // not on the closes. The settle-only-on-closes shape this replaces can
  // only settle when the grandchild dies (~2 s), which the < 1 s assertion
  // below rejects; the 5 s case budget is owner-approved (task-f5001d7f A18).
  // onExit proves no empty group; the shared stop cleanup joins clears the grandchild.
  const { transport, reportedExit } = startTransport('orphan-grandchild', { drainBoundMs: 250 })
  await transport.request('ping')
  const started = Date.now()
  const exit = await reportedExit
  expect(exit).toEqual({ kind: 'exited', code: 3, signal: null })
  expect(Date.now() - started).toBeLessThan(1_000)
}, 5_000)

test('the default drain bound is 1 s, and an unset option uses it (T1)', async () => {
  expect(DRAIN_BOUND_MS).toBe(1_000)
  // No drainBoundMs: the orphan grandchild (sleep 2) holds the pipes, so
  // the exit settles on the default bound — never before it.
  const { transport, reportedExit } = startTransport('orphan-grandchild')
  await transport.request('ping')
  const started = Date.now()
  expect(await reportedExit).toEqual({ kind: 'exited', code: 3, signal: null })
  expect(Date.now() - started).toBeGreaterThanOrEqual(DRAIN_BOUND_MS - 100)
}, 4_000)

test('a response a grandchild writes after the exit still resolves its request (R2-1)', async () => {
  // The parent exits 7 without answering; its grandchild writes the
  // response ~250 ms in, well inside the ~600 ms drain bound — the bound
  // must not outrun an answer that is already in flight. Settling at the
  // exit itself rejects the pending request before its answer lands, so
  // this kills the immediate-settle shape; waiting for the closes forever
  // hangs on the exit report, so it kills that shape too.
  const { transport, timeline, reportedExit, stop } = startTransport('late-response-grandchild', { drainBoundMs: 600 })
  const result = await transport.request('initialize') as { late?: boolean }
  expect(result.late).toBe(true)
  const exit = await reportedExit
  expect(exit).toEqual({ kind: 'exited', code: 7, signal: null })
  // A9: the native exit frame truthfully precedes the late reply, which is
  // received before the drained exit is reported.
  const nativeExit = timeline.findIndex(entry => entry.kind === 'frame' && entry.dir === 'lifecycle' && entry.line.includes('"event":"exit"'))
  const received = timeline.findIndex(entry => entry.kind === 'frame' && entry.dir === 'in' && entry.line.includes('"late":true'))
  const reported = timeline.findIndex(entry => entry.kind === 'onExit')
  expect({ nativeBeforeReply: nativeExit >= 0 && nativeExit < received, replyBeforeReport: received >= 0 && received < reported })
    .toEqual({ nativeBeforeReply: true, replyBeforeReport: true })
  expect(await stop()).toMatchObject({ state: 'exited', code: 7, signal: null, groupCleared: true })
}, 2_000)

test('initialize sends clientInfo and the experimental capability', async () => {
  const { transport } = startTransport('echo', { clientInfo: { name: 'kawai-test', title: 'Kawai test', version: '0.0.0' } })
  const result = await transport.initialize() as {
    receivedParams?: { clientInfo?: Record<string, unknown>; capabilities?: Record<string, unknown> }
  }
  expect(result.receivedParams?.clientInfo).toEqual({ name: 'kawai-test', title: 'Kawai test', version: '0.0.0' })
  expect(result.receivedParams?.capabilities).toEqual({ experimentalApi: true, requestAttestation: false })
})

test('cleanup joins held handler work before it removes the root; overlapping cleanups share one promise', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let entered = false
  const seen: boolean[] = []
  const { transport } = startTransport('server-request', {
    onServerRequest: async (_method, _params, signal) => {
      entered = true
      await held
      seen.push(fs.existsSync(cases.root))
      throw signal.reason // the stop's own cancellation, never a failure
    },
  })
  let first: Promise<void> | undefined
  try {
    await transport.request('turn/start', {})
    expect(await until(() => entered)).toBe(true)
    first = cases.cleanup()
    const second = cases.cleanup()
    expect(second).toBe(first)
  } finally {
    // Whatever failed above, the hold is released and the shared cleanup joined.
    release()
    await (first ?? cases.cleanup())
  }
  expect({ seen, rootKept: fs.existsSync(cases.root) }).toEqual({ seen: [true], rootKept: false })
})

test('cleanup reports a stop failure the test did not explicitly assert, raw and once', async () => {
  // Its own cases, so this test takes the cleanup's rejection itself.
  const own = transportCases('kawai-codex-client-own-')
  const thrown = new Error('unasserted')
  const { transport, frames, stop } = own.open({
    executable: fakePath,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: 'server-request' },
    clientInfo: CLIENT_INFO,
    capabilities: CAPABILITIES,
    onServerRequest: async () => {
      throw thrown
    },
  })
  await transport.request('turn/start', {})
  expect(await until(() => frames.some(frame => frame.dir === 'out' && frame.line.includes('-32603')))).toBe(true)
  // Calling stop() is not asserting its failure: cleanup still reports it.
  const stopped = await rejection(stop())
  const reported = await rejection(own.cleanup())
  expect(reported).toBe(stopped)
  expect([reported.category, reported.causes]).toEqual(['stop', [thrown]])
  expect(fs.existsSync(own.root)).toBe(false)
})
