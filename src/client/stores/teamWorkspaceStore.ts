// Per-team Team page view state (team-workspace-pages D8): each tab's
// `search`, `filters`, `expanded` row ids, and `collapsedSections`, keyed by
// team key and tab. Memory only — never sent to the server, never persisted —
// and nothing resets it on tab switches, chat visits, or reconnects, so each
// tab keeps its state for as long as the browser tab is open and two teams
// never share it. The store also records each team's last-used tab (the
// header Team button reopens it; Tasks the first time) and the fallback
// notice for an unknown repository or a missing item (D3).
import { create } from 'zustand'
import {
  DEFAULT_WORKSPACE_TAB,
  WORKSPACE_TABS,
  type WorkspaceTab,
} from '../utils/teamLocation'

export interface TeamTabViewState {
  search: string
  filters: Record<string, string | boolean>
  /** Expanded row, thread, or task ids. */
  expanded: string[]
  /** Collapsed section names (list sections and task-detail sections). */
  collapsedSections: string[]
}

/** The bands open until the human changes them: attention yes, summary no. */
export const DEFAULT_OPEN_BANDS: readonly string[] = ['attention']

export const emptyTabViewState = (): TeamTabViewState => ({
  search: '',
  filters: {},
  expanded: [],
  collapsedSections: [],
})

export interface TeamWorkspaceViewState {
  /** True while the team's Team page is the rendered route. */
  open: boolean
  /** The last tab used for this team; the Team button reopens it. */
  tab: WorkspaceTab
  tabs: Record<WorkspaceTab, TeamTabViewState>
  /** Page bands (attention, summary) the human expanded; attention starts open. */
  openBands?: string[]
  /** The D3 fallback notice (unknown repository, missing item); null = none. */
  notice: string | null
}

export const closedWorkspaceView = (): TeamWorkspaceViewState => ({
  open: false,
  tab: DEFAULT_WORKSPACE_TAB,
  tabs: Object.fromEntries(WORKSPACE_TABS.map(tab => [tab, emptyTabViewState()])) as Record<WorkspaceTab, TeamTabViewState>,
  notice: null,
})

interface TeamWorkspaceState {
  views: Record<string, TeamWorkspaceViewState>
  /** Mark the team's page open; existing view state is kept (D8). */
  open: (teamKey: string) => void
  /**
   * Mark the team's page closed. State stays: a chat visit or a later return
   * finds the same search, filters, and expansion until the browser tab closes.
   */
  close: (teamKey: string) => void
  /**
   * Move the view to the chat's new team key (team-workspace-pages D2), like
   * every other team store; a view already under the new key wins.
   */
  rekey: (from: string, to: string) => void
  /** Record the last-used tab. */
  setTab: (teamKey: string, tab: WorkspaceTab) => void
  setSearch: (teamKey: string, tab: WorkspaceTab, search: string) => void
  /** Merge a filter patch; an `undefined` value drops its key. */
  setFilters: (teamKey: string, tab: WorkspaceTab, patch: Record<string, string | boolean | undefined>) => void
  toggleExpanded: (teamKey: string, tab: WorkspaceTab, id: string) => void
  /** Replace the expanded list (Expand all / Collapse all). */
  setExpanded: (teamKey: string, tab: WorkspaceTab, ids: string[]) => void
  toggleSectionCollapsed: (teamKey: string, tab: WorkspaceTab, section: string) => void
  /** Replace the collapsed set (a tab's default section state on first open). */
  setCollapsedSections: (teamKey: string, tab: WorkspaceTab, sections: string[]) => void
  /** Expand or collapse one of the page's bands (attention, summary). */
  toggleBand: (teamKey: string, band: string) => void
  setNotice: (teamKey: string, notice: string | null) => void
}

const patchTab = (
  state: TeamWorkspaceState,
  teamKey: string,
  tab: WorkspaceTab,
  update: (view: TeamTabViewState) => TeamTabViewState,
): Partial<TeamWorkspaceState> => {
  // Tab state is lazily created: a view hosted outside the Team page (the
  // chat side slot, a task embed) keeps its per-tab state too (D8).
  const view = state.views[teamKey] ?? closedWorkspaceView()
  return { views: { ...state.views, [teamKey]: { ...view, tabs: { ...view.tabs, [tab]: update(view.tabs[tab] ?? emptyTabViewState()) } } } }
}

export const useTeamWorkspaceStore = create<TeamWorkspaceState>(set => ({
  views: {},
  open: teamKey => set(state => {
    const view = state.views[teamKey] ?? closedWorkspaceView()
    if (view.open) return state
    return { views: { ...state.views, [teamKey]: { ...view, open: true } } }
  }),
  close: teamKey => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    return { views: { ...state.views, [teamKey]: { ...view, open: false } } }
  }),
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
  setTab: (teamKey, tab) => set(state => {
    const view = state.views[teamKey]
    if (!view || view.tab === tab) return state
    return { views: { ...state.views, [teamKey]: { ...view, tab } } }
  }),
  setSearch: (teamKey, tab, search) => set(state => patchTab(state, teamKey, tab, view => ({ ...view, search }))),
  setFilters: (teamKey, tab, patch) => set(state => patchTab(state, teamKey, tab, view => {
    const filters = { ...view.filters }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete filters[key]
      else filters[key] = value
    }
    return { ...view, filters }
  })),
  toggleExpanded: (teamKey, tab, id) => set(state => patchTab(state, teamKey, tab, view => ({
    ...view,
    expanded: view.expanded.includes(id) ? view.expanded.filter(entry => entry !== id) : [...view.expanded, id],
  }))),
  setExpanded: (teamKey, tab, ids) => set(state => patchTab(state, teamKey, tab, view => ({ ...view, expanded: ids }))),
  toggleSectionCollapsed: (teamKey, tab, section) => set(state => patchTab(state, teamKey, tab, view => ({
    ...view,
    collapsedSections: view.collapsedSections.includes(section)
      ? view.collapsedSections.filter(entry => entry !== section)
      : [...view.collapsedSections, section],
  }))),
  setCollapsedSections: (teamKey, tab, sections) => set(state => patchTab(state, teamKey, tab, view => ({
    ...view, collapsedSections: sections,
  }))),
  toggleBand: (teamKey, band) => set(state => {
    const view = state.views[teamKey] ?? closedWorkspaceView()
    const current = view.openBands ?? DEFAULT_OPEN_BANDS
    const openBands = current.includes(band) ? current.filter(entry => entry !== band) : [...current, band]
    return { views: { ...state.views, [teamKey]: { ...view, openBands } } }
  }),
  setNotice: (teamKey, notice) => set(state => {
    const view = state.views[teamKey]
    if (!view || view.notice === notice) return state
    return { views: { ...state.views, [teamKey]: { ...view, notice } } }
  }),
}))
