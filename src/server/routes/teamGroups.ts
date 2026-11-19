// Team groups for the new-session picker (agent-teams): the groups of the
// request's project team — `.kawai/groups/` in the repository's main working
// tree layered over the user's home — with file failures riding along as
// `errors` and fallback warnings (unknown profiles, bad onLimit or effort) as
// `warnings`. Role prompts stay server-side; the picker needs labels only,
// plus each group's allowed profiles with their caps and live member counts
// so the dialog can warn before exceeding a cap (profile routing), and the
// team's default approval policy (`approvalDefault`, null when never set or
// with no project yet) that seeds the dialog's Auto-approve box
// (unify-approval-defaults D2), and `setupAvailable` — true while the main
// checkout's `.kawai/groups/` holds no group file, the New Session dialog's
// cue to point at Set up team (starter-team-setup D2; false with no project).
import { Hono } from 'hono'
import { setupAvailable } from '../team/teamSetup'
import type { ChatApprovalPolicy } from '../../shared/chat'
import { resolveProjectDirectory } from '../paths'
import { loadTeamGroups } from '../team/teamGroups'

export interface TeamGroupSummary {
  id: string
  label: string
  description: string
  /** Allowed profiles in preference order; empty = the default profile. */
  profiles: Array<{ profileId: string; providerId: string; providerLabel: string; cap?: number; live: number }>
}

export function createTeamGroupRoutes(options: {
  homeDir?: string
  /** Live members of a team's group per profile. */
  groupProfileCounts?: (teamId: string, groupId: string) => Record<string, number>
  /** The team's stored default approval policy; null = not set. */
  approvalDefault?: (teamId: string) => ChatApprovalPolicy | null
} = {}) {
  const routes = new Hono()
  routes.get('/', async c => {
    const project = resolveProjectDirectory(c.req.query('projectPath') ?? '')
    // No (or no existing) project yet: the dialog is still being filled in.
    if (!project.ok) return c.json({ groups: [], errors: [], warnings: [], approvalDefault: null, setupAvailable: false })
    const { team, catalog } = await loadTeamGroups(project.path, options.homeDir)
    const groups: TeamGroupSummary[] = [...catalog.groups.values()].map(({ group }) => {
      const live = options.groupProfileCounts?.(team.teamId, group.id) ?? {}
      return {
        id: group.id, label: group.label, description: group.description,
        profiles: group.profiles.map(entry => {
          const provider = [...catalog.providers].find(([, provider]) => provider.models.includes(entry.profileId))
          return {
            profileId: entry.profileId,
            providerId: provider?.[0] ?? entry.profileId,
            providerLabel: provider?.[1].label ?? entry.profileId,
            live: live[entry.profileId] ?? 0, ...(entry.cap !== undefined ? { cap: entry.cap } : {}),
          }
        }),
      }
    })
    return c.json({
      groups, errors: catalog.errors, warnings: catalog.warnings,
      approvalDefault: options.approvalDefault?.(team.teamId) ?? null,
      // starter-team-setup D2: the project has no group files of its own, so
      // the New Session dialog points to Set up team.
      setupAvailable: setupAvailable(team.groupsRoot),
    })
  })
  return routes
}
