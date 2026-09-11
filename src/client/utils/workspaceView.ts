// workspaceView.ts - Pure selectors building the grouped workspace view
// model: sessions (live, hibernating, historical) associated with their
// deepest containing worktree, explicit local-ungrouped and remote fallback
// groups, attention counts, and the flattened visible navigation order used
// by keyboard/terminal navigation.

import type { AgentSession, Session } from '@shared/types'
import {
  deepestPathMatch,
  type WorktreeOpenSpecState,
  type WorkspaceRepository,
  type WorkspaceSnapshot,
} from '@shared/workspace'

export interface SessionFilter {
  projectFilters: string[]
  hostFilters: string[]
}

export const NO_FILTER: SessionFilter = { projectFilters: [], hostFilters: [] }

/** Filter semantics mirror SessionList: exact-match allowlists. */
function sessionMatchesFilter(session: Session, filter: SessionFilter): boolean {
  if (filter.projectFilters.length > 0 && !filter.projectFilters.includes(session.projectPath)) {
    return false
  }
  if (filter.hostFilters.length > 0 && !filter.hostFilters.includes(session.host ?? '')) {
    return false
  }
  return true
}

function agentSessionMatchesFilter(session: AgentSession, filter: SessionFilter): boolean {
  if (filter.projectFilters.length > 0 && !filter.projectFilters.includes(session.projectPath)) {
    return false
  }
  if (filter.hostFilters.length > 0 && !filter.hostFilters.includes(session.host ?? '')) {
    return false
  }
  return true
}

/** A session row placed in a group; spans live, hibernating, and history. */
export interface GroupedSessionEntry {
  /** Stable row key (agent session id when present). */
  key: string
  kind: 'live' | 'hibernating' | 'history'
  /** Live session id (for live rows). */
  sessionId?: string
  /** Hibernating/history agent session (for those rows). */
  agentSession?: AgentSession
  liveSession?: Session
}

export interface WorktreeGroup {
  kind: 'worktree'
  /** Stable worktree id from the snapshot. */
  worktreeId: string
  repositoryId: string
  repositoryName: string
  repositoryStale: boolean
  repositoryError?: string
  worktreePath: string
  branch?: string
  detached: boolean
  headRevision: string
  isMain: boolean
  dirty: boolean
  openspec: WorktreeOpenSpecState
  collapsed: boolean
  /** Filtered rows inside the group, in input order. */
  entries: GroupedSessionEntry[]
  /** Live rows currently waiting for permission. */
  attentionCount: number
  /**
   * Permission-waiting rows hidden by collapse or filters: the header keeps
   * signaling them even when their rows are invisible.
   */
  hiddenAttentionCount: number
}

export interface LocalUngroupedGroup {
  kind: 'local-ungrouped'
  entries: GroupedSessionEntry[]
  attentionCount: number
  hiddenAttentionCount: number
}

export interface RemoteGroup {
  kind: 'remote'
  entries: GroupedSessionEntry[]
  attentionCount: number
  hiddenAttentionCount: number
}

export interface WorkspaceView {
  /** Worktree groups in snapshot order (repository, then path). */
  worktreeGroups: WorktreeGroup[]
  localUngrouped: LocalUngroupedGroup
  remote: RemoteGroup
  /** Flattened visible (filter-passing, non-collapsed) rows in render order. */
  visibleEntries: GroupedSessionEntry[]
}

function liveEntry(session: Session): GroupedSessionEntry {
  return {
    key: session.agentSessionId || session.id,
    kind: 'live',
    sessionId: session.id,
    liveSession: session,
  }
}

function agentEntry(
  agentSession: AgentSession,
  kind: 'hibernating' | 'history'
): GroupedSessionEntry {
  return {
    key: agentSession.sessionId,
    kind,
    agentSession,
  }
}

function isAttentionEntry(entry: GroupedSessionEntry): boolean {
  return entry.liveSession?.status === 'permission'
}

export function buildWorkspaceView(
  snapshot: WorkspaceSnapshot | null,
  sessions: Session[],
  hibernating: AgentSession[],
  history: AgentSession[],
  options: {
    filter?: SessionFilter
    collapsedWorktreeIds?: string[]
  } = {}
): WorkspaceView {
  const filter = options.filter ?? NO_FILTER
  const collapsed = new Set(options.collapsedWorktreeIds ?? [])

  // Map every worktree path to its group index for deepest-match lookups.
  const worktreePaths: string[] = []
  const groupIndexByPath = new Map<string, number>()
  const groups: WorktreeGroup[] = []
  if (snapshot) {
    for (const repository of snapshot.repositories) {
      for (const worktree of repository.worktrees) {
        groupIndexByPath.set(worktree.path, groups.length)
        worktreePaths.push(worktree.path)
        groups.push(createWorktreeGroup(repository, worktree, collapsed.has(worktree.id)))
      }
    }
  }

  const localUngrouped: LocalUngroupedGroup = {
    kind: 'local-ungrouped',
    entries: [],
    attentionCount: 0,
    hiddenAttentionCount: 0,
  }
  const remote: RemoteGroup = {
    kind: 'remote',
    entries: [],
    attentionCount: 0,
    hiddenAttentionCount: 0,
  }

  const place = (entry: GroupedSessionEntry, path: string | undefined, isRemote: boolean) => {
    const visible =
      entry.kind === 'live' && entry.liveSession
        ? sessionMatchesFilter(entry.liveSession, filter)
        : entry.agentSession
          ? agentSessionMatchesFilter(entry.agentSession, filter)
          : true

    let group: WorktreeGroup | LocalUngroupedGroup | RemoteGroup
    if (isRemote) {
      group = remote
    } else {
      const ownerPath = path ? deepestPathMatch(path, worktreePaths) : null
      const groupIndex = ownerPath !== null ? groupIndexByPath.get(ownerPath) : undefined
      group = groupIndex !== undefined ? groups[groupIndex] : localUngrouped
    }

    if (visible) {
      group.entries.push(entry)
      if (isAttentionEntry(entry)) group.attentionCount += 1
    } else if (isAttentionEntry(entry)) {
      group.hiddenAttentionCount += 1
    }
  }

  for (const session of sessions) {
    place(liveEntry(session), session.projectPath, session.remote === true)
  }
  for (const agentSession of hibernating) {
    place(agentEntry(agentSession, 'hibernating'), agentSession.projectPath, agentSession.host != null)
  }
  for (const agentSession of history) {
    place(agentEntry(agentSession, 'history'), agentSession.projectPath, agentSession.host != null)
  }

  const visibleEntries: GroupedSessionEntry[] = []
  for (const group of groups) {
    if (!group.collapsed) visibleEntries.push(...group.entries)
  }
  if (localUngrouped.entries.length > 0) visibleEntries.push(...localUngrouped.entries)
  if (remote.entries.length > 0) visibleEntries.push(...remote.entries)

  return { worktreeGroups: groups, localUngrouped, remote, visibleEntries }
}

function createWorktreeGroup(
  repository: WorkspaceRepository,
  worktree: WorkspaceRepository['worktrees'][number],
  collapsed: boolean
): WorktreeGroup {
  return {
    kind: 'worktree',
    worktreeId: worktree.id,
    repositoryId: repository.id,
    repositoryName: repository.name,
    repositoryStale: repository.stale,
    ...(repository.error !== undefined ? { repositoryError: repository.error } : {}),
    worktreePath: worktree.path,
    ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
    detached: worktree.detached,
    headRevision: worktree.headRevision,
    isMain: worktree.isMain,
    dirty: worktree.dirty,
    openspec: worktree.openspec,
    collapsed,
    entries: [],
    attentionCount: 0,
    hiddenAttentionCount: 0,
  }
}
