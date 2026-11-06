// The owned local spawner (design §3, task 2.1). Every agent process
// generation is spawned here: with exactly the launch's frozen environment
// and cwd (no ambient merge, I3), as the leader of its own POSIX process
// group, with its actual exit retained as a fact. terminate() is the only
// path to a stop receipt and succeeds only after the leader has actually
// exited and no live member of its group remains (I1) — never on a signal
// acknowledgement, a closed stream or an elapsed timer alone.

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
}

/** The leader's actual end, as observed. */
export type LeaderExit =
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawn-failed'; error: Error }

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
  const record = (direction: WireFrame['direction'], text: string) =>
    recorder?.record({ generation, direction, at: new Date().toISOString(), text })
  const lifecycle = (event: Record<string, unknown>) => record('lifecycle', JSON.stringify(event))

  // The environment is the launch's map, copied: no process.env, no SDK merge.
  lifecycle({ event: 'spawn', command: request.command, args: request.args, cwd: launch.cwd })
  const child = spawn(request.command, [...request.args], {
    cwd: launch.cwd,
    env: { ...launch.childEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: useGroup,
  })
  const pid = typeof child.pid === 'number' ? child.pid : null

  let exited: LeaderExit | null = null
  let settleExit!: (exit: LeaderExit) => void
  const leaderExit = new Promise<LeaderExit>((resolve) => {
    settleExit = (exit) => {
      if (exited) return
      exited = exit
      resolve(exit)
    }
  })
  child.on('exit', (code, signal) => {
    lifecycle({ event: 'exit', code, signal })
    settleExit({ kind: 'exited', code, signal })
  })
  child.on('error', (error) => {
    lifecycle({ event: 'error', message: error.message })
    if (pid === null) settleExit({ kind: 'spawn-failed', error })
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
  } else {
    // An unrecorded stdin may still fail (EPIPE after exit); keep it handled.
    child.stdin.on('error', () => {})
  }

  const signal = (sig: NodeJS.Signals): boolean => {
    if (pid === null) return false
    if (useGroup) return signalGroup(pid, sig)
    return child.kill(sig)
  }

  const groupEmpty = () => pid === null || liveGroupMembers(pid).length === 0

  async function doTerminate(options: TerminateOptions): Promise<ProcessExitFact> {
    const graceMs = options.graceMs ?? 2000
    const killMs = options.killMs ?? 5000
    if (pid === null) {
      await leaderExit
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
  return {
    generation,
    pid,
    stdin,
    stdout,
    leaderExit,
    get exited() {
      return exited
    },
    stderrTail: () => tail,
    signal,
    terminate(options = {}) {
      stopping ??= doTerminate(options)
      return stopping
    },
  }
}
