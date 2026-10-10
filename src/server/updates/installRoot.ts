// installRoot.ts - where an update is allowed to write, discovered from how
// this process runs. A compiled binary lives in the documented flat layout
// `<root>/bin/agentboard` + `<root>/dist/client` (the curl-then-tar install);
// anything else is refused with a named error instead of guessed at. Running
// from source never writes the git tree: the release lands as a fresh install
// under `~/.agentboard/app/`, a sibling the updater owns next to the data dir.

import path from 'node:path'
import fs from 'node:fs'
import { UpdateError } from './updateErrors'

export interface InstallRoot {
  /** Directory holding `bin/agentboard` and `dist/client`. */
  root: string
  binPath: string
  clientDir: string
  /**
   * True when this process runs from the layout being updated (a swap of our
   * own files); false when installing a fresh release from source, where the
   * target may not exist yet.
   */
  compiled: boolean
}

export function platformSlug(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64'
    if (arch === 'x64') return 'darwin-x64'
    return null
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64'
    if (arch === 'arm64') return 'linux-arm64'
    return null
  }
  return null
}

export interface DiscoverInstallRootOptions {
  /** Path of the running executable; defaults to `process.execPath`. */
  execPath?: string
  /**
   * Whether this process runs from a compiled binary. Defaults to the
   * bunfs marker, which only exists inside `bun build --compile` output.
   */
  isCompiled?: boolean
  /** Home directory for the source-run install target. */
  homeDir?: string
  exists?: (path: string) => boolean
  mkdir?: (path: string) => void
}

/** See `discoverInstallRoot`; throws UpdateError on a refused layout. */
export function discoverInstallRoot(options: DiscoverInstallRootOptions = {}): InstallRoot {
  const {
    execPath = process.execPath,
    isCompiled = import.meta.url.includes('$bunfs'),
    homeDir = process.env.HOME || process.env.USERPROFILE || '',
    exists = (p: string) => fs.existsSync(p),
    mkdir = (p: string) => fs.mkdirSync(p, { recursive: true }),
  } = options

  if (!isCompiled) {
    // Source run: install fresh under the application directory. The git
    // checkout is never a write target; `~/.agentboard/` stays data-only in
    // this server's mind, with `app/` as the install sibling.
    const root = path.join(homeDir, '.agentboard', 'app')
    mkdir(path.dirname(root))
    return { root, binPath: path.join(root, 'bin', 'agentboard'), clientDir: path.join(root, 'dist', 'client'), compiled: false }
  }

  const binDir = path.dirname(execPath)
  const root = path.dirname(binDir)
  const clientDir = path.join(root, 'dist', 'client')
  const refuse = (why: string): UpdateError =>
    new UpdateError(
      'ERR_UPDATE_UNEXPECTED_LAYOUT',
      `Refusing update: ${why} (execPath ${execPath}, expected <root>/bin/agentboard with dist/client beside it)`,
    )

  if (path.basename(execPath) !== 'agentboard') {
    throw refuse(`compiled binary is "${path.basename(execPath)}", not "agentboard"`)
  }
  if (path.basename(binDir) !== 'bin') {
    throw refuse(`binary sits in "${path.basename(binDir)}", not a "bin" directory`)
  }
  if (!exists(execPath)) {
    throw refuse('binary path does not exist')
  }
  if (!exists(clientDir)) {
    throw refuse(`client bundle not found at ${clientDir}`)
  }
  return { root, binPath: execPath, clientDir, compiled: true }
}
