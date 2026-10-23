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
  WorkspaceArtifactsView, WorkspaceChecklist, WorkspaceChecklistUnavailable, WorkspaceDocumentView,
  WorkspaceSnapshot, WorkspaceVersionSelector,
} from '@shared/planWorkspace'
import { routedTeamPath } from '../utils/teamKeyAliases'

/** The WBS row filters (design D2): all, work in flight, or work waiting on a cause. */
export type WorkspaceFilter = 'all' | 'active' | 'blocked'
/** The keyed workspace commands (design D4/D6). */
export type WorkspaceCommand = 'bind' | 'ref-add' | 'ref-remove'

/** The document the reader displays: the subscription identity (design D4). */
export interface WorkspaceDocumentSelection {
  worktreeId: string
  relativePath: string
}

export const documentKey = (selection: WorkspaceDocumentSelection): string =>
  `${selection.worktreeId}\0${selection.relativePath}`

export interface PlanWorkspaceView {
  planId: string
  /** The open's version selector; null = the default (approved, else newest in review, else newest draft). */
  version: WorkspaceVersionSelector | null
  /** The selected execution id; null = the latest execution (design D2). */
  executionId: string | null
  /** null until the first snapshot. */
  snapshot: WorkspaceSnapshot | null
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
  planId, version: null, executionId: null, snapshot: null, checklists: {}, documents: {}, artifacts: {},
  pending: {}, error: null, expanded: [], selectedChange: null, selectedDocument: null, filter: 'all',
})

interface PlanWorkspaceState {
  views: Record<string, PlanWorkspaceView>
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
  begin: (teamKey: string, requestId: string, command: WorkspaceCommand) => void
  /** The connection came back: results of pending commands are lost, so stop waiting. */
  reconnected: (teamKey: string) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'team-plan-workspace-snapshot' }>) => void
  applyChecklist: (message: Extract<ServerMessage, { type: 'team-plan-workspace-checklist' }>) => void
  applyDocument: (message: Extract<ServerMessage, { type: 'team-plan-workspace-document' }>) => void
  applyArtifacts: (message: Extract<ServerMessage, { type: 'team-plan-workspace-artifacts' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'team-plan-workspace-result' }>) => void
}

const update = (state: PlanWorkspaceState, teamKey: string, patch: Partial<PlanWorkspaceView>) => {
  const view = state.views[teamKey]
  if (!view) return state
  return { views: { ...state.views, [teamKey]: { ...view, ...patch } } }
}

export const useTeamPlanWorkspaceStore = create<PlanWorkspaceState>(set => ({
  views: {},
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
    if (!view) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
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
    if (!view || view.planId !== message.planId) return state
    return update(state, key, { snapshot: message.workspace })
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
