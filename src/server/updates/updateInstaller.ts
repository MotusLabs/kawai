// updateInstaller.ts - the one update verb: discover the install root,
// download and verify the platform tarball, extract into staging outside the
// live root, and swap all-or-restore. Source runs never touch the git tree —
// the release lands as a fresh install under ~/.agentboard/app. The restart
// verb is injected by the caller (see the supervisor restart in Group 5).

import fs from 'node:fs'
import path from 'node:path'
import { discoverInstallRoot, platformSlug, type DiscoverInstallRootOptions, type InstallRoot } from './installRoot'
import { downloadAndVerify } from './updateDownload'
import { UpdateError } from './updateErrors'
import { extractTarball, swapInstallPaths } from './updateSwap'
import type { LatestRelease } from './releaseFeed'

export interface InstallUpdateOptions {
  release: LatestRelease
  /** Platform slug override for tests; defaults to the running platform. */
  platform?: string
  discover?: (options?: DiscoverInstallRootOptions) => InstallRoot
  fetchImpl?: typeof fetch
  /**
   * Invoked after a successful swap, while the staged files are in place.
   * The caller restarts the deployment (systemd/launchd verb or re-exec).
   */
  restart?: () => void | Promise<void>
}

export interface InstallUpdateResult {
  /** The install root that now holds the new release. */
  root: string
  /** True when the running process's own files were swapped. */
  compiled: boolean
}

export async function installUpdate(options: InstallUpdateOptions): Promise<InstallUpdateResult> {
  const platform = options.platform ?? platformSlug()
  if (platform === null) {
    throw new UpdateError(
      'ERR_UPDATE_UNSUPPORTED_PLATFORM',
      `No release tarball exists for ${process.platform}-${process.arch}`,
    )
  }

  const discover = options.discover ?? discoverInstallRoot
  const install = discover()

  // Staging lives beside the install root: outside it (the design forbids
  // writes into the live root before verification) yet on the same
  // filesystem, so the swap's renames can never fail cross-device.
  const stagingParent = path.dirname(install.root)
  fs.mkdirSync(stagingParent, { recursive: true })
  const stagingDir = fs.mkdtempSync(path.join(stagingParent, '.agentboard-update-'))

  try {
    const verified = await downloadAndVerify({
      release: options.release,
      platform,
      stagingDir,
      fetchImpl: options.fetchImpl,
    })
    await extractTarball({ tarballPath: verified.tarballPath, stagingDir })
    swapInstallPaths({ root: install.root, stagedRoot: stagingDir })
    await options.restart?.()
    return { root: install.root, compiled: install.compiled }
  } finally {
    // Everything worth keeping has been renamed into the install root; the
    // leftovers here (tarball, emptied dirs) are garbage on both paths.
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }
}
