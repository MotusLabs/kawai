// Hop-limit notices are additive and independent of an open mailbox panel.
import type { ServerMessage } from '@shared/types'
import { toastManager } from '../components/Toast'
export function notifyMailboxDeadLetter(message: Extract<ServerMessage, { type: 'team-mailbox-dead-letter' }>) {
  toastManager.add({ title: 'Team message stopped at hop limit', description: `Message ${message.messageId} from ${message.senderSession} is in the team mailbox’s dead letters.`, type: 'warning' })
}
