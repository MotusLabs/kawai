// Per-team Audit views (execution-safety-recovery D9): the current page
// (rows newest first, the range's counts, the Load-more cursor, the backup
// status footer), the filters, the selected call, in-flight requests, and
// the acknowledge dialog's command id. Server pages are authoritative:
// a `team-audit-changed` push marks the view stale and the host re-requests
// its first page (replace semantics), so no delta merge exists here. A page
// reply whose request id is no longer the one this view waits for — a
// filter change or a stale more — is dropped. The acknowledge dialog mints
// its command id when it opens and keeps it while the payload is unchanged,
// so a resend after a lost result replays on the server (D10); success
// retires it, a refusal marks it so the same command is not re-sent.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { OutboundAuditBackups, OutboundAuditCounts, OutboundAuditFilters, OutboundAuditRow } from '@shared/outbound'

export type AuditAction = 'page' | 'more' | 'acknowledge'

/** The acknowledge dialog's armed command id and the payload last sent with it. */
export interface ArmedAuditCommand {
  commandId: string
  payload: string | null
  /** The server refused it; only reopening the dialog (a new command) can try again. */
  refused?: boolean
}

export interface AuditView {
  open: boolean
  loading: boolean
  /** null until the first page. */
  rows: OutboundAuditRow[] | null
  counts: OutboundAuditCounts | null
  cursor: string | null
  /** The backup status footer's facts, from the latest page. */
  backups: OutboundAuditBackups | null
  loadingMore: boolean
  filters: OutboundAuditFilters
  /** The URL's selected call id. */
  selected: string | null
  /** Requests awaiting their reply, by request id. */
  pending: Record<string, AuditAction>
  /** The page generation each request was minted at, by request id. */
  requestGenerations: Record<string, number>
  /** Bumped on every team-audit-changed; the host re-requests the first page. */
  changed: number
  /**
   * The latest first-page request's generation: a `more` appends only while
   * its own generation still matches, so a stale more of a superseded page
   * never lands in the new one.
   */
  pageGeneration: number
  /** A page-level notice (an unknown or other-team call id in the URL), until the next request. */
  notice: string | null
  error: string | null
  /** The acknowledge dialog's armed command (single slot). */
  command: ArmedAuditCommand | null
  commandRequest: string | null
}

export const closedAuditView = (): AuditView => ({
  open: false, loading: false, rows: null, counts: null, cursor: null, backups: null, loadingMore: false,
  filters: {}, selected: null, pending: {}, requestGenerations: {}, changed: 0, pageGeneration: 0,
  notice: null, error: null, command: null, commandRequest: null,
})

interface AuditState {
  views: Record<string, AuditView>
  open: (teamKey: string, callId?: string) => void
  close: (teamKey: string) => void
  rekey: (from: string, to: string) => void
  select: (teamKey: string, callId: string | null) => void
  setFilters: (teamKey: string, filters: OutboundAuditFilters) => void
  /** The dialog opened: mint its command id (a reopened dialog is a new command). */
  arm: (teamKey: string) => void
  disarm: (teamKey: string) => void
  /** The command id to send with `payload`: the armed one unless the payload changed. */
  command: (teamKey: string, payload: string, requestId: string) => string
  begin: (teamKey: string, requestId: string, action: AuditAction) => void
  /** The connection came back: results of pending requests are lost, so stop waiting. */
  reconnected: (teamKey: string) => void
  applyPage: (message: Extract<ServerMessage, { type: 'team-audit-page' }>) => void
  applyChanged: (message: Extract<ServerMessage, { type: 'team-audit-changed' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'team-audit-result' }>) => void
}

const update = (state: AuditState, teamKey: string, patch: Partial<AuditView>) => {
  const view = state.views[teamKey]
  if (!view?.open) return state
  return { views: { ...state.views, [teamKey]: { ...view, ...patch } } }
}

export const useTeamAuditStore = create<AuditState>(set => ({
  views: {},
  open: (teamKey, callId) => set(state => {
    const view = state.views[teamKey] ?? closedAuditView()
    return { views: { ...state.views, [teamKey]: {
      ...view, open: true, loading: view.rows === null,
      ...(callId !== undefined ? { selected: callId } : {}),
    } } }
  }),
  close: teamKey => set(state => {
    const views = { ...state.views }
    delete views[teamKey]
    return { views }
  }),
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
  select: (teamKey, callId) => set(state => update(state, teamKey, {
    selected: callId,
    // Leaving the call id in the URL returns to the default view: the
    // group's filters came from that call, so they go with it.
    ...(callId === null ? { filters: {} } : {}),
  })),
  setFilters: (teamKey, filters) => set(state => update(state, teamKey, {
    filters, rows: null, counts: null, cursor: null, loading: true, error: null,
  })),
  arm: teamKey => set(state => update(state, teamKey, {
    command: { commandId: crypto.randomUUID(), payload: null }, error: null,
  })),
  disarm: teamKey => set(state => update(state, teamKey, { command: null })),
  command: (teamKey, payload, requestId) => {
    let commandId: string = crypto.randomUUID()
    set(state => {
      const view = state.views[teamKey]
      if (!view?.open) return state
      const armed = view.command
      if (armed && (armed.payload === null || armed.payload === payload)) commandId = armed.commandId
      return update(state, teamKey, {
        command: { commandId, payload }, commandRequest: requestId,
      })
    })
    return commandId
  },
  begin: (teamKey, requestId, action) => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    // A new first page supersedes every page or more in flight: their
    // replies land nowhere (the generations no longer match). Acknowledge
    // requests are independent of paging and survive it.
    const surviving = Object.fromEntries(Object.entries(view.pending).filter(([, kind]) => kind === 'acknowledge'))
    const pending = action === 'page'
      ? { ...surviving, [requestId]: action }
      : { ...view.pending, [requestId]: action }
    const generations = action === 'page'
      ? { ...view.requestGenerations, [requestId]: view.pageGeneration + 1 }
      : { ...view.requestGenerations, [requestId]: view.pageGeneration }
    return update(state, teamKey, {
      pending,
      requestGenerations: generations,
      ...(action === 'page' ? { pageGeneration: view.pageGeneration + 1, loading: true, error: null, notice: null } : {}),
      ...(action === 'more' ? { loadingMore: true } : {}),
      ...(action === 'acknowledge' ? { error: null } : {}),
    })
  }),
  reconnected: teamKey => set(state => {
    const view = state.views[teamKey]
    if (!view?.open || Object.keys(view.pending).length === 0) return state
    return update(state, teamKey, {
      pending: {}, requestGenerations: {},
      loadingMore: false,
      ...(view.rows === null ? { loading: true } : {}),
    })
  }),
  applyPage: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    const action = view.pending[message.requestId]
    if (action === undefined) return state
    // A more whose page was superseded meanwhile appends to nothing.
    if (action === 'more' && view.requestGenerations[message.requestId] !== view.pageGeneration) {
      const pending = { ...view.pending }
      delete pending[message.requestId]
      return update(state, message.teamPath, { pending, loadingMore: false })
    }
    const pending = { ...view.pending }
    delete pending[message.requestId]
    const requestGenerations = { ...view.requestGenerations }
    delete requestGenerations[message.requestId]
    if (action === 'more') {
      const rows = view.rows === null ? message.page.rows : [...view.rows, ...message.page.rows]
      return update(state, message.teamPath, {
        pending, requestGenerations, rows, counts: message.page.counts, cursor: message.page.cursor,
        backups: message.page.backups, loading: false, loadingMore: false,
      })
    }
    // A group open adopts the server-applied filters, so a changed push
    // re-requests the same group.
    return update(state, message.teamPath, {
      pending, requestGenerations, rows: message.page.rows, counts: message.page.counts, cursor: message.page.cursor,
      backups: message.page.backups, loading: false,
      // The new page superseded any more in flight: its spinner is gone.
      loadingMore: false,
      ...(message.appliedFilters !== undefined ? { filters: message.appliedFilters } : {}),
      notice: message.notice ?? null,
    })
  }),
  applyChanged: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    return update(state, message.teamPath, { changed: view.changed + 1 })
  }),
  applyResult: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open || !(message.requestId in view.pending)) return state
    const pending = { ...view.pending }
    delete pending[message.requestId]
    if (message.error) {
      const armed = view.command
      const command = armed && view.commandRequest === message.requestId ? { ...armed, refused: true } : armed
      return update(state, message.teamPath, { pending, command, error: message.error })
    }
    // Success retires the dialog's command: a later dialog is a new command.
    return update(state, message.teamPath, { pending, command: null, commandRequest: null, error: null })
  }),
}))
