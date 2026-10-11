// Fixed peer-turn envelope. JSON metadata is escaped as an XML attribute;
// body text remains verbatim, including markup and newlines. Strict parsing
// avoids treating an ordinary user mention of the tag as delivered mail.
import type { ChatPeerMessage } from '../../shared/chat'
import { ENVELOPE_TAG } from './teamPrompt'
import type { TeamMessage } from './mailboxStore'

const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unescapeAttribute = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const DUPLICATE_NOTE = 'Possible duplicate: if you have already seen this message id, treat it as a no-op.'

export function messageEnvelope(message: TeamMessage, thread?: TeamMessage[]): ChatPeerMessage {
  return {
    messageId: message.id, senderSession: message.fromSession, senderGroup: message.fromGroup,
    priority: message.priority, originPath: message.originPath, tags: message.tags,
    threadId: message.threadId, body: message.body, possibleDuplicate: message.possibleDuplicate,
    ...(message.attachThread && thread ? { thread: thread.filter(row => row.id !== message.id).map(row => ({
      messageId: row.id, senderSession: row.fromSession, body: row.body,
    })) } : {}),
  }
}

export function formatEnvelope(envelope: ChatPeerMessage): string {
  const { body, ...metadata } = envelope
  return `<${ENVELOPE_TAG} metadata="${escapeAttribute(JSON.stringify(metadata))}">\n${envelope.possibleDuplicate ? `${DUPLICATE_NOTE}\n` : ''}${body}\n</${ENVELOPE_TAG}>`
}

export function parseEnvelope(text: string): ChatPeerMessage | null {
  const match = /^<kawai-message metadata="([^"\n]*)">\n([\s\S]*)\n<\/kawai-message>$/.exec(text)
  if (!match) return null
  try {
    const meta = JSON.parse(unescapeAttribute(match[1]!))
    if (!meta || typeof meta !== 'object' ||
      !['messageId', 'senderSession', 'originPath', 'threadId'].every(key => typeof meta[key] === 'string' && meta[key].length > 0) ||
      !(meta.senderGroup === null || typeof meta.senderGroup === 'string') ||
      !['urgent', 'normal'].includes(meta.priority) ||
      !Array.isArray(meta.tags) || !meta.tags.every((tag: unknown) => typeof tag === 'string') ||
      typeof meta.possibleDuplicate !== 'boolean') return null
    if (meta.thread !== undefined && (!Array.isArray(meta.thread) || !meta.thread.every((row: Record<string, unknown>) =>
      row && ['messageId', 'senderSession', 'body'].every(key => typeof row[key] === 'string')))) return null
    let body = match[2]!
    if (meta.possibleDuplicate) {
      if (!body.startsWith(`${DUPLICATE_NOTE}\n`)) return null
      body = body.slice(DUPLICATE_NOTE.length + 1)
    }
    return {
      messageId: meta.messageId, senderSession: meta.senderSession, senderGroup: meta.senderGroup,
      priority: meta.priority, originPath: meta.originPath, tags: meta.tags, threadId: meta.threadId,
      possibleDuplicate: meta.possibleDuplicate, body,
      ...(meta.thread ? { thread: meta.thread } : {}),
    }
  } catch { return null }
}
