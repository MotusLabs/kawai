// Set up team (starter-team-setup D1–D3): seed a team's main checkout with
// the starter role groups kawai ships in `config/groups/` — `lead`, `devs`,
// and `reviewers` — as ordinary, editable `.kawai/groups/<id>.md` files.
// Offered only while the project groups directory holds no `*.md` (D2; the
// user-level groups never count). The write never overwrites, never follows
// a symbolic link, and never leaves a partial group file: each template is
// written to a fresh exclusive temp name that does not end in `.md`, synced,
// then hard-linked to its final name — the link is exclusive and atomic, so
// a file that appears meanwhile is kept and reported skipped. Nothing is
// staged or committed.
//
// The whole run writes through one pinned directory chain (integration
// R4/R5): `groupsRoot`, `.kawai`, and `groups` are opened once with
// O_NOFOLLOW|O_DIRECTORY (created through the pinned parent when missing),
// and every later temp write, link, and temp cleanup is descriptor-relative
// (`pinnedFs.ts`, libc *at() through Bun's built-in FFI). A concurrent
// rename/symlink swap of any path component cannot redirect a write — the
// kernel fd, not a re-checked path, is the boundary — and a final
// dev+ino identity check refuses to report success through a path the run
// no longer occupies. The human's Team page is the only caller; no agent
// tool reaches it (I4).
import fs from 'node:fs'
import path from 'node:path'
import leadTemplate from '../../../config/groups/lead.md' with { type: 'text' }
import devsTemplate from '../../../config/groups/devs.md' with { type: 'text' }
import reviewersTemplate from '../../../config/groups/reviewers.md' with { type: 'text' }
import { parseGroupFile } from './groupFile'
import { createExclusive, EEXIST, ELOOP, ENOENT, ENOTDIR, lastErrno, linkAt, listDir, mkdirAt, openDirAt, openNoFollow, PinnedFsError, unlinkAt } from './pinnedFs'
import type { TeamSetupGroup, TeamSetupPreview, TeamSetupResult } from '../../shared/teamSetup'

/** The starter groups, in the order they are written and previewed. */
export const STARTER_TEMPLATES: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'lead', text: leadTemplate },
  { id: 'devs', text: devsTemplate },
  { id: 'reviewers', text: reviewersTemplate },
]

const groupsDirOf = (groupsRoot: string) => path.join(groupsRoot, '.kawai', 'groups')

/** The project group files present now (`*.md` names, sorted); a missing directory has none. */
export function projectGroupFiles(groupsRoot: string): string[] {
  try {
    return fs.readdirSync(groupsDirOf(groupsRoot)).filter(name => name.endsWith('.md')).sort()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

/** D2: setup is offered exactly while the project groups directory holds no `*.md`. */
export function setupAvailable(groupsRoot: string): boolean {
  return projectGroupFiles(groupsRoot).length === 0
}

/** Each template as the preview shows it, parsed by the same group parser routing uses. */
export function starterGroups(): TeamSetupGroup[] {
  return STARTER_TEMPLATES.map(({ id, text }) => {
    const parsed = parseGroupFile(id, text)
    if (!parsed.ok) throw new Error(`starter template ${id}.md does not parse: ${parsed.error}`)
    const { group } = parsed
    return {
      id, label: group.label ?? id, description: group.description ?? '',
      workers: group.profiles.map(entry => ({ profileId: entry.profileId, ...(entry.cap !== undefined ? { cap: entry.cap } : {}) })),
      max: group.max, crossModelReview: group.crossModelReview === true,
    }
  })
}

/**
 * The preview (D3): the groups, the target directory, and one warning per
 * starter worker the team's resolved catalog does not define.
 */
export function setupPreview(groupsRoot: string, catalogProfiles: ReadonlySet<string>): TeamSetupPreview {
  const groups = starterGroups()
  const missing = [...new Set(groups.flatMap(group => group.workers.map(worker => worker.profileId)))]
    .filter(profileId => !catalogProfiles.has(profileId))
  return {
    available: setupAvailable(groupsRoot), targetDir: groupsDirOf(groupsRoot), groups,
    warnings: missing.map(profileId => `Profile ${profileId} is not defined in this team's catalog; its slots will not staff until it is.`),
  }
}

/** Test seams: the temp-name suffix, and a hook that runs before each link. */
export interface SetupHooks {
  tempSuffix?: () => string
  beforeLink?: (id: string, target: string) => void
}

/** An opened, kernel-pinned directory: the fd is the write boundary. */
interface PinnedDir { fd: number; dev: number; ino: number }

type PinOutcome = { ok: true; dir: PinnedDir } | { ok: false; kind: 'symlink' | 'not-a-directory' | 'error'; errno?: number }

const ERRNO_NAMES: Record<number, string> = { 2: 'ENOENT', 13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 32: 'ELOOP', 39: 'ENOTEMPTY', 40: 'ELOOP' }
const errnoName = (errno: number) => ERRNO_NAMES[errno] ?? `errno ${errno}`

/**
 * Open `name` under the pinned `parent` (or under the process root for a
 * top-level path) as the next link of the chain: directory only, never
 * through a symlink, created through the pinned parent when missing. A
 * symlink is refused with kind `symlink`; a non-directory with
 * `not-a-directory` (kernels disagree on which errno says which, so
 * ENOTDIR is probed once more without O_DIRECTORY).
 */
function openPinned(parent: PinnedDir | null, name: string): PinOutcome {
  const at = parent ? parent.fd : -100 // AT_FDCWD
  try {
    const fd = openDirAt(at, name)
    const stat = fs.fstatSync(fd)
    return { ok: true, dir: { fd, dev: stat.dev, ino: stat.ino } }
  } catch (error) {
    const errno = error instanceof PinnedFsError ? error.errno : undefined
    if (errno === undefined) return { ok: false, kind: 'error' }
    if (errno === ELOOP) return { ok: false, kind: 'symlink', errno }
    if (errno === ENOTDIR) {
      const probe = openNoFollow(at, name)
      if (probe === -1) {
        if (lastErrno() === ELOOP) return { ok: false, kind: 'symlink', errno }
        return { ok: false, kind: 'not-a-directory', errno }
      }
      fs.closeSync(probe)
      return { ok: false, kind: 'not-a-directory', errno }
    }
    return { ok: false, kind: 'error', errno }
  }
}

function createPinned(parent: PinnedDir, name: string): PinOutcome {
  try {
    mkdirAt(parent.fd, name)
    return openPinned(parent, name)
  } catch (error) {
    const errno = error instanceof PinnedFsError ? error.errno : undefined
    if (errno === EEXIST) return openPinned(parent, name) // created meanwhile; judge it as it is now
    return { ok: false, kind: 'error', errno }
  }
}

/**
 * Run the setup (D3). Every outcome — refusal, error, or success — has the
 * same envelope: `ok`, the files created and skipped, and on failure a
 * `reason` and an `error` naming what blocked it.
 */
export function runTeamSetup(groupsRoot: string, hooks: SetupHooks = {}): TeamSetupResult {
  const created: string[] = []
  const skipped: string[] = []
  const fail = (reason: Exclude<TeamSetupResult['reason'], undefined>, error: string): TeamSetupResult =>
    ({ ok: false, reason, error, created, skipped })
  let root: PinnedDir | null = null
  let kawai: PinnedDir | null = null
  let groups: PinnedDir | null = null
  let resolved = groupsRoot
  let kawaiPath = path.join(groupsRoot, '.kawai')
  let groupsPath = groupsDirOf(groupsRoot)
  try {
    try {
      resolved = fs.realpathSync(groupsRoot)
      kawaiPath = path.join(resolved, '.kawai')
      groupsPath = groupsDirOf(resolved)
    } catch (error) {
      return fail('error', `Cannot prepare ${groupsDirOf(groupsRoot)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const opened = openPinned(null, resolved)
    if (!opened.ok) {
      if (opened.kind === 'symlink') return fail('symlink', `${resolved} is a symbolic link; Set up team writes only into a real directory.`)
      if (opened.kind === 'not-a-directory') return fail('error', `${resolved} is not a directory.`)
      return fail('error', `Cannot prepare ${groupsPath}: ${opened.errno === undefined ? 'pinned-directory backend unavailable' : errnoName(opened.errno)}`)
    }
    const rootDir = opened.dir
    root = rootDir
    const pin = (parentDir: PinnedDir, name: string, livePath: string): { ok: true; dir: PinnedDir } | { ok: false; result: TeamSetupResult } => {
      let outcome = openPinned(parentDir, name)
      if (!outcome.ok && outcome.kind === 'error' && outcome.errno === ENOENT) outcome = createPinned(parentDir, name)
      if (outcome.ok) return { ok: true, dir: outcome.dir }
      if (outcome.kind === 'symlink') return { ok: false, result: fail('symlink', `${livePath} is a symbolic link; Set up team writes only into a real directory.`) }
      if (outcome.kind === 'not-a-directory') return { ok: false, result: fail('error', `${livePath} is not a directory.`) }
      return { ok: false, result: fail('error', `Cannot prepare ${groupsPath}: ${outcome.errno === undefined ? 'pinned-directory backend unavailable' : errnoName(outcome.errno)}`) }
    }
    const kawaiPin = pin(rootDir, '.kawai', kawaiPath)
    if (!kawaiPin.ok) return kawaiPin.result
    const kawaiDir: PinnedDir = kawaiPin.dir
    kawai = kawaiDir
    const groupsPin = pin(kawaiDir, 'groups', groupsPath)
    if (!groupsPin.ok) return groupsPin.result
    const groupsDir: PinnedDir = groupsPin.dir
    groups = groupsDir

    // D2, read through the pin: the directory this run writes into holds no group file.
    let existing: string[]
    try {
      existing = listDir(groupsDir.fd).filter(name => name.endsWith('.md')).sort()
    } catch (error) {
      return fail('error', `Cannot read ${groupsPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (existing.length > 0) {
      return fail('already-set-up', `The team already has group files: ${existing.join(', ')}. Set up team never overwrites them.`)
    }
    for (const { id, text } of STARTER_TEMPLATES) {
      const error = writeOne(groupsDir, id, text)
      if (error !== null) return fail('error', error)
    }
    // The report gate (not the write boundary): success may only be claimed
    // while every pinned level is still the live path it was opened as.
    const chain: Array<[PinnedDir, string]> = [[rootDir, resolved], [kawaiDir, kawaiPath], [groupsDir, groupsPath]]
    for (const [dir, livePath] of chain) {
      let live: fs.Stats | null = null
      try {
        live = fs.lstatSync(livePath)
      } catch { /* renamed away entirely */ }
      if (live === null || live.dev !== dir.dev || live.ino !== dir.ino) {
        return fail('error', `The verified directory moved while Set up team ran (${livePath}); nothing was written through the current path.`)
      }
    }
    return { ok: true, created, skipped }
  } finally {
    for (const dir of [root, kawai, groups]) if (dir) { try { fs.closeSync(dir.fd) } catch { /* already closed */ } }
  }

  /** One template through the pinned groups directory; a failure message or null. */
  function writeOne(dir: PinnedDir, id: string, text: string): string | null {
    const name = `${id}.md`
    const temp = `.${name}.${hooks.tempSuffix?.() ?? crypto.randomUUID()}.tmp`
    let tempFd: number | null = null
    let writeError: string | null = null
    try {
      tempFd = createExclusive(dir.fd, temp)
      fs.writeSync(tempFd, text)
      fs.fsyncSync(tempFd)
      hooks.beforeLink?.(id, path.join(groupsPath, name))
      try {
        linkAt(dir.fd, temp, name)
        created.push(name)
      } catch (error) {
        if (!(error instanceof PinnedFsError) || error.errno !== EEXIST) throw error
        skipped.push(name)
      }
    } catch (error) {
      writeError = `Writing ${name} failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      if (tempFd !== null) { try { fs.closeSync(tempFd) } catch { /* already closed */ } }
    }
    // Owned-temp cleanup, on every path; only ENOENT is swallowed.
    try {
      unlinkAt(dir.fd, temp)
    } catch (error) {
      if (!(error instanceof PinnedFsError) || error.errno !== ENOENT) {
        return `Cleaning up after ${name} failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return writeError
  }
}
