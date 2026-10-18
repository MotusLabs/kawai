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

/** One layer's file for a group id (team-workspace D7). */
export interface GroupSourceFile {
  file: string
  /** Which layer read this file: the user's home or the project tree. */
  layer: 'user' | 'project'
  /** Whether this layer's definition is the one in effect (project wins). */
  inEffect: boolean
}

/**
 * One group as the catalog holds it (team-workspace D7): the definition in
 * effect plus every layer's file for the id, so Members can name the source
 * file and, when both layers define the id, both paths with the winner
 * marked. One file defines a whole group, so this is the whole provenance.
 */
export interface GroupCatalogEntry {
  group: GroupDefinition
  /** The file whose definition is in effect. */
  file: string
  /** Each layer's file for the id, user first; exactly one is in effect. */
  sources: GroupSourceFile[]
}

export interface GroupCatalog {
  /** Groups by id, in id order. */
  groups: Map<string, GroupCatalogEntry>
  /** One line per skipped file, naming its path. */
  errors: string[]
  /** Problems in loaded files that fell back to defaults, naming the path. */
  warnings: string[]
  /** The resolved profile catalog's providers, for worker grouping (D13). */
  providers: Map<string, { label: string; models: string[] }>
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
  // User level first so the project layer replaces same-id groups wholesale;
  // every layer's file is kept beside the winner (D7).
  const merged = new Map<string, { files: Array<{ file: string; layer: 'user' | 'project' }>; group: GroupDefinition }>()
  const errors: string[] = []
  groupCatalogDirs(ctx).forEach((dir, index) => {
    const layer = index === 0 ? 'user' : 'project'
    for (const [id, entry] of readGroupDir(dir, errors)) {
      const existing = merged.get(id)
      if (existing) {
        existing.files.push({ file: entry.file, layer })
        existing.group = entry.group
      } else {
        merged.set(id, { files: [{ file: entry.file, layer }], group: entry.group })
      }
    }
  })
  const resolved = resolveProfileCatalog(profileContext(ctx))
  const known = new Set(resolved.profiles.keys())
  // `<provider>/<model>` resolves to the bare model key when that provider
  // holds it (D5); anything else is reported and ignored like an unknown id.
  const qualified = new Map<string, string>()
  for (const [providerId, provider] of resolved.providers) {
    for (const model of provider.models) qualified.set(`${providerId}/${model}`, model)
  }
  const warnings: string[] = []
  const groups = new Map<string, GroupCatalogEntry>()
  for (const [id, { files, group }] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    // The last file is the winning layer's (the project layer, when both define the id).
    const file = files.at(-1)!.file
    const groupWarnings = [...group.warnings]
    let changed = false
    const resolvedProfiles: typeof group.profiles = []
    const seenProfiles = new Set<string>()
    for (const listed of group.profiles) {
      let entry = listed
      const written = entry.profileId
      const bare = qualified.get(entry.profileId)
      if (bare !== undefined) {
        entry = { ...entry, profileId: bare }
        changed = true
      }
      if (entry.profileId.includes('/')) {
        groupWarnings.push(`profile "${written}" is not defined; ignored`)
        changed = true
        continue
      }
      if (seenProfiles.has(entry.profileId)) {
        groupWarnings.push(`profile "${written}" is already listed; the later entry is ignored`)
        continue
      }
      seenProfiles.add(entry.profileId)
      resolvedProfiles.push(entry)
    }
    let profileEffort: typeof group.profileEffort
    if (group.profileEffort) {
      profileEffort = {}
      for (const [written, level] of Object.entries(group.profileEffort)) {
        const bare = qualified.get(written)
        if (bare === undefined && written.includes('/')) {
          groupWarnings.push(`modelEffort: "${written}" is not defined; ignored`)
          changed = true
          continue
        }
        const key = bare ?? written
        // First occurrence wins in file order, whatever spelling named it.
        if (profileEffort[key] !== undefined) {
          groupWarnings.push(`modelEffort: "${written}" is already listed; the later entry is ignored`)
          changed = true
          continue
        }
        profileEffort[key] = level
        if (bare !== undefined) changed = true
      }
    }
    const unknown = resolvedProfiles.filter(entry => !known.has(entry.profileId))
    if (unknown.length > 0) changed = true
    // A cap-derived default max re-sums the resolved caps; an explicit max
    // stays even when it happens to equal the sum (finding N2).
    const max = changed && group.maxFromCaps
      ? Math.max(1, resolvedProfiles.reduce((sum, entry) => sum + (entry.cap ?? 0), 0))
      : group.max
    const checked: GroupDefinition = changed || unknown.length > 0
      ? {
        ...group,
        profiles: resolvedProfiles.filter(entry => known.has(entry.profileId)),
        max,
        ...(profileEffort !== undefined ? { profileEffort } : {}),
        warnings: [...groupWarnings, ...unknown.map(entry => `profile "${entry.profileId}" is not defined; ignored`)],
      }
      : group
    for (const warning of checked.warnings) warnings.push(`${file}: ${warning}`)
    groups.set(id, {
      group: checked, file,
      sources: files.map((source, position) => ({ ...source, inEffect: position === files.length - 1 })),
    })
  }
  return { groups, errors, warnings, providers: resolved.providers }
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
