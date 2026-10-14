// The chat side slot holds one panel at a time — Debug, Mailbox, Tasks,
// Messages, or Strategy (team-message-threads 5.4, product-strategy 5.1).
// Opening one closes the others; the Mailbox panel's own delivery operations
// are untouched by this, it only shares the slot. The open slot is derived
// from the panels' own stores (chat-header-layout D2): each store keeps its
// panel state, and `toggleSideSlot` is the single way the header opens and
// closes them, so adding a panel is one table entry. Debug belongs to the
// chat session; the team panels belong to the chat's team (team-workspace-
// pages D2), so every chat of one team shows the same team panel.
import { useChatDebugStore } from '../../stores/chatDebugStore'
import { useStrategyStore } from '../../stores/strategyStore'
import { useTeamMailboxStore } from '../../stores/teamMailboxStore'
import { useTeamMessageStore } from '../../stores/teamMessageStore'
import { useTeamTaskStore } from '../../stores/teamTaskStore'

export type SideSlot = 'debug' | 'mailbox' | 'tasks' | 'messages' | 'strategy'

/** Whose slot this is: the chat (Debug) and its team key (the team panels). */
export interface SlotOwner {
  sessionId: string
  teamKey: string
}

const SLOTS: Record<SideSlot, { open: (owner: SlotOwner) => void; close: (owner: SlotOwner) => void }> = {
  debug: {
    open: owner => useChatDebugStore.getState().beginOpen(owner.sessionId),
    close: owner => useChatDebugStore.getState().close(owner.sessionId),
  },
  mailbox: {
    open: owner => useTeamMailboxStore.getState().open(owner.teamKey),
    close: owner => useTeamMailboxStore.getState().close(owner.teamKey),
  },
  tasks: {
    open: owner => useTeamTaskStore.getState().open(owner.teamKey),
    close: owner => useTeamTaskStore.getState().close(owner.teamKey),
  },
  messages: {
    open: owner => useTeamMessageStore.getState().open(owner.teamKey),
    close: owner => useTeamMessageStore.getState().close(owner.teamKey),
  },
  strategy: {
    open: owner => useStrategyStore.getState().open(owner.teamKey),
    close: owner => useStrategyStore.getState().close(owner.teamKey),
  },
}

const SLOT_NAMES = Object.keys(SLOTS) as SideSlot[]

/**
 * Close every side-slot panel but `which`, for the chat and its team. Debug
 * is this chat's own, so opening it leaves the team's shared panel open for
 * the team's other chats; it simply shows first here (`readOpenSideSlot`).
 * Opening a team panel still closes this chat's Debug.
 */
export function closeOtherSideSlots(which: SideSlot, owner: SlotOwner) {
  for (const slot of SLOT_NAMES) {
    if (slot === which || (which === 'debug' && slot !== 'debug')) continue
    SLOTS[slot].close(owner)
  }
}

/** Open `which` (closing the others), or close it when it is the open one. */
export function toggleSideSlot(which: SideSlot, owner: SlotOwner) {
  if (readOpenSideSlot(owner) === which) {
    SLOTS[which].close(owner)
    return
  }
  closeOtherSideSlots(which, owner)
  SLOTS[which].open(owner)
}

/**
 * The open side-slot panel, read once outside React. A team panel opened in
 * another chat of the team can be open beside this chat's Debug; the first
 * in this order is the one shown.
 */
export function readOpenSideSlot(owner: SlotOwner): SideSlot | null {
  if (useChatDebugStore.getState().views[owner.sessionId]?.open) return 'debug'
  if (useTeamMailboxStore.getState().views[owner.teamKey]?.open) return 'mailbox'
  if (useTeamTaskStore.getState().views[owner.teamKey]?.open) return 'tasks'
  if (useTeamMessageStore.getState().views[owner.teamKey]?.open) return 'messages'
  if (useStrategyStore.getState().views[owner.teamKey]?.open) return 'strategy'
  return null
}

/** The open side-slot panel, in `readOpenSideSlot`'s order; at most one is shown. */
export function useOpenSideSlot(owner: SlotOwner): SideSlot | null {
  const debug = useChatDebugStore(state => state.views[owner.sessionId]?.open ?? false)
  const mailbox = useTeamMailboxStore(state => state.views[owner.teamKey]?.open ?? false)
  const tasks = useTeamTaskStore(state => state.views[owner.teamKey]?.open ?? false)
  const messages = useTeamMessageStore(state => state.views[owner.teamKey]?.open ?? false)
  const strategy = useStrategyStore(state => state.views[owner.teamKey]?.open ?? false)
  if (debug) return 'debug'
  if (mailbox) return 'mailbox'
  if (tasks) return 'tasks'
  if (messages) return 'messages'
  if (strategy) return 'strategy'
  return null
}
