// The runner's run-shape decisions and their execution (design D1–D4,
// review B1/B3): planRun() is pure over the parsed arguments and the run's
// resolved inputs — the batch options main() passes to planBatches verbatim
// and whether the run is full — and runBatchesAndPublish() runs the planned
// batches in order and publishes once the first batch has passed.
// test-runner.ts owns the processes, the run root, and the signals; main()
// wires the real runCommand and publish into runBatchesAndPublish.

import type { PlannedBatch, planBatches } from './planBatches'
import type { CollectedFiles, RunArgs } from './test-runner'

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

// The run-shape decisions (review B1), pure over the parsed arguments and
// the run's resolved inputs: the batch options main() passes to planBatches
// verbatim — so no per-field call site can drop a flag — and whether the run
// is full. The publish gate (F5) is batchOptions.timingsPath itself: a run
// may publish the timings record only when it is full AND seeding produced
// the snapshot, which is the same fact as the path being set, and main()
// wires that path into runBatchesAndPublish — there is no second gate
// beside it. Only a full run seeds the snapshot: `seedTimings` is called
// with the previous record's text (null when there is none usable) and
// returns the snapshot path, or null when seeding failed.
export interface RunPlan {
  batchOptions: Parameters<typeof planBatches>[0]
  fullRun: boolean
}

export function planRun(input: {
  args: RunArgs
  workers: number
  collected: CollectedFiles
  serialFiles: string[]
  mainLabel: string
  seedText: string | null
  seedTimings: (seedText: string | null) => string | null
  junitReportDir?: string
}): RunPlan {
  const fullRun = input.args.fileArgs.length === 0 && !hasTestNameFilter(input.args.passthrough)
  const timingsPath = fullRun ? input.seedTimings(input.seedText) : null
  return {
    batchOptions: {
      workers: input.workers,
      // The main batch is the collected files, spelled as files: a directory
      // entry would escape the slow tier's per-file filter (review follow-up).
      mainFiles: [
        ...input.collected.serverTests,
        ...input.collected.runnerTests,
        ...input.collected.sharedTests,
        ...input.collected.clientTests,
        ...input.collected.packageTests,
      ],
      serialFiles: input.serialFiles,
      passthrough: input.args.passthrough,
      skipRealTmux: input.args.skipRealTmux,
      skipSlowTier: input.args.skipSlowTier,
      mainLabel: input.mainLabel,
      timingsPath: timingsPath ?? undefined,
      updateTimings: timingsPath !== null,
      // Per-batch JUnit reports ride only when a full check asked for them
      // (independent-verification D7); the runner passes the directory
      // through untouched.
      junitReportDir: input.junitReportDir,
    },
    fullRun,
  }
}

// One input the runner wires for real in main(): the planned batches, the
// child environment, the snapshot path planRun seeded — null when the plan
// publishes nothing — and the two effects, the batch runner and the publish
// step. Tests inject doubles for the effects; production passes the real
// runCommand and the real publish closure. There is no separate permission
// flag to bypass (F5): planRun's seeded path is the only publish gate.
// `retry` wires the real-tmux retry (check-time-optimization D2); absent or
// disabled (`--no-retry`), a failed real-tmux file fails the run once every
// real-tmux file has run.
export interface BatchRunInput {
  batches: PlannedBatch[]
  env: NodeJS.ProcessEnv
  publishTimingsPath: string | null
  publish: (timingsPath: string) => void
  runCommand: (cmd: string[], env: NodeJS.ProcessEnv, batch: string) => Promise<void>
  retry?: RetryWiring
}

export interface RetryWiring {
  enabled: boolean
  /** The rerun of a failed real-tmux batch; called once per rerun, just
   * before it starts, so production appends the rerun's report to the
   * planned-report manifest here (task 3.3). */
  planRerun: (batch: PlannedBatch) => PlannedBatch
  /** The failing tests a finished batch's report names; empty when it
   * names none (no report, or the file failed outside any test). */
  failingTests: (batch: PlannedBatch) => string[]
}

/** At most this many failed real-tmux files are rerun (D2): more signal a
 * broken environment or real breakage. */
export const MAX_REAL_TMUX_RETRIES = 2

/** A real-tmux file that failed once and passed when rerun alone. */
export interface RealTmuxRetry {
  file: string
  failures: string[]
}

export interface BatchRunOutcome {
  retries: RealTmuxRetry[]
}

/** Thrown when a batch is refused before it spawns (a handled signal owns
 * the exit): never collected as a real-tmux failure, always propagated. */
export class BatchRefusedError extends Error {}

function describeFailures(failures: string[]): string {
  return failures.length === 0 ? 'no failing test named' : failures.join('; ')
}

// Runs every planned batch in order and publishes the timings record once
// the first batch has passed: the main batch wrote the fresh snapshot
// (--update-timings), and a later serial batch failing must not lose it.
// A failed main batch throws out of runCommand before the publish point, so
// it never publishes and no later batch starts (D4, review B3). A failed
// real-tmux batch is collected instead and the next one starts (D2); after
// the last, one or two failed files rerun once each, alone, when retries
// are on, and the run passes only if every rerun passed. Three or more, or
// retries off, fail the run without a rerun. A main-batch failure is never
// retried (I1). A null publishTimingsPath never publishes — the gate is
// planRun's (F5).
export async function runBatchesAndPublish(input: BatchRunInput): Promise<BatchRunOutcome> {
  let published = false
  const failed: Array<{ batch: PlannedBatch; failures: string[] }> = []
  for (const batch of input.batches) {
    if (batch.kind === 'real-tmux') {
      try {
        await input.runCommand(batch.cmd, input.env, batch.label)
      } catch (error) {
        if (error instanceof BatchRefusedError) throw error
        const failures = input.retry?.failingTests(batch) ?? []
        console.error(`[test-runner] ${batch.label} failed: ${String(error)}`)
        failed.push({ batch, failures })
        continue
      }
    } else {
      await input.runCommand(batch.cmd, input.env, batch.label)
    }
    if (input.publishTimingsPath !== null && !published) {
      published = true
      input.publish(input.publishTimingsPath)
    }
  }
  if (failed.length === 0) return { retries: [] }
  const named = failed
    .map(({ batch, failures }) => `${batch.file ?? batch.label} (${describeFailures(failures)})`)
    .join(', ')
  if (input.retry === undefined || !input.retry.enabled) {
    throw new Error(`Real-tmux files failed, retries off: ${named}`)
  }
  if (failed.length > MAX_REAL_TMUX_RETRIES) {
    throw new Error(`${failed.length} real-tmux files failed, none rerun (at most ${MAX_REAL_TMUX_RETRIES} are): ${named}`)
  }
  const stillFailing: string[] = []
  for (const { batch, failures } of failed) {
    const rerun = input.retry.planRerun(batch)
    console.error(`[test-runner] WARNING: rerunning ${batch.file ?? batch.label} once, alone, after its failure`)
    try {
      await input.runCommand(rerun.cmd, input.env, rerun.label)
    } catch (error) {
      if (error instanceof BatchRefusedError) throw error
      stillFailing.push(
        `${batch.file ?? batch.label} — first attempt: ${describeFailures(failures)}; rerun: ${describeFailures(input.retry.failingTests(rerun))}`
      )
    }
  }
  if (stillFailing.length > 0) {
    throw new Error(`Real-tmux rerun failed: ${stillFailing.join(', ')}`)
  }
  const retries = failed.map(({ batch, failures }) => ({ file: batch.file ?? batch.label, failures }))
  console.error(`[test-runner] WARNING: passed after retrying ${retries.map((retry) => retry.file).join(', ')}`)
  return { retries }
}
