// Per-team mailbox views follow selection and reconnect. A snapshot replaces
// stale rows; closed views ignore late pushes. Snapshots also carry the
// team's routing state (rule load status, decisions) and, additively, the
// per-message waiting reasons and the worktree occupancy roster
// (team-waiting-reasons D3/D4) — a reason-only re-publish updates the view
// with no row change; a rules reload and a hand off answer with results the
// panel shows inline (profile routing).
import { create } from 'zustand'
import type { TeamRoutingState } from '@shared/routing'
import type { TeamMessage, TeamWorktreeOccupancy, WaitingReason } from '@shared/team'
import type { ServerMessage } from '@shared/types'

export type RulesResult = Extract<ServerMessage, { type: 'team-mailbox-rules-result' }>
export type HandOffResult = Extract<ServerMessage, { type: 'team-mailbox-hand-off-result' }>

export interface MailboxView {
  open: boolean
  loading: boolean
  messages: TeamMessage[]
  routing?: TeamRoutingState
  /** Per-message waiting reasons, keyed by message id (in-memory, additive). */
  waiting?: Record<string, WaitingReason>
  /** Live sessions per worktree plus pending spawns (occupancy read model). */
  worktrees?: TeamWorktreeOccupancy[]
  /** Set while a reload is in flight. */
  reloading?: boolean
  rulesResult?: RulesResult
  handOffResult?: HandOffResult
}
export const closedMailbox = (): MailboxView => ({ open: false, loading: false, messages: [] })
interface MailboxState {
  views: Record<string, MailboxView>
  open: (teamKey: string) => void
  close: (teamKey: string) => void
  /**
   * Move a view to the chat's new team key (team-workspace-pages D2): a key
   * changes when workspace discovery first places the chat in a repository.
   * A view already open under the new key wins; the old one is dropped.
   */
  rekey: (from: string, to: string) => void
  apply: (message: Extract<ServerMessage, { type: 'team-mailbox-snapshot' }>) => void
  beginReload: (teamKey: string) => void
  applyRulesResult: (message: RulesResult) => void
  applyHandOffResult: (message: HandOffResult) => void
}

const patch = (state: MailboxState, teamKey: string, update: Partial<MailboxView>) => state.views[teamKey]?.open
  ? { views: { ...state.views, [teamKey]: { ...state.views[teamKey]!, ...update } } }
  : state

export const useTeamMailboxStore = create<MailboxState>(set => ({
  views: {},
  open: id => set(state => ({ views: { ...state.views, [id]: { ...(state.views[id] ?? closedMailbox()), open: true, loading: true } } })),
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
  close: id => set(state => { const views = { ...state.views }; delete views[id]; return { views } }),
  apply: message => set(state => patch(state, message.teamPath, {
    loading: false, messages: message.messages,
    ...(message.routing ? { routing: message.routing } : {}),
    ...(message.waiting ? { waiting: message.waiting } : {}),
    ...(message.worktrees ? { worktrees: message.worktrees } : {}),
  })),
  beginReload: id => set(state => patch(state, id, { reloading: true })),
  applyRulesResult: message => set(state => patch(state, message.teamPath, { reloading: false, rulesResult: message })),
  applyHandOffResult: message => set(state => patch(state, message.teamPath, { handOffResult: message })),
}))
