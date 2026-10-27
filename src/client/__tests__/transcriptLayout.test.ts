import { describe, expect, test } from 'bun:test'
import type { ChatEvent } from '@shared/chat'
import { agentLabelOf, isVisibleEntry, layoutRows, toolEntries } from '../components/chat/transcriptLayout'

const user = (id: string, turnId: string, at = ''): ChatEvent => ({ id, sequence: 0, at, type: 'user_message', turnId, text: id })
const agent = (id: string, turnId: string, at = ''): ChatEvent =>
  ({ id, sequence: 0, at, type: 'assistant_text', turnId, messageId: id, text: id })
const tool = (id: string, turnId: string): ChatEvent =>
  ({ id, sequence: 0, at: '', type: 'tool_call', turnId, toolCallId: id, tool: 'Read', input: {} })

const layout = (events: ChatEvent[], options?: Parameters<typeof layoutRows>[1]) =>
  layoutRows(toolEntries(events), { timeZone: 'UTC', ...options })

describe('transcript layout (chat-transcript-layout D1)', () => {
  test('turns, author changes, and same-author continuations around a tool', () => {
    const rows = layout([user('u1', 't1'), agent('a1', 't1'), tool('c1', 't1'), agent('a2', 't1'), user('u2', 't2'), agent('a3', 't2')])
    expect(rows.map(row => [row.author, row.turnStart, row.authorStart])).toEqual([
      ['user', false, true],
      ['agent', false, true],
      [null, false, false],
      ['agent', false, false],
      ['user', true, true],
      ['agent', false, true],
    ])
  })

  test('replayed turns with no turn_completed still separate by their start rows', () => {
    const rows = layout([user('u1', 'hist-turn-1'), agent('a1', 'hist-turn-1'), user('u2', 'hist-turn-2')])
    expect(rows.map(row => row.turnStart)).toEqual([false, false, true])
  })

  test('a task trigger starts a turn; a resumed trigger is hidden and user-started draws nothing', () => {
    const plain: ChatEvent = { id: 's', sequence: 0, at: '', type: 'turn_started', turnId: 't2' }
    const resumed: ChatEvent = { ...plain, id: 'tr', turnId: 't3', trigger: { kind: 'resumed' } }
    const tasked: ChatEvent = { ...plain, id: 'tt', turnId: 't4', trigger: { kind: 'task', tasks: [{ taskId: 'b1', status: 'completed' }] } }
    const entries = toolEntries([agent('a1', 't1'), plain, resumed, tasked, agent('a2', 't4')])
    // Only the named task trigger draws; the resumed trigger is hidden.
    expect(entries.filter(isVisibleEntry).map(entry => entry.event.id)).toEqual(['a1', 'tt', 'a2'])
    expect(layoutRows(entries).map(row => [row.turnStart, row.authorStart])).toEqual([
      [false, true],
      [false, false],
      [false, false],
      [true, false],
      [false, true],
    ])
  })

  test('a hidden resumed trigger keeps its turn boundary on the following output row', () => {
    const resumed: ChatEvent = { id: 'tr', sequence: 0, at: '', type: 'turn_started', turnId: 't2', trigger: { kind: 'resumed' } }
    const rows = layout([user('u1', 't1'), resumed, agent('a1', 't2')])
    // a1 shares the hidden trigger's turn id, so only the carried boundary
    // separates it — the wide turn separation survives hiding the line.
    expect(rows.map(row => [row.author, row.turnStart])).toEqual([
      ['user', false],
      [null, false],
      ['agent', true],
    ])
  })

  test('a hidden trigger between days neither adds nor suppresses a separator', () => {
    const resumed: ChatEvent = { id: 'tr', sequence: 0, at: '2026-10-16T00:30:00Z', type: 'turn_started', turnId: 't2', trigger: { kind: 'resumed' } }
    const rows = layout([
      user('u1', 't1', '2026-10-15T10:00:00Z'),
      resumed,
      user('u2', 't2', '2026-10-16T09:00:00Z'),
    ])
    expect(rows.map(row => row.dayBreak)).toEqual([null, null, 'Friday, October 16, 2026'])
  })

  test('peers are distinct authors by sender', () => {
    const peer = (id: string, senderSession: string): ChatEvent => ({
      id, sequence: 0, at: '', type: 'peer_message', turnId: id, messageId: id, senderSession, senderGroup: null,
      priority: 'normal', tags: [], originPath: '/repo', threadId: id, body: 'hi', possibleDuplicate: false,
    } as ChatEvent)
    expect(layout([peer('p1', 'alice'), peer('p2', 'bob')]).map(row => row.author)).toEqual(['peer:alice', 'peer:bob'])
  })
})

describe('day separators (chat-transcript-layout D2)', () => {
  test('a separator marks each local day change between dated messages', () => {
    const rows = layout([user('u1', 't1', '2026-10-15T10:00:00Z'), agent('a1', 't1', '2026-10-15T23:59:00Z'), user('u2', 't2', '2026-10-16T00:01:00Z')])
    expect(rows.map(row => row.dayBreak)).toEqual([null, null, 'Friday, October 16, 2026'])
  })

  test('an undated message between days neither adds nor suppresses one', () => {
    const rows = layout([user('u1', 't1', '2026-10-15T10:00:00Z'), user('u2', 't2', ''), user('u3', 't3', '2026-10-16T09:00:00Z')])
    expect(rows.map(row => row.dayBreak)).toEqual([null, null, 'Friday, October 16, 2026'])
  })

  test('a transcript from another day opens with its date; today\'s does not', () => {
    const events = [user('u1', 't1', '2026-10-15T10:00:00Z')]
    expect(layout(events, { today: '2026-10-16' })[0]?.dayBreak).toBe('Thursday, October 15, 2026')
    expect(layout(events, { today: '2026-10-15' })[0]?.dayBreak).toBeNull()
  })
})

describe('agent label', () => {
  test('comes from the agent kind, never a model string', () => {
    expect(agentLabelOf(undefined)).toBe('Claude')
    expect(agentLabelOf('claude')).toBe('Claude')
    expect(agentLabelOf('claude-rp')).toBe('Claude')
    expect(agentLabelOf('codex')).toBe('Codex')
    expect(agentLabelOf('pi')).toBe('Pi')
  })
})
