// Hop-limit and human-delivery notices are additive and independent of an
// open mailbox panel.
import type { ServerMessage } from '@shared/types'
import { toastManager } from '../components/Toast'
export function notifyMailboxDeadLetter(message: Extract<ServerMessage, { type: 'team-mailbox-dead-letter' }>) {
  toastManager.add({ title: 'Team message stopped at hop limit', description: `Message ${message.messageId} from ${message.senderSession} is in the team mailbox’s dead letters.`, type: 'warning' })
}
/** An agent's reply reached the human (team-message-threads D5). */
export function notifyDeliveredToHuman(message: Extract<ServerMessage, { type: 'team-mailbox-delivered-to-human' }>) {
  const from = message.senderKind === 'human' || message.senderSession === null ? 'Human' : message.senderSession
  toastManager.add({ title: 'A reply is waiting for you', description: `Message ${message.messageId} from ${from} was delivered to you.`, type: 'info' })
}
