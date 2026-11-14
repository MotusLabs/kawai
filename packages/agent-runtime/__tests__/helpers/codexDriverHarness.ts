// The public Codex driver over the owned fake app-server (task 4.2 tests).
// Each harness gets an isolated root (cwd, Codex home, cache, temp) and a
// wrapper script `bin/codex` that execs the fixture with the pinned Bun, so
// the driver launches it as its executablePath through the default
// transport. Everything the callbacks report is recorded.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexDriver } from '../../src/codex/index.js'
import { createCodexDriverWith } from '../../src/codex/driver.js'
import { inProcessSpawn } from './inProcessCodex.js'
import { spawnOwned, type OwnedProcess, type OwnedSpawnRequest } from '../../src/process/ownedProcess.js'
import type { CodexAgentDriver, DriverState, ProcessEndReport, ResumeCheckpoint, TurnResult } from '../../src/contract.js'
import type { AgentRuntimeError } from '../../src/errors.js'
import type { AgentEvent } from '../../src/events.js'
import type { AgentCallbacks, CodexDriverOptions, CodexPermissions, LaunchConfiguration } from '../../src/options.js'

export const FAKE_CODEX = join(import.meta.dir, '..', 'fixtures', 'fakeCodex.ts')
export const BUN = process.execPath

export const PERMISSIONS: CodexPermissions = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  networkAccess: false,
  writableRoots: [],
  userInput: 'enabled',
  elicitation: 'enabled',
}

export interface CodexRoot {
  root: string
  home: string
  wrapper: string
  launch(env?: Record<string, string>): LaunchConfiguration
  /** Every JSON line the fake received, parsed (across generations). */
  received(): Record<string, any>[]
}

/** A fresh isolated root; `home` may be shared to resume across drivers. */
export function codexRoot(home?: string): CodexRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-codex-driver-')))
  for (const dir of ['home', 'cache', 'tmp', 'bin', 'work']) mkdirSync(join(root, dir))
  const codexHome = home ?? join(root, 'home')
  const wrapper = join(root, 'bin', 'codex')
  writeFileSync(wrapper, `#!/bin/sh\nexec '${BUN}' '${FAKE_CODEX}' "$@"\n`)
  chmodSync(wrapper, 0o755)
  return {
    root,
    home: codexHome,
    wrapper,
    launch: (env = {}) => ({
      cwd: join(root, 'work'),
      childEnv: { CODEX_HOME: codexHome, ...env },
      executablePath: wrapper,
      homeDir: codexHome,
      cacheDir: join(root, 'cache'),
      tempDir: join(root, 'tmp'),
    }),
    received: () => {
      let text = ''
      try {
        text = readFileSync(join(codexHome, 'received.jsonl'), 'utf8')
      } catch {
        return []
      }
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)
    },
  }
}

export interface Recorded {
  driver: CodexAgentDriver
  root: CodexRoot
  events: AgentEvent[]
  results: TurnResult[]
  states: DriverState[]
  ends: ProcessEndReport[]
  checkpoints: ResumeCheckpoint[]
  warnings: unknown[]
  types(): string[]
}

const live: CodexAgentDriver[] = []

export interface HarnessOptions extends Partial<Omit<CodexDriverOptions, 'callbacks' | 'launch'>> {
  root?: CodexRoot
  env?: Record<string, string>
  callbacks?: Partial<AgentCallbacks>
  launch?: CodexDriverOptions['launch']
  /** The bulk campaigns' in-process app-server (helpers/inProcessCodex.ts); default: the owned process. */
  inProcess?: boolean
  /** Private per-method request deadlines through createCodexDriverWith (task-5906f19c A7); never a public option. */
  requestTimeoutsMs?: Readonly<Record<string, number>>
  /** Fixture-internal cleanup owner: receives the inert driver instead of the shared stopDrivers registry; never a driver option. */
  enroll?: (driver: CodexAgentDriver) => void
  /**
   * Test-only owner collector (task-3c3e3658 R7 A16); never a driver option.
   * Supplied, the driver goes through createCodexDriverWith with a spawn that
   * calls the production spawnOwned with the exact original request, once,
   * pushes the returned OwnedProcess here and returns that same object:
   * nothing is wrapped or mutated and no listener is attached. Absent, the
   * spawn path is unchanged. Not combinable with `inProcess`.
   */
  owners?: OwnedProcess[]
}

/** The collecting spawn: spawnOwned(request) once; the same owner is retained and returned. */
function collectingSpawn(owners: OwnedProcess[]): (request: OwnedSpawnRequest) => OwnedProcess {
  return (request) => {
    const owned = spawnOwned(request)
    owners.push(owned)
    return owned
  }
}

/**
 * A public-factory driver (the package's createCodexDriver over the owned
 * process) whose callbacks record everything, then call any supplied hooks.
 * With `inProcess` or `requestTimeoutsMs`, the same options go through
 * createCodexDriverWith's private seams instead (the in-process spawn, the
 * per-method deadlines; the owned process stays the default spawn). With
 * `owners`, the private spawn is the collecting spawnOwned (A16): a private
 * factory composition, not the public factory's empty-internal branch.
 */
export function codexDriver(options: HarnessOptions = {}): Recorded {
  const { root: given, env, callbacks = {}, launch, inProcess = false, requestTimeoutsMs, enroll, owners, ...rest } = options
  if (owners && inProcess) throw new Error('the owner collector needs the owned process, not the in-process app-server')
  const root = given ?? codexRoot()
  const recorded = { root, events: [] as AgentEvent[], results: [] as TurnResult[], states: [] as DriverState[], ends: [] as ProcessEndReport[], checkpoints: [] as ResumeCheckpoint[], warnings: [] as unknown[] }
  const logger = { debug() {}, info() {}, warn: (obj: object, msg?: string) => recorded.warnings.push([msg, obj]), error: (obj: object, msg?: string) => recorded.warnings.push([msg, obj]) }
  const internal = { ...(inProcess ? { spawn: inProcessSpawn } : {}), ...(owners ? { spawn: collectingSpawn(owners) } : {}), ...(requestTimeoutsMs ? { requestTimeoutsMs } : {}) }
  const create = (o: CodexDriverOptions) => (inProcess || requestTimeoutsMs || owners ? createCodexDriverWith(o, internal) : createCodexDriver(o))
  const driver = create({
    logger,
    launch: launch ?? root.launch(env),
    permissions: PERMISSIONS,
    ...rest,
    callbacks: {
      ...callbacks,
      onEvent: (event) => {
        recorded.events.push(event)
        callbacks.onEvent?.(event)
      },
      onTurnResult: (result) => {
        recorded.results.push(result)
        callbacks.onTurnResult?.(result)
      },
      onState: (state) => {
        recorded.states.push(state)
        callbacks.onState?.(state)
      },
      onProcessEnd: (report) => {
        recorded.ends.push(report)
        callbacks.onProcessEnd?.(report)
      },
      onCheckpoint: (checkpoint) => {
        recorded.checkpoints.push(checkpoint)
        return callbacks.onCheckpoint?.(checkpoint)
      },
    },
  })
  if (enroll) enroll(driver)
  else live.push(driver)
  return { driver, ...recorded, types: () => recorded.events.map((event) => event.type) }
}

/** Stop every driver a test left running. */
export async function stopDrivers(): Promise<void> {
  await Promise.allSettled(live.splice(0).map((driver) => driver.kill()))
}

/** The requests of one method the fake received. */
export const sent = (root: CodexRoot, method: string) => root.received().filter((message) => message.method === method)

/** Poll until `probe` is truthy (or the bound passes); returns its value. */
export async function waitFor<T>(probe: () => T | undefined | null | false, ms = 5000): Promise<T | undefined> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The rejection of `promise`; throws when it resolves. */
export async function refusal(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise
  } catch (error) {
    return error as AgentRuntimeError
  }
  throw new Error('expected a refusal')
}

/** The pids the fake processes of this home recorded, oldest first. */
export function pids(home: string): number[] {
  try {
    return readFileSync(join(home, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/**
 * Whether a /proc/<pid>/stat line shows a live process: Z (zombie, exited
 * but unreaped) and X (dead, being reaped) count as dead, matching
 * processGroup.liveGroupMembers; every other state counts as live.
 */
export function statShowsLive(stat: string): boolean {
  return !/\) [ZX] /.test(stat)
}

/** Whether `pid` runs; a zombie or a dead (X) process counts as dead, as in ownedProcess. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return statShowsLive(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

/** A promise the test settles by hand. */
export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
