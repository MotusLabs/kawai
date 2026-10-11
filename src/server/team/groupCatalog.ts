// A team's group catalog: `.kawai/groups/<id>.md` files in the repository's
// main working tree layered over the user's `~/.kawai/groups/`. A project
// file replaces a user-level file with the same id wholesale (a role prompt
// does not merge). Files are re-read on every call — group prompts apply at
// spawn only, so there is no watch to keep warm. A file with an invalid id or
// frontmatter is reported with its path and skipped; the rest stay available.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseGroupFile, type GroupDefinition } from './groupFile'

/** Group ids name mailboxes and badges; same shape as profile ids. */
export const GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export interface GroupCatalog {
  /** Groups by id, in id order. */
  groups: Map<string, GroupDefinition>
  /** One line per skipped file, naming its path. */
  errors: string[]
}

export interface GroupCatalogContext {
  /** Main working tree of the team's repository (or the plain directory). */
  groupsRoot: string
  /** Effective home; injected in tests. */
  homeDir?: string
}

export function loadGroupCatalog(ctx: GroupCatalogContext): GroupCatalog {
  // HOME first, like the profile catalog: tests isolate by changing HOME.
  const home = ctx.homeDir ?? process.env.HOME ?? os.homedir()
  const userDir = path.join(home, '.kawai', 'groups')
  const projectDir = path.join(ctx.groupsRoot, '.kawai', 'groups')
  const merged = new Map<string, GroupDefinition>()
  const errors: string[] = []
  // User level first so the project layer replaces same-id groups. A project
  // rooted at home would list the same directory twice; read it once.
  const dirs = path.resolve(userDir) === path.resolve(projectDir) ? [userDir] : [userDir, projectDir]
  for (const dir of dirs) {
    for (const [id, group] of readGroupDir(dir, errors)) merged.set(id, group)
  }
  const groups = new Map([...merged].sort(([a], [b]) => a.localeCompare(b)))
  return { groups, errors }
}

function readGroupDir(dir: string, errors: string[]): Map<string, GroupDefinition> {
  const groups = new Map<string, GroupDefinition>()
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
    groups.set(id, parsed.group)
  }
  return groups
}
