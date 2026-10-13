// Worktree staffing (team-tasks design D4/D6, profile-routing D4/D4a):
// queued group mail whose task targets a worktree may get a new member
// spawned there — never past a cap, never by creating a worktree. Routing
// decides whether and on which profile (a `spawn` candidate); this module
// previews whether spawning is possible at all (`spawnContext`) and performs
// it (`spawnFor`). Caps, checked again in the same transaction that reserves
// the message (state `spawning`) and records a durable `team_spawns` row:
// - the group's `max` live members (every non-archived member, spawned or not);
// - the group's per-profile cap on live members of that profile;
// - the team's live spawned sessions (`~/.kawai/teams.json`, default 5);
// - one live spawned member of any group per resolved worktree.
// Pending reservations count toward all four. A failed spawn drops its
// reservation, requeues the message, and backs off; a restart drops every
// reservation and requeues every reserved message (none was ever pushed, so
// receipt recovery has nothing to say about them). Mail for a worktree that
// no longer exists is dead-lettered.
import type { Database } from 'bun:sqlite'
import type { ChatApprovalPolicy } from '../../shared/chat'
import type { ChatSessionRecord } from '../db'
import type { SpawnAssignment } from './dispatcher'
import type { MailboxStore, TeamMessage } from './mailboxStore'
import type { TeamCaps } from './teamCaps'
import type { GroupDefinition } from './groupFile'
import type { TeamIdentity } from './teamIdentity'
import { worktreeRootOf, type TeamWorktrees } from './worktreeRoots'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_spawns (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  worktree TEXT NOT NULL,
  created_at TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT 'default'
);
`

/** Columns added after the table first shipped. */
function migrateTable(db: Database) {
  const columns = db.prepare('PRAGMA table_info(team_spawns)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'profile_id')) {
    db.exec("ALTER TABLE team_spawns ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'")
  }
}

/** Whether spawning for a message is possible now, before choosing a profile. */
export interface SpawnContext {
  worktree: string
  /** Team cap, the worktree's writer slot, and failure backoff allow a spawn. */
  allowed: boolean
  /** Profiles of the group's pending reservations (they count toward caps). */
  pendingProfiles: string[]
}

/** A spawn request: where, which group, and the group's member settings. */
export interface SpawnRequest {
  projectPath: string
  groupId: string
  profileId?: string
  approvalPolicy: ChatApprovalPolicy
  taskId: string
}

export type SpawnResult = { ok: true; sessionId: string } | { ok: false; error: string }

/** A failed spawn is not retried for this long, so a broken profile cannot spin. */
const RETRY_AFTER_MS = 30_000

export class WorktreeStaffing {
  private readonly failedAt = new Map<string, number>()

  constructor(private readonly db: Database, private readonly store: MailboxStore, private readonly options: {
    /** Every live chat session record (archived ones included; filtered here). */
    records: () => Iterable<ChatSessionRecord>
    /** A session's resolved team; undefined while resolving. */
    teamOf: (sessionId: string) => TeamIdentity | undefined
    caps: TeamCaps
    worktrees: TeamWorktrees
    spawn: (request: SpawnRequest) => Promise<SpawnResult>
    onError?: (error: unknown) => void
    now?: () => number
  }) {
    db.exec(CREATE_TABLE_SQL)
    migrateTable(db)
  }

  /**
   * Startup reconciliation (before the first dispatch): reservations from an
   * interrupted spawn are dropped and their messages queued again. A member
   * that was created before the crash is an ordinary idle member now and
   * picks the message up through normal dispatch.
   */
  reconcile(): void {
    this.db.exec('DELETE FROM team_spawns')
    for (const message of this.store.spawningRows()) this.store.requeue(message.id)
  }

  /**
   * Preview for routing: null when the message is not worktree task mail;
   * `'worktree-missing'` after dead-lettering mail whose worktree is gone.
   * Group `max` and per-profile caps are applied by the candidate builder;
   * `spawnFor` re-checks everything inside its reservation transaction.
   */
  async spawnContext(message: TeamMessage, worktree: string | null): Promise<SpawnContext | 'worktree-missing' | null> {
    if (message.toKind !== 'group' || message.toId === null || !message.taskId || worktree === null) return null
    if (!(await this.options.worktrees.exists(message.teamId, worktree))) {
      this.store.deadLetter(message.id, `worktree-missing: ${worktree}`)
      return 'worktree-missing'
    }
    const now = this.options.now?.() ?? Date.now()
    const backingOff = now - (this.failedAt.get(message.id) ?? -Infinity) < RETRY_AFTER_MS
    const teamCap = await this.options.caps.maxSpawnedSessions(message.teamId)
    const counts = this.counts(message.teamId, message.toId, worktree)
    return {
      worktree,
      allowed: !backingOff && counts.teamSpawned < teamCap && counts.worktreeWriters < 1,
      pendingProfiles: counts.pending.filter(row => row.group_id === message.toId).map(row => row.profile_id),
    }
  }

  /**
   * Spawn a member of `group` on `profileId` in `worktree` and reserve the
   * message for it as its first turn; null when a cap no longer allows it or
   * the spawn failed (the message is queued again).
   */
  async spawnFor(message: TeamMessage, worktree: string, group: GroupDefinition, profileId: string): Promise<SpawnAssignment | null> {
    if (message.toId !== group.id || !message.taskId) return null
    const teamCap = await this.options.caps.maxSpawnedSessions(message.teamId)
    const cap = group.profiles.find(entry => entry.profileId === profileId)?.cap
    const reservation = `spawn-${crypto.randomUUID()}`
    const reserved = this.db.transaction(() => {
      const counts = this.counts(message.teamId, group.id, worktree)
      const onProfile = counts.groupLive.filter(record => (record.claudeProfileId ?? 'default') === profileId).length +
        counts.pending.filter(row => row.group_id === group.id && row.profile_id === profileId).length
      if (counts.groupMembers >= group.max || counts.teamSpawned >= teamCap || counts.worktreeWriters >= 1) return false
      if (cap !== undefined && onProfile >= cap) return false
      if (!this.store.reserveForSpawn(message.id)) return false
      this.db.prepare(`INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at, profile_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(reservation, message.id, message.teamId, group.id, worktree, new Date().toISOString(), profileId)
      return true
    })()
    if (!reserved) return null
    let result: SpawnResult
    try {
      result = await this.options.spawn({
        projectPath: worktree, groupId: group.id, approvalPolicy: group.approval, taskId: message.taskId,
        // The default profile is the absence of a choice, as for user-created chats.
        ...(profileId !== 'default' ? { profileId } : {}),
      })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    // The new member (a live spawned record) now holds the slot itself.
    this.db.prepare('DELETE FROM team_spawns WHERE id = ?').run(reservation)
    if (!result.ok) {
      this.failedAt.set(message.id, this.options.now?.() ?? Date.now())
      this.store.requeue(message.id)
      this.options.onError?.(new Error(`Spawning a ${group.id} member on ${profileId} in ${worktree} failed: ${result.error}`))
      return null
    }
    this.failedAt.delete(message.id)
    return { message: this.store.get(message.id)!, sessionId: result.sessionId }
  }

  /** Live counts behind every cap, pending reservations included. */
  private counts(teamId: string, groupId: string, worktree: string) {
    const live = [...this.options.records()].filter(record =>
      record.archivedAt == null && this.options.teamOf(record.sessionId)?.teamId === teamId)
    const pending = this.db.prepare('SELECT group_id, worktree, profile_id FROM team_spawns WHERE team_id = ?')
      .all(teamId) as Array<{ group_id: string; worktree: string; profile_id: string }>
    const spawned = live.filter(record => record.spawned)
    const groupLive = live.filter(record => record.groupId === groupId)
    return {
      pending,
      groupLive,
      groupMembers: groupLive.length + pending.filter(row => row.group_id === groupId).length,
      teamSpawned: spawned.length + pending.length,
      worktreeWriters: spawned.filter(record => worktreeRootOf(record.projectPath) === worktree).length +
        pending.filter(row => row.worktree === worktree).length,
    }
  }
}
