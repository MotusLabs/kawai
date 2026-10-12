// Per-chat mailbox views follow selection and reconnect. A snapshot replaces
// stale rows; closed views ignore late pushes. Snapshots also carry the
// team's routing state (rule load status, decisions); a rules reload and a
// hand off answer with results the panel shows inline (profile routing).
import { create } from 'zustand'
import type { TeamRoutingState } from '@shared/routing'
import type { TeamMessage } from '@shared/team'
import type { ServerMessage } from '@shared/types'

export type RulesResult = Extract<ServerMessage, { type: 'team-mailbox-rules-result' }>
export type HandOffResult = Extract<ServerMessage, { type: 'team-mailbox-hand-off-result' }>

export interface MailboxView {
  open: boolean
  loading: boolean
  messages: TeamMessage[]
  routing?: TeamRoutingState
  /** Set while a reload is in flight. */
  reloading?: boolean
  rulesResult?: RulesResult
  handOffResult?: HandOffResult
}
export const closedMailbox = (): MailboxView => ({ open: false, loading: false, messages: [] })
interface MailboxState {
  views: Record<string, MailboxView>
  open: (sessionId: string) => void
  close: (sessionId: string) => void
  apply: (message: Extract<ServerMessage, { type: 'team-mailbox-snapshot' }>) => void
  beginReload: (sessionId: string) => void
  applyRulesResult: (message: RulesResult) => void
  applyHandOffResult: (message: HandOffResult) => void
}

const patch = (state: MailboxState, sessionId: string, update: Partial<MailboxView>) => state.views[sessionId]?.open
  ? { views: { ...state.views, [sessionId]: { ...state.views[sessionId]!, ...update } } }
  : state

export const useTeamMailboxStore = create<MailboxState>(set => ({
  views: {},
  open: id => set(state => ({ views: { ...state.views, [id]: { ...(state.views[id] ?? closedMailbox()), open: true, loading: true } } })),
  close: id => set(state => { const views = { ...state.views }; delete views[id]; return { views } }),
  apply: message => set(state => patch(state, message.sessionId, {
    loading: false, messages: message.messages, ...(message.routing ? { routing: message.routing } : {}),
  })),
  beginReload: id => set(state => patch(state, id, { reloading: true })),
  applyRulesResult: message => set(state => patch(state, message.sessionId, { reloading: false, rulesResult: message })),
  applyHandOffResult: message => set(state => patch(state, message.sessionId, { handOffResult: message })),
}))
