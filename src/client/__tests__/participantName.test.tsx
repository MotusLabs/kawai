// Named message participants (team-message-threads D3): the peer-message row
// labels its sender through the resolver — a live agent's name and role, the
// human as `Human`, and a killed sender keeping its recorded name with
// `(gone)` and its role badge. The raw id is expandable metadata, never the
// primary label, and only an existing participant is clickable.
import { expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { Session } from '@shared/types'
import type { SessionDirectoryEntry } from '@shared/team'
import ChatMessages from '../components/chat/ChatMessages'
import ParticipantName from '../components/chat/ParticipantName'

/** Rendered text below a test instance (instances are cyclic; never stringify them). */
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const sessionRow = (id: string, name: string, groupId?: string) => ({
  id, name, projectPath: '/repo', status: 'waiting', lastActivity: '', createdAt: '',
  source: 'managed', kind: 'chat', ...(groupId ? { groupId } : {}),
} as Session)

const live: Session[] = [sessionRow('chat-live', 'Export button', 'devs')]
const directory: SessionDirectoryEntry[] = [
  { sessionId: 'chat-live', name: 'Export button', group: 'devs' },
  { sessionId: 'chat-gone', name: 'Killed helper', group: 'qa' },
]

const peerEvent = (extra: Partial<Extract<ChatEvent, { type: 'peer_message' }>> = {}): ChatEvent => ({
  type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 't1',
  messageId: 'm1', senderSession: 'chat-live', senderGroup: 'devs', priority: 'normal',
  originPath: '/repo', tags: [], threadId: 'm1', body: 'Please review', possibleDuplicate: false,
  ...extra,
})

const renderPeer = (event: ChatEvent, onOpen?: (sessionId: string) => void) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatMessages events={[event]} sessions={live} directory={directory}
      {...(onOpen ? { onOpenParticipant: onOpen } : {})} />)
  })
  return renderer
}

test('an agent sender shows its name, role badge, and expandable id', () => {
  const opened: string[] = []
  const renderer = renderPeer(peerEvent(), id => opened.push(id))
  const row = renderer.root.findByProps({ 'data-testid': 'participant' })
  expect(textOf(row.findByProps({ 'data-testid': 'participant-name' }))).toBe('Export button')
  expect(textOf(row.findByProps({ 'data-testid': 'participant-group' }))).toBe('devs')
  expect(textOf(row.findByProps({ 'data-testid': 'participant-id' }))).toContain('chat-live')
  expect(textOf(row.findByProps({ 'data-testid': 'participant-id' }))).toContain('id')

  act(() => { row.findByProps({ 'data-testid': 'participant-name' }).props.onClick() })
  expect(opened).toEqual(['chat-live'])
  act(() => renderer.unmount())
})

test('a human sender labels as Human with no role and never navigates', () => {
  const opened: string[] = []
  const renderer = renderPeer(peerEvent({ senderSession: '', senderKind: 'human' }), id => opened.push(id))
  const row = renderer.root.findByProps({ 'data-testid': 'participant' })
  expect(textOf(row.findByProps({ 'data-testid': 'participant-name' }))).toBe('Human')
  expect(row.findAllByProps({ 'data-testid': 'participant-group' })).toHaveLength(0)
  expect(textOf(row.findByProps({ 'data-testid': 'participant-id' }))).toContain('human')

  // A human sender has no session to open: the name is a plain span.
  expect(row.findAllByType('button')).toHaveLength(0)
  expect(opened).toEqual([])
  act(() => renderer.unmount())
})

test('a killed sender keeps its recorded name and role, marked gone and not clickable', () => {
  const opened: string[] = []
  const renderer = renderPeer(peerEvent({ senderSession: 'chat-gone' }), id => opened.push(id))
  const row = renderer.root.findByProps({ 'data-testid': 'participant' })
  expect(textOf(row.findByProps({ 'data-testid': 'participant-name' }))).toBe('Killed helper (gone)')
  expect(textOf(row.findByProps({ 'data-testid': 'participant-group' }))).toBe('qa')
  expect(row.findAllByType('button')).toHaveLength(0)
  expect(opened).toEqual([])
  act(() => renderer.unmount())
})

test('a never-seen sender is its raw id, marked gone', () => {
  const renderer = renderPeer(peerEvent({ senderSession: 'chat-never' }))
  const row = renderer.root.findByProps({ 'data-testid': 'participant' })
  expect(textOf(row.findByProps({ 'data-testid': 'participant-name' }))).toBe('chat-never (gone)')
  expect(row.findAllByType('button')).toHaveLength(0)
  act(() => renderer.unmount())
})

test('thread rows label each earlier sender the same way', () => {
  const renderer = renderPeer(peerEvent({
    thread: [
      { messageId: 'm0', senderSession: 'chat-gone', body: 'earlier', senderKind: 'agent' },
      { messageId: 'm-1', senderSession: '', body: 'from the human', senderKind: 'human' },
    ],
  }))
  const names = renderer.root.findAllByProps({ 'data-testid': 'participant-name' })
    .map(node => textOf(node))
  expect(names).toEqual(['Export button', 'Killed helper (gone)', 'Human'])
  act(() => renderer.unmount())
})

test('without a directory or sessions the label falls back to the raw id', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatMessages events={[peerEvent({ senderSession: 'chat-x' })]} />)
  })
  const row = renderer.root.findByProps({ 'data-testid': 'participant' })
  expect(textOf(row.findByProps({ 'data-testid': 'participant-name' }))).toBe('chat-x (gone)')
  act(() => renderer.unmount())
})

test('ParticipantName alone resolves the same labels the row does', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ParticipantName sessionId="chat-gone" sessions={live} directory={directory} />)
  })
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'participant-name' }))).toBe('Killed helper (gone)')
  act(() => renderer.unmount())

  act(() => {
    renderer = TestRenderer.create(<ParticipantName sessionId={null} senderKind="human" />)
  })
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'participant-name' }))).toBe('Human')
  act(() => renderer.unmount())
})

test('a live session wins on name but may take its role from the directory', () => {
  // The live row carries no group; only the directory recorded one.
  const unnamed: Session[] = [{ ...sessionRow('chat-live', 'Renamed helper') }]
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ParticipantName sessionId="chat-live" sessions={unnamed} directory={directory} />)
  })
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'participant-name' }))).toBe('Renamed helper')
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'participant-group' }))).toBe('devs')
  act(() => renderer.unmount())
})
