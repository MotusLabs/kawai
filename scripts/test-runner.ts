// The unit-suite runner (design D1–D3): one `bun test --parallel=N` over the
// main batch, and the real-tmux files one process at a time. The runner owns one
// run root per invocation; scripts/test-preload.ts — passed to every `bun
// test` child with --preload — gives each test file fresh directories for
// the four runner-provided variables beneath that root. Every child also
// gets a 20 s default per-test timeout: per-file isolation pays cold-start
// costs the shared process used to amortize. Stale run roots from killed
// runs are swept at startup, and SIGINT/SIGTERM are forwarded to the
// child's whole process group before the root is removed after a bounded
// kill; a finished batch's leftover processes are killed before the next
// batch starts or the root is removed (decision D-g).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordsDir } from './lib/checkRecords'
import { REAL_TMUX_FILES, isRealTmuxFile, planBatches } from './planBatches'
import {
  publishTimingsSnapshot,
  readTimingsSeed,
  seedTimingsSnapshot,
} from './testTimings'

const RUN_ROOT_PREFIX = 'agentboard-tests-'
const OWNER_MARKER = 'owner.json'
const KILL_GRACE_MS = 10_000
const UNMARKED_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface RunnerChild {
  pid: number
  kill(signal: NodeJS.Signals): unknown
  exited: Promise<number>
}

interface RunArgs {
  skipRealTmux: boolean
  fileArgs: string[]
  passthrough: string[]
}

// Positional arguments ending in .test.ts/.tsx are explicit test files: the
// runner runs exactly those files (task 2.4's per-entry verification uses
// this). Anything else passes through to `bun test`.
export function parseRunArgs(args: string[]): RunArgs {
  const parsed: RunArgs = {
    skipRealTmux: false,
    fileArgs: [],
    passthrough: [],
  }
  for (const arg of args) {
    if (arg === '--skip-real-tmux') parsed.skipRealTmux = true
    else if (arg.endsWith('.test.ts') || arg.endsWith('.test.tsx')) parsed.fileArgs.push(arg)
    else parsed.passthrough.push(arg)
  }
  return parsed
}

// A test-name filter selects a subset just like explicit file arguments do,
// so a filtered run must not overwrite the timings record (D4): only the
// selected files' durations would be measured.
export function hasTestNameFilter(passthrough: string[]): boolean {
  return passthrough.some(
    (arg) =>
      arg === '-t' ||
      arg.startsWith('-t=') ||
      arg === '--test-name-pattern' ||
      arg.startsWith('--test-name-pattern=')
  )
}

// The measured default (2.3, design D2): 4 is the largest N whose alone-run
// peak process-tree memory stayed within one serial run's peak, and it
// passed three loaded runs beside two serial suites. The cgroup grants this
// workspace 6 CPUs, so the default is the measured count capped at the
// quota read from cpu.max — never the platform CPU count.
export const MEASURED_WORKERS = 4

// Parses a cgroup v2 cpu.max ("quota period"; "max period" when unbounded)
// into whole CPUs, or null when the file is missing, unbounded, or malformed.
export function parseCpuQuota(content: string): number | null {
  const parts = content.trim().split(/\s+/)
  if (parts[0] === 'max') return null
  const quota = Number(parts[0])
  const period = Number(parts[1] ?? '')
  if (!Number.isInteger(quota) || !Number.isFinite(period) || period <= 0) return null
  return Math.floor(quota / period)
}

export function readCpuQuota(): number | null {
  try {
    return parseCpuQuota(fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8'))
  } catch {
    return null
  }
}

// The cap: the cgroup CPU quota where one is set, else the platform's
// reported parallelism (2.3). The reader is injectable for tests (review F7).
export function effectiveQuota(readQuota: () => number | null = readCpuQuota): number {
  return readQuota() ?? os.availableParallelism()
}

// The effective default: the measured count, never above the workspace's
// CPU cap, and at least 1.
export function defaultWorkers(quota: number = effectiveQuota()): number {
  return Math.max(1, Math.min(MEASURED_WORKERS, quota))
}

// The worker count comes from KAWAI_TEST_WORKERS; unset takes the measured
// default (2.3).
export function workersFromEnv(env: NodeJS.ProcessEnv = process.env, fallback: number = defaultWorkers()): number {
  const raw = env.KAWAI_TEST_WORKERS
  if (raw === undefined || raw === '') return fallback
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Sends a signal to the child's whole process group: every bun test worker
// and every process a test spawned is a member and dies with it (decision
// D-g). ESRCH means the group is already gone.
function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function groupHasMembers(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

// Forwards the signal to the child and its whole process group, escalates to
// a group SIGKILL once the grace passes, then removes the run root (decision
// D-g). The detached child no longer receives anything sent to the runner's
// own group, so the runner forwards it. The caller picks the exit code
// (130 for SIGINT, 143 for SIGTERM).
export async function forwardSignalAndReap(
  child: RunnerChild | null,
  signal: NodeJS.Signals,
  runRoot: string | null,
  graceMs: number = KILL_GRACE_MS
): Promise<void> {
  if (child !== null) {
    child.kill(signal)
    killGroup(child.pid, signal)
    const outcome = await Promise.race([
      child.exited.then(() => 'exited' as const),
      sleep(graceMs).then(() => 'timeout' as const),
    ])
    if (outcome === 'timeout') {
      child.kill('SIGKILL')
      killGroup(child.pid, 'SIGKILL')
      await child.exited
    }
  }
  if (runRoot !== null) fs.rmSync(runRoot, { recursive: true, force: true })
}

// --- file collection ---

async function collectFiles(): Promise<{
  serverTests: string[]
  clientTests: string[]
  runnerTests: string[]
}> {
  const serverTests: string[] = []
  const serverGlob = new Bun.Glob('src/server/__tests__/*.test.ts')
  for await (const file of serverGlob.scan({ onlyFiles: true })) {
    if (!isRealTmuxFile(file)) {
      serverTests.push(file)
    }
  }

  const clientTests: string[] = []
  const clientGlob = new Bun.Glob('src/client/__tests__/*.test.{ts,tsx}')
  for await (const file of clientGlob.scan({ onlyFiles: true })) {
    clientTests.push(file)
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
    if (isRealTmuxFile(asPath)) realTmux.push(asPath)
    else parallel.push(asPath)
  }
  return { parallel, realTmux }
}

let currentChild: RunnerChild | null = null

async function runCommand(cmd: string[], env: NodeJS.ProcessEnv, batch: string) {
  // A handled signal owns the exit (decision D-g): its handler reaps the
  // current child and process.exit()s. Spawning a further batch first would
  // orphan it, so the loop stops here instead (review F5).
  if (signalHandled) {
    throw new Error(`Signal handled; not starting batch: ${batch}`)
  }
  // detached: the child leads its own process group, so the group kills in
  // forwardSignalAndReap and below reach its workers and every process a
  // test spawned (decision D-g).
  const proc = Bun.spawn({
    cmd,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
    detached: true,
  })
  currentChild = proc
  const exitCode = await proc.exited
  currentChild = null
  // A finished batch may leave processes behind (a fixture's server, a
  // spawned tmux). Kill any group survivor before the next batch starts or
  // the run root is removed: no live process of a batch may write into a
  // removed root.
  if (groupHasMembers(proc.pid)) {
    killGroup(proc.pid, 'SIGKILL')
    console.error(`[test-runner] killed leftover processes of batch: ${batch}`)
  }
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
  // Parsed before the run root exists: a bad KAWAI_TEST_WORKERS exits
  // non-zero and leaves no run root behind (follow-up F1).
  const workers = workersFromEnv()
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), RUN_ROOT_PREFIX))
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

  try {
    writeOwnerMarker(runRoot)
    let mainFiles: string[]
    let serialFiles: string[]
    let mainLabel: string
    if (args.fileArgs.length > 0) {
      const resolved = resolveFileArgs(args.fileArgs)
      mainFiles = resolved.parallel
      serialFiles = resolved.realTmux
      mainLabel = 'explicit files'
    } else {
      const { serverTests, clientTests, runnerTests } = await collectFiles()
      mainFiles = [...serverTests, ...runnerTests, 'src/shared/__tests__', ...clientTests]
      serialFiles = [...REAL_TMUX_FILES].map((file) => `src/server/__tests__/${file}`)
      mainLabel = 'main batch'
    }
    // The timings record rides full runs only (D4): a filtered run — explicit
    // files or a test-name filter — measures a subset and must not overwrite
    // the record. A records directory that cannot be resolved (no git) only
    // costs the scheduling order, never the run.
    const fullRun = args.fileArgs.length === 0 && !hasTestNameFilter(args.passthrough)
    let timingsSnapshot: string | null = null
    if (fullRun) {
      try {
        timingsSnapshot = seedTimingsSnapshot(runRoot, readTimingsSeed(recordsDir(process.cwd())))
      } catch (error) {
        console.error(`[test-runner] timings record unavailable: ${String(error)}`)
      }
    }
    let published = false
    for (const batch of planBatches({
      workers,
      mainFiles,
      serialFiles,
      passthrough: args.passthrough,
      skipRealTmux: args.skipRealTmux,
      mainLabel,
      timingsPath: timingsSnapshot ?? undefined,
      updateTimings: timingsSnapshot !== null,
    })) {
      await runCommand(batch.cmd, env, batch.label)
      // The main batch wrote the fresh snapshot (--update-timings). Publish
      // it now — a later serial batch failing must not lose it.
      if (timingsSnapshot !== null && !published) {
        published = true
        try {
          publishTimingsSnapshot(recordsDir(process.cwd()), timingsSnapshot)
        } catch (error) {
          console.error(`[test-runner] timings record not published: ${String(error)}`)
        }
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
