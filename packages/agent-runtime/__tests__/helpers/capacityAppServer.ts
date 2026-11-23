// The in-process Codex app-server and fake capacity clock behind the
// codex-capacity-retry tests: the package's own tables (scriptedCodex.ts) and
// Kawai's manager-level rows (W1-W8, P4, which reach it through the package's
// private spawn and capacityClock seams). The test is the server: it sees
// every request the session writes and answers, fails or notifies by hand,
// except the boot (initialize, thread/start or resume), and turn/interrupt,
// which are answered at once; skills/list and rate-limit reads are refused as
// unknown methods. Each direction delivers on a later task. Model evidence
// only, never native exit.
import { PassThrough } from 'node:stream'
import type { CapacityClock } from '../../src/codex/capacityRetry.js'
import type { ProcessExitFact } from '../../src/contract.js'
import type { LeaderExit, OwnedProcess, OwnedSpawnRequest } from '../../src/process/ownedProcess.js'

export const EPOCH0 = Date.UTC(2026, 10, 18, 12, 0, 0)
export const THREAD = 'thr-capacity'

/** A manual clock: monotonic `now`, a wall clock that may jump, queued random fractions and ordered timers. */
export class FakeCapacityClock implements CapacityClock {
  now = 0
  wallOffset = 0
  randoms: number[] = []
  readonly timers = new Map<number, { at: number; fire: () => void }>()
  private next = 1
  monotonic = () => this.now
  epoch = () => EPOCH0 + this.now + this.wallOffset
  random = () => this.randoms.shift() ?? 0
  setTimer = (delayMs: number, fire: () => void) => {
    const id = this.next++
    this.timers.set(id, { at: this.now + delayMs, fire })
    return id
  }
  clearTimer = (handle: unknown) => void this.timers.delete(handle as number)
  /** Advance monotonic time, firing each due timer at its own time, oldest first. */
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      this.timers.delete(due[0])
      this.now = Math.max(this.now, due[1].at)
      due[1].fire()
    }
    this.now = end
  }
  /** Fire one armed timer now without moving the clock (an early or oversleeping callback is simulated by `now`). */
  fireAll(): void {
    for (const [id, timer] of Array.from(this.timers.entries())) {
      this.timers.delete(id)
      timer.fire()
    }
  }
  get pending(): number {
    return this.timers.size
  }
}

export interface ClientRequest {
  id: number
  method: string
  params: Record<string, any>
  /** The fake clock's monotonic time when the session wrote it. */
  at: number
}

export interface AppServer {
  /** The transport's private spawn seam: each call is one process generation. */
  spawn(request: OwnedSpawnRequest): OwnedProcess
  /** Every request the session wrote, in order (boot included). */
  requests: ClientRequest[]
  turnStarts(): ClientRequest[]
  interrupts(): ClientRequest[]
  reply(id: number, result: unknown): void
  fail(id: number, message: string, info?: unknown): void
  notify(method: string, params: Record<string, unknown>): void
  /** A server request to the session; resolves with the session's whole response message. */
  ask(method: string, params: Record<string, unknown>): Promise<Record<string, any>>
  /** The process ends (an unexpected exit unless the driver is stopping). */
  exit(code?: number): void
  flush(): Promise<void>
}

let nextPid = (1 << 30) + 500_000

/** One app-server for every process generation the session spawns; `thread` answers its boot. */
export function capacityAppServer(clock: FakeCapacityClock, thread: { id?: string; path?: string; model?: string } = {}): AppServer {
  const threadId = thread.id ?? THREAD
  const requests: ClientRequest[] = []
  let server: { write(message: unknown): void; exit(code: number): void } | null = null
  const send = (message: unknown) => server?.write(message)
  const spawn = (request: OwnedSpawnRequest): OwnedProcess => {
    const pid = nextPid++
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let exited: LeaderExit | null = null
    let settle!: (exit: LeaderExit) => void
    const leaderExit = new Promise<LeaderExit>((resolve) => (settle = resolve))
    const end = (exit: LeaderExit) => {
      if (exited) return
      exited = exit
      stdout.end()
      settle(exit)
    }
    const owned: OwnedProcess = {
      generation: request.generation, pid, stdin, stdout, leaderExit,
      get exited() { return exited },
      get evidence() { return exited ? Object.freeze({ exit: exited, marked: true, sentAfterMark: Object.freeze([]), errors: Object.freeze([]) }) : null },
      observerFailures: [], markTermination: () => {}, stderrTail: () => '',
      signal: (signal) => (exited ? false : (end({ kind: 'exited', code: null, signal }), true)),
      terminate: async () => {
        end({ kind: 'exited', code: 0, signal: null })
        return { generation: request.generation, state: 'exited', pid, code: 0, signal: null, escalated: false, groupCleared: true } satisfies ProcessExitFact
      },
    }
    request.onCreated?.(owned)
    let pending = ''
    server = {
      write: (message) => {
        if (exited) return
        if (pending === '') setImmediate(() => void (exited || stdout.write(pending), (pending = '')))
        pending += `${JSON.stringify(message)}\n`
      },
      exit: (code) => void setImmediate(() => end({ kind: 'exited', code, signal: null })),
    }
    let buffer = ''
    stdin.on('data', (chunk: Buffer) => {
      // The write's own time, before the delivery hop.
      const at = clock.now
      setImmediate(() => {
        if (exited) return
        buffer += chunk.toString('utf8')
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.trim()) handle(JSON.parse(line) as Record<string, any>, at)
        }
      })
    })
    return owned
  }
  const answers = new Map<number, (message: Record<string, any>) => void>()
  let nextAsk = 9000
  const reply = (id: number, result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: number, message: string, info?: unknown) => send({ jsonrpc: '2.0', id, error: { code: -32000, message, ...(info !== undefined ? { data: { codexErrorInfo: info } } : {}) } })
  function handle(message: Record<string, any>, at: number): void {
    const { id, method, params = {} } = message
    if (method === undefined) return void answers.get(id)?.(message)
    requests.push({ id, method, params, at })
    if (method === 'initialize') return reply(id, { userAgent: 'scripted-codex/0.163.0', codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'linux' })
    if (method === 'thread/start' || method === 'thread/resume') return reply(id, { thread: { id: threadId, path: thread.path ?? '' }, model: thread.model ?? 'fake-model' })
    if (method === 'turn/interrupt') return reply(id, {})
    if (method === 'turn/start' || method === 'turn/steer') return
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
  }
  return {
    spawn, requests,
    turnStarts: () => requests.filter((r) => r.method === 'turn/start'),
    interrupts: () => requests.filter((r) => r.method === 'turn/interrupt'),
    reply, fail,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params: { threadId, ...params } }),
    ask: (method, params) => {
      const id = nextAsk++
      return new Promise((resolve) => {
        answers.set(id, resolve)
        send({ jsonrpc: '2.0', id, method, params: { threadId, ...params } })
      })
    },
    exit: (code = 7) => server?.exit(code),
    flush: async () => {
      for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
    },
  }
}
