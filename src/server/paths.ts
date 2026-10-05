import fs from 'node:fs'
import path from 'node:path'

const homeDir = process.env.HOME || process.env.USERPROFILE || ''

export function resolveProjectPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  if (
    homeDir &&
    (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
  ) {
    const remainder = trimmed === '~' ? '' : trimmed.slice(2)
    return path.resolve(path.join(homeDir, remainder))
  }

  return path.resolve(trimmed)
}

/**
 * True when `value` names an existing directory. A path that is missing, is a
 * file, or cannot be stat'ed is not one — including tmux's `<dir> (deleted)`
 * report for a removed working directory.
 */
export function isExistingDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve a chat project path as terminal sessions do (`~`, absolute) and
 * require an existing directory: the agent process is spawned with it as
 * `cwd`, and a missing `cwd` surfaces from the Claude Agent SDK as a
 * misleading binary-launch error.
 */
export function resolveProjectDirectory(
  value: string,
  isDirectory: (path: string) => boolean = isExistingDirectory
): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = resolveProjectPath(value)
  if (!resolved) {
    return { ok: false, error: 'A project directory is required' }
  }
  if (!isDirectory(resolved)) {
    return { ok: false, error: `Project directory does not exist: ${resolved}` }
  }
  return { ok: true, path: resolved }
}
