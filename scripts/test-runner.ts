// The unit-suite runner (design D1–D3): one `bun test --parallel=N` over the
// main batch, the hand-kept isolated sets serially until task 2.4 removes
// them, and the real-tmux files one process at a time. The runner owns one
// run root per invocation; scripts/test-preload.ts — passed to every `bun
// test` child with --preload — gives each test file fresh directories for
// the four runner-provided variables beneath that root. Every child also
// gets a 20 s default per-test timeout: per-file isolation pays cold-start
// costs the shared process used to amortize. Stale run roots from killed
// runs are swept at startup, and SIGINT/SIGTERM remove the root after a
// bounded kill.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ISOLATED_CLIENT_FILES, ISOLATED_FILES, REAL_TMUX_FILES } from './test-isolation-lists'

const RUN_ROOT_PREFIX = 'agentboard-tests-'
const PRELOAD_ARG = 'scripts/test-preload.ts'
const OWNER_MARKER = 'owner.json'
const KILL_GRACE_MS = 10_000
const UNMARKED_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1000
// Per-file isolation pays cold module compilation and per-test database
// backups inside hook/test time; the shared-process runner amortized those,
// so tests that fit 5 s there need a larger default here (design D1).
// Tests keep any explicit per-test timeout.
const DEFAULT_TEST_TIMEOUT_MS = 20_000

interface RunnerChild {
  kill(signal: NodeJS.Signals): unknown
  exited: Promise<number>
}

interface RunArgs {
  skipRealTmux: boolean
  skipIsolated: boolean
  fileArgs: string[]
  passthrough: string[]
}

// Positional arguments ending in .test.ts/.tsx are explicit test files: the
// runner runs exactly those files (task 2.4's per-entry verification uses
// this). Anything else passes through to `bun test`.
export function parseRunArgs(args: string[]): RunArgs {
  const parsed: RunArgs = {
    skipRealTmux: false,
    skipIsolated: false,
    fileArgs: [],
    passthrough: [],
  }
  for (const arg of args) {
    if (arg === '--skip-real-tmux') parsed.skipRealTmux = true
    else if (arg === '--skip-isolated') parsed.skipIsolated = true
    else if (arg.endsWith('.test.ts') || arg.endsWith('.test.tsx')) parsed.fileArgs.push(arg)
    else parsed.passthrough.push(arg)
  }
  return parsed
}

// Default 1 until 2.3 measures the worker count (checkpoint-1 decision D-c).
export function workersFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KAWAI_TEST_WORKERS
  if (raw === undefined || raw === '') return 1
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`KAWAI_TEST_WORKERS must be a positive integer, got: ${raw}`)
  }
  return parsed
}

// --- run-root ownership (decision D-b) ---

// Field 22 of proc(5) stat is the start time; after the comm field's closing
// paren it lands at index 19. Returns null when /proc is missing (macOS) or
// unreadable — callers must then keep the root rather than guess.
export function readProcStartTime(pid: number | 'self'): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

export function isOwnerAlive(pid: number, starttime: string | null): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true // EPERM: exists under another user — never remove on a guess
  }
  if (starttime === null) return true
  const actual = readProcStartTime(pid)
  if (actual === null) return true
  return actual === starttime
}

export function writeOwnerMarker(
  runRoot: string,
  owner = { pid: process.pid, starttime: readProcStartTime('self') }
): void {
  fs.writeFileSync(path.join(runRoot, OWNER_MARKER), JSON.stringify(owner))
}

export function readOwnerMarker(runRoot: string): { pid: number; starttime: string | null } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runRoot, OWNER_MARKER), 'utf8')) as {
      pid?: unknown
      starttime?: unknown
    }
    if (typeof parsed.pid !== 'number') return null
    if (parsed.starttime !== null && typeof parsed.starttime !== 'string') return null
    return {
      pid: parsed.pid,
      starttime: typeof parsed.starttime === 'string' ? parsed.starttime : null,
    }
  } catch {
    return null
  }
}

// Removes only stale run roots (decision D-b): a marked root whose owner is
// dead — pid gone, or start time differs (pid reuse) — or an unmarked root
// older than 24 h. Live concurrent runs (the other suite-run slots and
// worktrees) are never touched.
export function sweepStaleRoots(tmpDir: string = os.tmpdir(), now: number = Date.now()): string[] {
  const removed: string[] = []
  let names: string[]
  try {
    names = fs.readdirSync(tmpDir)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!name.startsWith(RUN_ROOT_PREFIX)) continue
    const root = path.join(tmpDir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(root)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const marker = readOwnerMarker(root)
    const stale =
      marker === null
        ? now - stat.mtimeMs > UNMARKED_ROOT_MAX_AGE_MS
        : !isOwnerAlive(marker.pid, marker.starttime)
    if (stale) {
      fs.rmSync(root, { recursive: true, force: true })
      removed.push(root)
    }
  }
  return removed
}

// --- child handling ---

export function buildBunTestArgs(options: {
  workers: number
  files: string[]
  passthrough: string[]
}): string[] {
  // --parallel is passed even for 1: it implies --isolate, the per-file
  // isolation the suite now relies on (decision D-c). Leaving it out would
  // restore the shared-global batch.
  const args = [
    `--parallel=${options.workers}`,
    `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
    '--preload',
    PRELOAD_ARG,
  ]
  args.push(...options.passthrough, ...options.files.map(toTestFilePath))
  return args
}

// Bun treats a relative path outside the bunfig test root as a filter unless
// it is './'-prefixed; absolute and dot-prefixed forms always read as paths.
function toTestFilePath(file: string): string {
  if (file.startsWith('/') || file.startsWith('./') || file.startsWith('../')) return file
  return `./${file}`
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Forwards the signal to the child, escalates to SIGKILL once the grace
// passes, then removes the run root (decision D-b). The caller picks the
// exit code (130 for SIGINT, 143 for SIGTERM).
export async function forwardSignalAndReap(
  child: RunnerChild | null,
  signal: NodeJS.Signals,
  runRoot: string | null,
  graceMs: number = KILL_GRACE_MS
): Promise<void> {
  if (child !== null) {
    child.kill(signal)
    const outcome = await Promise.race([
      child.exited.then(() => 'exited' as const),
      sleep(graceMs).then(() => 'timeout' as const),
    ])
    if (outcome === 'timeout') {
      child.kill('SIGKILL')
      await child.exited
    }
  }
  if (runRoot !== null) fs.rmSync(runRoot, { recursive: true, force: true })
}

// --- file collection (task 2.4 removes the isolated sets) ---

async function collectFiles(): Promise<{
  serverTests: string[]
  clientTests: string[]
  runnerTests: string[]
}> {
  const serverTests: string[] = []
  const serverGlob = new Bun.Glob('src/server/__tests__/*.test.ts')
  for await (const file of serverGlob.scan({ onlyFiles: true })) {
    const basename = path.basename(file)
    if (!ISOLATED_FILES.has(basename) && !REAL_TMUX_FILES.has(basename)) {
      serverTests.push(file)
    }
  }

  const clientTests: string[] = []
  const clientGlob = new Bun.Glob('src/client/__tests__/*.test.{ts,tsx}')
  for await (const file of clientGlob.scan({ onlyFiles: true })) {
    if (!ISOLATED_CLIENT_FILES.has(path.basename(file))) {
      clientTests.push(file)
    }
  }

  const runnerTests: string[] = []
  const runnerGlob = new Bun.Glob('scripts/__tests__/*.test.{ts,tsx}')
  for await (const file of runnerGlob.scan({ onlyFiles: true })) {
    runnerTests.push(file)
  }

  serverTests.sort()
  clientTests.sort()
  runnerTests.sort()
  return { serverTests, clientTests, runnerTests }
}

function resolveFileArgs(fileArgs: string[]): { parallel: string[]; realTmux: string[] } {
  const parallel: string[] = []
  const realTmux: string[] = []
  for (const arg of fileArgs) {
    // Bun treats a bare name as a filter, not a path; make every explicit
    // file path-shaped.
    const asPath = arg.includes('/') ? arg : `./${arg}`
    if (!fs.existsSync(asPath)) {
      throw new Error(`Test file not found: ${arg}`)
    }
    if (REAL_TMUX_FILES.has(path.basename(asPath))) realTmux.push(asPath)
    else parallel.push(asPath)
  }
  return { parallel, realTmux }
}

let currentChild: RunnerChild | null = null

async function runCommand(cmd: string[], env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn({
    cmd,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  currentChild = proc
  const exitCode = await proc.exited
  currentChild = null
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}`)
  }
}

let runRootPath: string | null = null
let signalHandled = false
let signalExitCode = 1

function installSignalHandlers() {
  let handling = false
  const handle = (signal: 'SIGINT' | 'SIGTERM') => {
    if (handling) return
    handling = true
    signalHandled = true
    signalExitCode = signal === 'SIGINT' ? 130 : 143
    forwardSignalAndReap(currentChild, signal, runRootPath)
      .catch(() => {})
      .finally(() => process.exit(signalExitCode))
  }
  process.on('SIGINT', () => handle('SIGINT'))
  process.on('SIGTERM', () => handle('SIGTERM'))
}

async function main() {
  const args = parseRunArgs(process.argv.slice(2))

  // Clear stale roots before creating this run's own root (decision D-b).
  sweepStaleRoots()
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), RUN_ROOT_PREFIX))
  writeOwnerMarker(runRoot)
  runRootPath = runRoot
  installSignalHandlers()

  const env = {
    ...process.env,
    // React's act() requires the development build; force NODE_ENV=test
    // so tests pass even when the shell has NODE_ENV=production.
    NODE_ENV: process.env.NODE_ENV === 'production' ? 'test' : (process.env.NODE_ENV || 'test'),
    // Default skipMatchingPatterns excludes /tmp/* and /var/folders/* — both
    // common locations for test working directories (worktrees, CI runners on
    // some platforms). Tests that exercise matching logic from those paths
    // would otherwise be silently skipped. Tests that need specific skip
    // behavior pass patterns explicitly via the matcher API.
    AGENTBOARD_SKIP_MATCHING_PATTERNS: '',
    KAWAI_TEST_RUN_ROOT: runRoot,
  }
  const workers = workersFromEnv()

  try {
    if (args.fileArgs.length > 0) {
      const { parallel, realTmux } = resolveFileArgs(args.fileArgs)
      if (parallel.length > 0) {
        await runCommand(
          ['bun', 'test', ...buildBunTestArgs({ workers, files: parallel, passthrough: args.passthrough })],
          env
        )
      }
      if (!args.skipRealTmux) {
        for (const file of realTmux) {
          await runCommand(
            [
              'bun',
              'test',
              '--preload',
              PRELOAD_ARG,
              `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
              ...stripCoverageArgs(args.passthrough),
              toTestFilePath(file),
            ],
            env
          )
        }
      }
      return
    }

    const { serverTests, clientTests, runnerTests } = await collectFiles()
    await runCommand(
      [
        'bun',
        'test',
        ...buildBunTestArgs({
          workers,
          files: [...serverTests, ...runnerTests, 'src/shared/__tests__', ...clientTests],
          passthrough: args.passthrough,
        }),
      ],
      env
    )

    // Always run global-mutating tests in a separate process to prevent races.
    // Each file gets its own invocation — and, through the preload, its own
    // run root beneath this run's root (decision D-b).
    for (const file of ISOLATED_FILES) {
      await runCommand(
        ['bun', 'test', '--preload', PRELOAD_ARG, `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`, ...args.passthrough, `src/server/__tests__/${file}`],
        env
      )
    }

    if (!args.skipRealTmux) {
      const argsWithoutCoverage = stripCoverageArgs(args.passthrough)
      for (const file of REAL_TMUX_FILES) {
        await runCommand(
          [
            'bun',
            'test',
            '--preload',
            PRELOAD_ARG,
            `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
            ...argsWithoutCoverage,
            `src/server/__tests__/${file}`,
          ],
          env
        )
      }
    }

    for (const file of ISOLATED_CLIENT_FILES) {
      await runCommand(
        ['bun', 'test', '--preload', PRELOAD_ARG, `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`, ...args.passthrough, `src/client/__tests__/${file}`],
        env
      )
    }

    if (!args.skipIsolated) {
      // Each file in isolated/ runs in its own process, same as ISOLATED_FILES
      // above: these files install top-level mock.module(...) hooks (e.g.
      // indexHandlers.test.ts stubs ../../terminal with a partial factory),
      // and Bun module mocks persist for the life of the process — on readdir
      // orderings where the mocking file loads first (Linux ext4), a shared
      // process poisons every later import of the same module.
      const isolatedTests: string[] = []
      const isolatedGlob = new Bun.Glob('src/server/__tests__/isolated/*.test.ts')
      for await (const file of isolatedGlob.scan({ onlyFiles: true })) {
        isolatedTests.push(file)
      }
      isolatedTests.sort()
      for (const file of isolatedTests) {
        await runCommand(['bun', 'test', '--preload', PRELOAD_ARG, `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`, ...args.passthrough, file], env)
      }
    }
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main().catch((error) => {
    // A handled signal already removed the run root and owns the exit code;
    // the child's non-zero exit from that kill must not win the race.
    if (!signalHandled) console.error(error)
    process.exit(signalExitCode)
  })
}

function stripCoverageArgs(args: string[]) {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--coverage') continue
    if (arg.startsWith('--coverage=')) continue
    if (arg.startsWith('--coverage-reporter=')) continue
    if (arg === '--coverage-reporter') {
      index += 1
      continue
    }
    stripped.push(arg)
  }
  return stripped
}
