import { afterEach, beforeEach, expect, test } from 'bun:test'
import { WebSocketManager } from '../hooks/useWebSocket'
class Socket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  static all: Socket[] = []
  readyState = 0; bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  constructor(readonly url: string) { Socket.all.push(this) }
  send(text: string) { this.sent.push(text) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  pong(seq?: number) { this.onmessage?.({ data: JSON.stringify({ type: 'pong', seq: seq ?? JSON.parse(this.sent.at(-1)!).seq }) }) }
}
let now = 0, hidden = false, id = 0
const timers = new Map<number, { callback: () => void; delay: number }>()
const intervals = new Map<number, { callback: () => void; delay: number }>()
const original = { window: globalThis.window, document: globalThis.document, WebSocket: globalThis.WebSocket }
const managers: WebSocketManager[] = []
function manager() { const m = new WebSocketManager(() => now); managers.push(m); return m }
function fire(delay: number, map = timers) {
  const entry = [...map].find(([, value]) => value.delay === delay)
  expect(entry).toBeDefined()
  if (map === timers) map.delete(entry![0])
  entry![1].callback()
}
function internal(m: WebSocketManager) { return m as unknown as {
  nextConnectTimeoutMs: number; isResumeAttempt: boolean; srtt: number | null; verifyConnection(): void
} }
beforeEach(() => {
  now = 0; hidden = false; id = 0; timers.clear(); intervals.clear(); Socket.all = []
  Object.assign(globalThis, { WebSocket: Socket,
    document: { get visibilityState() { return hidden ? 'hidden' : 'visible' } },
    window: { location: { protocol: 'http:', host: 'fixture' },
      setTimeout: (callback: () => void, delay: number) => { timers.set(++id, { callback, delay }); return id },
      clearTimeout: (key: number) => { timers.delete(key); intervals.delete(key) },
      setInterval: (callback: () => void, delay: number) => { intervals.set(++id, { callback, delay }); return id },
      clearInterval: (key: number) => { timers.delete(key); intervals.delete(key) },
    },
  })
})
afterEach(() => { for (const m of managers.splice(0)) m.disconnect(); Object.assign(globalThis, original) })

// @covers: terminal-streaming › Connect timeouts grow with the link's handshake time › A slow handshake eventually connects
// @covers: terminal-streaming › Connect timeouts grow with the link's handshake time › Escalation is capped
// @covers: terminal-streaming › Connect timeouts grow with the link's handshake time › A fast link keeps fast failure detection
// @covers: terminal-streaming › Connect timeouts grow with the link's handshake time › A slow link keeps its learned timeout
test('T1-T11: real manager timers follow timeout, open, error and resume rows', () => {
  const cases = [
    ['T1', 3000, 'none', 0, false, 3000], ['T2', 3000, 'timeout', 0, false, 6000],
    ['T3', 12000, 'timeout', 0, false, 24000], ['T4', 24000, 'timeout', 0, false, 24000],
    ['T5', 24000, 'open', 200, false, 3000], ['T6', 3000, 'open', 5000, false, 15000],
    ['T7', 3000, 'open', 10000, false, 24000], ['T8', 3000, 'error', 0, false, 3000],
    ['T9', 3000, 'none', 0, true, 8000], ['T10', 24000, 'none', 0, true, 24000],
    ['T11', 6000, 'open', 1000, false, 3000],
  ] as const
  for (const [name, previous, event, elapsed, resume, expected] of cases) {
    const m = manager(); internal(m).nextConnectTimeoutMs = previous; internal(m).isResumeAttempt = resume
    m.connect(); const socket = Socket.all.at(-1)!
    if (event === 'none') expect([...timers.values()].some(t => t.delay === expected), name).toBe(true)
    if (event === 'timeout') { fire(previous); expect(internal(m).nextConnectTimeoutMs, name).toBe(expected) }
    if (event === 'open') { now += elapsed; socket.open(); expect(internal(m).nextConnectTimeoutMs, name).toBe(expected) }
    if (event === 'error') { socket.onerror?.(); expect(internal(m).nextConnectTimeoutMs, name).toBe(expected) }
    m.disconnect(); timers.clear(); intervals.clear()
  }
})

test('T12: a four-second handshake succeeds on the second attempt', () => {
  const m = manager(); m.connect()
  now = 3000; fire(3000); fire(1000)
  expect(Socket.all).toHaveLength(2)
  now += 4000; Socket.all[1]!.open()
  expect(m.getStatus()).toBe('connected')
})

// @covers: terminal-streaming › Resume verification waits for the measured round trip › A slow but live link passes verification
// @covers: terminal-streaming › Resume verification waits for the measured round trip › A dead socket on a fast link is still caught quickly
// @covers: terminal-streaming › Resume verification waits for the measured round trip › The deadline is capped
test('V1-V8: only armed heartbeat pongs learn the real verification deadline', () => {
  const cases = [
    { id: 'V1', samples: [], expected: 1500 }, { id: 'V2', samples: [50], expected: 1500 },
    { id: 'V3', samples: [1000], expected: 3000 }, { id: 'V4', samples: [5000], expected: 8000 },
    { id: 'V5', samples: [400, 1200], expected: 1500 },
  ]
  for (const c of cases) {
    const m = manager(); m.connect(); const socket = Socket.all.at(-1)!; socket.open()
    for (const sample of c.samples) { fire(20000, intervals); now += sample; socket.pong() }
    internal(m).verifyConnection()
    expect([...timers.values()].some(timer => timer.delay === c.expected), c.id).toBe(true)
    now += 1200; socket.pong()
    expect(Socket.all.at(-1)).toBe(socket)
    m.disconnect(); timers.clear(); intervals.clear()
  }
  const m = manager(); m.connect(); const socket = Socket.all.at(-1)!; socket.open()
  internal(m).verifyConnection(); now += 4000; socket.pong() // V6: verify is never a sample.
  expect(internal(m).srtt).toBeNull()
  fire(5000); now += 1000; socket.pong()
  expect(internal(m).srtt).toBe(1000)
  m.disconnect(); m.connect(); Socket.all.at(-1)!.open()
  internal(m).verifyConnection()
  expect([...timers.values()].some(timer => timer.delay === 3000)).toBe(true) // V7 kept across reconnect.
  // V8 dead fast socket: the scheduled deadline initiates reconnection.
  m.disconnect(); const fast = manager(); fast.connect(); Socket.all.at(-1)!.open()
  internal(fast).verifyConnection(); now += 1500; fire(1500)
  expect(fast.getStatus()).not.toBe('connected')
})

test('stale, hidden and late pongs cannot pollute heartbeat RTT', () => {
  const m = manager(); m.connect(); const old = Socket.all.at(-1)!; old.open()
  fire(20000, intervals); now += 1000; old.pong(-1)
  expect(internal(m).srtt).toBeNull()
  hidden = true; old.pong(); expect(internal(m).srtt).toBeNull()
  hidden = false; old.pong(); expect(internal(m).srtt).toBeNull() // hidden pong cleared the arm.
  const queued = old.onmessage
  m.disconnect(); m.connect(); const next = Socket.all.at(-1)!; next.open()
  fire(20000, intervals)
  queued?.({ data: JSON.stringify({ type: 'pong', seq: JSON.parse(next.sent.at(-1)!).seq }) })
  expect(internal(m).srtt).toBeNull()
  now += 10001; next.pong()
  expect(internal(m).srtt).toBeNull()
})
