// Worktree staffing (team-tasks design D4/D6): queued group mail whose task
// targets a worktree, and that no idle member in that worktree could take,
// gets a new member spawned there — never past a cap, never by creating a
// worktree. Caps, checked in the same transaction that reserves the message
// (state `spawning`) and records a durable `team_spawns` row:
// - the group's `max` live members (every non-archived member, spawned or not);
// - the team's live spawned sessions (`~/.kawai/teams.json`, default 5);
// - one live spawned member of any group per resolved worktree.
// Pending reservations count toward all three. A failed spawn drops its
// reservation and requeues the message; a restart drops every reservation
// and requeues every reserved message (none was ever pushed, so receipt
// recovery has nothing to say about them). Mail for a worktree that no
// longer exists is dead-lettered.
import type { Database } from 'bun:sqlite'
import type { ChatApprovalPolicy } from '../../shared/chat'
import type { ChatSessionRecord } from '../db'
import type { SpawnAssignment } from './dispatcher'
import type { MailboxStore, TeamMessage } from './mailboxStore'
import type { TeamCaps } from './teamCaps'
import { loadTeamGroups } from './teamGroups'
import type { TeamIdentity } from './teamIdentity'
import { worktreeRootOf, type TeamWorktrees } from './worktreeRoots'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_spawns (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  worktree TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

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
    /** An idle, available member of `groupId` in `worktree` exists (it will take the mail). */
    hasIdleMember: (teamId: string, groupId: string, worktree: string) => boolean
    caps: TeamCaps
    worktrees: TeamWorktrees
    spawn: (request: SpawnRequest) => Promise<SpawnResult>
    homeDir?: string
    onError?: (error: unknown) => void
    now?: () => number
  }) {
    db.exec(CREATE_TABLE_SQL)
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

  /** One staffing pass; returns the members spawned and the mail reserved for them. */
  async run(): Promise<SpawnAssignment[]> {
    const assignments: SpawnAssignment[] = []
    const now = this.options.now?.() ?? Date.now()
    for (const { message, worktree } of this.store.worktreeTaskMail()) {
      try {
        if (!(await this.options.worktrees.exists(message.teamId, worktree))) {
          this.store.deadLetter(message.id, `worktree-missing: ${worktree}`)
          continue
        }
        if (this.options.hasIdleMember(message.teamId, message.toId, worktree)) continue
        if (now - (this.failedAt.get(message.id) ?? -Infinity) < RETRY_AFTER_MS) continue
        const assignment = await this.staff(message, worktree)
        if (assignment) assignments.push(assignment)
      } catch (error) {
        this.options.onError?.(error)
      }
    }
    return assignments
  }

  private async staff(message: TeamMessage, worktree: string): Promise<SpawnAssignment | null> {
    const { team, catalog } = await loadTeamGroups(message.originPath, this.options.homeDir)
    const group = catalog.groups.get(message.toId)
    if (!group || team.teamId !== message.teamId) return null
    const teamCap = await this.options.caps.maxSpawnedSessions(message.teamId)
    const reservation = `spawn-${crypto.randomUUID()}`
    const reserved = this.db.transaction(() => {
      const live = [...this.options.records()].filter(record =>
        record.archivedAt == null && this.options.teamOf(record.sessionId)?.teamId === message.teamId)
      const pending = this.db.prepare('SELECT group_id, worktree FROM team_spawns WHERE team_id = ?')
        .all(message.teamId) as Array<{ group_id: string; worktree: string }>
      const spawned = live.filter(record => record.spawned)
      const groupMembers = live.filter(record => record.groupId === group.id).length +
        pending.filter(row => row.group_id === group.id).length
      const teamSpawned = spawned.length + pending.length
      const worktreeWriters = spawned.filter(record => worktreeRootOf(record.projectPath) === worktree).length +
        pending.filter(row => row.worktree === worktree).length
      if (groupMembers >= group.max || teamSpawned >= teamCap || worktreeWriters >= 1) return false
      if (!this.store.reserveForSpawn(message.id)) return false
      this.db.prepare('INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reservation, message.id, message.teamId, group.id, worktree, new Date().toISOString())
      return true
    })()
    if (!reserved) return null
    let result: SpawnResult
    try {
      result = await this.options.spawn({
        projectPath: worktree, groupId: group.id, approvalPolicy: group.approval, taskId: message.taskId!,
        ...(group.profiles[0] ? { profileId: group.profiles[0].profileId } : {}),
      })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    // The new member (a live spawned record) now holds the slot itself.
    this.db.prepare('DELETE FROM team_spawns WHERE id = ?').run(reservation)
    if (!result.ok) {
      this.failedAt.set(message.id, this.options.now?.() ?? Date.now())
      this.store.requeue(message.id)
      this.options.onError?.(new Error(`Spawning a ${group.id} member in ${worktree} failed: ${result.error}`))
      return null
    }
    this.failedAt.delete(message.id)
    return { message: this.store.get(message.id)!, sessionId: result.sessionId }
  }
}
