// Which team each chat session belongs to (agent-teams design D6), kept in
// memory beside the manager's records. Team resolution runs git, so it is
// asynchronous: `track` starts it and `onResolved` fires once the answer is
// in (and again whenever the session's project path moves to another team).
// Group display — label, and whether the group's file still exists — is read
// from the team's catalog on demand, so a removed or edited file shows up the
// next time the session is published.
import { loadGroupCatalog } from './groupCatalog'
import { resolveTeam, type TeamIdentity } from './teamIdentity'

export interface SessionGroupInfo {
  /** The group's label, or its id when the group is missing. */
  label: string
  /** The stored id names no group of the team's catalog any more. */
  missing: boolean
}

interface Entry {
  projectPath: string
  team?: TeamIdentity
  /** In-flight resolution for `projectPath`, shared by repeated tracks. */
  pending?: Promise<void>
}

export class SessionTeams {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly options: {
      /** Home holding the user-level `.kawai/groups/`; tests inject it. */
      homeDir?: string
      /** A session's team became known or changed. */
      onResolved?: (sessionId: string) => void
    } = {}
  ) {}

  /** Start (or redo, when the path changed) team resolution for a session. */
  track(sessionId: string, projectPath: string): Promise<void> {
    const current = this.entries.get(sessionId)
    if (current?.projectPath === projectPath) return current.pending ?? Promise.resolve()
    const entry: Entry = { projectPath, ...(current?.team ? { team: current.team } : {}) }
    this.entries.set(sessionId, entry)
    entry.pending = resolveTeam(projectPath).then(team => {
      // A newer track() or forget() superseded this resolution.
      if (this.entries.get(sessionId) !== entry) return
      delete entry.pending
      const changed = entry.team?.teamId !== team.teamId || entry.team?.groupsRoot !== team.groupsRoot
      entry.team = team
      if (changed) this.options.onResolved?.(sessionId)
    })
    return entry.pending
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** The session's team; undefined until resolution finishes. */
  teamOf(sessionId: string): TeamIdentity | undefined {
    return this.entries.get(sessionId)?.team
  }

  /** Session ids whose resolved team is `teamId`. */
  membersOf(teamId: string): string[] {
    return [...this.entries].filter(([, entry]) => entry.team?.teamId === teamId).map(([id]) => id)
  }

  /** Display state of a session's group; undefined until its team is known. */
  groupInfo(sessionId: string, groupId: string): SessionGroupInfo | undefined {
    const team = this.teamOf(sessionId)
    if (!team) return undefined
    const group = loadGroupCatalog({
      groupsRoot: team.groupsRoot,
      ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
    }).groups.get(groupId)
    return group ? { label: group.label, missing: false } : { label: groupId, missing: true }
  }
}
