// The private Codex app-server RPC transport (task 4.2 prerequisite). One
// owned `codex app-server` process per transport, spawned through spawnOwned
// with exactly the launch's cwd and complete childEnv (nothing ambient), as
// the leader of its own process group. Newline-delimited JSON-RPC over stdio:
// requests are correlated by their numeric id, notifications and server
// requests go to the supplied handlers, and the optional wire recorder is the
// owned spawner's (its absence changes nothing; its throws are kept).
//
// Ownership before callbacks: the owner is set in spawnOwned's onCreated,
// before its first recorder publication, and each request's pending entry
// (with its deadline timer) exists before its line is written. A reply settles
// only the entry its id names, once: the entry is removed before it settles
// and its timer cleared. Wrong, late, duplicate, malformed and uncorrelated
// (id null) lines settle nothing and are only counted.
//
// Stop is one shared terminal operation: it closes admission and writes,
// rejects every pending request once, aborts handler signals, awaits the owned
// terminate() (the leader's actual exit and an empty process group, never a
// signal acknowledgement, EOF or a drain bound), ends the reader, and joins
// every owned job (the reader generation and each server-request handler).
// A handler's reply after stop began is dropped, never written. A stop called
// from inside a handler is refused `internal` while the terminal operation it
// started continues for the external owner. Native, job and observer failures
// reject the stop (`stop`) with every cause kept by identity. There is no
// thread, resume or fallback logic here: the driver owns those.

import { AgentRuntimeError } from '../errors.js'
import type { ProcessExitFact } from '../contract.js'
import type { JsonObject } from '../json.js'
import type { WireRecorder } from '../options.js'
import { OwnedJobs } from '../lifecycle/jobs.js'
import { runGeneration } from '../lifecycle/generation.js'
import { resolveExecutable, type ResolvedLaunch } from '../process/launch.js'
import { createLineSplitter } from '../process/lineSplitter.js'
import { spawnOwned, type LeaderExit, type OwnedProcess, type TerminateOptions } from '../process/ownedProcess.js'

export interface AppServerClientInfo {
  name: string
  title?: string
  version: string
}

export interface AppServerTransportOptions {
  launch: ResolvedLaunch
  generation: number
  /** Absolute command; default: `codex` resolved through the launch's own PATH. */
  command?: string
  /** Default `['app-server']`. */
  args?: readonly string[]
  wire?: WireRecorder
  /** Sent verbatim by initialize(). */
  clientInfo: AppServerClientInfo
  capabilities: JsonObject
  /** A server notification (a method, no id). A throw is kept, never changes a reply. */
  onNotification?(method: string, params: JsonObject): void
  /**
   * A server request (a method with an id): the value becomes the reply's
   * `result` (undefined becomes `{}`), a throw or rejection an error reply.
   * Absent: every server request gets a method-not-found error reply. The
   * signal aborts when stop begins; stop joins the handler.
   */
  onServerRequest?(method: string, params: JsonObject, signal: AbortSignal): unknown
  /** The process ended unsolicited (not by stop), once, after its pending requests were rejected. */
  onExit?(exit: LeaderExit): void
  /** Per-request deadline; default 30 000 ms, 0 disables. */
  requestTimeoutMs?: number
  /** After the first of an unsolicited exit and EOF, how long pending requests wait for the other; default 1 000 ms. */
  drainBoundMs?: number
  terminate?: TerminateOptions
}

/** A JSON-RPC error reply; `error` is the raw value the server sent. */
export class AppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly id: number,
    readonly error: unknown,
  ) {
    const text = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    super(`app-server request ${id} (${method}) failed${text ? `: ${(error as { message: string }).message}` : ''}`)
    this.name = 'AppServerRpcError'
  }
}

export interface TransportCounters {
  /** Responses naming no pending request (unknown, late, duplicate, non-numeric or null id). */
  stray: number
  /** Lines that are not a JSON-RPC object this transport can route. */
  malformed: number
  /** Server-request replies dropped because stop had begun. */
  droppedReplies: number
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout> | undefined
}

const REQUEST_TIMEOUT_MS = 30_000
export const DRAIN_BOUND_MS = 1_000

type Message = Record<string, unknown>
const isObject = (value: unknown): value is Message => typeof value === 'object' && value !== null && !Array.isArray(value)

function describeExit(exit: LeaderExit | null): string {
  if (!exit) return 'closed its output'
  if (exit.kind === 'spawn-failed') return 'failed to start'
  if (exit.signal) return `exited on ${exit.signal}`
  return `exited with code ${exit.code}`
}

export class AppServerTransport {
  private owned: OwnedProcess | null = null
  private readonly jobs = new OwnedJobs()
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private started = false
  /** Requests and notifications are admitted. */
  private open = false
  /** Stop has begun: nothing is written or dispatched any more. */
  private closing = false
  private readerDone = false
  private exitReported = false
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private terminal: Promise<ProcessExitFact> | null = null
  private readonly handlers = new AbortController()
  private readonly observerFailures: unknown[] = []
  readonly counters: TransportCounters = { stray: 0, malformed: 0, droppedReplies: 0 }

  constructor(private readonly options: AppServerTransportOptions) {}

  /** The owned process once spawned. */
  get process(): OwnedProcess | null {
    return this.owned
  }

  /** Requests still awaiting a reply. */
  get pendingCount(): number {
    return this.pending.size
  }

  /** Spawn the app-server; once per transport. Throws `dependency` when the executable is missing. */
  start(): void {
    if (this.closing) throw new AgentRuntimeError({ category: 'stopped', message: 'the app-server transport was stopped' })
    if (this.started) throw new AgentRuntimeError({ category: 'internal', message: 'the app-server transport was already started' })
    const command = this.options.command ?? resolveExecutable(this.options.launch, 'codex')
    this.started = true
    this.open = true
    this.jobs.outside(() =>
      spawnOwned({
        command,
        args: this.options.args ?? ['app-server'],
        launch: this.options.launch,
        generation: this.options.generation,
        ...(this.options.wire ? { recorder: this.options.wire } : {}),
        onCreated: (owned) => this.attach(owned),
      }),
    )
  }

  /** The handshake with the supplied clientInfo and capabilities. */
  initialize(): Promise<unknown> {
    const { name, title, version } = this.options.clientInfo
    return this.request('initialize', {
      clientInfo: { name, ...(title ? { title } : {}), version },
      capabilities: this.options.capabilities,
    })
  }

  /** One request; resolves with its `result`, rejects with its error reply, the deadline, the end or stop. */
  request(method: string, params?: JsonObject): Promise<unknown> {
    const refusal = this.refusal()
    if (refusal) return Promise.reject(refusal)
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject, timer: undefined }
      const timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.get(id) !== entry) return
          this.pending.delete(id)
          reject(new AgentRuntimeError({ category: 'transport', message: `app-server request ${id} (${method}) had no reply within ${timeoutMs} ms` }))
        }, timeoutMs)
        entry.timer.unref?.()
      }
      // Pending ownership first: a reply can only find an entry that exists.
      this.pending.set(id, entry)
      this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  /** One notification (no id, no reply); throws the refusal when not admitted. */
  notify(method: string, params?: JsonObject): void {
    const refusal = this.refusal()
    if (refusal) throw refusal
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  /** The shared terminal operation; refused `internal` from inside a handler, which it still stops. */
  stop(): Promise<ProcessExitFact> {
    if (!this.terminal) {
      this.terminal = this.jobs.outside(() => this.terminate())
      void this.terminal.catch(() => {})
    }
    if (this.jobs.insideJob()) {
      return Promise.reject(new AgentRuntimeError({ category: 'internal', message: 'a server-request handler cannot join the stop of its own transport' }))
    }
    return this.terminal
  }

  private refusal(): AgentRuntimeError | null {
    if (this.closing) return new AgentRuntimeError({ category: 'stopped', message: 'the app-server transport is stopping' })
    if (!this.started) return new AgentRuntimeError({ category: 'not-ready', message: 'the app-server transport is not started' })
    if (!this.open) return this.endError()
    return null
  }

  private attach(owned: OwnedProcess): void {
    this.owned = owned
    // EPIPE after the child ends: pending requests are rejected by the end itself.
    owned.stdin.on('error', () => {})
    const generation = runGeneration(this.jobs, owned, (stdout) => this.read(stdout))
    void generation.catch(() => {})
    void owned.leaderExit.then(() => this.leaderEnded())
  }

  private read(stdout: OwnedProcess['stdout']): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const lines = createLineSplitter((line) => this.onLine(line))
      const done = () => {
        lines.end()
        this.readerEnded()
        resolve()
      }
      stdout.on('data', (chunk: Buffer) => lines.write(chunk))
      stdout.once('end', done)
      stdout.once('close', done)
      stdout.once('error', (error) => {
        this.readerEnded()
        if (this.closing) resolve()
        else reject(error)
      })
    })
  }

  private write(message: Message): boolean {
    if (this.closing || !this.owned) return false
    this.owned.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  }

  /** Observers run outside every owned job: a stop they call is the external, shared one. */
  private observe(fn: () => void): void {
    this.jobs.outside(() => {
      try {
        fn()
      } catch (error) {
        this.observerFailures.push(error)
      }
    })
  }

  private onLine(line: string): void {
    if (this.closing) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.counters.malformed++
      return
    }
    if (!isObject(message)) {
      this.counters.malformed++
      return
    }
    const method = message.method
    if (method === undefined) return this.settle(message)
    if (typeof method !== 'string') {
      this.counters.malformed++
      return
    }
    const params = isObject(message.params) ? (message.params as JsonObject) : {}
    const id = message.id
    if (id === undefined) return this.observe(() => this.options.onNotification?.(method, params))
    if (typeof id !== 'number' && typeof id !== 'string') {
      this.counters.malformed++
      return
    }
    this.serve(id, method, params)
  }

  private settle(message: Message): void {
    const id = message.id
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined
    if (entry === undefined || typeof id !== 'number') {
      this.counters.stray++
      return
    }
    const failed = message.error !== undefined
    if (!failed && !('result' in message)) {
      this.counters.malformed++
      return
    }
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (failed) entry.reject(new AppServerRpcError(entry.method, id, message.error))
    else entry.resolve(message.result)
  }

  private serve(id: number | string, method: string, params: JsonObject): void {
    const handler = this.options.onServerRequest
    const signal = this.handlers.signal
    const body = async (): Promise<void> => {
      let reply: Message
      if (!handler) {
        reply = { error: { code: -32601, message: `no handler for server request ${method}` } }
      } else {
        try {
          reply = { result: (await handler(method, params, signal)) ?? {} }
        } catch (error) {
          reply = { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }
        }
      }
      if (!this.write({ jsonrpc: '2.0', id, ...reply })) this.counters.droppedReplies++
    }
    void this.jobs.outside(() => this.jobs.run(`server-request:${method}`, body)).catch(() => {})
  }

  private endError(): AgentRuntimeError {
    const exit = this.owned?.exited ?? null
    const stderr = this.owned?.stderrTail().trim().split('\n').pop()
    const causes = exit?.kind === 'spawn-failed' ? [exit.error] : []
    const message = `the Codex app-server ${describeExit(exit)}${stderr ? ` (last stderr: ${stderr})` : ''}`
    return new AgentRuntimeError({ category: 'transport', message }, causes)
  }

  private rejectPending(error: unknown): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  private readerEnded(): void {
    if (this.readerDone) return
    this.readerDone = true
    // No reply can arrive after EOF, even while the process lives.
    this.open = false
    this.endObserved()
  }

  private leaderEnded(): void {
    this.open = false
    this.endObserved()
  }

  /**
   * Reject the pending requests with the end as known once both the leader's
   * exit and EOF are observed (a spawn failure has no output to wait for), or
   * when the drain bound passes after the first of them: an orphan holding the
   * pipes, or a process that closed its stdout, must not hold them forever.
   */
  private endObserved(): void {
    if (this.closing) return
    const exit = this.owned?.exited ?? null
    if (exit && (this.readerDone || exit.kind === 'spawn-failed')) {
      this.rejectPending(this.endError())
      this.reportExit()
      return
    }
    if (this.drainTimer) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      if (this.closing) return
      this.rejectPending(this.endError())
      this.reportExit()
    }, this.options.drainBoundMs ?? DRAIN_BOUND_MS)
    this.drainTimer.unref?.()
  }

  private reportExit(): void {
    const exit = this.owned?.exited
    if (this.exitReported || this.closing || !exit) return
    this.exitReported = true
    this.observe(() => this.options.onExit?.(exit))
  }

  private async terminate(): Promise<ProcessExitFact> {
    this.closing = true
    this.open = false
    this.jobs.beginStop()
    this.rejectPending(new AgentRuntimeError({ category: 'stopped', message: 'the app-server transport is stopping' }))
    this.handlers.abort()
    const owned = this.owned
    const causes: unknown[] = []
    let fact: ProcessExitFact = { generation: this.options.generation, state: 'never-started' }
    if (owned) {
      owned.markTermination()
      try {
        fact = await owned.terminate(this.options.terminate)
      } catch (error) {
        causes.push(error)
      }
      owned.stdin.destroy()
      owned.stdout.destroy()
    }
    for (const failure of await this.jobs.join()) causes.push(failure.error)
    causes.push(...(owned?.observerFailures ?? []), ...this.observerFailures)
    if (causes.length > 0) {
      throw new AgentRuntimeError({ category: 'stop', message: `the app-server transport stopped with ${causes.length} failure(s)` }, causes)
    }
    return fact
  }
}
