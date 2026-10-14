// Team groups for the new-session picker (agent-teams): the groups of the
// request's project team — `.kawai/groups/` in the repository's main working
// tree layered over the user's home — with file failures riding along as
// `errors` and fallback warnings (unknown profiles, bad onLimit or effort) as
// `warnings`. Role prompts stay server-side; the picker needs labels only,
// plus each group's allowed profiles with their caps and live member counts
// so the dialog can warn before exceeding a cap (profile routing).
import { Hono } from 'hono'
import { resolveProjectDirectory } from '../paths'
import { loadTeamGroups } from '../team/teamGroups'

export interface TeamGroupSummary {
  id: string
  label: string
  description: string
  /** Allowed profiles in preference order; empty = the default profile. */
  profiles: Array<{ profileId: string; cap?: number; live: number }>
}

export function createTeamGroupRoutes(options: {
  homeDir?: string
  /** Live members of a team's group per profile. */
  groupProfileCounts?: (teamId: string, groupId: string) => Record<string, number>
} = {}) {
  const routes = new Hono()
  routes.get('/', async c => {
    const project = resolveProjectDirectory(c.req.query('projectPath') ?? '')
    // No (or no existing) project yet: the dialog is still being filled in.
    if (!project.ok) return c.json({ groups: [], errors: [], warnings: [] })
    const { team, catalog } = await loadTeamGroups(project.path, options.homeDir)
    const groups: TeamGroupSummary[] = [...catalog.groups.values()].map(({ group }) => {
      const live = options.groupProfileCounts?.(team.teamId, group.id) ?? {}
      return {
        id: group.id, label: group.label, description: group.description,
        profiles: group.profiles.map(entry => ({
          profileId: entry.profileId, live: live[entry.profileId] ?? 0, ...(entry.cap !== undefined ? { cap: entry.cap } : {}),
        })),
      }
    })
    return c.json({ groups, errors: catalog.errors, warnings: catalog.warnings })
  })
  return routes
}
