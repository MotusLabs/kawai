// The human's retry of a dead or uncertain message (agent-mailbox), split from
// `MailboxStore` to keep it small. It writes only through the store's logged
// transition, which the store passes in.
import type { MessageState, TeamMessage } from '../../shared/team'
import type { StoreActor } from './messageEvents'

export interface RetryHost {
  get(id: string): TeamMessage | null
  transition(id: string, from: MessageState[], set: Record<string, string | number | null>, kind: 'retried' | 'dead-lettered', actor: StoreActor): boolean
  /** Whether a session still exists; absent = assume it does. */
  recipientExists?: (id: string) => boolean
}

const HUMAN: StoreActor = { kind: 'human' }

/**
 * Retry a dead letter (queued again, its hop reset so the thread may continue)
 * or an uncertain message (to the same recipient only, as direct mail flagged
 * as a possible duplicate). A killed recipient dead-letters it instead.
 */
export function retryMessage(host: RetryHost, id: string): boolean {
  const message = host.get(id)
  const recipient = message?.state === 'uncertain' ? message.claimedBy : message?.toKind === 'session' ? message.toId : null
  if (message && ['dead', 'uncertain'].includes(message.state) && recipient && host.recipientExists && !host.recipientExists(recipient)) {
    host.transition(id, ['dead', 'uncertain'], {
      state: 'dead', reason: 'killed-recipient', to_kind: 'session', to_id: recipient,
      ...(message.state === 'uncertain' ? { possible_duplicate: 1 } : {}),
    }, 'dead-lettered', HUMAN)
    return false
  }
  if (message?.state === 'dead') {
    return host.transition(id, ['dead'], { state: 'queued', hop: 1, reason: null }, 'retried', HUMAN)
  }
  if (message?.state === 'uncertain' && message.claimedBy) {
    return host.transition(id, ['uncertain'], {
      state: 'queued', to_kind: 'session', to_id: message.claimedBy,
      claimed_by: null, claimed_at: null, pushed_at: null, reason: null, possible_duplicate: 1,
    }, 'retried', HUMAN)
  }
  return false
}
