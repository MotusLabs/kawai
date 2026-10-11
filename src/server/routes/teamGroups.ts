// Team groups for the new-session picker (agent-teams): the groups of the
// request's project team — `.kawai/groups/` in the repository's main working
// tree layered over the user's home — with file failures riding along as
// `errors`. Role prompts stay server-side; the picker needs labels only.
import { Hono } from 'hono'
import { resolveProjectDirectory } from '../paths'
import { loadTeamGroups } from '../team/teamGroups'

export interface TeamGroupSummary {
  id: string
  label: string
  description: string
}

export function createTeamGroupRoutes(options: { homeDir?: string } = {}) {
  const routes = new Hono()
  routes.get('/', async c => {
    const project = resolveProjectDirectory(c.req.query('projectPath') ?? '')
    // No (or no existing) project yet: the dialog is still being filled in.
    if (!project.ok) return c.json({ groups: [], errors: [] })
    const { catalog } = await loadTeamGroups(project.path, options.homeDir)
    const groups: TeamGroupSummary[] = [...catalog.groups.values()].map(group => ({
      id: group.id, label: group.label, description: group.description,
    }))
    return c.json({ groups, errors: catalog.errors })
  })
  return routes
}
