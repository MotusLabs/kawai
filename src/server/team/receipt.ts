// Receipt evidence comes exclusively from a top-level peer user row in the
// CLI transcript (a Codex chat: a user message row of its rollout file).
// Missing/unreadable/torn records cannot license a retry.
import fs from 'node:fs'
import { parseEnvelope } from './envelope'
import { MailboxStore } from './mailboxStore'

export function receiptMessageId(line: string): string | null {
  try {
    const row = JSON.parse(line)
    if (row?.type !== 'user' || row.isSidechain || row.parent_tool_use_id) return null
    const content = row.message?.content
    const texts = typeof content === 'string' ? [content] : Array.isArray(content)
      ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text) : []
    for (const text of texts) {
      const envelope = parseEnvelope(text)
      if (envelope) return envelope.messageId
    }
  } catch { /* An incomplete row proves nothing. */ }
  return null
}

/** Reads the delivered message id from one transcript row, or null. */
export type ReceiptRowParser = (line: string) => string | null

/**
 * A Codex rollout row (codex-chat-sessions D8): only a `response_item`
 * user message whose input text is a Kawai envelope. Assistant, developer,
 * tool-output, and `event_msg` rows can quote an envelope and never count;
 * AGENTS.md user rows never parse as one.
 */
export function codexReceiptMessageId(line: string): string | null {
  try {
    const row = JSON.parse(line)
    const payload = row?.payload
    if (row?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') return null
    const content = Array.isArray(payload.content) ? payload.content : []
    for (const block of content) {
      if (block?.type !== 'input_text' || typeof block.text !== 'string') continue
      const envelope = parseEnvelope(block.text)
      if (envelope) return envelope.messageId
    }
  } catch { /* An incomplete row proves nothing. */ }
  return null
}

export function transcriptReceipt(
  file: string | null | undefined,
  messageId: string,
  parse: ReceiptRowParser = receiptMessageId
): 'found' | 'absent' | 'uncertain' {
  if (!file) return 'uncertain'
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim())
    if (lines.some(line => parse(line) === messageId)) return 'found'
    for (const line of lines) JSON.parse(line)
    return 'absent'
  } catch { return 'uncertain' }
}

export function reconcileMailbox(
  store: MailboxStore,
  transcriptFor: (sessionId: string) => string | null | undefined,
  parserFor: (sessionId: string) => ReceiptRowParser = () => receiptMessageId
) {
  for (const message of store.unacknowledgedClaims()) {
    if (!message.pushedAt) { store.requeue(message.id); continue }
    const receipt = message.claimedBy
      ? transcriptReceipt(transcriptFor(message.claimedBy), message.id, parserFor(message.claimedBy))
      : 'uncertain'
    if (receipt === 'found') store.markDelivered(message.id)
    else if (receipt === 'absent') store.requeue(message.id)
    else store.holdUncertain(message.id, 'transcript-unavailable-or-torn')
  }
}
