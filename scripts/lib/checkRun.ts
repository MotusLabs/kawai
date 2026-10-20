// checkRun.ts - The `bun run check` pipeline (check-dedup D3/D4).
//
// Computes the working tree's content key, reuses a recorded pass when one
// exists, otherwise runs lint, typecheck, and the unit suite in order,
// stopping at the first failure, and records a full pass. Only a completed
// pass is recorded: a failing or interrupted run also drops any earlier
// record of its key, so the next check on the same tree runs in full.
//
// The GIT_* variables a pre-commit hook exports are stripped from every
// step's environment; the hook's GIT_INDEX_FILE reaches the key computation
// only through the explicit `indexFile` option.

import path from 'node:path'
import { computeContentKey } from './checkKey'
import {
  readRecord,
  recordsDir,
  removeRecord,
  writeRecord,
  type CheckRecord,
  type CheckStep,
} from './checkRecords'

export interface CheckStepSpec {
  name: string
  command: string[]
}

export const DEFAULT_STEPS: CheckStepSpec[] = [
  { name: 'lint', command: ['bun', 'run', 'lint'] },
  { name: 'typecheck', command: ['bun', 'run', 'typecheck'] },
  { name: 'test', command: ['bun', 'run', 'test'] },
]

export type CheckOutcome =
  | { kind: 'recorded'; record: CheckRecord }
  | { kind: 'passed'; key: string; steps: CheckStep[] }
  | { kind: 'failed'; step: string; exitCode: number | null }
  | { kind: 'error'; message: string }

export interface SpawnRequest {
  command: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/** The environment a step runs in: the caller's environment without any
 * GIT_* variable, so hook exports cannot redirect git inside the steps. */
export function stepEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith('GIT_')) continue
    env[name] = value
  }
  return env
}

export interface CheckRunOptions {
  cwd: string
  force?: boolean
  /** The hook's GIT_INDEX_FILE, captured before stripping; the key's index
   * copy reads it. Undefined everywhere else. */
  indexFile?: string
  steps?: CheckStepSpec[]
  env?: NodeJS.ProcessEnv
  spawn?: (request: SpawnRequest) => Promise<number | null>
  now?: () => Date
}

function defaultSpawn(request: SpawnRequest): Promise<number | null> {
  try {
    const proc = Bun.spawn({
      cmd: request.command,
      cwd: request.cwd,
      env: request.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return proc.exited
  } catch (error) {
    console.error(`check: cannot start ${request.command.join(' ')}: ${String(error)}`)
    return Promise.resolve(1)
  }
}

/** Run the check for the working tree behind `options.cwd`. */
export async function runCheck(options: CheckRunOptions): Promise<CheckOutcome> {
  const { cwd, force = false, indexFile } = options
  const steps = options.steps ?? DEFAULT_STEPS
  const spawn = options.spawn ?? defaultSpawn
  const now = options.now ?? (() => new Date())

  let contentKey
  try {
    contentKey = computeContentKey({ cwd, indexFile })
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }

  let dir: string
  try {
    dir = recordsDir(cwd)
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }

  if (force) {
    // A forced run reruns everything, so its key's earlier pass must not
    // outlive it: dropping it up front means even a run killed mid-step
    // (SIGINT, SIGTERM, a crash) leaves no stale pass behind.
    removeRecord(dir, contentKey.key)
  } else {
    const recorded = readRecord(dir, contentKey.key)
    if (recorded) return { kind: 'recorded', record: recorded }
  }

  const env = stepEnv(options.env ?? { ...process.env })
  const stepDurations: CheckStep[] = []
  for (const step of steps) {
    const started = performance.now()
    const exitCode = await spawn({ command: step.command, cwd, env })
    stepDurations.push({ name: step.name, ms: Math.round(performance.now() - started) })
    if (exitCode !== 0) {
      // A failed or interrupted run leaves no pass record for its key — the
      // next check on the same tree runs in full. A plain run can race a
      // concurrent writer that records this key mid-run, so this runs on the
      // plain path too, not only under --force.
      removeRecord(dir, contentKey.key)
      return { kind: 'failed', step: step.name, exitCode }
    }
  }

  const record: CheckRecord = {
    key: contentKey.key,
    treeId: contentKey.treeId,
    bun: contentKey.bunVersion,
    platform: contentKey.platform,
    arch: contentKey.arch,
    at: now().toISOString(),
    worktree: path.resolve(cwd),
    steps: stepDurations,
  }
  writeRecord(dir, record)
  return { kind: 'passed', key: contentKey.key, steps: stepDurations }
}
