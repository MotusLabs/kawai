// Per-team Plan workspace views (plan-workspace §5, design D1/D8): the open
// plan's workspace snapshot, its composed checklists and documents, the
// keyed bind/reference command results, and the view state — expansions, the
// selected change and document, and the row filter. Server snapshots are
// authoritative and replace local state whole; a push for a plan that is no
// longer open is dropped, like the Plans view's late detail. View state is
// client-local (never sent to the server) and survives tab switches, so
// returning from a chat restores the same selection (spec: preserves access
// and reconnect state). One workspace per team at a time, matching the
// Plans view's single detail pane; selecting another plan resets the view,
// and the section's effect ends the old subscription.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type {
  PlanWorkspaceRole, WorkspaceArtifactsView, WorkspaceBindingView, WorkspaceChecklist, WorkspaceChecklistUnavailable,
  WorkspaceDocumentView, WorkspaceSnapshot, WorkspaceVersionSelector,
} from '@shared/planWorkspace'
import { routedTeamPath } from '../utils/teamKeyAliases'

/** The WBS row filters (design D2): all, work in flight, or work waiting on a cause. */
export type WorkspaceFilter = 'all' | 'active' | 'blocked'
/** The keyed workspace commands (design D4/D6). */
export type WorkspaceCommand = 'bind' | 'ref-add' | 'ref-remove'
/** The pane the narrow navigation shows (plan-workspace 7.2). */
export type WorkspaceNarrowPane = 'map' | 'documents' | 'conversation'
/** The pane expanded over the others (design D8); null = all visible. */
export type WorkspaceExpandedPane = 'reader' | 'conversation' | null

/** The documents pane's share bounds of the resizable desktop area (7.2). */
export const READER_FRACTION_MIN = 0.15
export const READER_FRACTION_MAX = 0.7
export const READER_FRACTION_DEFAULT = 0.45
export const READER_FRACTION_STEP = 0.03

/** Per-team pane state (design D8): sizes and expansions survive navigation. */
export interface WorkspacePanesState {
  readerFraction: number
  expandedPane: WorkspaceExpandedPane
  narrowPane: WorkspaceNarrowPane
  /** Whether the desktop layout shows the right conversation column. */
  conversationOpen: boolean
}

export const defaultPanes = (): WorkspacePanesState => ({
  readerFraction: READER_FRACTION_DEFAULT, expandedPane: null, narrowPane: 'map', conversationOpen: true,
})

const clampFraction = (fraction: number): number =>
  Math.min(READER_FRACTION_MAX, Math.max(READER_FRACTION_MIN, fraction))

/** The document the reader displays: the subscription identity (design D4). */
export interface WorkspaceDocumentSelection {
  worktreeId: string
  relativePath: string
}

export const documentKey = (selection: WorkspaceDocumentSelection): string =>
  `${selection.worktreeId}\0${selection.relativePath}`

/**
 * The one authoritative bindings slot per team (Q1, Lead-authorized):
 * per-plan snapshots and team bindings pushes reconcile here per role by the
 * CAS version, so the two read paths can never diverge. Versions only grow;
 * an equal version refreshes availability in place (neither side is older).
 */
export const mergeBindings = (
  current: WorkspaceBindingView[] | undefined,
  incoming: WorkspaceBindingView[],
): WorkspaceBindingView[] => {
  if (!current || current.length === 0) return incoming
  const byRole = new Map(current.map(binding => [binding.role, binding]))
  for (const next of incoming) {
    const existing = byRole.get(next.role)
    if (!existing || next.version >= existing.version) byRole.set(next.role, next)
  }
  return [...byRole.values()]
}

export interface PlanWorkspaceView {
  planId: string
  /** The open's version selector; null = the default (approved, else newest in review, else newest draft). */
  version: WorkspaceVersionSelector | null
  /** The selected execution id; null = the latest execution (design D2). */
  executionId: string | null
  /** null until the first snapshot. */
  snapshot: WorkspaceSnapshot | null
  /** The server-assigned team id from the snapshot wire message (V2's addressee). */
  teamId: string | null
  /** Composed checklists by change name. */
  checklists: Record<string, { checklist: WorkspaceChecklist | null; unavailable: WorkspaceChecklistUnavailable | null }>
  /** Composed documents by subscription key. */
  documents: Record<string, WorkspaceDocumentView>
  /** Canonical artifact enumerations by change name (5.3, lazy descriptors). */
  artifacts: Record<string, WorkspaceArtifactsView>
  /** Keyed commands awaiting their `team-plan-workspace-result`, by request id. */
  pending: Record<string, WorkspaceCommand>
  /** The last command refusal, until the next command or a success. */
  error: string | null
  /**
   * The location validator's last fallback notice (plan-workspace 7.1): a
   * linked selector the loaded data does not name. Cleared when the query and
   * the store agree again.
   */
  urlNotice: string | null
  // View state (design D8), client-local:
  /** Changes whose checklist rows are expanded. */
  expanded: string[]
  /** The selected change (the reader's scope and the map's highlight). */
  selectedChange: string | null
  /** The document the reader displays; null while none is open. */
  selectedDocument: WorkspaceDocumentSelection | null
  filter: WorkspaceFilter
}

const emptyView = (planId: string): PlanWorkspaceView => ({
  planId, version: null, executionId: null, snapshot: null, teamId: null,
  checklists: {}, documents: {}, artifacts: {},
  pending: {}, error: null, urlNotice: null,
  expanded: [], selectedChange: null, selectedDocument: null, filter: 'all',
})

interface PlanWorkspaceState {
  views: Record<string, PlanWorkspaceView>
  /** The team bindings slot (Q1): reconciled from plan snapshots and bindings pushes. */
  teamBindings: Record<string, WorkspaceBindingView[]>
  /** Each team's active conversation role (design D6); survives plan switches and navigation. */
  roles: Record<string, PlanWorkspaceRole>
  /** Each team's pane sizing and expansion (design D8). */
  panes: Record<string, WorkspacePanesState>
  open: (teamKey: string, planId: string) => void
  /** Drop the view (the tab closed); an unmount keeps it for the return trip. */
  close: (teamKey: string) => void
  rekey: (from: string, to: string) => void
  /** A displayed-version or execution pick (design D2); the section re-sends the open. */
  setVersion: (teamKey: string, version: WorkspaceVersionSelector | null) => void
  setExecution: (teamKey: string, executionId: string | null) => void
  toggleExpanded: (teamKey: string, change: string) => void
  selectChange: (teamKey: string, change: string | null) => void
  openDocument: (teamKey: string, selection: WorkspaceDocumentSelection | null) => void
  setFilter: (teamKey: string, filter: WorkspaceFilter) => void
  setRole: (teamKey: string, role: PlanWorkspaceRole) => void
  setReaderFraction: (teamKey: string, fraction: number) => void
  setExpandedPane: (teamKey: string, pane: WorkspaceExpandedPane) => void
  setNarrowPane: (teamKey: string, pane: WorkspaceNarrowPane) => void
  setConversationOpen: (teamKey: string, open: boolean) => void
  setUrlNotice: (teamKey: string, notice: string | null) => void
  begin: (teamKey: string, requestId: string, command: WorkspaceCommand) => void
  /** The connection came back: results of pending commands are lost, so stop waiting. */
  reconnected: (teamKey: string) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'team-plan-workspace-snapshot' }>) => void
  applyChecklist: (message: Extract<ServerMessage, { type: 'team-plan-workspace-checklist' }>) => void
  applyDocument: (message: Extract<ServerMessage, { type: 'team-plan-workspace-document' }>) => void
  applyArtifacts: (message: Extract<ServerMessage, { type: 'team-plan-workspace-artifacts' }>) => void
  applyBindings: (message: Extract<ServerMessage, { type: 'team-plan-workspace-bindings' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'team-plan-workspace-result' }>) => void
}

const update = (state: PlanWorkspaceState, teamKey: string, patch: Partial<PlanWorkspaceView>) => {
  const view = state.views[teamKey]
  if (!view) return state
  return { views: { ...state.views, [teamKey]: { ...view, ...patch } } }
}

export const useTeamPlanWorkspaceStore = create<PlanWorkspaceState>(set => ({
  views: {},
  teamBindings: {},
  roles: {},
  panes: {},
  open: (teamKey, planId) => set(state => {
    const view = state.views[teamKey]
    if (view?.planId === planId) return state
    return { views: { ...state.views, [teamKey]: emptyView(planId) } }
  }),
  close: teamKey => set(state => {
    if (!state.views[teamKey]) return state
    const views = { ...state.views }
    delete views[teamKey]
    return { views }
  }),
  rekey: (from, to) => set(state => {
    if (from === to) return state
    const view = state.views[from]
    const bindings = state.teamBindings[from]
    const role = state.roles[from]
    const panes = state.panes[from]
    if (view === undefined && bindings === undefined && role === undefined && panes === undefined) return state
    const views = { ...state.views }
    const teamBindings = { ...state.teamBindings }
    const roles = { ...state.roles }
    const paneMap = { ...state.panes }
    if (view) {
      delete views[from]
      if (!views[to]) views[to] = view
    }
    if (bindings) {
      delete teamBindings[from]
      if (!teamBindings[to]) teamBindings[to] = bindings
    }
    if (role !== undefined) {
      delete roles[from]
      if (!roles[to]) roles[to] = role
    }
    if (panes !== undefined) {
      delete paneMap[from]
      if (!paneMap[to]) paneMap[to] = panes
    }
    return { views, teamBindings, roles, panes: paneMap }
  }),
  setVersion: (teamKey, version) => set(state => update(state, teamKey, { version })),
  setExecution: (teamKey, executionId) => set(state => update(state, teamKey, { executionId })),
  toggleExpanded: (teamKey, change) => set(state => {
    const view = state.views[teamKey]
    if (!view) return state
    const expanded = view.expanded.includes(change)
      ? view.expanded.filter(name => name !== change)
      : [...view.expanded, change]
    return update(state, teamKey, { expanded })
  }),
  selectChange: (teamKey, change) => set(state => update(state, teamKey, { selectedChange: change })),
  openDocument: (teamKey, selection) => set(state => update(state, teamKey, { selectedDocument: selection })),
  setFilter: (teamKey, filter) => set(state => update(state, teamKey, { filter })),
  setRole: (teamKey, role) => set(state => {
    if (state.roles[teamKey] === role) return state
    return { roles: { ...state.roles, [teamKey]: role } }
  }),
  setReaderFraction: (teamKey, fraction) => set(state => {
    const panes = state.panes[teamKey] ?? defaultPanes()
    const next = clampFraction(fraction)
    if (panes.readerFraction === next) return state
    return { panes: { ...state.panes, [teamKey]: { ...panes, readerFraction: next } } }
  }),
  setExpandedPane: (teamKey, pane) => set(state => {
    const panes = state.panes[teamKey] ?? defaultPanes()
    if (panes.expandedPane === pane) return state
    return { panes: { ...state.panes, [teamKey]: { ...panes, expandedPane: pane } } }
  }),
  setNarrowPane: (teamKey, pane) => set(state => {
    const panes = state.panes[teamKey] ?? defaultPanes()
    if (panes.narrowPane === pane) return state
    return { panes: { ...state.panes, [teamKey]: { ...panes, narrowPane: pane } } }
  }),
  setConversationOpen: (teamKey, open) => set(state => {
    const panes = state.panes[teamKey] ?? defaultPanes()
    if (panes.conversationOpen === open) return state
    return { panes: { ...state.panes, [teamKey]: { ...panes, conversationOpen: open } } }
  }),
  setUrlNotice: (teamKey, notice) => set(state => {
    if (state.views[teamKey]?.urlNotice === notice) return state
    return update(state, teamKey, { urlNotice: notice })
  }),
  begin: (teamKey, requestId, command) => set(state => update(state, teamKey, {
    pending: { ...state.views[teamKey]?.pending, [requestId]: command }, error: null,
  })),
  reconnected: teamKey => set(state => {
    const view = state.views[teamKey]
    if (!view || Object.keys(view.pending).length === 0) return state
    return update(state, teamKey, { pending: {} })
  }),
  applySnapshot: message => set(state => {
    const key = routedTeamPath(message.teamPath, state.views)
    const view = state.views[key]
    // The snapshot's bindings reconcile into the team slot like a push (Q1).
    const merged = mergeBindings(state.teamBindings[key], message.workspace.bindings)
    const teamBindings = state.teamBindings[key] === merged
      ? state.teamBindings : { ...state.teamBindings, [key]: merged }
    if (!view || view.planId !== message.planId) return { teamBindings }
    return { teamBindings, ...update(state, key, { snapshot: message.workspace, teamId: message.teamId }) }
  }),
  applyChecklist: message => set(state => {
    const key = routedTeamPath(message.teamPath, state.views)
    const view = state.views[key]
    if (!view || view.planId !== message.planId) return state
    return update(state, key, {
      checklists: { ...view.checklists, [message.changeName]: { checklist: message.checklist, unavailable: message.unavailable } },
    })
  }),
  applyDocument: message => set(state => {
    const key = routedTeamPath(message.teamPath, state.views)
    const view = state.views[key]
    if (!view || view.planId !== message.planId) return state
    const keyId = documentKey({ worktreeId: message.worktreeId, relativePath: message.relativePath })
    return update(state, key, { documents: { ...view.documents, [keyId]: message.view } })
  }),
  applyArtifacts: message => set(state => {
    const key = routedTeamPath(message.teamPath, state.views)
    const view = state.views[key]
    if (!view || view.planId !== message.planId) return state
    return update(state, key, {
      artifacts: { ...view.artifacts, [message.changeName]: message.view },
    })
  }),
  applyBindings: message => set(state => {
    const key = routedTeamPath(message.teamPath, state.views)
    const merged = mergeBindings(state.teamBindings[key], message.bindings)
    if (state.teamBindings[key] === merged) return state
    return { teamBindings: { ...state.teamBindings, [key]: merged } }
  }),
  applyResult: message => set(state => {
    const key = routedTeamPath(message.teamPath, state.views)
    const view = state.views[key]
    if (!view || !(message.requestId in view.pending)) return state
    const pending = { ...view.pending }
    delete pending[message.requestId]
    if (message.error) {
      return update(state, key, { pending, error: message.error })
    }
    // A committed bind or reference change arrives again in the re-pushed
    // snapshot, so the result only settles the request.
    return update(state, key, { pending, error: null })
  }),
}))
