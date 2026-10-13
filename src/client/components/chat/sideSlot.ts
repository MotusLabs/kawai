// The chat side slot holds one panel at a time — Debug, Mailbox, Tasks, or
// Messages (team-message-threads 5.4). Opening one closes the others; the
// Mailbox panel's own delivery operations are untouched by this, it only
// shares the slot.
import { useChatDebugStore } from '../../stores/chatDebugStore'
import { useTeamMailboxStore } from '../../stores/teamMailboxStore'
import { useTeamMessageStore } from '../../stores/teamMessageStore'
import { useTeamTaskStore } from '../../stores/teamTaskStore'

export type SideSlot = 'debug' | 'mailbox' | 'tasks' | 'messages'

/** Close every side-slot panel but `which`, for the session's chat. */
export function closeOtherSideSlots(which: SideSlot, sessionId: string) {
  if (which !== 'debug') useChatDebugStore.getState().close(sessionId)
  if (which !== 'mailbox') useTeamMailboxStore.getState().close(sessionId)
  if (which !== 'tasks') useTeamTaskStore.getState().close(sessionId)
  if (which !== 'messages') useTeamMessageStore.getState().close(sessionId)
}
