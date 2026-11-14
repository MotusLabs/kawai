// A native-free process for the real pinned SDK (task-d6bf9929 R2): the
// SDK's ProcessTransport speaks stream-json to it over in-memory pipes, and
// the test decides when the "process" answers, ends its stdout or exits, so
// the SDK's own cleanup orders (exit first, EOF first, our close first) run
// deterministically. There is no owned process, so a stop's native account
// is empty: these cases prove control cancellation only, never an owned exit.
// A test may install a controlled owner whose frozen evidence it chooses, to
// drive the real stop account; that is controlled evidence, not a native run.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Options, Query, SDKUserMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { genuineQuery } from '../../src/claude/sdkControlCleanup.js'
import { loadSdk } from '../../src/claude/generations.js'
import type { ClaudeQueryFactory } from '../../src/claude/session.js'
import type { ProcessExitFact } from '../../src/contract.js'
import type { LeaderExit, NativeEvidence } from '../../src/process/ownedProcess.js'

export interface ControlFrame {
  request_id: string
  request: { subtype: string } & Record<string, unknown>
}

export class PipeProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly kills: string[] = []
  readonly controls: ControlFrame[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private readonly events = new EventEmitter()
  private buffer = ''
  private readonly waiters: Array<{ subtype: string; resolve: (frame: ControlFrame) => void }> = []

  constructor() {
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (!line) continue
        const frame = JSON.parse(line) as { type?: string } & Partial<ControlFrame>
        if (frame.type !== 'control_request') continue
        const control = frame as ControlFrame
        this.controls.push(control)
        if (control.request.subtype === 'initialize') this.respond(control, { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] })
        for (const waiter of this.waiters.splice(0)) {
          if (waiter.subtype === control.request.subtype) waiter.resolve(control)
          else this.waiters.push(waiter)
        }
      }
    })
  }

  get killed(): boolean {
    return false
  }

  /** The first control request of `subtype` the SDK wrote (now or later). */
  control(subtype: string): Promise<ControlFrame> {
    const seen = this.controls.find((frame) => frame.request.subtype === subtype)
    return seen ? Promise.resolve(seen) : new Promise((resolve) => this.waiters.push({ subtype, resolve }))
  }

  respond(frame: ControlFrame, response: Record<string, unknown> = {}): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } })
  }

  write(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  /** The "process" exits: exitCode reads it at once, the exit event follows synchronously. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.events.emit('exit', code, signal)
  }

  /** Records the SDK's signal request; the test decides whether the process ever ends. */
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }

  on(event: string, listener: (...args: any[]) => void): void {
    this.events.on(event, listener)
  }

  once(event: string, listener: (...args: any[]) => void): void {
    this.events.once(event, listener)
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.events.off(event, listener)
  }
}

/**
 * Ends a pipe process the test left running and joins what that releases:
 * the query's cleanup (closed here if no stop ran it; the SDK bounds its own
 * wait for the exit) and the SDK transport reading this stdout to its end.
 */
export async function release(process: PipeProcess, query: Query): Promise<void> {
  if (process.exitCode === null && process.signalCode === null) process.exit(0)
  process.stdout.end()
  const internals = query as unknown as { cleanupPromise?: Promise<void> }
  if (!internals.cleanupPromise) query.close()
  await internals.cleanupPromise
  if (!process.stdout.readableEnded) await new Promise<void>((resolve) => process.stdout.once('end', () => resolve()))
}

/**
 * A CONTROLLED owner standing in for an owned process in a native-free
 * session: the test freezes its exit evidence, so the real stop account
 * (accountGenerations, nativeCauses, nativeVerdict) judges facts the test
 * chose. It is controlled evidence, never proof of a native exit.
 */
export interface ControlledOwner {
  readonly generation: number
  readonly pid: number
  exited: LeaderExit | null
  evidence: NativeEvidence | null
  readonly observerFailures: unknown[]
  readonly signals: NodeJS.Signals[]
  marked: boolean
  readonly leaderExit: Promise<LeaderExit>
  markTermination(): void
  stderrTail(): string
  signal(signal: NodeJS.Signals): boolean
  terminate(): Promise<ProcessExitFact>
}

/** An owner that already observed `before` (pre-stop), or whose termination ends with `atStop`. */
export function controlledOwner(generation: number, end: { before: LeaderExit } | { atStop: LeaderExit }): ControlledOwner {
  let settle!: (exit: LeaderExit) => void
  const leaderExit = new Promise<LeaderExit>((resolve) => (settle = resolve))
  const owner: ControlledOwner = {
    generation, pid: 900000 + generation, exited: null, evidence: null, observerFailures: [], signals: [], marked: false, leaderExit,
    markTermination: () => void (owner.marked = true),
    stderrTail: () => '',
    signal: (signal) => {
      owner.signals.push(signal)
      return owner.exited === null
    },
    terminate: async () => {
      if (owner.exited === null && 'atStop' in end) freeze(end.atStop)
      const exit = owner.exited!
      return exit.kind === 'exited'
        ? { generation, state: 'exited', pid: owner.pid, code: exit.code, signal: exit.signal, escalated: false, groupCleared: true }
        : { generation, state: 'never-started' }
    },
  }
  const freeze = (exit: LeaderExit) => {
    owner.evidence = { exit, marked: owner.marked, sentAfterMark: owner.marked ? [...owner.signals] : [], errors: [] }
    owner.exited = exit
    settle(exit)
  }
  if ('before' in end) freeze(end.before)
  return owner
}

export interface GenuinePipeQueries {
  factory: ClaudeQueryFactory
  processes: PipeProcess[]
  queries: Query[]
  /** Runs on each genuine query before the session sees it (a test's substitution). */
  onQuery?: (query: Query, process: PipeProcess) => void
}

/**
 * A queryFactory whose queries the genuine SDK constructs through the same
 * private helper the default session uses, over a pipe process instead of
 * the owned spawner. The SDK module is the one loadSdk imported.
 */
export async function genuinePipeQueries(): Promise<GenuinePipeQueries> {
  const sdk = await loadSdk()
  const out: GenuinePipeQueries = {
    processes: [],
    queries: [],
    factory: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const process = new PipeProcess()
      out.processes.push(process)
      const query = genuineQuery(sdk, { prompt, options: { ...options, spawnClaudeCodeProcess: () => process as unknown as SpawnedProcess } })
      out.queries.push(query)
      out.onQuery?.(query, process)
      return query
    },
  }
  return out
}
