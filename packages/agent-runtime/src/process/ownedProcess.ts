// The owned local spawner (design §3, task 2.1). Every agent process
// generation is spawned here: with exactly the launch's frozen environment
// and cwd (no ambient merge, I3), as the leader of its own POSIX process
// group, with its actual exit retained as a fact. terminate() is the only
// path to a stop receipt and succeeds only after the leader has actually
// exited and no live member of its group remains (I1) — never on a signal
// acknowledgement, a closed stream or an elapsed timer alone.
//
// Native evidence (task 4.1, A3) is fixed by this owner before anything
// outside it can observe the exit. The frozen record holds the actual exit,
// whether termination had been marked by then, and a copy of the signals
// this owner successfully sent after the mark. Settlement and every recorder
// publication come after it, and a recorder throw is kept, never allowed to
// skip settlement or cleanup. The owner is reported to `onCreated` before the
// first recorder publication, so an observer that reenters stop finds the
// process owned.
//
// With a recorder, terminate() also joins every recording producer before it
// returns: it waits (within killMs) for the child's stdio to close, flushes
// each unterminated line, then closes recording, so no later callback can add
// a recorder failure after the stop's account. Stdio still open at the bound
// is destroyed, recording is closed, and that is a failure of its own. A
// destroyed raw stdout does not end the wrapper the caller (the SDK) reads, so
// the cutoff ends that wrapper (destroying it if it does not close in the
// bound) and joins it and the raw streams before terminate() returns.

import { spawn } from 'node:child_process'
import { Transform, Writable, type Readable } from 'node:stream'
import { AgentRuntimeError } from '../errors.js'
import type { ProcessExitFact } from '../contract.js'
import type { WireFrame, WireRecorder } from '../options.js'
import type { ResolvedLaunch } from './launch.js'
import { createLineSplitter } from './lineSplitter.js'
import { GROUPS_SUPPORTED, liveGroupMembers, signalGroup } from './processGroup.js'

export interface OwnedSpawnRequest {
  command: string
  args: readonly string[]
  launch: ResolvedLaunch
  generation: number
  /** Optional raw recorder; its absence changes nothing about ownership. */
  recorder?: WireRecorder
  /** Lead a new process group (default: true where supported). */
  group?: boolean
  /** Receives the owner synchronously, before any recorder publication. */
  onCreated?(owned: OwnedProcess): void
}

/** The leader's actual end, as observed. */
export type LeaderExit =
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawn-failed'; error: Error }

/**
 * The leader's end as this owner observed it, frozen at that moment.
 * `marked`: termination had been requested (intent, not cause).
 * `sentAfterMark`: the signals this owner successfully sent after the mark.
 * `errors`: child errors observed while a process existed, kept by identity.
 */
export interface NativeEvidence {
  readonly exit: LeaderExit
  readonly marked: boolean
  readonly sentAfterMark: readonly NodeJS.Signals[]
  readonly errors: readonly Error[]
}

export interface TerminateOptions {
  /** Wait after SIGTERM before escalating to SIGKILL (default 2000 ms). */
  graceMs?: number
  /** Wait after SIGKILL before failing the stop (default 5000 ms). */
  killMs?: number
}

export interface OwnedProcess {
  readonly generation: number
  /** Null when the spawn failed before a process existed. */
  readonly pid: number | null
  readonly stdin: Writable
  readonly stdout: Readable
  /** Resolves once with the leader's actual exit or the spawn failure. */
  readonly leaderExit: Promise<LeaderExit>
  /** The leader's exit once observed, else null. */
  readonly exited: LeaderExit | null
  /** The frozen native evidence, set before the exit is published or settled. */
  readonly evidence: NativeEvidence | null
  /** Recorder throws (and a recording cut off at stop), kept by identity; publication never gates ownership. */
  readonly observerFailures: readonly unknown[]
  /** Record that termination is requested; later successful sends count as this owner's. */
  markTermination(): void
  /** The last stderr bytes (bounded), for safe failure reasons. */
  stderrTail(): string
  /** Signal the process (its group when owned); false when nothing received it. */
  signal(signal: NodeJS.Signals): boolean
  /** Memoized: the first call's outcome is every caller's outcome. */
  terminate(options?: TerminateOptions): Promise<ProcessExitFact>
}

const STDERR_TAIL_BYTES = 8 * 1024
const POLL_MS = 20

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function pollUntil(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() >= deadline) return false
    await delay(POLL_MS)
  }
  return true
}

function stopError(message: string): AgentRuntimeError {
  return new AgentRuntimeError({ category: 'stop', message })
}

/** Spawn one owned generation. Never throws: a spawn failure is a LeaderExit. */
export function spawnOwned(request: OwnedSpawnRequest): OwnedProcess {
  const { launch, generation, recorder } = request
  const useGroup = (request.group ?? true) && GROUPS_SUPPORTED
  const observerFailures: unknown[] = []
  /** Set once every recording producer is joined or cut off: nothing records after it. */
  let recordingClosed = false
  const record = (direction: WireFrame['direction'], text: string) => {
    if (!recorder || recordingClosed) return
    try {
      recorder.record({ generation, direction, at: new Date().toISOString(), text })
    } catch (error) {
      observerFailures.push(error)
    }
  }
  const lifecycle = (event: Record<string, unknown>) => record('lifecycle', JSON.stringify(event))

  // The environment is the launch's map, copied: no process.env, no SDK merge.
  const child = spawn(request.command, [...request.args], {
    cwd: launch.cwd,
    env: { ...launch.childEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: useGroup,
  })
  const pid = typeof child.pid === 'number' ? child.pid : null
  // 'close' follows the exit and the end of every stdio stream.
  const stdioClosed = new Promise<void>((resolve) => child.once('close', () => resolve()))

  let exited: LeaderExit | null = null
  let evidence: NativeEvidence | null = null
  let marked = false
  const sentAfterMark: NodeJS.Signals[] = []
  const childErrors: Error[] = []
  let resolveExit!: (exit: LeaderExit) => void
  const leaderExit = new Promise<LeaderExit>((resolve) => (resolveExit = resolve))
  /** Freeze the evidence, then settle; publication is the caller's next step. */
  const settleExit = (exit: LeaderExit): boolean => {
    if (exited) return false
    evidence = Object.freeze({ exit, marked, sentAfterMark: Object.freeze([...sentAfterMark]), errors: Object.freeze([...childErrors]) })
    exited = exit
    resolveExit(exit)
    return true
  }
  child.on('exit', (code, signal) => {
    if (settleExit({ kind: 'exited', code, signal })) lifecycle({ event: 'exit', code, signal })
  })
  child.on('error', (error) => {
    // With a process, an error is kept as observed; the leader's actual exit is still awaited.
    if (pid === null) settleExit({ kind: 'spawn-failed', error })
    else childErrors.push(error)
    lifecycle({ event: 'error', message: error.message })
  })

  // stderr is always drained (a full pipe would block the child) into a tail.
  let tail = ''
  const errLines = createLineSplitter((line) => record('stderr', line))
  child.stderr.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    if (recorder) errLines.write(chunk)
  })
  child.stderr.on('end', () => errLines.end())
  child.stderr.on('error', () => errLines.end())

  let stdin: Writable = child.stdin
  let stdout: Readable = child.stdout
  /** The recording wrapper the caller reads instead of the raw stdout, and its 'close'. */
  let wrapper: { stream: Transform; closed: Promise<void> } | null = null
  const splitters = [errLines]
  if (recorder) {
    const outLines = createLineSplitter((line) => record('out', line))
    stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        outLines.write(chunk)
        child.stdin.write(chunk, (error) => callback(error ?? null))
      },
      final(callback) {
        outLines.end()
        child.stdin.end()
        callback()
      },
      destroy(error, callback) {
        outLines.end()
        if (!child.stdin.destroyed) child.stdin.destroy(error ?? undefined)
        callback(error)
      },
    })
    child.stdin.on('error', (error) => stdin.destroy(error))
    const inLines = createLineSplitter((line) => record('in', line))
    splitters.push(outLines, inLines)
    const tapped = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        inLines.write(chunk)
        callback(null, chunk)
      },
      flush(callback) {
        inLines.end()
        callback()
      },
    })
    child.stdout.on('error', (error) => tapped.destroy(error))
    child.stdout.pipe(tapped)
    stdout = tapped
    wrapper = { stream: tapped, closed: new Promise<void>((resolve) => tapped.once('close', () => resolve())) }
  } else {
    // An unrecorded stdin may still fail (EPIPE after exit); keep it handled.
    child.stdin.on('error', () => {})
  }

  const signal = (sig: NodeJS.Signals): boolean => {
    if (pid === null) return false
    const sent = useGroup ? signalGroup(pid, sig) : child.kill(sig)
    if (sent && marked && !exited) sentAfterMark.push(sig)
    return sent
  }

  const groupEmpty = () => pid === null || liveGroupMembers(pid).length === 0

  /** Join every recording producer (bounded by `ms`), flush unterminated lines, then close recording. */
  async function closeRecording(ms: number): Promise<void> {
    if (!recorder || recordingClosed) return
    if (!(await settlesWithin(stdioClosed, ms))) {
      recordingClosed = true
      observerFailures.push(stopError(`agent process ${pid ?? generation} kept its stdio open ${ms} ms after exit; its recording was cut off`))
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
      // A destroyed source does not end its pipe destination: end the wrapper the
      // caller reads (its reader sees EOF), destroy it if it does not close in the
      // bound, and join it and the raw streams before the stop accounts.
      if (wrapper) {
        if (!wrapper.stream.writableEnded && !wrapper.stream.destroyed) wrapper.stream.end()
        if (!(await settlesWithin(wrapper.closed, ms))) wrapper.stream.destroy()
        if (!(await settlesWithin(wrapper.closed, ms))) observerFailures.push(stopError(`agent process ${pid ?? generation}: its stdout wrapper did not close`))
      }
      if (!(await settlesWithin(stdioClosed, ms))) observerFailures.push(stopError(`agent process ${pid ?? generation}: its stdio did not close after the cutoff`))
      return
    }
    for (const lines of splitters) lines.end()
    recordingClosed = true
  }

  async function doTerminate(options: TerminateOptions): Promise<ProcessExitFact> {
    const graceMs = options.graceMs ?? 2000
    const killMs = options.killMs ?? 5000
    if (pid === null) {
      await leaderExit
      await closeRecording(killMs)
      return { generation, state: 'never-started' }
    }
    let escalated = false
    if (!exited) {
      signal('SIGTERM')
      if (!(await settlesWithin(leaderExit, graceMs))) {
        escalated = true
        signal('SIGKILL')
        if (!(await settlesWithin(leaderExit, killMs))) {
          throw stopError(`agent process ${pid} did not exit after SIGKILL`)
        }
      }
    }
    // The leader is gone; helpers holding its pipes may not be (task 2.3).
    let groupCleared = false
    if (useGroup) {
      if (!groupEmpty()) {
        signalGroup(pid, 'SIGTERM')
        if (!(await pollUntil(groupEmpty, graceMs))) {
          escalated = true
          signalGroup(pid, 'SIGKILL')
          if (!(await pollUntil(groupEmpty, killMs))) {
            throw stopError(`agent process group ${pid} kept live members after SIGKILL`)
          }
        }
      }
      groupCleared = true
    }
    await closeRecording(killMs)
    const exit = exited as LeaderExit | null
    return {
      generation,
      state: 'exited',
      pid,
      code: exit?.kind === 'exited' ? exit.code : null,
      signal: exit?.kind === 'exited' ? exit.signal : null,
      escalated,
      groupCleared,
    }
  }

  let stopping: Promise<ProcessExitFact> | null = null
  const owned: OwnedProcess = {
    generation,
    pid,
    stdin,
    stdout,
    leaderExit,
    get exited() {
      return exited
    },
    get evidence() {
      return evidence
    },
    observerFailures,
    markTermination() {
      marked = true
    },
    stderrTail: () => tail,
    signal,
    terminate(options = {}) {
      stopping ??= doTerminate(options)
      return stopping
    },
  }
  // Ownership first, publication after: an observer reentering stop finds this process owned.
  request.onCreated?.(owned)
  lifecycle({ event: 'spawn', command: request.command, args: request.args, cwd: launch.cwd, pid })
  return owned
}
