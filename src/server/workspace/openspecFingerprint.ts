// openspecFingerprint.ts - Stat fingerprint of the inputs `openspec list
// --json` reads for one worktree (bounded-openspec-discovery D1), so an
// unchanged worktree can reuse its last result without starting the CLI.
//
// It reads metadata only, never file contents, and never writes:
//   1. the root: the nearest ancestor holding an `openspec` directory (the
//      CLI's nearest-root rule), or `none`;
//   2. each entry of `<root>/openspec/` (name, type, size, mtime), which
//      covers `config.yaml`, pointer files, and `changes/` itself;
//   3. each entry of `<root>/openspec/changes/` (name, type), and every entry
//      under each active change directory (every directory except
//      `archive`), by relative path, type, size, and mtime. A symbolic link
//      is recorded by its target's stat and never descended into.
// The sorted records are hashed with SHA-256. A read error, or more than
// OPENSPEC_FINGERPRINT_MAX_RECORDS records, returns null, which never
// matches a stored fingerprint, so the caller runs the CLI.

import { createHash } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export const OPENSPEC_FINGERPRINT_MAX_RECORDS = 5_000

export type OpenSpecFingerprintFn = (worktreePath: string) => Promise<string | null>

class TooManyRecords extends Error {}

/** The nearest ancestor (inclusive) holding an `openspec` directory. */
async function findNearestRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start)
  for (;;) {
    try {
      const stats = await fs.stat(path.join(dir, 'openspec'))
      if (stats.isDirectory()) return dir
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function typeOf(entry: Dirent | Stats): string {
  if (entry.isSymbolicLink()) return 'l'
  if (entry.isDirectory()) return 'd'
  if (entry.isFile()) return 'f'
  return 'o'
}

/** Stat used for size/mtime: a link's target, or the link itself if dangling. */
async function statForRecord(fullPath: string): Promise<Stats> {
  try {
    return await fs.stat(fullPath)
  } catch (error) {
    if (!isMissing(error)) throw error
    return fs.lstat(fullPath)
  }
}

export async function fingerprintOpenSpecInputs(worktreePath: string): Promise<string | null> {
  const records: string[] = []
  const push = (record: string): void => {
    records.push(record)
    if (records.length > OPENSPEC_FINGERPRINT_MAX_RECORDS) throw new TooManyRecords()
  }

  // A subtree walk; `relative` is the record path below `changes/`.
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      const childRelative = `${relative}/${entry.name}`
      const stats = await statForRecord(fullPath)
      push(`f\t${childRelative}\t${typeOf(entry)}\t${stats.size}\t${stats.mtimeMs}`)
      if (entry.isDirectory()) await walk(fullPath, childRelative)
    }
  }

  try {
    const root = await findNearestRoot(worktreePath)
    if (root === null) {
      push('root\tnone')
    } else {
      push(`root\t${root}`)
      const openspecDir = path.join(root, 'openspec')
      for (const entry of await fs.readdir(openspecDir, { withFileTypes: true })) {
        const stats = await statForRecord(path.join(openspecDir, entry.name))
        push(`r\t${entry.name}\t${typeOf(entry)}\t${stats.size}\t${stats.mtimeMs}`)
      }
      const changesDir = path.join(openspecDir, 'changes')
      let changeEntries: Dirent[] = []
      try {
        changeEntries = await fs.readdir(changesDir, { withFileTypes: true })
      } catch (error) {
        if (!isMissing(error)) throw error
        push('changes\tmissing')
      }
      for (const entry of changeEntries) {
        push(`c\t${entry.name}\t${typeOf(entry)}`)
        if (entry.isDirectory() && entry.name !== 'archive') {
          await walk(path.join(changesDir, entry.name), entry.name)
        }
      }
    }
  } catch {
    // TooManyRecords or an unreadable path: no fingerprint, so the CLI runs.
    return null
  }

  records.sort()
  return createHash('sha256').update(records.join('\n')).digest('hex')
}
