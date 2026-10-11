// Team scope (agent-teams design D6): every chat session whose project
// directory belongs to one git repository — main checkout or any linked
// worktree — is one team, identified by the canonical common git directory.
// Group files resolve from the main working tree (the common dir's parent),
// so every worktree reads the same roles. A directory outside any repository
// is a team of its own, keyed by its realpath. Repository answers are cached
// per directory; a non-repository answer is not, since `git init` may follow.
import path from 'node:path'
import { canonicalizePath, resolveGitDirs } from '../git/repositoryResolution'

export interface TeamIdentity {
  /** Stable team key: canonical common git dir, or the plain directory. */
  teamId: string
  /** Where `.kawai/groups/` is read: the main working tree. */
  groupsRoot: string
}

const cache = new Map<string, TeamIdentity>()

export async function resolveTeam(projectPath: string): Promise<TeamIdentity> {
  const directory = canonicalizePath(projectPath)
  const cached = cache.get(directory)
  if (cached) return cached
  const dirs = await resolveGitDirs(directory)
  if (!dirs) return { teamId: directory, groupsRoot: directory }
  // A non-bare repository keeps its common dir at `<main tree>/.git`; a bare
  // one has no main tree, so the worktree itself carries the group files.
  const groupsRoot = path.basename(dirs.commonDir) === '.git'
    ? path.dirname(dirs.commonDir)
    : dirs.toplevel
  const identity = { teamId: dirs.commonDir, groupsRoot }
  cache.set(directory, identity)
  return identity
}

/** Forget cached answers (tests; a repository moved on disk). */
export function clearTeamCache(): void {
  cache.clear()
}
