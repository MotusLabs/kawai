// The groups available to a project path: resolve its team (git repository
// or plain directory), then load that team's layered group catalog. Shared
// by session creation (group validation), the groups route, and spawn-time
// prompt assembly, so all three read the same files the same way.
import { loadGroupCatalog, type GroupCatalog } from './groupCatalog'
import { resolveTeam, type TeamIdentity } from './teamIdentity'

export interface TeamGroups {
  team: TeamIdentity
  catalog: GroupCatalog
}

export async function loadTeamGroups(projectPath: string, homeDir?: string): Promise<TeamGroups> {
  const team = await resolveTeam(projectPath)
  return {
    team,
    catalog: loadGroupCatalog({ groupsRoot: team.groupsRoot, ...(homeDir ? { homeDir } : {}) }),
  }
}
