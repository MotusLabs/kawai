// The chat side slot holds one panel at a time — Debug, Mailbox, Tasks,
// Messages, or Strategy (team-message-threads 5.4, product-strategy 5.1).
// Opening one closes the others; the Mailbox panel's own delivery operations
// are untouched by this, it only shares the slot. The open slot is derived
// from the panels' own stores (chat-header-layout D2): each store keeps its
// panel state, and `toggleSideSlot` is the single way the header opens and
// closes them, so adding a panel is one table entry.
import { useChatDebugStore } from '../../stores/chatDebugStore'
import { useStrategyStore } from '../../stores/strategyStore'
import { useTeamMailboxStore } from '../../stores/teamMailboxStore'
import { useTeamMessageStore } from '../../stores/teamMessageStore'
import { useTeamTaskStore } from '../../stores/teamTaskStore'

export type SideSlot = 'debug' | 'mailbox' | 'tasks' | 'messages' | 'strategy'

const SLOTS: Record<SideSlot, { open: (sessionId: string) => void; close: (sessionId: string) => void }> = {
  debug: {
    open: id => useChatDebugStore.getState().beginOpen(id),
    close: id => useChatDebugStore.getState().close(id),
  },
  mailbox: {
    open: id => useTeamMailboxStore.getState().open(id),
    close: id => useTeamMailboxStore.getState().close(id),
  },
  tasks: {
    open: id => useTeamTaskStore.getState().open(id),
    close: id => useTeamTaskStore.getState().close(id),
  },
  messages: {
    open: id => useTeamMessageStore.getState().open(id),
    close: id => useTeamMessageStore.getState().close(id),
  },
  strategy: {
    open: id => useStrategyStore.getState().open(id),
    close: id => useStrategyStore.getState().close(id),
  },
}

const SLOT_NAMES = Object.keys(SLOTS) as SideSlot[]

/** Close every side-slot panel but `which`, for the session's chat. */
export function closeOtherSideSlots(which: SideSlot, sessionId: string) {
  for (const slot of SLOT_NAMES) if (slot !== which) SLOTS[slot].close(sessionId)
}

/** Open `which` (closing the others), or close it when it is the open one. */
export function toggleSideSlot(which: SideSlot, sessionId: string) {
  if (readOpenSideSlot(sessionId) === which) {
    SLOTS[which].close(sessionId)
    return
  }
  closeOtherSideSlots(which, sessionId)
  SLOTS[which].open(sessionId)
}

/** The session's open side-slot panel, read once outside React. */
export function readOpenSideSlot(sessionId: string): SideSlot | null {
  if (useChatDebugStore.getState().views[sessionId]?.open) return 'debug'
  if (useTeamMailboxStore.getState().views[sessionId]?.open) return 'mailbox'
  if (useTeamTaskStore.getState().views[sessionId]?.open) return 'tasks'
  if (useTeamMessageStore.getState().views[sessionId]?.open) return 'messages'
  if (useStrategyStore.getState().views[sessionId]?.open) return 'strategy'
  return null
}

/** The session's open side-slot panel; at most one is open by construction. */
export function useOpenSideSlot(sessionId: string): SideSlot | null {
  const debug = useChatDebugStore(state => state.views[sessionId]?.open ?? false)
  const mailbox = useTeamMailboxStore(state => state.views[sessionId]?.open ?? false)
  const tasks = useTeamTaskStore(state => state.views[sessionId]?.open ?? false)
  const messages = useTeamMessageStore(state => state.views[sessionId]?.open ?? false)
  const strategy = useStrategyStore(state => state.views[sessionId]?.open ?? false)
  if (debug) return 'debug'
  if (mailbox) return 'mailbox'
  if (tasks) return 'tasks'
  if (messages) return 'messages'
  if (strategy) return 'strategy'
  return null
}
