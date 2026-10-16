import { describe, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { searchEvents } from '../chat/sessionSearch'

let counter = 0
function at(): string {
  counter++
  return new Date(Date.UTC(2026, 9, 15, 10, 0, counter)).toISOString()
}
const base = () => ({ id: `e${counter + 1}`, sequence: 0, at: at(), turnId: 't1' })

const user = (text: string): ChatEvent => ({ ...base(), type: 'user_message', text })
const assistant = (text: string): ChatEvent => ({ ...base(), type: 'assistant_text', messageId: 'm1', text })
const call = (toolCallId: string, tool: string, input: unknown): ChatEvent =>
  ({ ...base(), type: 'tool_call', toolCallId, tool, input })
const result = (toolCallId: string, output: string): ChatEvent =>
  ({ ...base(), type: 'tool_result', toolCallId, output })
const peer = (body: string, title?: string): ChatEvent => ({
  ...base(), type: 'peer_message', messageId: 'p1', senderSession: 's2', senderGroup: 'lead',
  priority: 'normal', originPath: '/r', tags: [], threadId: 'th1', body, possibleDuplicate: false,
  ...(title ? { task: { id: 'k1', title, status: 'active', revision: 1, direction: '', acceptance: null, openspecChange: null, worktree: null, journal: [] } } : {}),
} as ChatEvent)

describe('searchEvents', () => {
  test('finds a PR URL in a tool result and labels it with the tool', () => {
    const events = [
      call('c1', 'Bash', { command: 'gh pr create' }),
      result('c1', 'Creating pull request…\nhttps://github.com/acme/app/pull/147\n'),
    ]
    const found = searchEvents(events, 'pull/147')
    expect(found.matchCount).toBe(1)
    const [snippet] = found.snippets
    expect(snippet).toMatchObject({ kind: 'tool_result', tool: 'Bash', anchorId: 'tool:c1' })
    expect(snippet!.text).toContain('pull/147')
    expect(snippet!.text).not.toContain('\n')
  })

  test('matches tool input text', () => {
    const found = searchEvents([call('c2', 'Bash', { command: 'gh pr view 147' })], 'pr view 147')
    expect(found.snippets[0]).toMatchObject({ kind: 'tool_input', tool: 'Bash', anchorId: 'tool:c2' })
  })

  test('matches approval requests', () => {
    const approval = { ...base(), type: 'approval_request', requestId: 'r1', tool: 'Bash', input: { command: 'gh pr merge 147' } } as ChatEvent
    expect(searchEvents([approval], 'merge 147').snippets[0]).toMatchObject({ kind: 'approval', tool: 'Bash', anchorId: approval.id })
  })

  test('matches a peer message body and its task title', () => {
    expect(searchEvents([peer('opened PR #147')], 'PR #147').snippets[0]!.kind).toBe('peer')
    expect(searchEvents([peer('hello', 'Ship PR 147')], 'pr 147').matchCount).toBe(1)
  })

  test('matches command output, notices, and errors', () => {
    const events: ChatEvent[] = [
      { ...base(), type: 'command_output', text: 'context 147 tokens' },
      { id: 'n1', sequence: 0, at: at(), type: 'notice', text: 'compacted at 147' },
      { id: 'x1', sequence: 0, at: at(), type: 'error', message: 'failed 147' },
    ]
    const kinds = searchEvents(events, '147').snippets.map(s => s.kind)
    expect(kinds).toEqual(['error', 'notice', 'command_output'])
  })

  test('treats the query as a literal, case-insensitively', () => {
    const events = [user('Fix(chat): add search'), user('fixXchat): no')]
    expect(searchEvents(events, 'fix(chat):').matchCount).toBe(1)
    expect(searchEvents([user('Pull Request #147')], 'pull request #147').matchCount).toBe(1)
    expect(searchEvents([user('a.b')], 'a.b').matchCount).toBe(1)
    expect(searchEvents([user('axb')], 'a.b').matchCount).toBe(0)
  })

  test('skips streaming deltas, the history placeholder, and question cards', () => {
    const events: ChatEvent[] = [
      { ...base(), type: 'assistant_delta', messageId: 'm', delta: 'needle' },
      { id: 'hist-unavailable', sequence: 0, at: at(), type: 'notice', text: 'History unavailable needle' },
      { ...base(), type: 'turn_completed', subtype: 'success', finalText: 'needle' },
    ]
    expect(searchEvents(events, 'needle')).toEqual({ matchCount: 0, lastMatchAt: null, snippets: [] })
  })

  test('returns nothing for an empty query', () => {
    expect(searchEvents([user('anything')], '').matchCount).toBe(0)
  })

  test('counts every matching entry, keeps the newest three newest first', () => {
    const events = ['1', '2', '3', '4', '5'].map(n => user(`mention ${n} of #147`))
    const found = searchEvents(events, '#147')
    expect(found.matchCount).toBe(5)
    expect(found.snippets.map(s => s.eventId)).toEqual([events[4]!.id, events[3]!.id, events[2]!.id])
    expect(found.lastMatchAt).toBe(events[4]!.at)
  })

  test('returns ranges for every occurrence inside the excerpt', () => {
    const [snippet] = searchEvents([user('see #147 and again #147 here')], '#147').snippets
    expect(snippet!.ranges).toEqual([{ start: 4, end: 8 }, { start: 19, end: 23 }])
    expect(snippet!.text.slice(4, 8)).toBe('#147')
  })

  test('bounds the excerpt of a long entry and offsets ranges past the ellipsis', () => {
    const output = `${'a'.repeat(10_000)}needle${'b'.repeat(10_000)}`
    const [snippet] = searchEvents([result('c3', output)], 'needle').snippets
    expect(snippet!.text.length).toBe(1 + 60 + 6 + 60 + 1)
    expect(snippet!.text.startsWith('…')).toBe(true)
    expect(snippet!.text.endsWith('…')).toBe(true)
    const [range] = snippet!.ranges
    expect(snippet!.text.slice(range!.start, range!.end)).toBe('needle')
  })

  test('keeps a short entry whole without ellipses', () => {
    const [snippet] = searchEvents([assistant('done #147')], '#147').snippets
    expect(snippet!.text).toBe('done #147')
  })

  test('tool results without a known call carry no tool name', () => {
    const [snippet] = searchEvents([result('orphan', 'needle')], 'needle').snippets
    expect(snippet!.tool).toBeUndefined()
  })

  test('survives tool input that cannot be stringified', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(searchEvents([call('c4', 'Bash', cyclic)], 'Bash').matchCount).toBe(1)
    expect(searchEvents([call('c5', 'Bash', undefined)], 'Bash').matchCount).toBe(1)
  })

  test('searches plain-string tool input directly', () => {
    expect(searchEvents([call('c6', 'Bash', 'echo needle')], 'needle').matchCount).toBe(1)
  })
})

describe('undated history (chat-transcript-layout D2)', () => {
  test('an undated match never stands in as the match time', () => {
    const undated: ChatEvent = { id: 'u', sequence: 0, at: '', type: 'user_message', turnId: 't', text: 'needle undated' }
    expect(searchEvents([undated], 'needle').lastMatchAt).toBeNull()
    const dated: ChatEvent = { ...undated, id: 'd', at: '2026-10-04T10:00:00.000Z' }
    expect(searchEvents([dated, undated], 'needle').lastMatchAt).toBe('2026-10-04T10:00:00.000Z')
  })
})
