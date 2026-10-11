// Envelope round-trip and replay verification; parsing is also the receipt
// boundary, so malformed metadata must never count as a delivered message.
import { expect, test } from 'bun:test'
import type { ChatPeerMessage } from '../../shared/chat'
import { formatEnvelope, parseEnvelope } from '../team/envelope'
import { parseTranscriptContent } from '../chat/transcriptReplay'

export const PEER: ChatPeerMessage = {
  messageId: 'mail-1', senderSession: 'chat-lead', senderGroup: 'leads',
  priority: 'urgent', originPath: '/repo/worktree "a" & b', tags: ['ui', '<tag>'],
  threadId: 'thread-1', body: 'Build <thing>\n</kawai-message>\nKeep going & reply.', possibleDuplicate: false,
}
test('envelope preserves body, escaped metadata and optional full thread', () => {
  const peer = { ...PEER, thread: [{ messageId: 'older', senderSession: 'chat-dev', body: 'Earlier message' }] }
  expect(parseEnvelope(formatEnvelope(peer))).toEqual(peer)
})
test('possible duplicate notice is visible and round-trips', () => {
  const peer = { ...PEER, possibleDuplicate: true }
  const text = formatEnvelope(peer)
  expect(text).toContain('already seen this message id')
  expect(parseEnvelope(text)).toEqual(peer)
  expect(parseEnvelope(text.replace('Possible duplicate:', 'Changed:'))).toBeNull()
})
test('malformed or ordinary text cannot masquerade as mail', () => {
  expect(parseEnvelope('mention <kawai-message>')).toBeNull()
  expect(parseEnvelope(formatEnvelope(PEER).replace('&quot;urgent&quot;', '&quot;invalid&quot;'))).toBeNull()
  expect(parseEnvelope('<kawai-message metadata="{}">\nbody\n</kawai-message>')).toBeNull()
})
test('replay restores string and block peer turns with all metadata', () => {
  for (const content of [formatEnvelope(PEER), [{ type: 'text', text: formatEnvelope(PEER) }]]) {
    const replay = parseTranscriptContent(JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content } }))
    expect(replay.events).toHaveLength(1)
    expect(replay.events[0]).toMatchObject({ type: 'peer_message', ...PEER })
  }
})
