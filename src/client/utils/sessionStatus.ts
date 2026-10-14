// Status dot colors shared by the terminal control deck and the chat header
// (chat-header-layout D7). A dot never stands alone: callers render the
// status word beside it, so color is never the only signal.
import type { SessionStatus } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'

export const sessionStatusDot: Record<SessionStatus, string> = {
  working: 'bg-working',
  waiting: 'bg-waiting',
  permission: 'bg-approval',
  unknown: 'bg-muted',
}

const connectionStatusDot: Record<Exclude<ConnectionStatus, 'connected'>, string> = {
  connecting: 'bg-approval',
  reconnecting: 'bg-approval',
  disconnected: 'bg-danger',
}

/** The chat header's indicator: the connection state while not connected,
 *  `archived` for an archived chat, else the session's own status. */
export function chatStatusIndicator(
  status: SessionStatus, connection: ConnectionStatus, archived: boolean,
): { word: string; dot: string } {
  if (connection !== 'connected') return { word: connection, dot: connectionStatusDot[connection] }
  if (archived) return { word: 'archived', dot: 'bg-muted' }
  return { word: status, dot: sessionStatusDot[status] }
}
