// Team task UI (team-tasks 7.1–7.3): the store's authoritative snapshots,
// the list/create view, the detail with its sections and human controls,
// and task context on live and replayed peer rows.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { ClientMessage, Session } from '@shared/types'
import type { TeamTaskDetail as Detail, TeamTaskSummary } from '@shared/teamTasks'
import ChatMessages from '../components/chat/ChatMessages'
import TeamTasksPanel from '../components/chat/TeamTasksPanel'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamTaskStore, type TaskView } from '../stores/teamTaskStore'

afterEach(() => {
  useTeamTaskStore.setState({ views: {} })
  useSessionStore.setState({ sessions: [] })
  useChatStore.setState({ sessions: {} })
})

const summary = (id: string, extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id, teamId: 'team', title: `Task ${id}`, status: 'open', creator: { kind: 'agent', sessionId: 'lead' }, parentId: null,
  worktree: null, openspecChange: null, revision: 1, direction: 'Build it', acceptance: null, createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z', participants: ['lead', 'dev'], assignment: null, ...extra,
})
const detail = (task: TeamTaskSummary, extra: Partial<Detail> = {}): Detail => ({
  task, revisions: [
    { revision: 1, direction: 'First plan', acceptance: null, author: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-11T00:00:00.000Z' },
    { revision: 2, direction: task.direction, acceptance: task.acceptance, author: { kind: 'human', sessionId: null }, createdAt: '2026-10-11T01:00:00.000Z' },
  ],
  journal: [
    { id: 'n1', author: { kind: 'agent', sessionId: 'dev' }, text: 'Picked option B', createdAt: '2026-10-11T02:00:00.000Z' },
    { id: 'n2', author: { kind: 'system', sessionId: null }, text: 'Released Dev one (dev): task done by human.', createdAt: '2026-10-11T03:00:00.000Z' },
  ],
  subtasks: [summary('child', { title: 'Export button', parentId: task.id })],
  assignments: [],
  messages: [{ id: 'm1', teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo', priority: 'normal',
    tags: [], threadId: 'm1', inReplyTo: null, hop: 1, body: 'Please build', state: 'delivered', claimedBy: 'dev', claimedAt: null, deliverAt: null,
    createdAt: '', pushedAt: null, deliveredAt: null, reason: null, possibleDuplicate: false, attachThread: false, taskId: task.id,
    taskRevision: null, claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null }],
  ...extra,
})
const sessionRow = (id: string, name: string) => ({ id, name, projectPath: '/repo', status: 'waiting', lastActivity: '', createdAt: '', source: 'managed', kind: 'chat' } as Session)
const text = (renderer: TestRenderer.ReactTestRenderer) => JSON.stringify(renderer.toJSON())
/** Rendered text below a test instance (instances are cyclic; never stringify them). */
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const openView = (): TaskView => {
  useTeamTaskStore.getState().open('dev')
  return useTeamTaskStore.getState().views.dev!
}

test('store: snapshots replace rows, closed views ignore pushes, results select a created task or show the refusal', () => {
  const store = useTeamTaskStore.getState()
  store.applySnapshot({ type: 'team-tasks-snapshot', teamPath: 'dev', teamId: 'team', tasks: [summary('a')] })
  expect(useTeamTaskStore.getState().views.dev).toBeUndefined()
  openView()
  expect(useTeamTaskStore.getState().views.dev!.loading).toBe(true)
  store.applySnapshot({ type: 'team-tasks-snapshot', teamPath: 'dev', teamId: 'team', tasks: [summary('a'), summary('b')] })
  store.applySnapshot({ type: 'team-tasks-snapshot', teamPath: 'dev', teamId: 'team', tasks: [summary('b')] })
  expect(useTeamTaskStore.getState().views.dev).toMatchObject({ loading: false, tasks: [{ id: 'b' }] })
  store.begin('dev', 'r1', 'create')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'r1', task: summary('new') })
  expect(useTeamTaskStore.getState().views.dev).toMatchObject({ selectedTaskId: 'new', pending: {}, error: null })
  store.applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: detail(summary('other')), directory: [] })
  expect(useTeamTaskStore.getState().views.dev!.detail).toBeNull()
  store.applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: detail(summary('new')), directory: [] })
  expect(useTeamTaskStore.getState().views.dev!.detail?.task.id).toBe('new')
  store.begin('dev', 'r2', 'status')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'r2', error: 'Task not found in this team: x' })
  expect(useTeamTaskStore.getState().views.dev).toMatchObject({ error: 'Task not found in this team: x', pending: {} })
  store.close('dev')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'r3', error: 'late' })
  expect(useTeamTaskStore.getState().views.dev).toBeUndefined()
})

test('list shows title, status, creator, and participants; a killed creator is marked gone', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  const view = { ...openView(), loading: false, tasks: [summary('a', { status: 'blocked' }), summary('b', { creator: { kind: 'human', sessionId: null }, participants: [] })] }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view} sendMessage={() => {}} connected onClose={() => {}} />) })
  const rows = renderer.root.findAll(node => node.type === 'article' && !!node.props['data-task-id'])
  expect(rows.map(row => row.props['data-task-id'])).toEqual(['a', 'b'])
  expect(textOf(rows[0]!.findByProps({ 'data-testid': 'task-status' }))).toBe('blocked')
  expect(rows[0]!.findByProps({ 'data-testid': 'task-participants' }).children.join('')).toBe('Participants: lead (gone), Dev one')
  expect(textOf(rows[0]!)).toContain('created by lead (gone)')
  expect(textOf(rows[1]!)).toContain('created by Human')
  expect(rows[1]!.findByProps({ 'data-testid': 'task-participants' }).children.join('')).toBe('Participants: none yet')
  act(() => renderer.unmount())
})

test('create sends every field with a request id; disconnected disables it; errors show inline', () => {
  const sent: ClientMessage[] = []
  openView()
  let renderer!: TestRenderer.ReactTestRenderer
  // The draft lives in the store; render from it so typing re-renders.
  const render = (connected: boolean) => <TeamTasksPanel teamPath="dev" projectPath="/repo"
    view={{ ...useTeamTaskStore.getState().views.dev!, loading: false, tasks: [summary('parent')], error: connected ? null : '/nowhere is not a worktree of this team\'s repository' }}
    sendMessage={message => sent.push(message)} connected={connected} onClose={() => {}} />
  act(() => { renderer = TestRenderer.create(render(true)) })
  const input = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
  act(() => {
    input('Task title').props.onChange({ target: { value: ' Export ' } })
    input('Task direction').props.onChange({ target: { value: 'CSV' } })
    input('Acceptance criteria').props.onChange({ target: { value: 'Downloads' } })
    input('Parent task').props.onChange({ target: { value: 'parent' } })
    input('Target worktree').props.onChange({ target: { value: '/repo-feature' } })
    input('Linked OpenSpec change').props.onChange({ target: { value: 'add-export' } })
  })
  // The draft lives in the store: re-render so the typed values reach the form.
  act(() => renderer.update(render(true)))
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  expect(sent.filter(message => message.type === 'team-task-create')).toEqual([{ type: 'team-task-create', teamPath: 'dev', requestId: expect.any(String), requestKey: expect.any(String),
    title: 'Export', direction: 'CSV',
    acceptance: 'Downloads', parentId: 'parent', worktree: '/repo-feature', openspecChange: 'add-export' }])
  expect(Object.values(useTeamTaskStore.getState().views.dev!.pending)).toEqual(['create'])
  act(() => renderer.update(render(false)))
  expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('/nowhere is not a worktree')
  expect(renderer.root.find(node => node.type === 'button' && node.children.includes('Create task')).props.disabled).toBe(true)
  expect(text(renderer)).toContain('Disconnected')
  act(() => renderer.unmount())
})

test('detail shows direction, retained revisions, journal, subtasks, messages; controls send amend, note, status, and reopen', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  const sent: ClientMessage[] = []
  const task = summary('t1', { status: 'done', revision: 2, direction: 'Current plan', acceptance: 'Ships', openspecChange: 'add-export', worktree: '/repo-feature' })
  const view: TaskView = { ...openView(), loading: false, tasks: [task], selectedTaskId: 't1', detail: detail(task) }
  let renderer!: TestRenderer.ReactTestRenderer
  const render = (connected: boolean) => <TeamTasksPanel teamPath="dev" projectPath="/repo" view={view} sendMessage={message => sent.push(message)} connected={connected} onClose={() => {}} />
  act(() => { renderer = TestRenderer.create(render(true)) })
  expect(renderer.root.findAllByType('section').map(section => section.props['aria-label'])).toEqual(['Assignment', 'Direction', 'Status', 'Journal', 'Subtasks', 'Messages'])
  expect(renderer.root.findByProps({ 'data-testid': 'task-direction' }).children.join('')).toBe('Current plan')
  expect(renderer.root.findByProps({ 'data-testid': 'task-acceptance' }).children.join('')).toBe('Ships')
  expect(renderer.root.findByProps({ 'data-testid': 'task-creator' }).children.join('')).toBe('lead (gone)')
  const revisions = renderer.root.findByProps({ 'data-testid': 'task-revisions' })
  expect(revisions.findAll(node => node.props['data-revision'] !== undefined && node.type === 'div').map(node => node.props['data-revision'])).toEqual([1, 2])
  expect(textOf(revisions)).toContain('First plan')
  for (const fragment of ['Picked option B', 'Dev one', 'Export button', 'Please build', 'add-export', 'authoritative direction', '/repo-feature']) {
    expect(text(renderer)).toContain(fragment)
  }
  // A system journal entry renders as kawai (member-release D4).
  expect(text(renderer)).toContain('Kawai')
  const button = (label: string) => renderer.root.find(node => node.type === 'button' && node.children.join('') === label)
  act(() => button('Reopen').props.onClick())
  act(() => button('Mark cancelled').props.onClick())
  const field = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
  // A draft first, then its publication (task-revision-publication 5.1/5.2).
  act(() => field('Draft direction').props.onChange({ target: { value: 'Revised plan' } }))
  act(() => button('Save draft').props.onClick())
  act(() => field('Rationale').props.onChange({ target: { value: 'Customer asked' } }))
  act(() => button('Publish revision 3').props.onClick())
  act(() => field('Journal note').props.onChange({ target: { value: 'Human note' } }))
  act(() => renderer.root.findAllByType('form').at(-1)!.props.onSubmit({ preventDefault: () => {} }))
  // Exactly one targets request per mount, not one per effect pass (N2).
  expect(sent.filter(message => message.type === 'team-task-targets')).toHaveLength(1)
  const actions = sent.filter(message => message.type.startsWith('team-task-') && message.type !== 'team-task-targets')
  expect(actions.map(message => ({ ...message, requestId: undefined, requestKey: undefined }) as Record<string, unknown>)).toEqual([
    { type: 'team-task-status', teamPath: 'dev', taskId: 't1', status: 'open' },
    { type: 'team-task-status', teamPath: 'dev', taskId: 't1', status: 'cancelled' },
    { type: 'team-task-draft', teamPath: 'dev', taskId: 't1', action: 'save', baseRevision: 2, direction: 'Revised plan', acceptance: 'Ships', rationale: '' },
    { type: 'team-task-publish', teamPath: 'dev', taskId: 't1', baseRevision: 2, direction: 'Revised plan', acceptance: 'Ships', rationale: 'Customer asked', notify: false, fromDraft: false },
    { type: 'team-task-note', teamPath: 'dev', taskId: 't1', text: 'Human note' },
  ].map(message => ({ ...message, requestId: undefined, requestKey: undefined })))
  expect(typeof (actions[3] as { requestKey?: string }).requestKey).toBe('string')
  act(() => renderer.update(render(false)))
  for (const node of renderer.root.findAll(node => node.type === 'button' && (/^Mark |^Reopen|^Save draft|^Publish|^Add note/).test(node.children.join('')))) {
    expect(node.props.disabled).toBe(true)
  }
  act(() => button('All tasks').props.onClick())
  expect(useTeamTaskStore.getState().views.dev!.selectedTaskId).toBeNull()
  act(() => renderer.unmount())
})

test('peer rows show task context, live and after replay', () => {
  const peer: ChatEvent = { type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 't', messageId: 'mail', senderSession: 'lead',
    senderGroup: 'leads', priority: 'normal', originPath: '/repo', tags: [], threadId: 'mail', body: 'Please build', possibleDuplicate: false,
    task: { id: 'task-1', title: 'Export', status: 'active', revision: 3, direction: 'CSV and JSON', acceptance: 'Downloads',
      openspecChange: 'add-export', worktree: '/repo-feature', journal: [{ author: 'qa', text: 'Schema needed', createdAt: '2026-10-11' }] } }
  const replayed: ChatEvent = { ...peer, id: 'p2', sequence: 0 }
  for (const event of [peer, replayed]) {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatMessages events={[event]} />) })
    const section = renderer.root.findByProps({ 'data-testid': 'peer-task' })
    for (const fragment of ['Task: ', 'Export', 'active', 'revision ', '/repo-feature', 'add-export', 'CSV and JSON', 'Acceptance: ', 'Schema needed']) {
      expect(textOf(section)).toContain(fragment)
    }
    act(() => renderer.unmount())
  }
  let plain!: TestRenderer.ReactTestRenderer
  act(() => { plain = TestRenderer.create(<ChatMessages events={[{ ...peer, task: undefined } as ChatEvent]} />) })
  expect(plain.root.findAllByProps({ 'data-testid': 'peer-task' })).toHaveLength(0)
  act(() => plain.unmount())
})
