// Per-chat mailbox views follow selection and reconnect. A snapshot replaces
// stale rows; closed views ignore late pushes.
import { create } from 'zustand'
import type { TeamMessage } from '@shared/team'
import type { ServerMessage } from '@shared/types'

export interface MailboxView { open: boolean; loading: boolean; messages: TeamMessage[] }
export const closedMailbox = (): MailboxView => ({ open: false, loading: false, messages: [] })
interface MailboxState {
  views: Record<string, MailboxView>
  open: (sessionId: string) => void
  close: (sessionId: string) => void
  apply: (message: Extract<ServerMessage, { type: 'team-mailbox-snapshot' }>) => void
}
export const useTeamMailboxStore = create<MailboxState>(set => ({
  views: {},
  open: id => set(state => ({ views: { ...state.views, [id]: { ...(state.views[id] ?? closedMailbox()), open: true, loading: true } } })),
  close: id => set(state => { const views = { ...state.views }; delete views[id]; return { views } }),
  apply: message => set(state => state.views[message.sessionId]?.open ? {
    views: { ...state.views, [message.sessionId]: { open: true, loading: false, messages: message.messages } },
  } : state),
}))
