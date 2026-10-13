// Per-chat product strategy views (product-strategy 5.1): the team's
// strategy snapshot (null record = the capture affordance), its full
// detail, and in-flight human actions. Server snapshots are authoritative
// and replace local state whole; closed views ignore late pushes. A CAS
// conflict keeps the caller's text client-side — the store records the
// stored draft for display until the author explicitly adopts it (S12).
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { ProductStrategy, StrategyDetail, StrategyDraft } from '@shared/productStrategy'

export type StrategyAction = 'save' | 'submit' | 'approve' | 'withdraw'

export interface StrategyView {
  open: boolean
  loading: boolean
  /** The team's strategy record; null until a snapshot says whether one exists. */
  strategy: ProductStrategy | null
  /** True once the first snapshot arrived — distinguishes loading from "no record". */
  seen: boolean
  detail: StrategyDetail | null
  /** The revision whose review/approve panel is expanded; null = none. */
  reviewing: number | null
  /** Actions awaiting their `strategy-result`, by request id. */
  pending: Record<string, StrategyAction>
  /** The last refused action's message, until the next action or reopen. */
  error: string | null
  /** The stored draft a CAS refusal returned, for reconciliation. */
  conflict: StrategyDraft | null
}

export const closedStrategyView = (): StrategyView => ({
  open: false, loading: false, strategy: null, seen: false, detail: null, reviewing: null, pending: {}, error: null, conflict: null,
})

interface StrategyState {
  views: Record<string, StrategyView>
  open: (sessionId: string) => void
  close: (sessionId: string) => void
  review: (sessionId: string, revision: number | null) => void
  /** Reload after a CAS refusal: the stored draft it returned replaces the stale copy in detail. */
  adoptConflict: (sessionId: string) => void
  begin: (sessionId: string, requestId: string, action: StrategyAction) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'strategy-snapshot' }>) => void
  applyDetail: (message: Extract<ServerMessage, { type: 'strategy-detail' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'strategy-result' }>) => void
}

const update = (state: StrategyState, sessionId: string, patch: Partial<StrategyView>) => {
  const view = state.views[sessionId]
  if (!view?.open) return state
  return { views: { ...state.views, [sessionId]: { ...view, ...patch } } }
}

export const useStrategyStore = create<StrategyState>(set => ({
  views: {},
  open: sessionId => set(state => {
    const view = state.views[sessionId] ?? closedStrategyView()
    return { views: { ...state.views, [sessionId]: { ...view, open: true, loading: !view.seen, error: null, conflict: null } } }
  }),
  close: sessionId => set(state => {
    const views = { ...state.views }
    delete views[sessionId]
    return { views }
  }),
  review: (sessionId, revision) => set(state => update(state, sessionId, { reviewing: revision })),
  // A draft written behind this client (another editor, another tab) sends
  // no detail push, so the refusal's stored draft is the freshest server
  // copy; adopting it rebases the editor and its next save's CAS hash.
  adoptConflict: sessionId => set(state => {
    const view = state.views[sessionId]
    const stored = view?.conflict
    if (!stored || !view.detail) return update(state, sessionId, { conflict: null, error: null })
    const drafts = [...view.detail.drafts.filter(draft => draft.draftId !== stored.draftId), stored]
    return update(state, sessionId, { detail: { ...view.detail, drafts }, conflict: null, error: null })
  }),
  begin: (sessionId, requestId, action) => set(state => update(state, sessionId, {
    pending: { ...state.views[sessionId]?.pending, [requestId]: action }, error: null, conflict: null,
  })),
  applySnapshot: message => set(state => update(state, message.sessionId, {
    loading: false, seen: true, strategy: message.strategy,
    // A vanished record (never happens today) stops showing stale detail.
    detail: message.strategy ? state.views[message.sessionId]?.detail ?? null : null,
    reviewing: message.strategy ? state.views[message.sessionId]?.reviewing ?? null : null,
  })),
  applyDetail: message => set(state => update(state, message.sessionId, { detail: message.detail })),
  applyResult: message => set(state => {
    const view = state.views[message.sessionId]
    if (!view?.open) return state
    const pending = { ...view.pending }
    delete pending[message.requestId]
    if (message.error) {
      return update(state, message.sessionId, {
        pending, error: message.error, ...(message.conflict !== undefined ? { conflict: message.conflict } : {}),
      })
    }
    return update(state, message.sessionId, { pending, error: null, conflict: null })
  }),
}))
