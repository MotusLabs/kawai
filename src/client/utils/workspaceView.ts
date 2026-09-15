// workspaceView.ts - Pure selectors building the sectioned workspace view
// model: sessions (live, hibernating, historical) associated with their
// deepest containing worktree, grouped under OpenSpec change sections
// (canonical source resolved server-side), then unmatched worktree
// sections, then the Workspace and remote fallback sections. Also produces
// the flattened visible navigation order used by keyboard/terminal
// navigation.

import type { AgentSession, Session } from '@shared/types'
import {
  changeSectionKey,
  deepestPathMatch,
  type ChangeRegistryEntry,
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

/** A session row placed in a section; spans live, hibernating, and history. */
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

/** A collapsible section for one registry change. */
export interface ChangeSectionData {
  kind: 'change'
  /** Stable section key (changeSectionKey). */
  key: string
  repositoryId: string
  repositoryName: string
  repositoryStale: boolean
  repositoryError?: string
  /** Registry entry with canonical source already resolved. */
  change: ChangeRegistryEntry
  collapsed: boolean
  /** Filtered rows inside the section, in input order. */
  entries: GroupedSessionEntry[]
  /** Live rows currently waiting for permission. */
  attentionCount: number
  /**
   * Permission-waiting rows hidden by collapse or filters: the header keeps
   * signaling them even when their rows are invisible.
   */
  hiddenAttentionCount: number
}

/** A collapsible section for a worktree with no matching registry change. */
export interface WorktreeSectionData {
  kind: 'worktree'
  /** Stable section key (the worktree id). */
  key: string
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
  collapsed: boolean
  entries: GroupedSessionEntry[]
  attentionCount: number
  hiddenAttentionCount: number
}

export type WorkspaceSection = ChangeSectionData | WorktreeSectionData

export interface FallbackSectionData {
  kind: 'workspace' | 'remote'
  entries: GroupedSessionEntry[]
  attentionCount: number
  hiddenAttentionCount: number
}

export interface WorkspaceView {
  /**
   * Sections in render order: per repository (snapshot order) its change
   * sections first, then its unmatched worktrees (main worktree included).
   */
  sections: WorkspaceSection[]
  /** Local sessions outside any worktree. */
  workspace: FallbackSectionData
  remote: FallbackSectionData
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
    collapsedSectionIds?: string[]
  } = {}
): WorkspaceView {
  const filter = options.filter ?? NO_FILTER
  const collapsed = new Set(options.collapsedSectionIds ?? [])

  const sections: WorkspaceSection[] = []
  // Session placement: deepest worktree path -> owning section index.
  const sectionIndexByWorktreePath = new Map<string, number>()

  if (snapshot) {
    for (const repository of snapshot.repositories) {
      const registry = repository.changeRegistry ?? []
      const registryWorktreeIds = new Set(
        registry.flatMap((entry) => (entry.worktreeId !== undefined ? [entry.worktreeId] : []))
      )
      const worktreeById = new Map(repository.worktrees.map((worktree) => [worktree.id, worktree]))

      for (const entry of registry) {
        // Only anchor a change section to a worktree that actually exists in
        // the snapshot; inconsistent payloads degrade to registry-only.
        const worktree =
          entry.worktreeId !== undefined ? worktreeById.get(entry.worktreeId) : undefined
        const key = changeSectionKey(repository.id, entry.name)
        const index = sections.length
        sections.push({
          kind: 'change',
          key,
          repositoryId: repository.id,
          repositoryName: repository.name,
          repositoryStale: repository.stale,
          ...(repository.error !== undefined ? { repositoryError: repository.error } : {}),
          change: worktree
            ? {
                ...entry,
                worktreeId: worktree.id,
                worktreePath: worktree.path,
              }
            : { ...entry, worktreeId: undefined, worktreePath: undefined, missingInWorktree: undefined },
          collapsed: collapsed.has(key),
          entries: [],
          attentionCount: 0,
          hiddenAttentionCount: 0,
        })
        if (worktree) {
          sectionIndexByWorktreePath.set(worktree.path, index)
        }
      }

      for (const worktree of repository.worktrees) {
        if (registryWorktreeIds.has(worktree.id)) continue
        const index = sections.length
        sections.push({
          kind: 'worktree',
          key: worktree.id,
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
          collapsed: collapsed.has(worktree.id),
          entries: [],
          attentionCount: 0,
          hiddenAttentionCount: 0,
        })
        sectionIndexByWorktreePath.set(worktree.path, index)
      }
    }
  }

  const workspace: FallbackSectionData = {
    kind: 'workspace',
    entries: [],
    attentionCount: 0,
    hiddenAttentionCount: 0,
  }
  const remote: FallbackSectionData = {
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

    const target = isRemote ? null : deepestPathMatch(path ?? '', sectionIndexByWorktreePath.keys())
    const sectionIndex = target !== null ? sectionIndexByWorktreePath.get(target) : undefined
    const section =
      sectionIndex !== undefined ? sections[sectionIndex] : isRemote ? remote : workspace

    if (visible) {
      section.entries.push(entry)
      if (isAttentionEntry(entry)) section.attentionCount += 1
    } else if (isAttentionEntry(entry)) {
      section.hiddenAttentionCount += 1
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
  for (const section of sections) {
    if (!section.collapsed) visibleEntries.push(...section.entries)
  }
  if (workspace.entries.length > 0) visibleEntries.push(...workspace.entries)
  if (remote.entries.length > 0) visibleEntries.push(...remote.entries)

  return { sections, workspace, remote, visibleEntries }
}
