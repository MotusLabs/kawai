// Where a known team's group files live, without a surviving session
// (process-quota-history-and-incident-advice A1; Sol checkpoint item 3). A
// non-bare repository's team id is `<main tree>/.git`, so its groups root is
// the main tree. A bare repository has no main tree: every registered
// worktree carries its own group files, so the roots are the worktrees git
// registers under `<common dir>/worktrees/*/gitdir` (read from the files —
// the minute sweep spawns no git). A plain directory is its own root. A bare
// common directory is never read as a groups root.
import fs from 'node:fs'
import path from 'node:path'

function isGitDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'HEAD')).isFile() && fs.statSync(path.join(dir, 'objects')).isDirectory()
  } catch {
    return false
  }
}

/** The worktree roots a bare common directory registers, existing ones only. */
function registeredWorktrees(commonDir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(path.join(commonDir, 'worktrees'))
  } catch {
    return []
  }
  const roots: string[] = []
  for (const name of names.sort()) {
    try {
      const gitFile = fs.readFileSync(path.join(commonDir, 'worktrees', name, 'gitdir'), 'utf8').trim()
      const root = path.dirname(gitFile)
      if (fs.statSync(root).isDirectory()) roots.push(root)
    } catch {
      // A pruned or unreadable registration contributes nothing.
    }
  }
  return roots
}

/** Every groups root of a known team id; empty when none can be found. */
export function teamGroupsRoots(teamId: string): string[] {
  if (path.basename(teamId) === '.git') return fs.existsSync(path.dirname(teamId)) ? [path.dirname(teamId)] : []
  if (isGitDir(teamId)) return registeredWorktrees(teamId)
  try {
    return fs.statSync(teamId).isDirectory() ? [teamId] : []
  } catch {
    return []
  }
}
