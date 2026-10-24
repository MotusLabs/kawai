// workerCount.ts - The runner's worker-count decision (2.3, design D2),
// extracted from test-runner.ts (file-size cap, K7): the measured default,
// the cgroup quota cap, and the KAWAI_TEST_WORKERS override.
import fs from 'node:fs'
import os from 'node:os'

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
