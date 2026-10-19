// One Codex app-server child per chat (codex-chat-sessions 4.3, design D2):
// the client spawns `<codex> app-server` for this session alone — never the
// installed daemon — frames newline-delimited JSON-RPC over its stdio,
// correlates requests with responses, routes notifications and server
// requests to their handlers, and records every line in the chat's wire log.
// It owns no thread state: the driver (5.6) starts threads and turns through
// `request`. A child exit rejects every pending request; the next start
// respawns a fresh process.
import { spawn, type ChildProcess } from 'node:child_process'
import { logger } from '../../logger'
import { createLineSplitter, type ChatWireRecorder } from '../wireTap'

/** How the app-server process ended. */
export interface AppServerExit {
  code: number | null
  signal: string | null
}

const describeExit = (exit: AppServerExit): string => {
  if (exit.signal) return `on ${exit.signal}`
  if (exit.code !== null) return `with code ${exit.code}`
  return 'without starting'
}

export interface AppServerClientOptions {
  /** The resolved Codex executable (codexExecutable.ts); never a shell command. */
  executable: string
  /** The child's full environment; the caller builds it (codexSpawnEnv). */
  env: Record<string, string>
  /** Every inbound and outbound line, plus spawn/exit lifecycle frames. */
  wire: ChatWireRecorder
  /** A server-initiated notification (a `method` with no id). */
  onNotification(method: string, params: Record<string, unknown>): void
  /**
   * A server request (a `method` with an id): the resolved value becomes the
   * reply's `result` (undefined becomes `{}`), a rejection an error reply —
   * never an unhandled rejection. Handlers must answer promptly; a dynamic
   * tool call blocks the thread until the reply arrives.
   */
  onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown>
  /** The child ended: an exit code, a kill signal, or a spawn failure (both null). */
  onExit(exit: AppServerExit): void
  /** SIGTERM → SIGKILL escalation delay for end(); default 3 000 ms. */
  killGraceMs?: number
  /**
   * Per-request deadline in ms (N5): a hung child that never answers —
   * initialize included — fails that request instead of blocking forever.
   * Default 30 000; 0 disables.
   */
  requestTimeoutMs?: number
  /**
   * How long after the child's exit the stdio streams may keep the exit
   * unsettled (R2-1): an orphan grandchild can inherit the pipes and hold
   * them open long after the app-server is gone. The exit settles when the
   * streams close or when this bound passes, whichever comes first.
   * Default 1 000; 0 settles at the exit itself.
   */
  drainBoundMs?: number
}

/** Default per-request deadline (N5). */
const REQUEST_TIMEOUT_MS = 30_000

/** Default drain bound (R2-1); exported so its value is pinned (T1). */
export const DRAIN_BOUND_MS = 1_000

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  /** The request's deadline timer (N5); cleared when the request settles. */
  timer?: NodeJS.Timeout
}

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

export class AppServerClient {
  private child: ChildProcess | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private exitInfo: AppServerExit | null = null
  private readonly exitWaiters: Array<(exit: AppServerExit) => void> = []
  private killTimer: NodeJS.Timeout | null = null
  /** Last stderr line, so a failing exit's reason names what the child said. */
  private lastStderr = ''
  // N5: the exit settles only once the stdio streams have closed too —
  // 'exit' can precede the final stdout flush, which would cut a last
  // notification or response off before it is routed. R2-1 bounds that
  // wait: an orphan grandchild holding the pipes must not hold the exit
  // (and with it the respawn) open forever.
  private exitFacts: AppServerExit | null = null
  private stdoutClosed = false
  private stderrClosed = false
  private drainBound = false
  private drainTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: AppServerClientOptions) {}

  /** The child has ended (or failed to start); null while it runs. */
  get exit(): AppServerExit | null {
    return this.exitInfo
  }

  /** Resolves with the exit info once the child has ended. */
  whenExited(): Promise<AppServerExit> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo)
    return new Promise(resolve => this.exitWaiters.push(resolve))
  }

  /** Spawn the app-server. One start per client; the driver respawns instead. */
  start(): void {
    if (this.child) throw new Error('Codex app-server client already started')
    this.options.wire.record('lifecycle', JSON.stringify({
      event: 'spawn',
      command: this.options.executable,
      args: ['app-server'],
    }))
    // Detached so end() signals the whole process group: a sandboxed
    // app-server can leave helper grandchildren that outlive the pid alone
    // (the smoke script's stop() learned this; review O5).
    const child = spawn(this.options.executable, ['app-server'], {
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.child = child
    child.on('error', (error) => {
      this.options.wire.record('lifecycle', JSON.stringify({ event: 'error', message: error.message }))
      this.settleExit({ code: null, signal: null })
    })
    child.on('exit', (code, signal) => {
      this.exitFacts = { code, signal }
      // R2-1: the streams may never close — an orphan grandchild can hold
      // them — so the drain wait is bounded: settle on the closes or the
      // bound, whichever comes first.
      const bound = this.options.drainBoundMs ?? DRAIN_BOUND_MS
      if (bound > 0) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = null
          this.drainBound = true
          this.settleWhenClosed()
        }, bound)
        this.drainTimer.unref?.()
      } else {
        this.drainBound = true
      }
      this.settleWhenClosed()
    })
    child.stdin?.on('error', () => {
      // EPIPE after the child died: the exit handler rejects the pending
      // requests; the write failure itself has nowhere better to go.
    })
    const inLines = createLineSplitter(line => this.onLine(line))
    child.stdout?.on('data', chunk => inLines.write(chunk as Buffer))
    child.stdout?.on('close', () => {
      this.stdoutClosed = true
      inLines.end()
      this.settleWhenClosed()
    })
    const errLines = createLineSplitter((line) => {
      if (line.trim()) this.lastStderr = line
      this.options.wire.record('stderr', line)
    })
    child.stderr?.on('data', chunk => errLines.write(chunk as Buffer))
    child.stderr?.on('close', () => {
      this.stderrClosed = true
      errLines.end()
      this.settleWhenClosed()
    })
  }

  /**
   * Settle the exit once the streams have drained (N5) or the drain bound
   * has passed (R2-1), whichever comes first.
   */
  private settleWhenClosed(): void {
    if (this.exitInfo || !this.exitFacts) return
    if (!this.drainBound && !(this.stdoutClosed && this.stderrClosed)) return
    this.settleExit(this.exitFacts)
  }

  /**
   * Send one request and resolve with its response `result`; rejects with
   * the response `error`, when the child exits with the request pending, or
   * at the request deadline (N5) — a hung child fails the request instead of
   * blocking a turn forever.
   */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.exitInfo) {
      return Promise.reject(new Error(`Codex app-server has already exited ${describeExit(this.exitInfo)}`))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject }
      const timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`Codex app-server request ${id} (${method}) timed out after ${timeoutMs} ms with no response`))
        }, timeoutMs)
        timer.unref?.()
        entry.timer = timer
      }
      this.pending.set(id, entry)
      this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  /** Send one notification (no id, no reply). */
  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  /**
   * The protocol handshake (design D2): clientInfo plus the experimental
   * API capability the driver's thread calls need. `requestAttestation` is
   * off — nothing in Kawai verifies device attestation.
   */
  initialize(info: { name: string; title?: string; version: string }): Promise<unknown> {
    return this.request('initialize', {
      clientInfo: {
        name: info.name,
        ...(info.title ? { title: info.title } : {}),
        version: info.version,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
  }

  /**
   * End the child (archive, kill, shutdown, restart): SIGTERM to the process
   * group, SIGKILL once the grace passes. Idempotent; the exit still
   * surfaces through onExit exactly as an unplanned death would.
   */
  end(): void {
    if (!this.child || this.exitInfo) return
    this.options.wire.record('lifecycle', JSON.stringify({ event: 'kill' }))
    const grace = this.options.killGraceMs ?? 3_000
    this.signalGroup('SIGTERM')
    if (grace <= 0) {
      this.signalGroup('SIGKILL')
      return
    }
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (!this.exitInfo) this.signalGroup('SIGKILL')
    }, grace)
    this.killTimer.unref?.()
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      // The group is already gone (or was never one): fall back to the pid.
      this.child?.kill(signal)
    }
  }

  private write(message: Record<string, unknown>): void {
    const line = JSON.stringify(message)
    this.options.wire.record('out', line)
    this.child?.stdin?.write(`${line}\n`)
  }

  private onLine(line: string): void {
    this.options.wire.record('in', line)
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return // A torn or non-JSON line: recorded raw, never dispatched.
    }
    if (message.method === undefined) {
      this.settleResponse(message)
      return
    }
    const method = message.method
    if (typeof method !== 'string') return
    const params = (message.params ?? {}) as Record<string, unknown>
    if (message.id !== undefined) {
      // Server request: the handler's outcome becomes the reply. Off the
      // read path immediately, so a slow handler never stalls the stream.
      void Promise.resolve()
        .then(() => this.options.onServerRequest(method, params))
        .then(result => this.write({ jsonrpc: '2.0', id: message.id, result: result ?? {} }))
        .catch((error: unknown) => {
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          })
        })
      return
    }
    // A synchronous handler throw would surface as an uncaught exception on
    // the stdout data event; the client survives it instead.
    try {
      this.options.onNotification(method, params)
    } catch (error) {
      logger.warn('codex_app_server_notification_handler_error', {
        method,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private settleResponse(message: JsonRpcMessage): void {
    // An error whose id is null (a parse-level failure) names no request:
    // the transport is broken, so every pending request fails (N5,
    // fail-closed) instead of hanging until their deadlines.
    if (message.id === null) {
      if (message.error === undefined) return
      const error = new Error(`Codex app-server reported an uncorrelated error: ${JSON.stringify(message.error)}`)
      for (const [, entry] of this.pending) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.reject(error)
      }
      this.pending.clear()
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (entry.timer) clearTimeout(entry.timer)
    if (message.error !== undefined) {
      entry.reject(new Error(`request ${message.id} failed: ${JSON.stringify(message.error)}`))
    } else {
      entry.resolve(message.result)
    }
  }

  private settleExit(exit: AppServerExit): void {
    if (this.exitInfo) return
    this.exitInfo = exit
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    this.options.wire.record('lifecycle', JSON.stringify({ event: 'exit', code: exit.code, signal: exit.signal }))
    const reason = this.lastStderr ? ` (last stderr: ${this.lastStderr})` : ''
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(new Error(`Codex app-server exited ${describeExit(exit)} with request ${id} pending${reason}`))
    }
    this.pending.clear()
    for (const waiter of this.exitWaiters.splice(0)) waiter(exit)
    this.options.onExit(exit)
  }
}
