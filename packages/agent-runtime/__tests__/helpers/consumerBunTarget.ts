// The packed-consumer tests install packages and run examples with one
// selected Bun executable: the check runner itself by default, or the
// CONSUMER_BUN override the release workflow's minimum-consumer job
// installs. Instead of a hardcoded version whitelist, the selected
// executable is verified against a separately known expectation: the
// runner's own version by default, or the CONSUMER_BUN_VERSION the caller
// declares for an override. The expectation is compared literally with the
// executable's own `--version` output; no versions are parsed.
import { PACKAGE_DIR, run, type RunResult } from './packArtifact.js'

/** A selected consumer Bun executable and the version it must report. */
export interface ConsumerBunTarget {
  executable: string
  expected: string
}

/**
 * Resolves the consumer Bun target from `env`: without CONSUMER_BUN the
 * target is the running check executable and its own version; with an
 * override the expected version must be declared in CONSUMER_BUN_VERSION,
 * so an override can never run unverified.
 */
export function resolveConsumerBun(env: Record<string, string | undefined> = process.env): ConsumerBunTarget {
  const override = env.CONSUMER_BUN
  if (!override) return { executable: process.execPath, expected: process.versions.bun }
  const declared = env.CONSUMER_BUN_VERSION
  if (!declared) throw new Error('CONSUMER_BUN is set without CONSUMER_BUN_VERSION: declare the version the consumer executable must report')
  return { executable: override, expected: declared }
}

/**
 * Runs the target's `bun --version` and requires the reported version to
 * equal the expectation, so a wrong, undeclared or silent target fails
 * before any consumer assertion can pass. Returns the reported version.
 */
export function verifyConsumerBun(target: ConsumerBunTarget): string {
  let result: RunResult
  try {
    result = run([target.executable, '--version'], PACKAGE_DIR)
  } catch (error) {
    // Bun.spawnSync throws (ENOENT, EACCES) instead of returning a nonzero
    // exit: an executable that cannot run at all is the same mismatch.
    throw new Error(`consumer Bun target mismatch: ${target.executable} could not be run (${(error as Error).message.split('\n')[0]}), expected ${JSON.stringify(target.expected)}`)
  }
  const reported = result.out.trim()
  if (result.code !== 0 || reported !== target.expected) {
    throw new Error(`consumer Bun target mismatch: ${target.executable} exited ${result.code} reporting ${JSON.stringify(reported)}, expected ${JSON.stringify(target.expected)}`)
  }
  return reported
}
