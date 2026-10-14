// Which team a human team view addresses (team-workspace-pages D1). Views
// name a directory — a repository's main checkout from the navigator, or a
// chat's project directory — instead of a chat session, so a repository with
// no chat still has its views. The directory is resolved like any session
// path (`resolveTeam`), then accepted only when its team is one the UI can
// already see: a discovered workspace repository, or the team of a chat
// session that has not been killed (archived ones included). Anything else
// is refused, so a path on the wire never opens an arbitrary directory.
import path from 'node:path'
import type { SessionTeams } from './sessionTeams'
import { resolveTeam, type TeamIdentity } from './teamIdentity'

export interface TeamScopeOptions {
  teams: SessionTeams
  /** Canonical common git dirs of the discovered workspace repositories. */
  repositories: () => readonly string[]
}

export class TeamScopes {
  constructor(private readonly options: TeamScopeOptions) {}

  /** The team `teamPath` addresses, or undefined when it is not a known team. */
  async resolve(teamPath: unknown): Promise<TeamIdentity | undefined> {
    if (typeof teamPath !== 'string' || !path.isAbsolute(teamPath)) return undefined
    let team: TeamIdentity
    try {
      team = await resolveTeam(teamPath)
    } catch {
      return undefined
    }
    if (this.options.repositories().includes(team.teamId)) return team
    return await this.options.teams.hasTeam(team.teamId) ? team : undefined
  }
}
