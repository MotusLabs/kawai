// Receipt evidence comes exclusively from a top-level peer user row in the
// CLI transcript. Missing/unreadable/torn records cannot license a retry.
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

export function transcriptReceipt(file: string | null | undefined, messageId: string): 'found' | 'absent' | 'uncertain' {
  if (!file) return 'uncertain'
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim())
    if (lines.some(line => receiptMessageId(line) === messageId)) return 'found'
    for (const line of lines) JSON.parse(line)
    return 'absent'
  } catch { return 'uncertain' }
}

export function reconcileMailbox(store: MailboxStore, transcriptFor: (sessionId: string) => string | null | undefined) {
  for (const message of store.unacknowledgedClaims()) {
    if (!message.pushedAt) { store.requeue(message.id); continue }
    const receipt = transcriptReceipt(message.claimedBy ? transcriptFor(message.claimedBy) : null, message.id)
    if (receipt === 'found') store.markDelivered(message.id)
    else if (receipt === 'absent') store.requeue(message.id)
    else store.holdUncertain(message.id, 'transcript-unavailable-or-torn')
  }
}
