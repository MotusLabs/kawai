// The in-process app-server owner for the bulk Codex campaigns (I6, I7, I8;
// Lead decision e5492858). It is passed through the transport's private
// `spawn` seam (createCodexDriverWith), so the same transport, session,
// frame, result, observer and job reducers run; only the process is
// replaced: fakeCodexServer.ts serves over in-memory stdio. Like a pipe,
// each direction delivers on a later task, never inside the writer's own
// write (a PassThrough alone would run the server reentrantly within the
// transport's write), and the lines one side writes in one task arrive as
// one chunk. Its exit and evidence follow an owned process's shape: the
// fake's own exit (or its EOF on a closed stdin, code 0) ends the leader
// after its pending output; a signal sent after termination was marked ends
// it with that signal. This is model/client
// evidence only, never native-exit proof: the real owned-stdio witnesses
// (oldFrame, codexUsageFacts, the R11 observer tests, codexDriver*) keep
// spawnOwned. No wire recorder is supported here.
import { PassThrough } from 'node:stream'
import type { ProcessExitFact } from '../../src/contract.js'
import type { LeaderExit, NativeEvidence, OwnedProcess, OwnedSpawnRequest } from '../../src/process/ownedProcess.js'
import { serveFakeCodex } from '../fixtures/fakeCodexServer.js'

// Above any Linux pid_max, so no fact can name a real process.
let nextPid = 1 << 30

export function inProcessSpawn(request: OwnedSpawnRequest): OwnedProcess {
  if (request.recorder) throw new Error('the in-process app-server records no wire')
  const pid = nextPid++
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exited: LeaderExit | null = null
  let evidence: NativeEvidence | null = null
  let marked = false
  const sentAfterMark: NodeJS.Signals[] = []
  let settle!: (exit: LeaderExit) => void
  const leaderExit = new Promise<LeaderExit>((resolve) => (settle = resolve))
  const end = (exit: LeaderExit) => {
    if (exited) return
    exited = exit
    evidence = Object.freeze({ exit, marked, sentAfterMark: Object.freeze([...sentAfterMark]), errors: Object.freeze([]) })
    stdout.end()
    settle(exit)
  }
  let terminal: Promise<ProcessExitFact> | null = null
  const owned: OwnedProcess = {
    generation: request.generation,
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
    observerFailures: [],
    markTermination: () => void (marked = true),
    stderrTail: () => '',
    signal(signal) {
      if (exited) return false
      if (marked) sentAfterMark.push(signal)
      end({ kind: 'exited', code: null, signal })
      return true
    },
    terminate(options) {
      terminal ??= (async () => {
        // Like the process fake, a closed stdin ends it; else SIGTERM after the grace.
        const grace = new Promise<void>((resolve) => setTimeout(resolve, options?.graceMs ?? 2000).unref?.())
        await Promise.race([leaderExit, grace])
        if (!exited) owned.signal('SIGTERM')
        const exit = (await leaderExit) as Extract<LeaderExit, { kind: 'exited' }>
        return { generation: request.generation, state: 'exited', pid, code: exit.code, signal: exit.signal, escalated: false, groupCleared: true }
      })()
      return terminal
    },
  }
  request.onCreated?.(owned)
  // Client to server: each chunk on a later task; a closed or ended stdin is the server's EOF.
  const toServer = new PassThrough()
  let eof = false
  const close = () => void (eof || ((eof = true), setImmediate(() => toServer.end())))
  stdin.on('data', (chunk: Buffer) => void setImmediate(() => eof || exited || toServer.write(chunk)))
  stdin.on('end', close)
  stdin.on('close', close)
  // Server to client: the lines of one task as one chunk, on a later task.
  let pending = ''
  const write = (text: string) => {
    if (exited) return
    if (pending === '') setImmediate(() => void (exited || stdout.write(pending), (pending = '')))
    pending += text
  }
  // The server starts on a later task, as a spawned child would.
  setImmediate(() =>
    serveFakeCodex({
      env: { ...request.launch.childEnv },
      pid,
      cwd: request.launch.cwd,
      input: toServer,
      write,
      // Its pending output first, then the leader's end.
      exit: (code) => void setImmediate(() => setImmediate(() => end({ kind: 'exited', code, signal: null }))),
      canSpawnChildren: false,
    }),
  )
  return owned
}
