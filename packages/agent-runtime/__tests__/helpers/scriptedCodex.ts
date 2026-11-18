// A scripted in-process Codex app-server and a fake capacity clock for the
// codex-capacity-retry tables (O, C, L, T, P1-P3). The driver is the real
// package session built by createCodexDriverWith; only the process (through
// the transport's private spawn seam) and the capacity clock (the session's
// private capacityClock seam) are replaced. The test is the server: it sees
// every request the session writes and answers, fails or notifies by hand,
// except the boot (initialize, thread/start), skills/list, rate-limit reads
// and turn/interrupt, which are answered at once. Like inProcessCodex.ts each
// direction delivers on a later task. Model evidence only, never native exit.
import { PassThrough } from 'node:stream'
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexDriverWith } from '../../src/codex/driver.js'
import type { CapacityClock } from '../../src/codex/capacityRetry.js'
import type { ProcessExitFact, CodexAgentDriver, TurnResult } from '../../src/contract.js'
import type { AgentEvent } from '../../src/events.js'
import type { Activity } from '../../src/activity.js'
import type { LimitEvent } from '../../src/usage/types.js'
import type { CodexDriverOptions } from '../../src/options.js'
import type { LeaderExit, OwnedProcess, OwnedSpawnRequest } from '../../src/process/ownedProcess.js'
import { PERMISSIONS } from './codexDriverHarness.js'

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
    for (const [id, timer] of [...this.timers.entries()]) {
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
}

export interface Scripted {
  driver: CodexAgentDriver
  clock: FakeCapacityClock
  events: AgentEvent[]
  activities: Array<Activity | null>
  limits: LimitEvent[]
  results: TurnResult[]
  /** Every request the session wrote, in order (boot included). */
  requests: ClientRequest[]
  turnStarts(): ClientRequest[]
  interrupts(): ClientRequest[]
  reply(id: number, result: unknown): void
  fail(id: number, message: string, info?: unknown): void
  notify(method: string, params: Record<string, unknown>): void
  /** The process ends (an unexpected exit unless the driver is stopping). */
  exit(code?: number): void
  flush(): Promise<void>
  types(): string[]
}

let sharedRoot: { launch: CodexDriverOptions['launch'] } | null = null
function launch(): CodexDriverOptions['launch'] {
  if (!sharedRoot) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-capacity-')))
    for (const dir of ['home', 'cache', 'tmp', 'bin', 'work']) mkdirSync(join(root, dir))
    const wrapper = join(root, 'bin', 'codex')
    writeFileSync(wrapper, '#!/bin/sh\nexit 1\n')
    chmodSync(wrapper, 0o755)
    sharedRoot = { launch: { cwd: join(root, 'work'), childEnv: { CODEX_HOME: join(root, 'home') }, executablePath: wrapper, homeDir: join(root, 'home'), cacheDir: join(root, 'cache'), tempDir: join(root, 'tmp') } }
  }
  return sharedRoot.launch
}

let nextPid = (1 << 30) + 500_000

/** One scripted driver; `capacityRecovery` as given (omit it for the default). */
export function scriptedCodex(options: { capacityRecovery?: unknown; clock?: FakeCapacityClock } = {}): Scripted {
  const clock = options.clock ?? new FakeCapacityClock()
  const recorded = { events: [] as AgentEvent[], activities: [] as Array<Activity | null>, limits: [] as LimitEvent[], results: [] as TurnResult[], requests: [] as ClientRequest[] }
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
    stdin.on('data', (chunk: Buffer) => void setImmediate(() => {
      if (exited) return
      buffer += chunk.toString('utf8')
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) handle(JSON.parse(line) as Record<string, any>)
      }
    }))
    return owned
  }
  const reply = (id: number, result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: number, message: string, info?: unknown) => send({ jsonrpc: '2.0', id, error: { code: -32000, message, ...(info !== undefined ? { data: { codexErrorInfo: info } } : {}) } })
  function handle(message: Record<string, any>): void {
    const { id, method, params = {} } = message
    if (method === undefined) return
    recorded.requests.push({ id, method, params })
    if (method === 'initialize') return reply(id, { userAgent: 'scripted-codex/0.163.0', codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'linux' })
    if (method === 'thread/start' || method === 'thread/resume') return reply(id, { thread: { id: THREAD, path: '' }, model: 'fake-model' })
    if (method === 'turn/interrupt') return reply(id, {})
    if (method === 'turn/start' || method === 'turn/steer') return
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
  }
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const driverOptions = {
    logger, launch: launch(), permissions: PERMISSIONS,
    ...(options.capacityRecovery !== undefined ? { capacityRecovery: options.capacityRecovery as 'bounded' } : {}),
    callbacks: {
      onEvent: (event: AgentEvent) => void recorded.events.push(event),
      onActivity: (activity: Activity | null) => void recorded.activities.push(activity),
      onLimitEvent: (event: LimitEvent) => void recorded.limits.push(event),
      onTurnResult: (result: TurnResult) => void recorded.results.push(result),
    },
  } satisfies CodexDriverOptions
  const driver = createCodexDriverWith(driverOptions, { spawn, capacityClock: clock })
  return {
    driver, clock, ...recorded,
    turnStarts: () => recorded.requests.filter((r) => r.method === 'turn/start'),
    interrupts: () => recorded.requests.filter((r) => r.method === 'turn/interrupt'),
    reply, fail,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params: { threadId: THREAD, ...params } }),
    exit: (code = 7) => server?.exit(code),
    flush: async () => {
      for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
    },
    types: () => recorded.events.map((event) => event.type),
  }
}

/** Frame helpers for one attempt id. */
export const frames = {
  started: (turnId: string) => ['turn/started', { turn: { id: turnId, status: 'inProgress', items: [], error: null } }] as const,
  completed: (turnId: string, items: unknown[] = []) => ['turn/completed', { turn: { id: turnId, status: 'completed', error: null, items } }] as const,
  failed: (turnId: string, codexErrorInfo: unknown, message = 'the turn failed') => ['turn/completed', { turn: { id: turnId, status: 'failed', error: { message, codexErrorInfo, additionalDetails: null }, items: [] } }] as const,
  interrupted: (turnId: string) => ['turn/completed', { turn: { id: turnId, status: 'interrupted', error: null, items: [] } }] as const,
  retryError: (turnId: string, codexErrorInfo: unknown, willRetry = true) => ['error', { turnId, willRetry, error: { message: 'busy', codexErrorInfo, additionalDetails: null } }] as const,
}
