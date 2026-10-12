// A team's group catalog: `.kawai/groups/<id>.md` files in the repository's
// main working tree layered over the user's `~/.kawai/groups/`. A project
// file replaces a user-level file with the same id wholesale (a role prompt
// does not merge). A file with an invalid id or frontmatter is reported with
// its path and skipped; the rest stay available. Profile ids a group lists
// that the project's profile catalog does not define are dropped with a
// warning (profile routing), as are the file's own fallback warnings.
// There is no watch to keep
// the catalog warm; callers that read it often validate a change stamp
// (listings with mtimes) instead and skip the re-read when nothing moved.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { profileCatalogLevels, resolveProfileCatalog } from '../chat/profileCatalog'
import { parseGroupFile, type GroupDefinition } from './groupFile'

/** Group ids name mailboxes and badges; same shape as profile ids. */
export const GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export interface GroupCatalog {
  /** Groups by id, in id order. */
  groups: Map<string, GroupDefinition>
  /** One line per skipped file, naming its path. */
  errors: string[]
  /** Problems in loaded files that fell back to defaults, naming the path. */
  warnings: string[]
}

export interface GroupCatalogContext {
  /** Main working tree of the team's repository (or the plain directory). */
  groupsRoot: string
  /** Effective home; injected in tests. */
  homeDir?: string
}

/** The two directories a catalog reads, user level first (see loadGroupCatalog). */
export function groupCatalogDirs(ctx: GroupCatalogContext): string[] {
  // HOME first, like the profile catalog: tests isolate by changing HOME.
  const home = ctx.homeDir ?? process.env.HOME ?? os.homedir()
  const userDir = path.join(home, '.kawai', 'groups')
  const projectDir = path.join(ctx.groupsRoot, '.kawai', 'groups')
  // A project rooted at home would list the same directory twice; read once.
  return path.resolve(userDir) === path.resolve(projectDir) ? [userDir] : [userDir, projectDir]
}

export function loadGroupCatalog(ctx: GroupCatalogContext): GroupCatalog {
  const merged = new Map<string, { file: string; group: GroupDefinition }>()
  const errors: string[] = []
  // User level first so the project layer replaces same-id groups.
  for (const dir of groupCatalogDirs(ctx)) {
    for (const [id, entry] of readGroupDir(dir, errors)) merged.set(id, entry)
  }
  const known = new Set(resolveProfileCatalog(profileContext(ctx)).profiles.keys())
  const warnings: string[] = []
  const groups = new Map<string, GroupDefinition>()
  for (const [id, { file, group }] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    const unknown = group.profiles.filter(entry => !known.has(entry.profileId))
    const checked = unknown.length === 0 ? group : {
      ...group,
      profiles: group.profiles.filter(entry => known.has(entry.profileId)),
      warnings: [...group.warnings, ...unknown.map(entry => `profile "${entry.profileId}" is not defined; ignored`)],
    }
    for (const warning of checked.warnings) warnings.push(`${file}: ${warning}`)
    groups.set(id, checked)
  }
  return { groups, errors, warnings }
}

const profileContext = (ctx: GroupCatalogContext) =>
  ({ projectPath: ctx.groupsRoot, ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}) })

/**
 * A cheap change signature of the catalog's files: each directory's listing
 * with every group file's mtime and size. Equal stamps mean a re-read would
 * produce the same files, so hot paths can reuse the parsed catalog without
 * re-reading and re-parsing on every call. The profile catalog files are
 * part of the stamp because they decide which listed profiles are known.
 */
export function groupCatalogStamp(ctx: GroupCatalogContext): string {
  const profiles = profileCatalogLevels(profileContext(ctx)).map(({ file }) => {
    try {
      const stat = fs.statSync(file)
      return `${file}:${stat.mtimeMs}:${stat.size}`
    } catch {
      return `${file}:missing`
    }
  })
  return [...groupCatalogDirs(ctx).map(dir => {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return `${dir}|missing`
    }
    const files = names.filter(name => name.endsWith('.md')).sort().map(name => {
      try {
        const stat = fs.statSync(path.join(dir, name))
        return `${name}:${stat.mtimeMs}:${stat.size}`
      } catch {
        return `${name}:gone`
      }
    })
    return `${dir}|${files.join(',')}`
  }), ...profiles].join(';')
}

function readGroupDir(dir: string, errors: string[]): Map<string, { file: string; group: GroupDefinition }> {
  const groups = new Map<string, { file: string; group: GroupDefinition }>()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    // No groups directory is the normal case, not a problem to report.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`${dir}: ${(error as Error).message}`)
    }
    return groups
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    const file = path.join(dir, name)
    const id = name.slice(0, -'.md'.length)
    if (!GROUP_ID_PATTERN.test(id)) {
      errors.push(`${file}: group id "${id}" must use lowercase letters, digits, and hyphens`)
      continue
    }
    let content: string
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch (error) {
      errors.push(`${file}: ${(error as Error).message}`)
      continue
    }
    const parsed = parseGroupFile(id, content)
    if (!parsed.ok) {
      errors.push(`${file}: ${parsed.error}`)
      continue
    }
    groups.set(id, { file, group: parsed.group })
  }
  return groups
}
