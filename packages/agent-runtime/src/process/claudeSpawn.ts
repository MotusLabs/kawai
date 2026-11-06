// The Claude driver's always-present `spawnClaudeCodeProcess` (design §3):
// the SDK chooses the command and arguments, the owned spawner supplies the
// process. The SDK's proposed env and cwd are ignored — the launch's frozen
// map and cwd are enforced, so SpawnOptions can never reintroduce ambient
// variables (I3); a protocol variable the CLI needs must come through the
// profile helper's returned map. The SDK's forwarded abort starts the owned
// termination; the driver awaits the same memoized terminate() for its receipt.

import { EventEmitter } from 'node:events'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { WireRecorder } from '../options.js'
import type { ResolvedLaunch } from './launch.js'
import { spawnOwned, type OwnedProcess } from './ownedProcess.js'

export interface OwnedClaudeSpawnOptions {
  launch: ResolvedLaunch
  generation: number
  recorder?: WireRecorder
  /** Receives the owned process before the SDK sees it. */
  onSpawn(owned: OwnedProcess): void
}

type ProcessEvent = 'exit' | 'error'
type Listener = (...args: any[]) => void

/** Adapt one owned process to the SDK's SpawnedProcess interface. */
export function toSpawnedProcess(owned: OwnedProcess): SpawnedProcess {
  const events = new EventEmitter()
  let killed = false
  void owned.leaderExit.then((exit) => {
    if (exit.kind === 'exited') events.emit('exit', exit.code, exit.signal)
    else events.emit('error', exit.error)
  })
  return {
    stdin: owned.stdin,
    stdout: owned.stdout,
    get killed() {
      return killed
    },
    get exitCode() {
      const exit = owned.exited
      return exit?.kind === 'exited' ? exit.code : null
    },
    get signalCode() {
      const exit = owned.exited
      return exit?.kind === 'exited' ? exit.signal : null
    },
    kill(signal) {
      const sent = owned.signal(signal)
      if (sent) killed = true
      return sent
    },
    on: (event: ProcessEvent, listener: Listener) => void events.on(event, listener),
    once: (event: ProcessEvent, listener: Listener) => void events.once(event, listener),
    off: (event: ProcessEvent, listener: Listener) => void events.off(event, listener),
  } as SpawnedProcess
}

export function createOwnedClaudeSpawn(options: OwnedClaudeSpawnOptions): (spawnOptions: SpawnOptions) => SpawnedProcess {
  return (spawnOptions) => {
    const owned = spawnOwned({
      command: spawnOptions.command,
      args: spawnOptions.args,
      launch: options.launch,
      generation: options.generation,
      ...(options.recorder ? { recorder: options.recorder } : {}),
    })
    options.onSpawn(owned)
    spawnOptions.signal?.addEventListener('abort', () => void owned.terminate().catch(() => {}), { once: true })
    return toSpawnedProcess(owned)
  }
}
