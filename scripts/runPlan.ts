// The runner's run-shape decisions and their execution (design D1–D4,
// review B1/B3): planRun() is pure over the parsed arguments and the run's
// resolved inputs — the batch options main() passes to planBatches verbatim,
// whether the run is full, and whether it may publish the timings record —
// and runBatchesAndPublish() runs the planned batches in order and publishes
// once the first batch has passed. test-runner.ts owns the processes, the
// run root, and the signals; main() wires the real runCommand and publish
// into runBatchesAndPublish.

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
// verbatim — so no per-field call site can drop a flag — whether the run is
// full, and whether it may publish the timings record. Only a full run
// publishes (D4): a filtered run measures a subset, and a failed one throws
// in runBatchesAndPublish before its publish point. Only a full run seeds
// the snapshot: `seedTimings` is called with the previous record's text
// (null when there is none usable) and returns the snapshot path, or null
// when seeding failed.
export interface RunPlan {
  batchOptions: Parameters<typeof planBatches>[0]
  fullRun: boolean
  // planRun's publish decision (F5): a run may publish the timings record
  // only when it is full AND seeding produced the snapshot — the same fact
  // as batchOptions.timingsPath being set, spelled for readers. What main()
  // wires into runBatchesAndPublish is the path itself (publishTimingsPath),
  // so there is no second gate beside this one.
  publishTimings: boolean
}

export function planRun(input: {
  args: RunArgs
  workers: number
  collected: CollectedFiles
  serialFiles: string[]
  mainLabel: string
  seedText: string | null
  seedTimings: (seedText: string | null) => string | null
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
      ],
      serialFiles: input.serialFiles,
      passthrough: input.args.passthrough,
      skipRealTmux: input.args.skipRealTmux,
      skipSlowTier: input.args.skipSlowTier,
      mainLabel: input.mainLabel,
      timingsPath: timingsPath ?? undefined,
      updateTimings: timingsPath !== null,
    },
    fullRun,
    publishTimings: timingsPath !== null,
  }
}

// One input the runner wires for real in main(): the planned batches, the
// child environment, the snapshot path planRun seeded — null when the plan
// publishes nothing — and the two effects, the batch runner and the publish
// step. Tests inject doubles for the effects; production passes the real
// runCommand and the real publish closure. There is no separate permission
// flag to bypass (F5): planRun's seeded path is the only publish gate.
export interface BatchRunInput {
  batches: PlannedBatch[]
  env: NodeJS.ProcessEnv
  publishTimingsPath: string | null
  publish: (timingsPath: string) => void
  runCommand: (cmd: string[], env: NodeJS.ProcessEnv, batch: string) => Promise<void>
}

// Runs every planned batch in order and publishes the timings record once
// the first batch has passed: the main batch wrote the fresh snapshot
// (--update-timings), and a later serial batch failing must not lose it.
// A failed batch throws out of runCommand before the publish point, so a
// failed run never publishes and no later batch starts (D4, review B3).
// A null publishTimingsPath never publishes — the gate is planRun's (F5).
export async function runBatchesAndPublish(input: BatchRunInput): Promise<void> {
  let published = false
  for (const batch of input.batches) {
    await input.runCommand(batch.cmd, input.env, batch.label)
    if (input.publishTimingsPath !== null && !published) {
      published = true
      input.publish(input.publishTimingsPath)
    }
  }
}
