// The public Codex driver over the owned fake app-server (task 4.2 tests).
// Each harness gets an isolated root (cwd, Codex home, cache, temp) and a
// wrapper script `bin/codex` that execs the fixture with the pinned Bun, so
// the driver launches it as its executablePath through the default
// transport. Everything the callbacks report is recorded.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexDriver } from '../../src/codex/index.js'
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
}

/** A public-factory driver whose callbacks record everything, then call any supplied hooks. */
export function codexDriver(options: HarnessOptions = {}): Recorded {
  const { root: given, env, callbacks = {}, launch, ...rest } = options
  const root = given ?? codexRoot()
  const recorded = { root, events: [] as AgentEvent[], results: [] as TurnResult[], states: [] as DriverState[], ends: [] as ProcessEndReport[], checkpoints: [] as ResumeCheckpoint[], warnings: [] as unknown[] }
  const logger = { debug() {}, info() {}, warn: (obj: object, msg?: string) => recorded.warnings.push([msg, obj]), error: (obj: object, msg?: string) => recorded.warnings.push([msg, obj]) }
  const driver = createCodexDriver({
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
  live.push(driver)
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

/** Whether `pid` runs; a zombie (exited, not yet reaped) counts as dead, as in ownedProcess. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
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
