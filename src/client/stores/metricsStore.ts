// Per-team Metrics tab snapshots (team-process-metrics D5). The server
// computes metrics at read time and sends one authoritative snapshot per
// open, refresh, and report commit; this store keeps the newest one for the
// window and slice the tab last asked for, and drops a late snapshot for an
// earlier request so a quick window switch never flashes stale numbers.
// Window, slice, and collapsed families live in `teamWorkspaceStore`
// (memory only, per team); this store holds server data and the human's
// proposal commands (team-process-metrics D6): each action slot (`decide:<id>`
// or `link:<id>`) arms one command key, reused while its payload is unchanged
// (a resend after a lost result replays), re-minted after a payload change,
// and retired on success; a refusal stays on the slot. Closing the view (its
// cleanup runs on every reconnect) clears waiting slots, so a lost result
// never leaves a card busy. A report outside the snapshot, opened by id,
// lands in `opened` (null when the team has none) and is dropped on close.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { MetricSlice, MetricWindow, ProcessMetrics } from '@shared/processMetrics'
import type { ProcessReport, ReportFreshness, VersionChange } from '@shared/processReports'

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
  /** The newest reports plus older ones with work left, with their proposals' derived state. */
  reports: ProcessReport[]
  freshness: ReportFreshness[]
  /** Version changes in the requested window no accepted proposal's link names. */
  unproposed: VersionChange[]
  /** Armed proposal commands by slot (`decide:<id>`, `link:<id>`). */
  commands: Record<string, ProposalCommand>
  /** Reports opened by id; null when the team has no such report, absent while loading. */
  opened: Record<string, ProcessReport | null>
}

export interface ProposalCommand {
  commandId: string
  /** The payload the key was armed for, serialized. */
  payload: string
  busy: boolean
  error: string | null
}

export const closedMetricsView = (): MetricsView => ({
  open: false, loading: false, requested: null, metrics: null, reports: [], freshness: [], unproposed: [], commands: {}, opened: {},
})

const mintCommandId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `cmd-${Date.now()}-${Math.random()}`)

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
  /** Arm (or reuse) the slot's command key for `payload` and mark it busy; returns the key. */
  arm: (teamKey: string, slot: string, payload: unknown) => string
  applyResult: (message: Extract<ServerMessage, { type: 'process-proposal-result' }>) => void
  applyReport: (message: Extract<ServerMessage, { type: 'process-report-detail' }>) => void
  /** Drop a report opened by id (the view closed it). */
  forgetReport: (teamKey: string, reportId: string) => void
}

export const useMetricsStore = create<MetricsState>((set, get) => ({
  views: {},
  request: (teamKey, request) => set(state => {
    const view = state.views[teamKey] ?? closedMetricsView()
    return { views: { ...state.views, [teamKey]: { ...view, open: true, loading: true, requested: request } } }
  }),
  close: teamKey => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    const commands = Object.fromEntries(Object.entries(view.commands).map(([slot, command]) => [slot, { ...command, busy: false }]))
    return { views: { ...state.views, [teamKey]: { ...view, open: false, loading: false, commands } } }
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
    return { views: { ...state.views, [message.teamPath]: {
      ...view, loading: false, metrics: message.metrics, reports: message.reports, freshness: message.freshness, unproposed: message.unproposed,
    } } }
  }),
  arm: (teamKey, slot, payload) => {
    const serialized = JSON.stringify(payload)
    const view = get().views[teamKey] ?? closedMetricsView()
    const current = view.commands[slot]
    const commandId = current && current.payload === serialized ? current.commandId : mintCommandId()
    set(state => {
      const latest = state.views[teamKey] ?? closedMetricsView()
      return { views: { ...state.views, [teamKey]: {
        ...latest, commands: { ...latest.commands, [slot]: { commandId, payload: serialized, busy: true, error: null } },
      } } }
    })
    return commandId
  },
  applyResult: message => set(state => {
    const view = state.views[message.teamPath]
    const slot = view && Object.keys(view.commands).find(key => view.commands[key]!.commandId === message.commandId)
    if (!view || !slot) return state
    const commands = { ...view.commands }
    if (message.error) commands[slot] = { ...commands[slot]!, busy: false, error: message.error }
    else delete commands[slot]
    return { views: { ...state.views, [message.teamPath]: { ...view, commands } } }
  }),
  applyReport: message => set(state => {
    const view = state.views[message.teamPath] ?? closedMetricsView()
    return { views: { ...state.views, [message.teamPath]: { ...view, opened: { ...view.opened, [message.reportId]: message.report } } } }
  }),
  forgetReport: (teamKey, reportId) => set(state => {
    const view = state.views[teamKey]
    if (!view || !(reportId in view.opened)) return state
    const opened = { ...view.opened }
    delete opened[reportId]
    return { views: { ...state.views, [teamKey]: { ...view, opened } } }
  }),
}))
