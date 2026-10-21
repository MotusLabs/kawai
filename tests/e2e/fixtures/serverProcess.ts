import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { killPrivateTmuxServer } from './privateTmux'

/** Stop bounds: how long to wait after each signal before escalating. Both
 * are options so unit tests can use short ones (see
 * src/server/__tests__/serverProcess.test.ts). */
export interface ServerStopOptions {
  /** Milliseconds to wait after SIGTERM before escalating to SIGKILL. Default 10 s. */
  termGraceMs?: number
  /** Milliseconds to wait after SIGKILL before failing, naming the pid. Default 5 s. */
  killGraceMs?: number
}

const DEFAULT_TERM_GRACE_MS = 10_000
const DEFAULT_KILL_GRACE_MS = 5_000
const DIAGNOSTICS_BYTES = 6000

/**
 * One self-hosted e2e server: its exit promise and the shared stop sequence
 * (the copies every self-hosted spec carried before this fixture).
 *
 * spawn() arms the exit listener in the statement right after node's spawn
 * returns, so stop() awaits an exit whatever ended the server — including a
 * signal kill before stop(), where exitCode is still null but the exit event
 * has already fired and a listener attached only at stop() would never
 * resolve. Every restart replaces the child and re-arms the promise.
 *
 * stop() is the bounded sequence: SIGTERM, a bounded wait, SIGKILL, another
 * bounded wait, then a failure naming the pid. It never signals a server
 * that already exited (by code or by signal) or that was never spawned, and
 * it awaits the exit promise whatever path ended the server. When given a
 * tmuxRoot it kills the root's private tmux server — after the exit, or
 * after a failed sequence that throws — always before the caller removes
 * the root: the daemon outlives the server and pins the checkout (see
 * privateTmux.ts).
 */
export class ServerProcess {
  private child: ChildProcess | null = null
  private exited: Promise<void> = Promise.resolve()
  private tail = ''

  /** Spawn the server child, arm its exit listener, and start capturing its
   * output as diagnostics. Call again on every restart. */
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const child = spawn(command, args, options)
    this.child = child
    this.exited = new Promise<void>(resolve => { child.once('exit', () => resolve()) })
    child.stdout?.on('data', chunk => { this.tail = (this.tail + String(chunk)).slice(-DIAGNOSTICS_BYTES) })
    child.stderr?.on('data', chunk => { this.tail = (this.tail + String(chunk)).slice(-DIAGNOSTICS_BYTES) })
    return child
  }

  /** True while a spawned child has exited neither by code nor by signal. */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  /** The last 6 KiB of the server's stdout and stderr, for failure reports. */
  diagnostics(): string {
    return this.tail
  }

  /** End the current server through the bounded SIGTERM-then-SIGKILL
   * sequence, then (with a tmuxRoot) kill its private tmux server. Safe to
   * call twice: after the first stop the exit promise is resolved and there
   * is nothing left to signal. */
  async stop(options: ServerStopOptions & { tmuxRoot?: string } = {}): Promise<void> {
    const child = this.child
    const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        // Re-check liveness before escalating: the exit can land on the same
        // tick the grace timer fires, and a dead pid must never be signalled.
        if (!(await this.exitedWithin(termGraceMs)) && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          if (!(await this.exitedWithin(killGraceMs))) {
            throw new Error(`e2e server pid ${child.pid ?? '<unknown>'} ignored SIGKILL and is still running`)
          }
        }
      }
      await this.exited
    } finally {
      // The tmux kill and the child cleanup run even when the sequence
      // throws: the daemon outlives the server and pins the checkout (see
      // privateTmux.ts), and a failed stop must not leave a stale child.
      if (options.tmuxRoot) killPrivateTmuxServer(options.tmuxRoot)
      this.child = null
    }
  }

  /** Resolves true when the current child exited within the bound, false
   * when the bound expired first. The timer never holds the caller past the
   * race: it is cleared whichever side wins. */
  private exitedWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      this.exited.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms) }),
    ]).finally(() => { clearTimeout(timer) })
  }
}
