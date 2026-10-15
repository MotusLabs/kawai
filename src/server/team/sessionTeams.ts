// Which team each chat session belongs to (agent-teams design D6), kept in
// memory beside the manager's records. Team resolution runs git, so it is
// asynchronous: `track` starts it and `onResolved` fires once the answer is
// in (and again whenever the session's project path moves to another team).
// Group display — label, and whether the group's file still exists — is read
// from the team's catalog on demand, so a removed or edited file shows up the
// next time the session is published.
import { groupCatalogStamp, loadGroupCatalog, type GroupCatalog } from './groupCatalog'
import type { GroupEffort } from './groupFile'
import { buildTeamPrompt } from './teamPrompt'
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

/** A catalog kept warm between file changes (validated by stamp, below). */
interface CachedCatalog {
  stamp: string
  catalog: GroupCatalog
}

export class SessionTeams {
  private readonly entries = new Map<string, Entry>()
  /**
   * Parsed catalogs keyed by team id and groups root, reused while the files'
   * listing stamp holds. Status flips re-ask for group labels on every turn
   * boundary; without this each one would re-read and re-parse every file.
   */
  private readonly catalogCache = new Map<string, CachedCatalog>()

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

  /** Mailbox opens wait for startup/path-change resolution before scoping. */
  async resolvedTeamOf(sessionId: string): Promise<TeamIdentity | undefined> {
    let entry = this.entries.get(sessionId)
    while (entry?.pending) {
      await entry.pending
      entry = this.entries.get(sessionId)
    }
    return entry?.team
  }

  /** Session ids whose resolved team is `teamId`. */
  membersOf(teamId: string): string[] {
    return [...this.entries].filter(([, entry]) => entry.team?.teamId === teamId).map(([id]) => id)
  }

  /**
   * Whether any tracked session (live or archived; killed ones are forgotten)
   * belongs to `teamId`, once every in-flight resolution has settled — a view
   * opened right after a restart must not be refused while teams resolve.
   */
  async hasTeam(teamId: string): Promise<boolean> {
    if (this.membersOf(teamId).length > 0) return true
    // One settle pass: a rejected resolution never clears its `pending`, so
    // looping until none remain could spin forever.
    await Promise.allSettled([...this.entries.values()].flatMap(entry => entry.pending ? [entry.pending] : []))
    return this.membersOf(teamId).length > 0
  }

  /** Display state of a session's group; undefined until its team is known. */
  groupInfo(sessionId: string, groupId: string, cache?: Map<string, GroupCatalog>): SessionGroupInfo | undefined {
    const group = this.catalogOf(sessionId, cache)?.groups.get(groupId)?.group
    if (!this.teamOf(sessionId)) return undefined
    return group ? { label: group.label, missing: false } : { label: groupId, missing: true }
  }

  /**
   * The system-prompt addition for a spawn (design D7), read from the files
   * as they are now. A missing group gets the note without a role; a team
   * not resolved yet gets the note with no group list.
   */
  promptFor(sessionId: string, groupId: string | null | undefined): string {
    const catalog = this.catalogOf(sessionId)
    const groups = [...(catalog?.groups.values() ?? [])].map(entry => entry.group)
    const group = groupId ? catalog?.groups.get(groupId)?.group : undefined
    return buildTeamPrompt({ sessionId, groups, ...(group ? { group } : {}) })
  }

  /**
   * The launch effort for a spawn (group-effort D2), read from the files as
   * they are now like `promptFor`; undefined without a group, team, or
   * `effort`, leaving Claude Code's own settings to decide.
   */
  effortFor(sessionId: string, groupId: string | null | undefined): GroupEffort | undefined {
    return groupId ? this.catalogOf(sessionId)?.groups.get(groupId)?.group.effort : undefined
  }

  /**
   * The session's team catalog; undefined until resolved. A per-cycle `cache`
   * map shares one read across a dispatch pass; behind both sits a parsed
   * catalog reused while its files' stamp is unchanged, so frequent callers
   * (status flips, spawns) still see edits without re-reading every turn.
   */
  catalogOf(sessionId: string, cache?: Map<string, GroupCatalog>): GroupCatalog | undefined {
    const team = this.teamOf(sessionId)
    return team ? this.catalogForTeam(team, cache) : undefined
  }

  /** A team's catalog, for callers that hold the team rather than a session. */
  catalogForTeam(team: TeamIdentity, cache?: Map<string, GroupCatalog>): GroupCatalog {
    const cached = cache?.get(team.teamId)
    if (cached) return cached
    const context = {
      groupsRoot: team.groupsRoot,
      ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
    }
    const stamp = groupCatalogStamp(context)
    // Same team from two worktrees would share an id but not a groups root.
    const key = `${team.teamId}\0${team.groupsRoot}`
    const warm = this.catalogCache.get(key)
    if (warm && warm.stamp === stamp) {
      cache?.set(team.teamId, warm.catalog)
      return warm.catalog
    }
    const catalog = loadGroupCatalog(context)
    this.catalogCache.set(key, { stamp, catalog })
    cache?.set(team.teamId, catalog)
    return catalog
  }
}
