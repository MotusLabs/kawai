// chatArchive.ts - Single client-side archive entry point for chat sessions.
// The server archive operation is unconditional (chat-archive design D3), so
// every UI path — the chat view header and the navigator row menu — goes
// through here to ask before interrupting a turn in flight.

import type { SendClientMessage, Session } from '@shared/types'

/** True when archiving would interrupt a running or permission-blocked turn. */
export function chatArchiveNeedsConfirmation(session: Pick<Session, 'status'>): boolean {
  return session.status === 'working' || session.status === 'permission'
}

/**
 * Archive a chat, asking first when a turn is in flight. Returns whether the
 * chat-archive message was sent (false when the user declined).
 */
export function requestChatArchive(
  session: Pick<Session, 'id' | 'name' | 'status'>,
  sendMessage: SendClientMessage,
  confirm: (message: string) => boolean = (message) => window.confirm(message)
): boolean {
  if (
    chatArchiveNeedsConfirmation(session) &&
    !confirm(`Archive "${session.name}"? A turn is in flight and will be interrupted.`)
  ) {
    return false
  }
  sendMessage({ type: 'chat-archive', sessionId: session.id })
  return true
}
