// Per-team Metrics tab snapshots (team-process-metrics D5). The server
// computes metrics at read time and sends one authoritative snapshot per
// open, refresh, and report commit; this store keeps the newest one for the
// window and slice the tab last asked for, and drops a late snapshot for an
// earlier request so a quick window switch never flashes stale numbers.
// Window, slice, and collapsed families live in `teamWorkspaceStore`
// (memory only, per team); this store holds server data alone.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { MetricSlice, MetricWindow, ProcessMetrics } from '@shared/processMetrics'

export interface MetricsRequest {
  window: MetricWindow
  slice: MetricSlice | null
}

export interface MetricsView {
  open: boolean
  /** True from a request until its snapshot arrives. */
  loading: boolean
  requested: MetricsRequest | null
  /** The newest snapshot for `requested`; an earlier request's stays shown while loading. */
  metrics: ProcessMetrics | null
}

export const closedMetricsView = (): MetricsView => ({ open: false, loading: false, requested: null, metrics: null })

const sameRequest = (a: MetricsRequest | null, window: MetricWindow, slice: MetricSlice | null) =>
  a !== null && a.window === window && JSON.stringify(a.slice) === JSON.stringify(slice)

interface MetricsState {
  views: Record<string, MetricsView>
  /** The tab asked for a window and slice (an open or a refresh). */
  request: (teamKey: string, request: MetricsRequest) => void
  close: (teamKey: string) => void
  /** Move a view to the chat's new team key; a view already under the new key wins. */
  rekey: (from: string, to: string) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'process-metrics-snapshot' }>) => void
}

export const useMetricsStore = create<MetricsState>(set => ({
  views: {},
  request: (teamKey, request) => set(state => {
    const view = state.views[teamKey] ?? closedMetricsView()
    return { views: { ...state.views, [teamKey]: { ...view, open: true, loading: true, requested: request } } }
  }),
  close: teamKey => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    return { views: { ...state.views, [teamKey]: { ...view, open: false, loading: false } } }
  }),
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
  applySnapshot: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open || !sameRequest(view.requested, message.window, message.slice)) return state
    return { views: { ...state.views, [message.teamPath]: { ...view, loading: false, metrics: message.metrics } } }
  }),
}))
