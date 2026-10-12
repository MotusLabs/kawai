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

const HANDOFF = {
  fromSession: 'chat-glm', fromProfile: 'glm', claimCommit: 'abc1234', lastError: 'API Error: 429 quota',
  progress: { toolCalls: 3, tools: ['Read', 'Edit', 'Bash'], filesTouched: ['src/a.ts'] },
}

test('a handoff package renders the digest, claim commit, and inspect-first instruction, and round-trips', () => {
  const peer = { ...PEER, handoff: HANDOFF }
  const text = formatEnvelope(peer)
  expect(text).toContain('[Handoff] Session chat-glm (profile glm) hit a provider limit')
  expect(text).toContain('3 tool calls (Read, Edit, Bash)')
  expect(text).toContain('Files touched: src/a.ts.')
  expect(text).toContain('Last error: API Error: 429 quota.')
  expect(text).toContain('`git status`, `git diff abc1234`, and `git log abc1234..`')
  expect(parseEnvelope(text)).toEqual(peer)
  // The readable section is verified against the metadata on parse.
  expect(parseEnvelope(text.replace('3 tool calls', '9 tool calls'))).toBeNull()
})

test('a handoff without a claim commit still asks for git status first', () => {
  const peer = { ...PEER, handoff: { ...HANDOFF, claimCommit: null, lastError: null, progress: { toolCalls: 1, tools: [], filesTouched: [] } } }
  const text = formatEnvelope(peer)
  expect(text).toContain('run `git status` and inspect what changed')
  expect(text).toContain('1 tool call.')
  expect(parseEnvelope(text)).toEqual(peer)
})

test('a malformed handoff package is not mail', () => {
  const text = formatEnvelope({ ...PEER, handoff: HANDOFF }).replace('&quot;toolCalls&quot;:3', '&quot;toolCalls&quot;:&quot;3&quot;')
  expect(parseEnvelope(text)).toBeNull()
})
