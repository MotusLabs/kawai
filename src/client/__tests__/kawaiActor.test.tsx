// Kawai as a rendered actor (plan-execution 2.4, design D2): "Kawai" names
// the creator, dispatcher, sender, and journal author in the task list and
// detail, the assignment history, the Mailbox, the Messages view, and
// peer-message rows — and it is never a link.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { TeamMessage } from '@shared/team'
import type { TeamTaskAssignment, TeamTaskDetail as Detail, TeamTaskSummary } from '@shared/teamTasks'
import ChatMessages from '../components/chat/ChatMessages'
import MessageRow from '../components/team/MessageRow'
import TeamMailboxView from '../components/team/TeamMailboxView'
import TeamTasksPanel from '../components/team/TeamTasksView'
import { useTeamTaskStore, type TaskView } from '../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import { useSessionStore } from '../stores/sessionStore'

const KAWAI = { kind: 'system', sessionId: null } as const
const mounted: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  act(() => { for (const renderer of mounted.splice(0)) renderer.unmount() })
  useTeamTaskStore.setState({ views: {} })
  useTeamWorkspaceStore.setState({ views: {} })
  useSessionStore.setState({ sessions: [] })
})
const mount = (element: React.ReactElement) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element) })
  mounted.push(renderer)
  return renderer
}
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const noButtonNamed = (renderer: TestRenderer.ReactTestRenderer, name: string) =>
  expect(renderer.root.findAllByType('button').filter(button => textOf(button).includes(name))).toEqual([])

const mail = (extra: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'm1', state: 'queued', deliverAt: null, teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'system', fromSession: null, fromGroup: null,
  originPath: '/repo', priority: 'normal', tags: [], threadId: 'm1', inReplyTo: null, hop: 1, body: 'Implement api',
  claimedBy: null, claimedAt: null, createdAt: new Date().toISOString(), pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: 't1', taskRevision: null, claimCommit: null, parkedUntil: null,
  parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null, ...extra,
})
const task: TeamTaskSummary = {
  id: 't1', teamId: 'team', title: 'api — Wave C', status: 'active', creator: KAWAI, parentId: null, worktree: null, openspecChange: 'api',
  revision: 1, direction: 'Build it', acceptance: null, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
  participants: [], assignment: null,
}
const assignment = {
  id: 'a1', taskId: 't1', requestKey: 'k', targetKind: 'group', targetId: 'devs', role: 'devs', instruction: 'Implement api',
  createdBy: KAWAI, messageId: 'm1', claimedBy: null, claimedAt: null, supersededBy: null, state: 'queued', reason: null,
  createdAt: '2026-10-16T00:00:00.000Z',
} as unknown as TeamTaskAssignment
const detail: Detail = {
  task, assignments: [assignment], subtasks: [], messages: [mail()],
  revisions: [{ revision: 1, direction: 'Build it', acceptance: null, author: KAWAI, createdAt: '2026-10-16T00:00:00.000Z' }],
  journal: [{ id: 'n1', author: KAWAI, text: 'Assigned to group devs by Kawai', createdAt: '2026-10-16T00:00:00.000Z' }],
}
const view = (extra: Partial<TaskView> = {}): TaskView => {
  useTeamTaskStore.getState().open('dev')
  return { ...useTeamTaskStore.getState().views.dev!, loading: false, tasks: [task], ...extra }
}

test('the task list names Kawai as creator', () => {
  const renderer = mount(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />)
  const row = renderer.root.find(node => node.type === 'article' && node.props['data-task-id'] === 't1')
  expect(textOf(row)).toContain('created by Kawai')
})

test('task detail names Kawai as creator, dispatcher, and journal author', () => {
  const renderer = mount(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view({ selectedTaskId: 't1', detail })} sendMessage={() => {}} connected />)
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'task-creator' }))).toBe('Kawai')
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'assignment-dispatcher' }))).toBe(' · by Kawai')
  expect(textOf(renderer.root)).not.toContain('Human')
  noButtonNamed(renderer, 'Kawai')
})

test('a Messages row names Kawai and never links it', () => {
  const opened: string[] = []
  const renderer = mount(<MessageRow row={mail()} sessions={[]} names={[]} onOpenSession={id => opened.push(id)} />)
  expect(textOf(renderer.root.findAllByProps({ 'data-testid': 'participant-name' })[0]!)).toBe('Kawai')
  noButtonNamed(renderer, 'Kawai')
})

test('a Mailbox row names Kawai as sender', () => {
  const renderer = mount(<TeamMailboxView teamPath="dev" view={{ open: true, loading: false, messages: [mail({ state: 'dead', reason: 'hop-limit' })] } as never} connected sendMessage={() => {}} />)
  const line = textOf(renderer.root.findByProps({ 'data-testid': 'mailbox-row-line' }))
  expect(line).toMatch(/^Kawai → /)
})

test('a peer-message row from Kawai names it and never links it', () => {
  const peer: ChatEvent = {
    type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 't', messageId: 'm1', senderSession: null, senderKind: 'system',
    senderGroup: null, priority: 'normal', originPath: '/repo', tags: [], threadId: 'm1', body: 'Implement api', possibleDuplicate: false,
  } as ChatEvent
  const renderer = mount(<ChatMessages events={[peer]} sessions={[]} directory={[]} onOpenParticipant={() => {}} />)
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'participant-name' }))).toBe('Kawai')
  noButtonNamed(renderer, 'Kawai')
})
