// The unit-suite runner (design D1–D3): one `bun test --parallel=N` over the
// main batch, and the real-tmux files one process at a time. The runner owns one
// run root per invocation; scripts/test-preload.ts — passed to every `bun
// test` child with --preload — gives each test file fresh directories for
// the four runner-provided variables beneath that root. Every child also
// gets a 20 s default per-test timeout: per-file isolation pays cold-start
// costs the shared process used to amortize. `--skip-slow` (design D7)
// excludes the slow tier — every `*.integration.test.ts` file plus the
// real-tmux files — from the run; by default both tiers run. After a full
// run the runner records per-file durations to
// <git-common-dir>/kawai-checks/timings.json, feeds the record back with
// --timings so the slowest files start first, and reports files the record
// shows over 5 s outside the slow tier. Stale run roots from killed
// runs are swept at startup, and SIGINT/SIGTERM are forwarded to the
// child's whole process group before the root is removed after a bounded
// kill; a finished batch's leftover processes are killed before the next
// batch starts or the root is removed (decision D-g).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordsDir } from '../src/server/checks/checkRecords'
import {
  REAL_TMUX_FILES,
  UNIT_TEST_GLOBS,
  isRealTmuxFile,
  isSlowTierFile,
  planBatches,
} from './planBatches'
import { planRun, runBatchesAndPublish } from './runPlan'
import {
  formatMisplacedReport,
  misplacedFromRecords,
  publishTimingsSnapshot,
  readTimingsSeed,
  seedTimingsSnapshot,
} from './testTimings'
import { workersFromEnv } from './lib/workerCount'
import { plannedReportNames, writePlannedReports } from './lib/junitReports'

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
  skipSlowTier: boolean
  fileArgs: string[]
  passthrough: string[]
}

// Positional arguments ending in .test.ts/.tsx are explicit test files: the
// runner runs exactly those files (task 2.4's per-entry verification uses
// this). Anything else passes through to `bun test`.
export function parseRunArgs(args: string[]): RunArgs {
  const parsed: RunArgs = {
    skipRealTmux: false,
    skipSlowTier: false,
    fileArgs: [],
    passthrough: [],
  }
  for (const arg of args) {
    if (arg === '--skip-real-tmux') parsed.skipRealTmux = true
    else if (arg === '--skip-slow') parsed.skipSlowTier = true
    else if (arg.endsWith('.test.ts') || arg.endsWith('.test.tsx')) parsed.fileArgs.push(arg)
    else parsed.passthrough.push(arg)
  }
  return parsed
}

// The test files collectFiles() gathers, per source tree.
export interface CollectedFiles {
  serverTests: string[]
  clientTests: string[]
  runnerTests: string[]
  sharedTests: string[]
}

// The worker-count decision (2.3) lives in lib/workerCount.ts (file-size
// cap, K7); the runner consumes it like any caller.

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

// Every directory is enumerated as files: a bare directory entry in the main
// batch would escape excludeSlowTier's per-file filter (review follow-up).
export async function collectFiles(): Promise<CollectedFiles> {
  const [serverGlob, sharedGlob, clientGlob, runnerGlob] = UNIT_TEST_GLOBS
  const serverTests: string[] = []
  for await (const file of new Bun.Glob(serverGlob).scan({ onlyFiles: true })) {
    if (!isRealTmuxFile(file)) {
      serverTests.push(file)
    }
  }

  const sharedTests: string[] = []
  for await (const file of new Bun.Glob(sharedGlob).scan({ onlyFiles: true })) {
    sharedTests.push(file)
  }

  const clientTests: string[] = []
  for await (const file of new Bun.Glob(clientGlob).scan({ onlyFiles: true })) {
    clientTests.push(file)
  }

  const runnerTests: string[] = []
  for await (const file of new Bun.Glob(runnerGlob).scan({ onlyFiles: true })) {
    runnerTests.push(file)
  }

  serverTests.sort()
  sharedTests.sort()
  clientTests.sort()
  runnerTests.sort()
  return { serverTests, clientTests, runnerTests, sharedTests }
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

// The last gate before a batch spawns (review F5, N1): a handled signal owns
// the exit (decision D-g) — its handler sets the flag synchronously when the
// signal arrives and process.exit()s after reaping — so no further batch may
// start. The handler's synchronous section always precedes any code that
// could spawn a next batch (the current one ends only in response to the
// forwarded signal), so the loop's continuation evaluates this after the flag
// is set. Kept a pure helper so testRunner.test.ts asserts the gate directly.
export function refuseBatchAfterSignal(signalHandled: boolean, batch: string): void {
  if (signalHandled) {
    throw new Error(`Signal handled; not starting batch: ${batch}`)
  }
}

async function runCommand(cmd: string[], env: NodeJS.ProcessEnv, batch: string) {
  // A handled signal owns the exit (decision D-g): its handler reaps the
  // current child and process.exit()s. Spawning a further batch first would
  // orphan it, so the loop stops here instead (review F5).
  refuseBatchAfterSignal(signalHandled, batch)
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
    let collected: CollectedFiles
    let serialFiles: string[]
    let mainLabel: string
    if (args.fileArgs.length > 0) {
      const resolved = resolveFileArgs(args.fileArgs)
      collected = { serverTests: resolved.parallel, clientTests: [], runnerTests: [], sharedTests: [] }
      serialFiles = resolved.realTmux
      mainLabel = 'explicit files'
    } else {
      collected = await collectFiles()
      serialFiles = [...REAL_TMUX_FILES].map((file) => `src/server/__tests__/${file}`)
      mainLabel = 'main batch'
    }
    // The run-shape decisions (review B1): the batch options below are passed
    // to planBatches verbatim. The timings record rides full runs only (D4):
    // planRun seeds the snapshot through this callback — a records directory
    // that cannot be resolved only costs the scheduling order, never the run.
    // A full check exports KAWAI_TEST_JUNIT_DIR (independent-verification
    // D7); the runner gives every batch its own report inside it. Unset, no
    // report is written and nothing else changes.
    const junitReportDir = process.env.KAWAI_TEST_JUNIT_DIR || undefined
    // Consumed here, never inherited (D7): the batches get their report paths
    // as explicit --reporter-outfile arguments, so a runner spawned by a test
    // (runnerRoots' probes, a hook a suite test commits with) that inherits
    // this environment must plan no reports of its own into the check's
    // directory — its failure-path probes would poison the check's merge.
    delete env.KAWAI_TEST_JUNIT_DIR
    const plan = planRun({
      args,
      workers,
      collected,
      serialFiles,
      mainLabel,
      seedText: readTimingsSeed(recordsDir(process.cwd())),
      junitReportDir,
      seedTimings: (seed) => {
        try {
          return seedTimingsSnapshot(runRoot, seed)
        } catch (error) {
          console.error(`[test-runner] timings record unavailable: ${String(error)}`)
          return null
        }
      },
    })
    // The batches run and the record is published through runBatchesAndPublish
    // (review B3): the throw-before-publish ordering lives there, tested with
    // injected effects. Here the effects are the real ones. planRun's seeded
    // path is the only publish gate (F5) — null for a filtered run or a
    // failed seed — so the closure runs only with a snapshot to publish and
    // has no gate of its own.
    const batches = planBatches(plan.batchOptions)
    // The planned-report manifest (C2 advisor point on the all-or-nothing
    // leak): written at plan time, before the first batch, so the check's
    // merge can require the reports on disk to be exactly this run's planned
    // set — a batch report that never landed must not silently shrink the
    // list into fabricated `not-in-run` answers, and an unlisted report must
    // not sneak in. Written only when this run actually plans reports into
    // the directory: a caller carrying its own --reporter-outfile (the
    // hook's affected-tests pass) writes nothing here, manifest included —
    // the directory stays untouched for the run that owns it.
    const planned = plannedReportNames(batches)
    if (junitReportDir !== undefined && planned.length > 0) {
      writePlannedReports(junitReportDir, planned)
    }
    await runBatchesAndPublish({
      batches,
      env,
      publishTimingsPath: plan.batchOptions.timingsPath ?? null,
      publish: (timingsPath) => {
        // The main batch wrote the fresh snapshot (--update-timings). Publish
        // it — a later serial batch failing must not lose it — and report
        // files whose shortest kept duration sits over 5 s outside the slow
        // tier (D7).
        try {
          const record = publishTimingsSnapshot(recordsDir(process.cwd()), timingsPath)
          if (record !== null) {
            const misplaced = misplacedFromRecords(recordsDir(process.cwd()), isSlowTierFile)
            if (misplaced !== null) {
              for (const line of formatMisplacedReport(misplaced)) console.log(line)
            }
          }
        } catch (error) {
          console.error(`[test-runner] timings record not published: ${String(error)}`)
        }
      },
      runCommand,
    })
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
