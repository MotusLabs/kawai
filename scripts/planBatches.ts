// The batch plan for the unit-suite runner (design D1–D3), as a pure
// function: one `bun test --parallel=N` over the main batch, then the
// real-tmux files one process at a time. test-runner.ts owns the processes,
// the run root, and the signals; this module only decides what runs and in
// which order.

import path from 'node:path'
import { junitReporterArgs, junitReportPath } from './lib/junitReports'

// These spawn real servers, PTYs, and tmux clients, so they run one process
// at a time after the main batch. They still need process isolation from
// global Bun.* mocks, but running them under coverage on Linux CI can stall
// PTY attach readiness — hence no --coverage* on their batches.
export const REAL_TMUX_FILES = [
  'copy-mode-async.integration.test.ts',
  'output-coalescing.integration.test.ts',
  'double-attach.integration.test.ts',
  'hibernation.integration.test.ts',
  'integration.test.ts',
  'throttled-reconnect.integration.test.ts',
  'chatRename.integration.test.ts',
]

// An explicit `.test.ts` argument naming one of these files goes to the
// serial step, whatever path it was spelled with.
export function isRealTmuxFile(file: string): boolean {
  return REAL_TMUX_FILES.includes(path.basename(file))
}

// The slow tier (design D7): every `*.integration.test.ts` file plus the
// real-tmux set. Both tiers run by default; `--skip-slow` excludes the tier.
export function isIntegrationFile(file: string): boolean {
  return path.basename(file).endsWith('.integration.test.ts')
}

export function isSlowTierFile(file: string): boolean {
  return isRealTmuxFile(file) || isIntegrationFile(file)
}

export function excludeSlowTier(files: string[]): string[] {
  return files.filter((file) => !isSlowTierFile(file))
}

export const PRELOAD_ARG = 'scripts/test-preload.ts'

// The unit-test corpus, in collectFiles' order: the one list the runner's
// file collection and the @reads guard's scan both use, so the guard always
// scans exactly what the suite runs (per-result-suite D3/B4).
export const UNIT_TEST_GLOBS = [
  'src/server/__tests__/*.test.ts',
  'src/shared/__tests__/*.test.{ts,tsx}',
  'src/client/__tests__/*.test.{ts,tsx}',
  'scripts/__tests__/*.test.{ts,tsx}',
] as const

// Per-file isolation pays cold module compilation and per-test database
// backups inside hook/test time; the shared-process runner amortized those,
// so tests that fit 5 s there need a larger default here (design D1).
// Tests keep any explicit per-test timeout.
export const DEFAULT_TEST_TIMEOUT_MS = 20_000

export interface PlannedBatch {
  kind: 'parallel' | 'real-tmux'
  label: string
  cmd: string[]
  /** The basename of the JUnit report this batch writes into
   * `junitReportDir` (K3) — recorded exactly when the runner's own reporter
   * was appended, so the planned-report manifest names what will land in
   * the directory, never a caller's own report. */
  report?: string
}

// Bun treats a relative path outside the bunfig test root as a filter unless
// it is './'-prefixed; absolute and dot-prefixed forms always read as paths.
export function toTestFilePath(file: string): string {
  if (file.startsWith('/') || file.startsWith('./') || file.startsWith('../')) return file
  return `./${file}`
}

export function buildBunTestArgs(options: {
  workers: number
  files: string[]
  passthrough: string[]
  timingsPath?: string
  updateTimings?: boolean
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
  // The timings record (D4): read the previous run's durations and, on a
  // full run, rewrite the snapshot with the measured ones.
  if (options.timingsPath !== undefined) {
    args.push(`--timings=${options.timingsPath}`)
    if (options.updateTimings) args.push('--update-timings')
  }
  args.push(...options.passthrough, ...options.files.map(toTestFilePath))
  return args
}

export function stripCoverageArgs(args: string[]) {
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

// The main batch first (with --parallel, skipped when it has no files), then
// each real-tmux file as its own later batch: serial, without --parallel, and
// without any --coverage* argument — coverage on Linux CI can stall PTY
// attach readiness. `--skip-real-tmux` yields no tmux batch. `--skip-slow`
// excludes the slow tier (D7): no `*.integration.test.ts` file in the main
// batch and no tmux batch. The timings flags ride the main batch only: the
// serial files are one-file processes whose scheduling never reorders.
// `junitReportDir` (independent-verification D7, set only by a full check)
// gives every `bun test` invocation — the parallel batch included — its own
// unique JUnit report path (K3); unset, no reporter arguments are added and
// ordinary runs stay report-free. A passthrough that already carries a
// reporter wins outright: bun test takes the last `--reporter-outfile`, so
// appending ours would silently move a caller's report (a hook nested in a
// full check inherits KAWAI_TEST_JUNIT_DIR and counts its own reports from
// it — the caller's report would land in the check's directory instead).
export function planBatches(options: {
  workers: number
  mainFiles: string[]
  serialFiles: string[]
  passthrough: string[]
  skipRealTmux: boolean
  skipSlowTier?: boolean
  mainLabel?: string
  timingsPath?: string
  updateTimings?: boolean
  junitReportDir?: string
}): PlannedBatch[] {
  const batches: PlannedBatch[] = []
  const callerReports = options.passthrough.some(
    (arg) => arg === '--reporter=junit' || arg.startsWith('--reporter-outfile=')
  )
  const reports = options.junitReportDir !== undefined && !callerReports ? options.junitReportDir : undefined
  let reportIndex = 0
  const reporter = (kind: string): { args: string[]; report?: string } => {
    if (reports === undefined) return { args: [] }
    const reportPath = junitReportPath(reports, reportIndex++, kind)
    return { args: junitReporterArgs(reportPath), report: path.basename(reportPath) }
  }
  const mainFiles = options.skipSlowTier ? excludeSlowTier(options.mainFiles) : options.mainFiles
  if (mainFiles.length > 0) {
    const main = reporter('parallel')
    batches.push({
      kind: 'parallel',
      label: options.mainLabel ?? 'main batch',
      cmd: [
        'bun',
        'test',
        ...buildBunTestArgs({
          workers: options.workers,
          files: mainFiles,
          passthrough: options.passthrough,
          timingsPath: options.timingsPath,
          updateTimings: options.updateTimings,
        }),
        ...main.args,
      ],
      report: main.report,
    })
  }
  if (!options.skipRealTmux && !options.skipSlowTier) {
    const passthrough = stripCoverageArgs(options.passthrough)
    for (const file of options.serialFiles) {
      const report = reporter('real-tmux')
      batches.push({
        kind: 'real-tmux',
        label: `real-tmux: ${file}`,
        cmd: [
          'bun',
          'test',
          '--preload',
          PRELOAD_ARG,
          `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
          ...passthrough,
          toTestFilePath(file),
          ...report.args,
        ],
        report: report.report,
      })
    }
  }
  return batches
}
