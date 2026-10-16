// Assert work avoided, rather than machine-dependent render durations.
import { afterEach, expect, spyOn, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ReactNode } from 'react'
import type { ChatEvent, ChatCommandState } from '@shared/chat'
import type { Session } from '@shared/types'
import ChatView from '../components/chat/ChatView'
import ChatMessages from '../components/chat/ChatMessages'
import Markdown from '../components/Markdown'
import { emptyTranscript, useChatStore } from '../stores/chatStore'
import * as layout from '../components/chat/transcriptLayout'
import * as times from '../utils/chatTimeFormat'
import { typingHistory } from '../../../tests/e2e/support/chatTypingFixture'

const session = { id: 'typing-test', name: 'Typing', projectPath: '/repo', kind: 'chat', status: 'waiting' } as Session
const commands: ChatCommandState = { status: 'ready', commands: [
  { name: 'context', description: 'Context', source: 'builtin', aliases: [] },
  { name: 'compact', description: 'Compact', source: 'builtin', aliases: [] },
] }
const restores: Array<() => void> = []
let renderer: TestRenderer.ReactTestRenderer | undefined
function watch<T extends object, K extends keyof T>(object: T, key: K) {
  const spy = spyOn(object, key)
  restores.push(() => spy.mockRestore())
  return spy
}
// React.memo exposes its wrapped function as `type`; spy on the actual parser
// component so a passing test cannot hide repeated Markdown work below it.
const markdownType = Markdown as unknown as { type: (props: { content: string }) => ReactNode }

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  for (const restore of restores.splice(0)) restore()
  useChatStore.setState({ sessions: {}, drafts: {}, workerBodies: {}, taskOutputs: {} })
})

test('typing, paste, deletion, selection, and command navigation skip unchanged history', async () => {
  useChatStore.setState({ sessions: { [session.id]: { ...emptyTranscript(), events: typingHistory(), commands } } })
  const rows = watch(layout, 'layoutRows')
  const pairing = watch(layout, 'toolEntries')
  const labels = watch(times, 'chatTimeLabels')
  const markdown = watch(markdownType, 'type')
  const props = { session, sendMessage: () => {}, connectionStatus: 'connected' as const, connectionEpoch: 0, error: null, onClose: () => {}, onKill: () => {} }
  await act(async () => { renderer = TestRenderer.create(<ChatView {...props} />) })
  const counts = () => [rows.mock.calls.length, pairing.mock.calls.length, labels.mock.calls.length, markdown.mock.calls.length]
  const mounted = counts()
  expect(mounted[0]).toBeGreaterThan(0)
  expect(mounted[2]).toBe(500)
  expect(mounted[3]).toBe(250)
  const input = () => renderer!.root.findByType('textarea')
  for (const value of ['h', 'hello', 'hell', 'pasted\ntext', '/', '/co']) {
    act(() => input().props.onChange({ target: { value, selectionStart: value.length, selectionEnd: value.length } }))
  }
  act(() => input().props.onSelect({ target: { selectionStart: 0, selectionEnd: 2 } }))
  act(() => input().props.onSelect({ target: { selectionStart: 3, selectionEnd: 3 } }))
  for (const key of ['ArrowDown', 'ArrowUp', 'Tab']) {
    act(() => input().props.onKeyDown({ key, preventDefault() {} }))
  }
  expect(input().props.value).toMatch(/^\/(context|compact) /)
  expect(counts()).toEqual(mounted)
  // Unrelated parent updates also reuse the transcript.
  act(() => renderer!.update(<ChatView {...props} error="Connection notice" />))
  expect(counts()).toEqual(mounted)
  act(() => useChatStore.getState().apply(session.id, [{ type: 'assistant_text', id: 'new', sequence: 1, at: '2026-10-16T11:00:00Z', turnId: 'new-turn', messageId: 'new-message', text: '**New content**' }]))
  expect(rows.mock.calls.length).toBe(mounted[0]! + 1)
  expect(markdown.mock.calls.length).toBe(mounted[3]! + 1)
  expect(renderer!.root.findAllByType('strong').at(-1)!.children).toEqual(['New content'])
})

test('streaming parses only changed Markdown and keeps stable disclosure nodes', () => {
  const markdown = watch(markdownType, 'type')
  const labels = watch(times, 'chatTimeLabels')
  const initial = typingHistory(20)
  act(() => { renderer = TestRenderer.create(<ChatMessages events={initial} />) })
  const parsed = markdown.mock.calls.length
  const formatted = labels.mock.calls.length
  const disclosure = renderer!.root.findAllByType('details')[0]!
  const last = initial.at(-1)!
  expect(last.type).toBe('assistant_text')
  act(() => renderer!.update(<ChatMessages events={[...initial.slice(0, -1), { ...last, text: 'updated stream' } as ChatEvent]} />))
  expect(markdown.mock.calls.length).toBe(parsed + 1)
  expect(labels.mock.calls.length).toBe(formatted)
  expect(renderer!.root.findAllByType('details')[0]).toBe(disclosure)
})

test('memoization preserves participant labels, project paths, connection and archive changes', () => {
  const events: ChatEvent[] = [
    { type: 'peer_message', id: 'peer', sequence: 0, at: '', turnId: 't', messageId: 'm', senderSession: 'peer', senderGroup: 'devs', priority: 'normal', originPath: '/repo', tags: [], threadId: 'thread', body: 'Review', possibleDuplicate: false },
    { type: 'tool_call', id: 'read', sequence: 0, at: '', turnId: 't', tool: 'Read', toolCallId: 'read', input: { file_path: '/repo/src/a.ts' } },
    { type: 'tool_call', id: 'shell', sequence: 0, at: '', turnId: 't', tool: 'Bash', toolCallId: 'shell', input: { command: 'sleep 60' } },
  ]
  useChatStore.setState({ sessions: { [session.id]: { ...emptyTranscript(), backgroundTasks: [{ taskId: 'task', toolCallId: 'shell', kind: 'shell', status: 'running', live: true, startedAtMs: 1792144800000, elapsedMs: 0 }] } } })
  const render = (name: string, projectPath: string, connected: boolean, archived: boolean) => <ChatMessages
    sessionId={session.id} events={events} sessions={[{ ...session, id: 'peer', name }]} projectPath={projectPath} connected={connected} archived={archived} />
  act(() => { renderer = TestRenderer.create(render('Before', '/repo', true, false)) })
  expect(renderer!.root.findByProps({ 'data-testid': 'participant-name' }).children).toEqual(['Before'])
  expect(renderer!.root.findAllByType('button').find(node => node.children.includes('Stop'))!.props.disabled).toBe(false)
  act(() => renderer!.update(render('After', '/other', false, false)))
  expect(renderer!.root.findAllByType('button').find(node => node.children.includes('Stop'))!.props.disabled).toBe(true)
  act(() => renderer!.update(render('After', '/other', false, true)))
  expect(renderer!.root.findByProps({ 'data-testid': 'participant-name' }).children).toEqual(['After'])
  expect(JSON.stringify(renderer!.toJSON())).toContain('/repo/src/a.ts')
  expect(renderer!.root.findAllByType('button').filter(node => node.children.includes('Stop'))).toHaveLength(0)
})

test('a new local day recomputes separators even when events keep their reference', () => {
  const rows = watch(layout, 'layoutRows')
  const day = watch(times, 'chatDayKey')
  let today = '2026-10-15'
  // Keep the fixture day fixed and advance only the current-day lookup.
  day.mockImplementation((at: string) => at === '2026-10-15T10:00:00.000Z' ? '2026-10-15' : today)
  const events = typingHistory(1)
  act(() => { renderer = TestRenderer.create(<ChatMessages events={events} agentLabel="Claude" />) })
  const before = rows.mock.calls.length
  today = '2026-10-16'
  act(() => renderer!.update(<ChatMessages events={events} agentLabel="Codex" />))
  expect(rows.mock.calls.length).toBe(before + 1)
  expect(renderer!.root.findAllByProps({ 'data-testid': 'chat-day-separator' })).toHaveLength(1)
})
