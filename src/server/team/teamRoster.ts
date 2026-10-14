// Worktree occupancy read model (team-waiting-reasons D4): a team's live
// (non-archived) sessions grouped by their resolved worktree root, each with
// group, profile, status, spawned identity, and task, plus pending spawn
// reservations. One model serves the mailbox snapshot, the waiting reasons,
// and staffing's worktree-writer count, so the occupant a reason names is the
// same fact that blocked the spawn. Transparency, not semantics: manual and
// spawned sessions are both listed, while only spawned sessions and pending
// reservations count as delivery-blocking writers (staffing's caps keep their
// existing arithmetic and read the same entries).
import type { TeamWorktreeOccupancy } from '../../shared/team'
import type { ChatSessionRecord } from '../db'
import type { TeamIdentity } from './teamIdentity'
import { worktreeRootOf } from './worktreeRoots'

/** A pending `team_spawns` reservation as the roster sees it. */
export interface PendingSpawnRow {
  teamId: string
  groupId: string
  worktree: string
  profileId: string
  messageId: string
  createdAt: string
}

export interface TeamRosterInput {
  records: Iterable<ChatSessionRecord>
  teamOf: (sessionId: string) => TeamIdentity | undefined
  pendingSpawns: PendingSpawnRow[]
}

/**
 * The team's live sessions per resolved worktree root, deterministic in
 * order (worktree path, then session id) so snapshots and structural
 * compares stay stable. Sessions in subdirectories resolve to their
 * worktree root; sessions of other teams and archived ones are excluded.
 */
export function teamRoster(teamId: string, input: TeamRosterInput): TeamWorktreeOccupancy[] {
  const byWorktree = new Map<string, TeamWorktreeOccupancy>()
  const entry = (worktree: string): TeamWorktreeOccupancy => {
    const existing = byWorktree.get(worktree)
    if (existing) return existing
    const created: TeamWorktreeOccupancy = { worktree, sessions: [], pendingSpawns: [] }
    byWorktree.set(worktree, created)
    return created
  }
  for (const record of input.records) {
    if (record.archivedAt != null) continue
    if (input.teamOf(record.sessionId)?.teamId !== teamId) continue
    entry(worktreeRootOf(record.projectPath)).sessions.push({
      sessionId: record.sessionId,
      group: record.groupId ?? null,
      profile: record.claudeProfileId ?? 'default',
      status: record.status,
      spawned: !!record.spawned,
      taskId: record.taskId ?? null,
    })
  }
  for (const pending of input.pendingSpawns) {
    if (pending.teamId !== teamId) continue
    entry(pending.worktree).pendingSpawns.push({ group: pending.groupId, profile: pending.profileId })
  }
  return [...byWorktree.values()]
    .map(occupancy => ({
      ...occupancy,
      sessions: [...occupancy.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      pendingSpawns: [...occupancy.pendingSpawns].sort((a, b) => a.group.localeCompare(b.group) || a.profile.localeCompare(b.profile)),
    }))
    .sort((a, b) => a.worktree.localeCompare(b.worktree))
}

/** Spawned sessions and pending reservations holding a worktree's writer slot. */
export function worktreeWriters(occupancy: TeamWorktreeOccupancy | undefined): { spawnedIds: string[]; pending: number } {
  return {
    spawnedIds: occupancy?.sessions.filter(session => session.spawned).map(session => session.sessionId) ?? [],
    pending: occupancy?.pendingSpawns.length ?? 0,
  }
}
