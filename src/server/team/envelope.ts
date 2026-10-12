// Fixed peer-turn envelope. JSON metadata is escaped as an XML attribute;
// body text remains verbatim, including markup and newlines. Strict parsing
// avoids treating an ordinary user mention of the tag as delivered mail. A
// task message (team-tasks D3) also carries its task context in the metadata
// and as a readable header above the body; envelopes without one keep the
// original shape, so older transcripts still parse. Work forwarded after a
// provider limit (profile routing) carries its handoff package the same way,
// below the task header.
import type { ChatPeerMessage } from '../../shared/chat'
import type { ChatPeerTaskContext } from '../../shared/teamTasks'
import { TASK_STATUSES } from '../../shared/teamTasks'
import { ENVELOPE_TAG } from './teamPrompt'
import type { TeamMessage } from './mailboxStore'
import { formatTaskHeader } from './taskContext'
import { formatHandoffHeader, isHandoffPackage } from './routing/handoff'

// Built from the same constant formatEnvelope writes, so the two cannot
// drift apart and silently stop matching.
const ENVELOPE_PATTERN = new RegExp(`^<${ENVELOPE_TAG} metadata="([^"\\n]*)">\\n([\\s\\S]*)\\n</${ENVELOPE_TAG}>$`)

const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unescapeAttribute = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const DUPLICATE_NOTE = 'Possible duplicate: if you have already seen this message id, treat it as a no-op.'

export function messageEnvelope(message: TeamMessage, thread?: TeamMessage[], task?: ChatPeerTaskContext | null): ChatPeerMessage {
  return {
    messageId: message.id, senderSession: message.fromSession, senderGroup: message.fromGroup,
    priority: message.priority, originPath: message.originPath, tags: message.tags,
    threadId: message.threadId, body: message.body, possibleDuplicate: message.possibleDuplicate,
    ...(message.attachThread && thread ? { thread: thread.filter(row => row.id !== message.id).map(row => ({
      messageId: row.id, senderSession: row.fromSession, body: row.body,
    })) } : {}),
    ...(task ? { task } : {}),
    ...(message.handoff ? { handoff: message.handoff } : {}),
  }
}

export function formatEnvelope(envelope: ChatPeerMessage): string {
  const { body, ...metadata } = envelope
  const header = (envelope.task ? `${formatTaskHeader(envelope.task)}\n` : '') +
    (envelope.handoff ? formatHandoffHeader(envelope.handoff) : '')
  return `<${ENVELOPE_TAG} metadata="${escapeAttribute(JSON.stringify(metadata))}">\n${envelope.possibleDuplicate ? `${DUPLICATE_NOTE}\n` : ''}${header}${body}\n</${ENVELOPE_TAG}>`
}

export function parseEnvelope(text: string): ChatPeerMessage | null {
  const match = ENVELOPE_PATTERN.exec(text)
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
    if (meta.task !== undefined && !isTaskContext(meta.task)) return null
    if (meta.handoff !== undefined && !isHandoffPackage(meta.handoff)) return null
    let body = match[2]!
    if (meta.possibleDuplicate) {
      if (!body.startsWith(`${DUPLICATE_NOTE}\n`)) return null
      body = body.slice(DUPLICATE_NOTE.length + 1)
    }
    if (meta.task) {
      const header = `${formatTaskHeader(meta.task)}\n`
      if (!body.startsWith(header)) return null
      body = body.slice(header.length)
    }
    if (meta.handoff) {
      const header = formatHandoffHeader(meta.handoff)
      if (!body.startsWith(header)) return null
      body = body.slice(header.length)
    }
    return {
      messageId: meta.messageId, senderSession: meta.senderSession, senderGroup: meta.senderGroup,
      priority: meta.priority, originPath: meta.originPath, tags: meta.tags, threadId: meta.threadId,
      possibleDuplicate: meta.possibleDuplicate, body,
      ...(meta.thread ? { thread: meta.thread } : {}),
      ...(meta.task ? { task: meta.task } : {}),
      ...(meta.handoff ? { handoff: meta.handoff } : {}),
    }
  } catch { return null }
}

function isTaskContext(value: unknown): value is ChatPeerTaskContext {
  const task = value as Record<string, unknown> | null
  if (!task || typeof task !== 'object') return false
  const nullableString = (key: string) => task[key] === null || typeof task[key] === 'string'
  return ['id', 'title', 'direction'].every(key => typeof task[key] === 'string') &&
    TASK_STATUSES.includes(task.status as never) && typeof task.revision === 'number' &&
    ['acceptance', 'openspecChange', 'worktree'].every(nullableString) &&
    Array.isArray(task.journal) && task.journal.every((entry: Record<string, unknown>) =>
      !!entry && ['author', 'text', 'createdAt'].every(key => typeof entry[key] === 'string'))
}
