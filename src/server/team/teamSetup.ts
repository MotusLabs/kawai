// Set up team (starter-team-setup D1–D3): seed a team's main checkout with
// the starter role groups kawai ships in `config/groups/` — `lead`, `devs`,
// and `reviewers` — as ordinary, editable `.kawai/groups/<id>.md` files.
// Offered only while the project groups directory holds no `*.md` (D2; the
// user-level groups never count). The write never overwrites, never follows
// a symbolic link, and never leaves a partial group file: each template is
// written to a temp name that does not end in `.md`, synced, then hard-linked
// to its final name — `link` is exclusive and atomic, so a file that appears
// meanwhile is kept and reported skipped. Nothing is staged or committed.
// The human's Team page is the only caller; no agent tool reaches it (I4).
import fs from 'node:fs'
import path from 'node:path'
import leadTemplate from '../../../config/groups/lead.md' with { type: 'text' }
import devsTemplate from '../../../config/groups/devs.md' with { type: 'text' }
import reviewersTemplate from '../../../config/groups/reviewers.md' with { type: 'text' }
import { parseGroupFile } from './groupFile'
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

/** A path component that must be a real directory: created when missing, refused when a link. */
function ensureRealDir(dir: string): 'ok' | 'symlink' | 'not-a-directory' {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    fs.mkdirSync(dir)
    stat = fs.lstatSync(dir)
  }
  if (stat.isSymbolicLink()) return 'symlink'
  return stat.isDirectory() ? 'ok' : 'not-a-directory'
}

/** Write one file's bytes to a fresh exclusive temp path and sync it. */
function writeSynced(file: string, text: string): void {
  const fd = fs.openSync(file, 'wx', 0o644)
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
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
  try {
    for (const dir of [path.join(groupsRoot, '.kawai'), groupsDirOf(groupsRoot)]) {
      const state = ensureRealDir(dir)
      if (state === 'symlink') return fail('symlink', `${dir} is a symbolic link; Set up team writes only into a real directory.`)
      if (state === 'not-a-directory') return fail('error', `${dir} is not a directory.`)
    }
  } catch (error) {
    return fail('error', `Cannot prepare ${groupsDirOf(groupsRoot)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const existing = projectGroupFiles(groupsRoot)
  if (existing.length > 0) {
    return fail('already-set-up', `The team already has group files: ${existing.join(', ')}. Set up team never overwrites them.`)
  }
  const dir = groupsDirOf(groupsRoot)
  for (const { id, text } of STARTER_TEMPLATES) {
    const name = `${id}.md`
    const target = path.join(dir, name)
    const temp = path.join(dir, `.${name}.${hooks.tempSuffix?.() ?? crypto.randomUUID()}.tmp`)
    try {
      writeSynced(temp, text)
      hooks.beforeLink?.(id, target)
      try {
        fs.linkSync(temp, target)
        created.push(name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        skipped.push(name)
      }
    } catch (error) {
      return fail('error', `Writing ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      fs.rmSync(temp, { force: true })
    }
  }
  return { ok: true, created, skipped }
}
