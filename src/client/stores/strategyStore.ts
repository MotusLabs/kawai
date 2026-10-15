// Per-team product strategy views (product-strategy 5.1): the team's
// strategy snapshot (null record = the capture affordance), its full
// detail, and in-flight human actions. Server snapshots are authoritative
// and replace local state whole; closed views ignore late pushes. A CAS
// conflict keeps the caller's text client-side — the store records the
// stored draft for display until the author explicitly adopts it (S12).
// The impact review (strategy-revision-impact D9) rides the detail push;
// its Decide and Ask to assess dialogs mint a command id when they open
// (`armImpact`), reuse it while the payload they send is unchanged — so a
// resend after a lost result replays on the server — re-mint after a payload
// change, and retire it on success. Their refusals show in the dialog, not
// the view banner. Every (re)open drops waiting requests: a result lost with
// the connection never leaves the view busy.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { ProductStrategy, StrategyContent, StrategyDetail, StrategyDraft } from '@shared/productStrategy'
import type { StrategyImpactDetail } from '@shared/strategyImpact'

export type StrategyAction = 'save' | 'submit' | 'approve' | 'withdraw' | 'decide' | 'request'

/** One impact dialog's command id and the payload it was last sent with (null = not sent yet). */
export interface ArmedImpactCommand {
  commandId: string
  payload: string | null
}

/**
 * The draft editor's unsaved text, held per team (team-workspace-pages D5)
 * so switching sub-views keeps it; a reload still drops it. `dirty` marks
 * text newer than the stored draft, so a push refresh never wipes it.
 */
export interface RetainedDraft {
  body: StrategyContent
  impact: string
  dirty: boolean
}

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
  /** The editor's unsaved text, kept across sub-view switches (D5). */
  retained: RetainedDraft | null
  /** The impact reviews and current assessment from the last detail push; null without a record. */
  impact: StrategyImpactDetail | null
  /** Armed impact dialog command ids, by dialog slot (e.g. `decide:<review>:<plan>`). */
  impactCommands: Record<string, ArmedImpactCommand>
  /** Which slot each pending impact request was sent from. */
  impactRequests: Record<string, string>
  /** The last refused impact command, shown in its dialog. */
  impactError: { slot: string; message: string } | null
  /** What the last assessment request sent, until the next impact command. */
  impactNotice: string | null
}

export const closedStrategyView = (): StrategyView => ({
  open: false, loading: false, strategy: null, seen: false, detail: null, reviewing: null, pending: {}, error: null, conflict: null, retained: null,
  impact: null, impactCommands: {}, impactRequests: {}, impactError: null, impactNotice: null,
})

interface StrategyState {
  views: Record<string, StrategyView>
  open: (teamKey: string) => void
  close: (teamKey: string) => void
  /**
   * Move a view to the chat's new team key (team-workspace-pages D2): a key
   * changes when workspace discovery first places the chat in a repository.
   * A view already open under the new key wins; the old one is dropped.
   */
  rekey: (from: string, to: string) => void
  review: (teamKey: string, revision: number | null) => void
  /** Keep the editor's unsaved text (D5); `null` drops it (after a reload). */
  retainDraft: (teamKey: string, retained: RetainedDraft | null) => void
  /** Reload after a CAS refusal: the stored draft it returned replaces the stale copy in detail. */
  adoptConflict: (teamKey: string) => void
  begin: (teamKey: string, requestId: string, action: StrategyAction) => void
  /** An impact dialog opened: mint its command id (a reopened dialog is a new command). */
  armImpact: (teamKey: string, slot: string) => void
  /** The command id to send from `slot` with `payload`: the armed one unless the payload changed. */
  impactCommand: (teamKey: string, slot: string, payload: string, requestId: string) => string
  applySnapshot: (message: Extract<ServerMessage, { type: 'strategy-snapshot' }>) => void
  applyDetail: (message: Extract<ServerMessage, { type: 'strategy-detail' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'strategy-result' }>) => void
}

const update = (state: StrategyState, teamKey: string, patch: Partial<StrategyView>) => {
  const view = state.views[teamKey]
  if (!view?.open) return state
  return { views: { ...state.views, [teamKey]: { ...view, ...patch } } }
}

export const useStrategyStore = create<StrategyState>(set => ({
  views: {},
  open: teamKey => set(state => {
    const view = state.views[teamKey] ?? closedStrategyView()
    // A (re)open is a new connection's subscription: earlier requests' results are lost.
    return { views: { ...state.views, [teamKey]: {
      ...view, open: true, loading: !view.seen, error: null, conflict: null, pending: {}, impactRequests: {}, impactError: null,
    } } }
  }),
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
  close: teamKey => set(state => {
    const views = { ...state.views }
    delete views[teamKey]
    return { views }
  }),
  review: (teamKey, revision) => set(state => update(state, teamKey, { reviewing: revision })),
  retainDraft: (teamKey, retained) => set(state => update(state, teamKey, { retained })),
  // A draft written behind this client (another editor, another tab) sends
  // no detail push, so the refusal's stored draft is the freshest server
  // copy; adopting it rebases the editor and its next save's CAS hash.
  adoptConflict: teamKey => set(state => {
    const view = state.views[teamKey]
    const stored = view?.conflict
    if (!stored || !view.detail) return update(state, teamKey, { conflict: null, error: null })
    const drafts = [...view.detail.drafts.filter(draft => draft.draftId !== stored.draftId), stored]
    return update(state, teamKey, { detail: { ...view.detail, drafts }, conflict: null, error: null })
  }),
  begin: (teamKey, requestId, action) => set(state => update(state, teamKey, {
    pending: { ...state.views[teamKey]?.pending, [requestId]: action }, error: null, conflict: null, impactError: null, impactNotice: null,
  })),
  armImpact: (teamKey, slot) => set(state => update(state, teamKey, {
    impactCommands: { ...state.views[teamKey]?.impactCommands, [slot]: { commandId: crypto.randomUUID(), payload: null } },
    impactError: null,
  })),
  impactCommand: (teamKey, slot, payload, requestId) => {
    let commandId: string = crypto.randomUUID()
    set(state => {
      const view = state.views[teamKey]
      if (!view?.open) return state
      const armed = view.impactCommands[slot]
      if (armed && (armed.payload === null || armed.payload === payload)) commandId = armed.commandId
      return update(state, teamKey, {
        impactCommands: { ...view.impactCommands, [slot]: { commandId, payload } },
        impactRequests: { ...view.impactRequests, [requestId]: slot },
      })
    })
    return commandId
  },
  applySnapshot: message => set(state => update(state, message.teamPath, {
    loading: false, seen: true, strategy: message.strategy,
    // A vanished record (never happens today) stops showing stale detail.
    detail: message.strategy ? state.views[message.teamPath]?.detail ?? null : null,
    reviewing: message.strategy ? state.views[message.teamPath]?.reviewing ?? null : null,
    impact: message.strategy ? state.views[message.teamPath]?.impact ?? null : null,
  })),
  // A push supersedes the refusal's snapshot: the conflict follows the
  // pushed stored draft (or goes with it), so the box always shows what
  // Reload will adopt and Reload never reinstates an older copy.
  applyDetail: message => set(state => {
    const conflict = state.views[message.teamPath]?.conflict
    const impact = message.impact ?? null
    if (!conflict) return update(state, message.teamPath, { detail: message.detail, impact })
    const stored = message.detail.drafts.find(draft => draft.draftId === conflict.draftId) ?? null
    return update(state, message.teamPath, { detail: message.detail, impact, conflict: stored })
  }),
  applyResult: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    const pending = { ...view.pending }
    delete pending[message.requestId]
    const slot = view.impactRequests[message.requestId]
    if (slot !== undefined) {
      const impactRequests = { ...view.impactRequests }
      delete impactRequests[message.requestId]
      if (message.error) return update(state, message.teamPath, { pending, impactRequests, impactError: { slot, message: message.error } })
      // Success retires the dialog's command: a later dialog is a new command.
      const impactCommands = { ...view.impactCommands }
      delete impactCommands[slot]
      const impactNotice = message.messageId ? `Assessment request sent (message ${message.messageId.slice(0, 8)}).` : null
      return update(state, message.teamPath, { pending, impactRequests, impactCommands, impactError: null, impactNotice })
    }
    if (message.error) {
      return update(state, message.teamPath, {
        pending, error: message.error, ...(message.conflict !== undefined ? { conflict: message.conflict } : {}),
      })
    }
    return update(state, message.teamPath, { pending, error: null, conflict: null })
  }),
}))
