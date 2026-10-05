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
