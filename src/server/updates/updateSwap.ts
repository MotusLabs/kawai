// updateSwap.ts - extract the verified tarball into staging and swap the
// live install all-or-restore. The two live paths (`bin/agentboard`,
// `dist/client`) cannot be replaced in one atomic operation: `dist/client`
// is a directory and POSIX rename refuses to replace a non-empty directory
// (ENOTEMPTY). Correctness comes from ordering instead — each live path is
// moved aside before its replacement is moved in, and any failure restores
// every already-swapped path from its aside copy, leaving the install exactly
// as it was. Fresh installs (source runs) have no live paths to move aside;
// their placements are recorded too and restored by removal, so a failed
// fresh install leaves no partial binary behind.

import fs from 'node:fs'
import path from 'node:path'
import { UpdateError } from './updateErrors'

/** Live paths (relative to the install root) an update replaces. */
export const LIVE_PATHS = ['bin/agentboard', 'dist/client'] as const

export type TarRunner = (args: string[]) => Promise<{ exitCode: number | null; stderr: string }>

async function runTar(args: string[]): Promise<{ exitCode: number | null; stderr: string }> {
  const proc = Bun.spawn(['tar', ...args], {
    env: process.env,
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr as ReadableStream<Uint8Array> | null).text(),
    proc.exited,
  ])
  return { exitCode, stderr }
}

export interface ExtractTarballOptions {
  tarballPath: string
  /** Directory to extract into; must be outside the live install root. */
  stagingDir: string
  /** Overridable tar invocation for tests. */
  runTarImpl?: TarRunner
}

/** Extract the verified tarball into `stagingDir`; throws UpdateError on failure. */
export async function extractTarball(options: ExtractTarballOptions): Promise<void> {
  const run = options.runTarImpl ?? runTar
  const result = await run(['-xzf', options.tarballPath, '-C', options.stagingDir])
  if (result.exitCode !== 0) {
    throw new UpdateError(
      'ERR_UPDATE_TARBALL_EXTRACT',
      `Extracting ${options.tarballPath} failed (${result.stderr.trim() || `exit ${result.exitCode}`})`,
    )
  }
}

export interface SwapInstallPathsOptions {
  /** Install root holding `bin/agentboard` + `dist/client` (see installRoot). */
  root: string
  /** Extracted release tree with the same layout, outside the live root. */
  stagedRoot: string
}

/**
 * Replace both live paths from the staged release. Every live path is moved
 * aside first; if placing any path fails, all completed placements are
 * restored so the install is unchanged. Throws UpdateError on failure.
 */
export function swapInstallPaths(options: SwapInstallPathsOptions): void {
  const { root, stagedRoot } = options
  // `aside` is null for a fresh placement (nothing was moved aside): its
  // rollback is removal, restoring "no install" rather than an old file.
  const swapped: Array<{ live: string; aside: string | null }> = []

  const restore = (cause: unknown): UpdateError => {
    const problems: string[] = []
    for (const { live, aside } of swapped.reverse()) {
      try {
        fs.rmSync(live, { recursive: true, force: true })
        if (aside !== null) fs.renameSync(aside, live)
      } catch (restoreCause) {
        problems.push(`${live}: ${restoreCause instanceof Error ? restoreCause.message : String(restoreCause)}`)
      }
    }
    const why = cause instanceof Error ? cause.message : String(cause)
    return new UpdateError(
      'ERR_UPDATE_SWAP_FAILED',
      `Swapping the update into ${root} failed (${why}).` +
        (problems.length > 0 ? ` Restoring the previous install also failed: ${problems.join('; ')}` : ' The previous install was restored unchanged.'),
    )
  }

  try {
    for (const relative of LIVE_PATHS) {
      const staged = path.join(stagedRoot, relative)
      const live = path.join(root, relative)
      const aside = `${live}.update-aside`
      // A leftover aside from an interrupted run must not block this one.
      fs.rmSync(aside, { recursive: true, force: true })
      let movedAside = false
      if (fs.existsSync(live)) {
        fs.renameSync(live, aside)
        movedAside = true
      }
      try {
        // Fresh installs (source runs) may not have the parent directories.
        fs.mkdirSync(path.dirname(live), { recursive: true })
        fs.renameSync(staged, live)
      } catch (cause) {
        if (movedAside) fs.renameSync(aside, live)
        throw restore(cause)
      }
      swapped.push({ live, aside: movedAside ? aside : null })
    }
  } catch (cause) {
    if (cause instanceof UpdateError) throw cause
    throw restore(cause)
  }

  // Success: the aside copies are no longer needed.
  for (const { aside } of swapped) {
    if (aside !== null) fs.rmSync(aside, { recursive: true, force: true })
  }
}
