// Content hashes of what an agent starts with (team-process-metrics D2): the
// group file, the system-prompt addition, the Claude auto-memory directory as
// a per-file manifest plus a directory hash, and the worktree's CLAUDE.md.
// SHA-256 hex throughout. A missing input hashes to null; one that exists but
// cannot be read is reported in `unavailable` and never fails the caller.
//
// The memory directory is the CLI's: `<claudeConfigDir(env)>/projects/<main
// checkout with every non-alphanumeric character replaced by '-'>/memory`
// (observed: /home/coder/kawai -> -home-coder-kawai). Linked worktrees load
// the main checkout's directory, so the caller passes the main checkout.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { claudeConfigDir } from '../chat/chatAuth'

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The CLI's project-directory name for a path. */
export function sanitizeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

export function memoryDirFor(mainCheckout: string, env: Record<string, string | undefined>): string {
  return path.join(claudeConfigDir(env), 'projects', sanitizeProjectPath(mainCheckout), 'memory')
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** A file's hash, null when it does not exist; throws when it exists but cannot be read. */
export function hashFileOrNull(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file))
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export interface MemoryManifest {
  /** Over sorted `relpath \0 sha256 \n` lines. */
  hash: string
  /** relpath (with '/') -> sha256 of its content. */
  files: Record<string, string>
}

/** The memory directory's manifest, null when the directory does not exist. */
export function memoryManifest(dir: string): MemoryManifest | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (!stat.isDirectory()) return null
  const files: Record<string, string> = {}
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files[path.relative(dir, full).split(path.sep).join('/')] = sha256(fs.readFileSync(full))
    }
  }
  walk(dir)
  const sorted = Object.keys(files).sort()
  const ordered: Record<string, string> = {}
  for (const name of sorted) ordered[name] = files[name]!
  return { hash: sha256(sorted.map(name => `${name}\0${files[name]}\n`).join('')), files: ordered }
}

export interface ProvenanceInput {
  /** The session group's file, null for a session without a group. */
  groupFile: string | null
  promptAppend: string
  /** The team's main checkout, whose memory directory every worktree loads. */
  mainCheckout: string
  /** The session's worktree root, where CLAUDE.md is read. */
  worktreeRoot: string
  env: Record<string, string | undefined>
}

export interface Provenance {
  groupFileHash: string | null
  promptAppendHash: string
  memory: MemoryManifest | null
  instructionsHash: string | null
  /** Inputs that exist but could not be read. */
  unavailable: Array<'group_file' | 'memory' | 'instructions'>
}

export function computeProvenance(input: ProvenanceInput): Provenance {
  const unavailable: Provenance['unavailable'] = []
  const attempt = <T>(name: Provenance['unavailable'][number], read: () => T | null): T | null => {
    try {
      return read()
    } catch {
      unavailable.push(name)
      return null
    }
  }
  return {
    groupFileHash: input.groupFile ? attempt('group_file', () => hashFileOrNull(input.groupFile!)) : null,
    promptAppendHash: sha256(input.promptAppend),
    memory: attempt('memory', () => memoryManifest(memoryDirFor(input.mainCheckout, input.env))),
    instructionsHash: attempt('instructions', () => hashFileOrNull(path.join(input.worktreeRoot, 'CLAUDE.md'))),
    unavailable,
  }
}
