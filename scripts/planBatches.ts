// The batch plan for the unit-suite runner (design D1–D3), as a pure
// function: one `bun test --parallel=N` over the main batch, then the
// real-tmux files one process at a time. test-runner.ts owns the processes,
// the run root, and the signals; this module only decides what runs and in
// which order.

import path from 'node:path'

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

// Per-file isolation pays cold module compilation and per-test database
// backups inside hook/test time; the shared-process runner amortized those,
// so tests that fit 5 s there need a larger default here (design D1).
// Tests keep any explicit per-test timeout.
export const DEFAULT_TEST_TIMEOUT_MS = 20_000

export interface PlannedBatch {
  kind: 'parallel' | 'real-tmux'
  label: string
  cmd: string[]
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
}): PlannedBatch[] {
  const batches: PlannedBatch[] = []
  const mainFiles = options.skipSlowTier ? excludeSlowTier(options.mainFiles) : options.mainFiles
  if (mainFiles.length > 0) {
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
      ],
    })
  }
  if (!options.skipRealTmux && !options.skipSlowTier) {
    const passthrough = stripCoverageArgs(options.passthrough)
    for (const file of options.serialFiles) {
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
        ],
      })
    }
  }
  return batches
}
