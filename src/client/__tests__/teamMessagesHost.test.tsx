// Where the Messages view is hosted (team-message-threads 5.4): the chat side
// slot holds one of Debug / Mailbox / Tasks / Messages at a time, task detail
// draws the same message rows with named participants and a link into each
// thread, and the Mailbox panel keeps every delivery operation — the Messages
// view is read plus compose, never retry/discard/cancel/hand-off.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { ClientMessage, Session } from '@shared/types'
import type { TeamMessage } from '@shared/team'
import type { TeamTaskDetail as Detail, TeamTaskSummary } from '@shared/teamTasks'
import ChatView from '../components/chat/ChatView'
import TeamMailboxPanel from '../components/chat/TeamMailboxPanel'
import TeamMessagesPanel from '../components/chat/TeamMessagesPanel'
import TeamMessagesView from '../components/team/TeamMessagesView'
import TeamTaskDetail from '../components/chat/TeamTaskDetail'
import { closeOtherSideSlots } from '../components/chat/sideSlot'
import { chooseSessionMenuEntry } from './support/sessionMenu'
import { useChatDebugStore } from '../stores/chatDebugStore'
import { emptyTranscript, useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { closedMessageView, useTeamMessageStore } from '../stores/teamMessageStore'
import { useTeamMailboxStore, type MailboxView } from '../stores/teamMailboxStore'
import { emptyDraft, useTeamTaskStore, type TaskView } from '../stores/teamTaskStore'

afterEach(() => {
  act(() => {
    useChatDebugStore.setState({ views: {} })
    useTeamMailboxStore.setState({ views: {} })
    useTeamTaskStore.setState({ views: {} })
    useTeamMessageStore.setState({ views: {} })
    useSessionStore.setState({ sessions: [], selectedSessionId: null, selectedHibernatingSessionId: null })
    useChatStore.setState({ sessions: {} })
  })
})

const chatSession = {
  id: 'chat-1', name: 'Chat', projectPath: '/tmp/project', status: 'waiting', kind: 'chat',
} as unknown as Session

const textOf = (node: TestRenderer.ReactTestInstance | string | TestRenderer.ReactTestInstance[]): string =>
  typeof node === 'string' ? node
    : Array.isArray(node) ? node.map(textOf).join('')
      : (node.children ?? []).map(textOf).join('')
const buttonNamed = (renderer: TestRenderer.ReactTestRenderer, name: string) =>
  renderer.root.findAllByType('button').find(button => textOf(button) === name)!

const message = (id: string, extra: Partial<TeamMessage> = {}): TeamMessage => ({
  id, teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'chat-gone',
  fromGroup: 'qa', originPath: '/repo', priority: 'normal', tags: [], threadId: 'th', inReplyTo: null,
  hop: 1, body: `Body ${id}`, state: 'delivered', claimedBy: 'dev', claimedAt: null, deliverAt: null,
  createdAt: '2026-10-13T10:00:00.000Z', pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: 't1', taskRevision: 2, claimCommit: null,
  parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null,
  ...extra,
})
const sessions = [{ id: 'dev', name: 'Dev one', groupId: 'devs' }]
const directory = [{ sessionId: 'chat-gone', name: 'Killed helper', group: 'qa' }]

test('the side slot holds one panel at a time: Messages closes the others and is closed by them', () => {
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatView
      session={chatSession} sendMessage={message => sent.push(message)}
      connectionStatus="connected" connectionEpoch={0} error={null}
      onClose={() => {}} onKill={() => {}} />)
  })
  const panel = (id: string) => renderer.root.findAllByProps({ 'data-testid': id })

  act(() => buttonNamed(renderer, 'Messages').props.onClick())
  expect(panel('team-messages')).toHaveLength(1)
  expect(panel('team-mailbox')).toHaveLength(0)
  expect(panel('team-tasks')).toHaveLength(0)
  expect(panel('chat-debug-panel')).toHaveLength(0)
  expect(useTeamMessageStore.getState().views['/tmp/project']!.open).toBe(true)

  // Opening another side panel closes Messages.
  act(() => buttonNamed(renderer, 'Mailbox').props.onClick())
  expect(panel('team-messages')).toHaveLength(0)
  expect(panel('team-mailbox')).toHaveLength(1)
  expect(useTeamMessageStore.getState().views['/tmp/project']).toBeUndefined()
  act(() => buttonNamed(renderer, 'Tasks').props.onClick())
  expect(panel('team-mailbox')).toHaveLength(0)
  expect(panel('team-tasks')).toHaveLength(1)
  act(() => chooseSessionMenuEntry(renderer.root, 'debug'))
  expect(panel('team-tasks')).toHaveLength(0)
  expect(panel('chat-debug-panel')).toHaveLength(1)
  // Messages closes Debug again.
  act(() => buttonNamed(renderer, 'Messages').props.onClick())
  expect(panel('chat-debug-panel')).toHaveLength(0)
  expect(panel('team-messages')).toHaveLength(1)
  expect(useTeamMailboxStore.getState().views['/tmp/project']).toBeUndefined()
  expect(useTeamTaskStore.getState().views['/tmp/project']).toBeUndefined()
  expect(useChatDebugStore.getState().views['chat-1']?.open).not.toBe(true)
  act(() => renderer.unmount())
})

test('closeOtherSideSlots keeps the named panel and drops the rest, one chat and team at a time', () => {
  act(() => {
    useChatDebugStore.getState().beginOpen('chat-1')
    useTeamMailboxStore.getState().open('/repo')
    useTeamTaskStore.getState().open('/repo')
    useTeamMessageStore.getState().open('/other')
    closeOtherSideSlots('messages', { sessionId: 'chat-1', teamKey: '/repo' })
  })
  expect(useChatDebugStore.getState().views['chat-1']).toBeUndefined()
  expect(useTeamMailboxStore.getState().views['/repo']).toBeUndefined()
  expect(useTeamTaskStore.getState().views['/repo']).toBeUndefined()
  // Another team's panel is untouched.
  expect(useTeamMessageStore.getState().views['/other']!.open).toBe(true)
})

test('task detail names its message participants and links into each thread', () => {
  const opened: string[] = []
  const summary: TeamTaskSummary = {
    id: 't1', teamId: 'team', title: 'Export CSV', status: 'open', creator: { kind: 'human', sessionId: null },
    parentId: null, worktree: null, openspecChange: null, revision: 2, direction: 'Build it', acceptance: null,
    createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', participants: ['dev'], assignment: null,
  }
  const detail: Detail = {
    task: summary, revisions: [], journal: [], subtasks: [], assignments: [],
    messages: [
      message('m1', { fromSession: 'chat-gone', threadId: 'th-one', body: 'From the killed helper' }),
      message('m2', { fromSession: 'dev', threadId: 'th-two', body: 'From the live one', taskRevision: null }),
    ],
  }
  const view: TaskView = {
    open: true, loading: false, tasks: [summary], selectedTaskId: 't1', detail, directory, pending: {}, error: null,
    draft: emptyDraft(), flow: null, preview: null, previewPending: {}, targets: null, targetsLoading: false,
    commands: {}, commandRequests: {},
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamTaskDetail teamPath="chat-1" projectPath="/repo" view={view} sendMessage={() => {}}
      connected sessions={[{ ...chatSession, id: 'dev', name: 'Dev one', groupId: 'devs' } as Session]}
      onOpenThread={threadId => opened.push(threadId)} />)
  })
  const rows = renderer.root.findAllByProps({ 'data-testid': 'message-row' })
  expect(rows).toHaveLength(2)
  // Named participants: a killed sender keeps its name with `(gone)`, a live
  // one its own name. The raw id stays in the expandable metadata, never the
  // label (D3).
  const names = renderer.root.findAllByProps({ 'data-testid': 'participant-name' }).map(node => textOf(node))
  expect(names).toEqual(['Killed helper (gone)', 'Dev one'])
  expect(textOf(renderer.root)).toContain('From the killed helper')
  expect(textOf(renderer.root)).toContain('Task revision 2')
  const links = renderer.root.findAllByProps({ 'data-testid': 'message-open-thread' })
  expect(links.map(link => link.parent!.props['data-message-id'])).toEqual(['m1', 'm2'])
  act(() => { links[1].props.onClick() })
  expect(opened).toEqual(['th-two'])
  act(() => renderer.unmount())
})

test('the Messages view composes and reads; delivery operations stay with the Mailbox panel', () => {
  const uncertain = message('u1', { state: 'uncertain', claimedBy: 'dev', reason: 'Transcript unreadable' })
  const dead = message('d1', { state: 'dead', reason: 'worktree-missing: /gone' })
  const sent: ClientMessage[] = []
  const messageView = {
    ...closedMessageView(), open: true, teamId: 'team', messages: [uncertain, dead],
    directory, tasks: [{ id: 't1', title: 'Export CSV' }],
  }
  let messages!: TestRenderer.ReactTestRenderer
  act(() => {
    messages = TestRenderer.create(<TeamMessagesView teamPath="chat-1" view={messageView}
      sendMessage={message => sent.push(message)} connected sessions={sessions} groups={[]} />)
  })
  const labels = messages.root.findAllByType('button').map(button => textOf(button))
  // Read + compose only: no delivery operation leaked out of the Mailbox.
  for (const operation of ['Retry', 'Discard', 'Cancel', 'Hand off', 'Reload routing rules']) {
    expect(labels).not.toContain(operation)
  }
  expect(labels).toContain('Send message')
  expect(labels).toContain('Open thread')
  act(() => messages.unmount())
  // The view's own subscription opened and closed around that render.
  sent.length = 0

  // The Mailbox panel still runs those operations on the same rows.
  const mailboxView: MailboxView = { open: true, loading: false, messages: [uncertain, dead] }
  let mailbox!: TestRenderer.ReactTestRenderer
  act(() => {
    mailbox = TestRenderer.create(<TeamMailboxPanel teamPath="chat-1" view={mailboxView}
      sendMessage={message => sent.push(message)} connected onClose={() => {}} />)
  })
  act(() => {
    for (const button of mailbox.root.findAllByType('button')) {
      if (textOf(button) === 'Retry' || textOf(button) === 'Discard') button.props.onClick()
    }
  })
  expect(sent.map(message => message.type)).toEqual(['team-mailbox-retry', 'team-mailbox-discard', 'team-mailbox-retry', 'team-mailbox-discard'])
  act(() => mailbox.unmount())
})

test('a live message participant opens its chat; a killed one is a name and no link', () => {
  act(() => {
    useTeamMessageStore.setState({
      views: { 'chat-1': { ...closedMessageView(), open: true, teamId: 'team', messages: [
        message('m1', { fromSession: 'dev', toKind: 'session', toId: 'chat-gone', body: 'Live to gone' }),
      ], directory } },
    })
    useSessionStore.setState({ sessions: [chatSession, { ...chatSession, id: 'dev', name: 'Dev one', groupId: 'devs' }] })
  })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamMessagesPanel teamPath="chat-1" projectPath="/tmp/project"
      sendMessage={() => {}} connected connectionEpoch={0} onClose={() => {}} />)
  })
  const byName = (name: string) =>
    renderer.root.findAllByProps({ 'data-testid': 'participant-name' }).find(node => textOf(node) === name)!
  // D3: only a participant that still exists is a button.
  expect(byName('Dev one').type).toBe('button')
  expect(byName('Killed helper (gone)').type).toBe('span')
  act(() => { (byName('Dev one') as TestRenderer.ReactTestInstance).props.onClick() })
  expect(useSessionStore.getState().selectedSessionId).toBe('dev')
  act(() => renderer.unmount())
})

test('the transcript names its peer senders and opens a live one, never a gone one', () => {
  const peer: ChatEvent = {
    type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 't1',
    messageId: 'm1', senderSession: 'dev', senderGroup: 'devs', senderKind: 'agent',
    priority: 'normal', originPath: '/repo', tags: [], threadId: 'm1', body: 'Please review',
    possibleDuplicate: false,
  }
  act(() => {
    useChatStore.setState({ sessions: { 'chat-1': { ...emptyTranscript(), events: [peer] } } })
    useSessionStore.setState({ sessions: [chatSession, { ...chatSession, id: 'dev', name: 'Dev one', groupId: 'devs' }] })
    useTeamMessageStore.setState({
      views: { 'chat-1': { ...closedMessageView(), open: true, teamId: 'team', directory } },
    })
  })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatView session={chatSession} sendMessage={() => {}}
      connectionStatus="connected" connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />)
  })
  const names = renderer.root.findAllByProps({ 'data-testid': 'participant-name' }).map(node => textOf(node))
  // Without the host wiring this read `dev (gone)` — a live sender is named.
  expect(names).toContain('Dev one')
  expect(names).not.toContain('dev (gone)')
  const live = renderer.root.findAllByProps({ 'data-testid': 'participant-name' }).find(node => textOf(node) === 'Dev one')!
  expect(live.type).toBe('button')
  act(() => { live.props.onClick() })
  expect(useSessionStore.getState().selectedSessionId).toBe('dev')
  act(() => renderer.unmount())
})
