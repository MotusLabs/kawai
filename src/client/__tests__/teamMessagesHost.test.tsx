// Where the team views are hosted (team-message-threads 5.4,
// team-workspace-pages D4): the chat side slot hosts only the debug panel —
// no team view ever mounts in a chat — while task detail draws the same
// message rows with named participants and a link into each thread, and the
// Mailbox view keeps every delivery operation the Messages view is read
// plus compose over.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { ClientMessage, Session } from '@shared/types'
import type { TeamMessage } from '@shared/team'
import type { TeamTaskDetail as Detail, TeamTaskSummary } from '@shared/teamTasks'
import ChatView from '../components/chat/ChatView'
import TeamMailboxView from '../components/team/TeamMailboxView'
import TeamMessagesView from '../components/team/TeamMessagesView'
import TeamTaskDetail from '../components/team/TeamTaskDetail'
import { chooseSessionMenuEntry } from './support/sessionMenu'
import { useChatDebugStore } from '../stores/chatDebugStore'
import { emptyTranscript, useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { closedMessageView, useTeamMessageStore } from '../stores/teamMessageStore'
import { useTeamMailboxStore, type MailboxView } from '../stores/teamMailboxStore'
import { emptyDraft, useTeamTaskStore, type TaskView } from '../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'

afterEach(() => {
  act(() => {
    useChatDebugStore.setState({ views: {} })
    useTeamMailboxStore.setState({ views: {} })
    useTeamTaskStore.setState({ views: {} })
    useTeamMessageStore.setState({ views: {} })
    useTeamWorkspaceStore.setState({ views: {} })
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

test('the side slot hosts only Debug: no team view mounts in a chat', () => {
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatView
      session={chatSession} sendMessage={message => sent.push(message)}
      connectionStatus="connected" connectionEpoch={0} error={null}
      onClose={() => {}} onKill={() => {}} />)
  })
  act(() => chooseSessionMenuEntry(renderer.root, 'debug'))
  expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(1)
  for (const view of ['team-tasks', 'team-messages', 'team-mailbox', 'product-strategy']) {
    expect(renderer.root.findAllByProps({ 'data-testid': view })).toHaveLength(0)
  }
  // Team subscriptions stay untouched by a chat: nothing team-shaped is sent.
  expect(sent.filter(each => each.type.startsWith('team-'))).toHaveLength(0)
  act(() => { renderer.unmount() })
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
  act(() => { renderer.unmount() })
})

test('the Messages view composes and reads; delivery operations stay with the Mailbox view', () => {
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
  act(() => { messages.unmount() })
  sent.length = 0

  // The Mailbox view still runs those operations on the same rows.
  const mailboxView: MailboxView = { open: true, loading: false, messages: [uncertain, dead] }
  act(() => {
    useTeamWorkspaceStore.setState({ views: { 'chat-1': {
      open: true, tab: 'mailbox',
      tabs: {
        strategy: { search: '', filters: {}, expanded: [], collapsedSections: [] },
        tasks: { search: '', filters: {}, expanded: [], collapsedSections: [] },
        messages: { search: '', filters: {}, expanded: [], collapsedSections: [] },
        mailbox: { search: '', filters: {}, expanded: ['u1', 'd1'], collapsedSections: ['#defaults'] },
        members: { search: '', filters: {}, expanded: [], collapsedSections: [] },
        plans: { search: '', filters: {}, expanded: [], collapsedSections: [] },
          audit: { search: '', filters: {}, expanded: [], collapsedSections: [] },
        metrics: { search: '', filters: {}, expanded: [], collapsedSections: [] },
      },
      notice: null,
    } } })
  })
  let mailbox!: TestRenderer.ReactTestRenderer
  act(() => {
    mailbox = TestRenderer.create(<TeamMailboxView teamPath="chat-1" view={mailboxView}
      sendMessage={message => sent.push(message)} connected />)
  })
  act(() => {
    for (const button of mailbox.root.findAllByType('button')) {
      if (textOf(button) === 'Retry' || textOf(button) === 'Discard') button.props.onClick()
    }
  })
  expect(sent.map(message => message.type)).toEqual(['team-mailbox-retry', 'team-mailbox-discard', 'team-mailbox-retry', 'team-mailbox-discard'])
  act(() => { mailbox.unmount() })
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
    renderer = TestRenderer.create(<TeamMessagesView teamPath="chat-1" view={useTeamMessageStore.getState().views['chat-1']!}
      sendMessage={() => {}} connected sessions={sessions} onOpenSession={id => useSessionStore.getState().setSelectedSessionId(id)} />)
  })
  const byName = (name: string) =>
    renderer.root.findAllByProps({ 'data-testid': 'participant-name' }).find(node => textOf(node) === name)!
  // D3: only a participant that still exists is a button.
  expect(byName('Dev one').type).toBe('button')
  expect(byName('Killed helper (gone)').type).toBe('span')
  act(() => { (byName('Dev one') as TestRenderer.ReactTestInstance).props.onClick() })
  expect(useSessionStore.getState().selectedSessionId).toBe('dev')
  act(() => { renderer.unmount() })
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
  act(() => { renderer.unmount() })
})
