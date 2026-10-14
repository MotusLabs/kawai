// Task assignment UI (task-assignment 5.2–5.5, 2.2): the create form's
// stable request key and its dispatch leg, the retained draft on refusal
// with Retry assignment reusing the task and key, the preview display, the
// detail's Assign / send task with the reassignment choice, assignment row
// labels, and the human sender on dispatched instruction rows (rendered
// through team-message-threads' sender plumbing, nothing of our own).
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { ClientMessage, Session } from '@shared/types'
import type { TeamTaskAssignment, TeamTaskDetail as Detail, TeamTaskSummary } from '@shared/teamTasks'
import type { TeamMessage } from '@shared/team'
import ChatMessages from '../components/chat/ChatMessages'
import MessageRow from '../components/team/MessageRow'
import TeamTasksPanel from '../components/chat/TeamTasksPanel'
import { assignmentLabel } from '../components/chat/TeamTasksPanel'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { emptyDraft, useTeamTaskStore, type TaskView } from '../stores/teamTaskStore'

afterEach(() => {
  useTeamTaskStore.setState({ views: {} })
  useSessionStore.setState({ sessions: [] })
  useChatStore.setState({ sessions: {} })
})

const summary = (id: string, extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id, teamId: 'team', title: `Task ${id}`, status: 'open', creator: { kind: 'agent', sessionId: 'lead' }, parentId: null,
  worktree: null, openspecChange: null, revision: 1, direction: 'Build it', acceptance: null, createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z', participants: [], assignment: null, ...extra,
})

const assignment = (id: string, extra: Partial<TeamTaskAssignment> = {}): TeamTaskAssignment => ({
  id, taskId: 't1', requestKey: `key-${id}`, targetKind: 'group', targetId: 'devs', role: 'devs',
  instruction: 'Go', createdBy: { kind: 'human', sessionId: null }, messageId: `mail-${id}`,
  claimedBy: null, claimedAt: null, supersededBy: null, state: 'queued', reason: null,
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', ...extra,
})

const detail = (task: TeamTaskSummary, extra: Partial<Detail> = {}): Detail => ({
  task, revisions: [], journal: [], subtasks: [], assignments: [], messages: [], ...extra,
})

const sessionRow = (id: string, name: string): Session =>
  ({ id, name, projectPath: '/repo', status: 'waiting', lastActivityAt: '', createdAt: '', source: 'managed', kind: 'chat' } as unknown) as Session

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const openView = (patch: Partial<TaskView> = {}): TaskView => {
  useTeamTaskStore.getState().open('dev')
  // Applied into the store: the panels read their view from it.
  useTeamTaskStore.setState(state => ({ views: { ...state.views, dev: { ...state.views.dev!, ...patch } } }))
  return useTeamTaskStore.getState().views.dev!
}

/** Render the panel reading the store's live view (the draft lives there). */
const mountPanel = (patch: Partial<TaskView> = {}) => {
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  const element = (connected = true) => <TeamTasksPanel teamPath="dev" projectPath="/repo"
    view={{ ...useTeamTaskStore.getState().views.dev!, loading: false, ...patch }}
    sendMessage={message => sent.push(message)} connected={connected} onClose={() => {}} />
  act(() => { renderer = TestRenderer.create(element(true)) })
  const rerender = (connected = true) => act(() => { renderer.update(element(connected)) })
  const store = () => useTeamTaskStore.getState().views.dev!
  const sentOf = (type: string) => sent.filter(message => message.type === type)
  return { renderer, sent, sentOf, rerender, store }
}

test('store: create-and-assign commits the task, then the dispatch leg under the same key', () => {
  const view = openView()
  const store = useTeamTaskStore.getState()
  store.armFlow('dev', 'create-and-assign')
  const key = useTeamTaskStore.getState().views.dev!.flow!.requestKey
  store.begin('dev', 'c1', 'create-assign')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'c1', task: summary('t1') })
  expect(useTeamTaskStore.getState().views.dev!.flow).toMatchObject({ requestKey: key, taskId: 't1' })
  // The draft is retained until the assign leg lands.
  expect(useTeamTaskStore.getState().views.dev!.draft).toEqual(emptyDraft())
  store.begin('dev', 'a1', 'assign')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'a1', assignment: assignment('as1'), task: summary('t1') })
  expect(useTeamTaskStore.getState().views.dev!.flow).toBeNull()
  expect(useTeamTaskStore.getState().views.dev!.selectedTaskId).toBe('t1')
  void view
})

test('store: a refused assign keeps the draft and the flow; retry reuses the key until the payload changes', () => {
  openView()
  const store = useTeamTaskStore.getState()
  store.armFlow('dev', 'create-and-assign')
  const flow = useTeamTaskStore.getState().views.dev!.flow!
  store.setDraft('dev', { title: 'Export', direction: 'CSV', targetKind: 'group', targetId: 'devs', instruction: 'Go' })
  store.flowSendAssign('dev', { targetKind: 'group', targetId: 'devs', instruction: 'Go' })
  store.begin('dev', 'a1', 'assign')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'a1', error: 'Unknown group: ghosts' })
  expect(useTeamTaskStore.getState().views.dev!.flow).toMatchObject({ requestKey: flow.requestKey, assignFailed: true })
  expect(useTeamTaskStore.getState().views.dev!.draft.instruction).toBe('Go')
  // An unchanged retry reuses the key; an edited instruction re-keys.
  store.retryAssign('dev')
  expect(useTeamTaskStore.getState().views.dev!.flow).toMatchObject({ requestKey: flow.requestKey, assignFailed: false })
  store.begin('dev', 'a2', 'assign')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'a2', error: 'nope' })
  store.setDraft('dev', { instruction: 'Different wording' })
  store.retryAssign('dev')
  expect(useTeamTaskStore.getState().views.dev!.flow!.requestKey).not.toBe(flow.requestKey)
  expect(useTeamTaskStore.getState().views.dev!.flow!.sentPayload).toMatchObject({ instruction: 'Different wording' })
})

test('panel: create and assign sends create then assign under one key; a double click sends one create', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  openView()
  const store = useTeamTaskStore.getState()
  store.setDraft('dev', { title: 'Export', direction: 'CSV', targetKind: 'group', targetId: 'devs', instruction: 'Please build' })
  const { renderer, sentOf, store: live, rerender } = mountPanel()
  const button = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  act(() => button('task-create-assign-button').props.onClick())
  expect(sentOf('team-task-create')).toHaveLength(1)
  const create = sentOf('team-task-create')[0] as Extract<ClientMessage, { type: 'team-task-create' }>
  expect(create.requestKey).toEqual(expect.any(String))
  // The button disables while the create is pending: a second click sends nothing.
  rerender()
  expect(button('task-create-assign-button').props.disabled).toBe(true)
  act(() => button('task-create-assign-button').props.onClick())
  expect(sentOf('team-task-create')).toHaveLength(1)
  // The create commits; the dispatch leg goes out under the same key.
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: create.requestId, task: summary('t1') }))
  rerender()
  expect(live().flow).toMatchObject({ taskId: 't1' })
  const assigns = sentOf('team-task-assign') as Array<Extract<ClientMessage, { type: 'team-task-assign' }>>
  expect(assigns).toHaveLength(1)
  expect(assigns[0]).toMatchObject({ taskId: 't1', requestKey: create.requestKey, target: { kind: 'group', id: 'devs' }, instruction: 'Please build' })
  void renderer.unmount
  act(() => renderer.unmount())
})

test('panel: empty instruction keeps Create and assign disabled; the preview renders', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  openView()
  useTeamTaskStore.getState().setDraft('dev', { title: 'Export', direction: 'CSV', targetKind: 'group', targetId: 'devs', instruction: '' })
  const { renderer, sentOf, rerender } = mountPanel()
  expect(renderer.root.findByProps({ 'data-testid': 'task-create-assign-button' }).props.disabled).toBe(true)
  // Preview on demand: the result renders, errors included.
  act(() => renderer.root.findByProps({ 'data-testid': 'task-assign-preview-button' }).props.onClick())
  const preview = sentOf('team-task-preview')[0] as Extract<ClientMessage, { type: 'team-task-preview' }>
  expect(preview.target).toEqual({ kind: 'group', id: 'devs' })
  act(() => useTeamTaskStore.getState().applyPreviewResult({
    type: 'team-task-preview-result', teamPath: 'dev', requestId: preview.requestId,
    preview: {
      worktree: null, target: { kind: 'group', id: 'devs' }, role: 'Developers', profile: 'default', approval: 'manual',
      sessionWorktree: null, idleMembers: ['dev'], spawn: { allowed: false, profile: null, blockedBy: 'group devs is at its max' }, warning: null,
    },
  }))
  rerender()
  const rendered = renderer.root.findByProps({ 'data-testid': 'task-assign-preview' })
  expect(textOf(rendered)).toContain('Developers')
  expect(textOf(rendered)).toContain('Idle matching members: dev')
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'task-preview-staffing' }))).toContain('cannot add a member')
  act(() => renderer.unmount())
})

test('panel: a refused dispatch keeps every field and offers Retry assignment on the existing task', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  openView()
  const store = useTeamTaskStore.getState()
  store.setDraft('dev', { title: 'Export', direction: 'CSV', acceptance: 'Ships', targetKind: 'group', targetId: 'devs', instruction: 'Please build' })
  const { renderer, sentOf, store: live, rerender } = mountPanel()
  act(() => renderer.root.findByProps({ 'data-testid': 'task-create-assign-button' }).props.onClick())
  const create = sentOf('team-task-create')[0] as Extract<ClientMessage, { type: 'team-task-create' }>
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: create.requestId, task: summary('t1') }))
  rerender()
  // The assign leg is refused (E02): the error shows inline, the task stays,
  // and every field remains as entered.
  const assigns = () => sentOf('team-task-assign') as Array<Extract<ClientMessage, { type: 'team-task-assign' }>>
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: assigns()[0]!.requestId, error: 'Unknown group: devs' }))
  rerender()
  expect(live().flow).toMatchObject({ taskId: 't1', assignFailed: true })
  expect(live().draft).toMatchObject({ title: 'Export', direction: 'CSV', acceptance: 'Ships', instruction: 'Please build' })
  expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('Unknown group: devs')
  // Once creation committed, only the dispatch-side retry is offered.
  expect(renderer.root.findAllByProps({ 'data-testid': 'task-create-assign-button' })).toHaveLength(0)
  expect(renderer.root.findByProps({ 'data-testid': 'task-retry-assign' })).toBeDefined()
  act(() => renderer.root.findByProps({ 'data-testid': 'task-retry-assign' }).props.onClick())
  rerender()
  expect(assigns()).toHaveLength(2)
  expect(assigns()[1]).toMatchObject({ taskId: 't1', requestKey: create.requestKey })
  act(() => renderer.unmount())
})

test('a lost result plus reconnect clears the waiters and the dispatch leg re-sends under the same key', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  openView()
  const store = useTeamTaskStore.getState()
  store.setDraft('dev', { title: 'Export', direction: 'CSV', targetKind: 'group', targetId: 'devs', instruction: 'Please build' })
  const { renderer, sentOf, store: live, rerender } = mountPanel()
  act(() => renderer.root.findByProps({ 'data-testid': 'task-create-assign-button' }).props.onClick())
  const create = sentOf('team-task-create')[0] as Extract<ClientMessage, { type: 'team-task-create' }>
  // The result is lost with the connection; the reconnect drops the waiter
  // so the form is usable again, and the human resubmit reuses the armed key.
  rerender(false)
  expect(live().pending).toMatchObject({ [create.requestId]: 'create-assign' })
  rerender(true)
  expect(live().pending).toEqual({})
  // The cleared pending reaches the panel on the next render (the effect
  // runs after the reconnect render itself).
  rerender(true)
  act(() => renderer.root.findByProps({ 'data-testid': 'task-create-assign-button' }).props.onClick())
  const creates = sentOf('team-task-create') as Array<Extract<ClientMessage, { type: 'team-task-create' }>>
  expect(creates).toHaveLength(2)
  expect(creates[1]!.requestKey).toBe(create.requestKey)
  // The create commits; its assign leg is sent, its result is lost too, and
  // the reconnect re-arms the dispatch effect to re-send under the same key.
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: creates[1]!.requestId, task: summary('t1') }))
  rerender()
  const firstAssign = (sentOf('team-task-assign') as Array<Extract<ClientMessage, { type: 'team-task-assign' }>>)[0]!
  rerender(false)
  rerender(true)
  rerender()
  const assigns = sentOf('team-task-assign') as Array<Extract<ClientMessage, { type: 'team-task-assign' }>>
  expect(assigns).toHaveLength(2)
  expect(assigns[1]).toMatchObject({ taskId: 't1', requestKey: firstAssign.requestKey, target: { kind: 'group', id: 'devs' } })
  act(() => renderer.unmount())
})

test('detail: Assign / send task dispatches; an outstanding assignment forces the notify/stop choice', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one'), sessionRow('qa', 'QA helper')] })
  const outstanding = assignment('as1', { claimedBy: 'dev' })
  const tasked = summary('t1', { assignment: outstanding })
  openView({ tasks: [tasked], selectedTaskId: 't1', detail: detail(tasked, { assignments: [outstanding] }) })
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo"
      view={{ ...useTeamTaskStore.getState().views.dev!, loading: false }}
      sendMessage={message => sent.push(message)} connected onClose={() => {}} />)
  })
  expect(renderer.root.findByProps({ 'data-testid': 'task-outstanding-assignment' }).children.join('')).toContain('group devs')
  const form = renderer.root.findByProps({ 'data-testid': 'task-assign-form' })
  // Fill the assign form: session target with an instruction.
  act(() => form.findByProps({ 'aria-label': 'Assignment target kind' }).props.onChange({ target: { value: 'session' } }))
  act(() => renderer.root.findByProps({ 'aria-label': 'Assignment session' }).props.onChange({ target: { value: 'qa' } }))
  act(() => renderer.root.findByProps({ 'aria-label': 'Assignment instruction' }).props.onChange({ target: { value: 'Take over' } }))
  // An outstanding assignment opens the choice instead of sending.
  act(() => renderer.root.findByProps({ 'data-testid': 'task-assign-send' }).props.onClick())
  const choice = renderer.root.findByProps({ 'data-testid': 'task-reassign-choice' })
  expect(textOf(choice)).toContain('group devs')
  expect(textOf(choice)).toContain('claimed by Dev one')
  const confirm = () => renderer.root.findByProps({ 'data-testid': 'task-reassign-confirm' })
  expect(confirm().children.join('')).toContain('Reassign (notify)')
  act(() => choice.findAllByProps({ type: 'radio' })[1]!.props.onChange())
  expect(confirm().children.join('')).toContain('Reassign (stop)')
  act(() => confirm().props.onClick())
  const assigns = sent.filter(message => message.type === 'team-task-assign') as Array<Extract<ClientMessage, { type: 'team-task-assign' }>>
  expect(assigns).toHaveLength(1)
  expect(assigns[0]).toMatchObject({ taskId: 't1', target: { kind: 'session', id: 'qa' }, instruction: 'Take over', handling: 'stop', requestKey: expect.any(String) })
  act(() => renderer.unmount())
})

test('detail: an unassigned task sends directly; a failed assignment shows its reason; disconnect disables', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  const failed = assignment('as0', { state: 'failed', reason: 'worktree-missing: /gone' })
  const superseded = assignment('as1', { state: 'superseded', supersededBy: 'as2', claimedBy: 'dev' })
  const standing = assignment('as2', { state: 'delivered', claimedBy: 'dev' })
  const tasked = summary('t1', { assignment: standing })
  openView({ tasks: [tasked], selectedTaskId: 't1', detail: detail(tasked, { assignments: [failed, superseded, standing] }) })
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  const element = (connected: boolean) => <TeamTasksPanel teamPath="dev" projectPath="/repo"
    view={{ ...useTeamTaskStore.getState().views.dev!, loading: false }}
    sendMessage={message => sent.push(message)} connected={connected} onClose={() => {}} />
  act(() => { renderer = TestRenderer.create(element(true)) })
  const history = renderer.root.findByProps({ 'data-testid': 'task-assignment-history' })
  expect(textOf(history)).toContain('failed')
  expect(textOf(history)).toContain('worktree-missing: /gone')
  expect(textOf(history)).toContain('superseded')
  // Delivered work stays outstanding — a new dispatch still needs the choice.
  expect(renderer.root.findByProps({ 'data-testid': 'task-outstanding-assignment' }).children.join('')).toContain('delivered')
  // An unassigned task sends directly (no dialog): use the second task in the list.
  act(() => useTeamTaskStore.getState().select('dev', null))
  const plain = summary('t2')
  act(() => useTeamTaskStore.getState().applySnapshot({ type: 'team-tasks-snapshot', teamPath: 'dev', teamId: 'team', tasks: [tasked, plain] }))
  act(() => useTeamTaskStore.getState().select('dev', 't2'))
  act(() => useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: detail(plain), directory: [] }))
  act(() => renderer.update(element(true)))
  const form = renderer.root.findByProps({ 'data-testid': 'task-assign-form' })
  act(() => form.findByProps({ 'aria-label': 'Assignment target kind' }).props.onChange({ target: { value: 'group' } }))
  act(() => renderer.root.findByProps({ 'aria-label': 'Assignment group' }).props.onChange({ target: { value: 'devs' } }))
  act(() => renderer.root.findByProps({ 'aria-label': 'Assignment instruction' }).props.onChange({ target: { value: 'Go' } }))
  act(() => renderer.root.findByProps({ 'data-testid': 'task-assign-send' }).props.onClick())
  const assigns = sent.filter(message => message.type === 'team-task-assign') as Array<Extract<ClientMessage, { type: 'team-task-assign' }>>
  expect(assigns).toEqual([expect.objectContaining({ taskId: 't2', target: { kind: 'group', id: 'devs' }, instruction: 'Go' })])
  // Disconnected: the assign controls disable.
  act(() => renderer.update(element(false)))
  expect(renderer.root.findByProps({ 'data-testid': 'task-assign-send' }).props.disabled).toBe(true)
  act(() => renderer.unmount())
})

test('row labels name the assignment target and state, or Unassigned', () => {
  const sessions = [sessionRow('dev', 'Dev one')]
  expect(assignmentLabel(null, sessions)).toBe('Unassigned')
  expect(assignmentLabel(assignment('a'), sessions)).toBe('Assigned: group devs · queued')
  expect(assignmentLabel(assignment('b', { state: 'claimed', claimedBy: 'dev' }), sessions)).toBe('Assigned: group devs · claimed (claimed by Dev one)')
  expect(assignmentLabel(assignment('c', { state: 'delivered' }), sessions)).toContain('delivered')
  expect(assignmentLabel(assignment('d', { state: 'failed', reason: 'killed-recipient' }), sessions)).toContain('failed')
  expect(assignmentLabel(assignment('e', { targetKind: 'session', targetId: 'dev', role: null }), sessions)).toContain('Dev one')
})

test('dispatched instruction rows show the Human sender; agent rows are unchanged', () => {
  const sessions = [sessionRow('dev', 'Dev one')] as never
  const names: never[] = [] as never
  const humanRow: TeamMessage = {
    id: 'm1', teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'human', fromSession: null, fromGroup: null,
    originPath: '/repo', priority: 'normal', tags: [], threadId: 'm1', inReplyTo: null, hop: 1, body: 'Please build it', state: 'delivered',
    claimedBy: 'dev', claimedAt: null, deliverAt: null, createdAt: '2026-10-13T00:00:00.000Z', pushedAt: null, deliveredAt: null, reason: null,
    possibleDuplicate: false, attachThread: false, taskId: 't1', taskRevision: 1, claimCommit: null, parkedUntil: null, parkCount: 0,
    resumeMessageId: null, handoff: null, excludedProfile: null,
  }
  const agentRow: TeamMessage = { ...humanRow, id: 'm2', fromKind: 'agent', fromSession: 'dev', threadId: 'm2', taskId: null, taskRevision: null }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<div>
    <MessageRow row={humanRow} sessions={sessions} names={names} />
    <MessageRow row={agentRow} sessions={sessions} names={names} />
  </div>) })
  const names2 = renderer.root.findAllByProps({ 'data-testid': 'participant-name' }).map(textOf)
  expect(names2[0]).toBe('Human')
  expect(names2[1]).toBe('Dev one')
  act(() => renderer.unmount())
  // Live transcript rows carry senderKind on the peer event (ChatMessages).
  const event: ChatEvent = { type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 't', messageId: 'm1',
    senderSession: null, senderKind: 'human', senderGroup: null, priority: 'normal', originPath: '/repo', tags: [], threadId: 'm1',
    body: 'Please build it', possibleDuplicate: false }
  let live!: TestRenderer.ReactTestRenderer
  act(() => { live = TestRenderer.create(<ChatMessages events={[event]} />) })
  expect(textOf(live.root.findByProps({ 'data-chat-role': 'peer' }))).toContain('Human')
  act(() => live.unmount())
})

test('flowSendAssign records the payload once; later sends do not overwrite it', () => {
  openView()
  const store = useTeamTaskStore.getState()
  store.armFlow('dev', 'create-and-assign')
  store.flowSendAssign('dev', { targetKind: 'group', targetId: 'devs', instruction: 'First' })
  store.flowSendAssign('dev', { targetKind: 'group', targetId: 'devs', instruction: 'Overwrite attempt' })
  expect(useTeamTaskStore.getState().views.dev!.flow!.sentPayload).toMatchObject({ instruction: 'First' })
  // retryAssign re-keys and re-records on a changed intent, as designed.
  store.setDraft('dev', { targetKind: 'group', targetId: 'devs', instruction: 'Second' })
  store.begin('dev', 'a1', 'assign')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'a1', error: 'nope' })
  store.retryAssign('dev')
  store.flowSendAssign('dev', { targetKind: 'group', targetId: 'devs', instruction: 'Second' })
  expect(useTeamTaskStore.getState().views.dev!.flow!.sentPayload).toMatchObject({ instruction: 'Second' })
})

test('an edited create after a lost result re-arms a fresh key; an unchanged one replays', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  openView()
  const store = useTeamTaskStore.getState()
  store.setDraft('dev', { title: 'Export', direction: 'CSV' })
  const { renderer, sentOf, rerender } = mountPanel()
  const submit = () => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
  act(() => submit())
  const first = sentOf('team-task-create')[0] as Extract<ClientMessage, { type: 'team-task-create' }>
  // The result is lost with the connection; the reconnect clears the waiter.
  rerender(false)
  rerender(true)
  rerender(true)
  // An edit changes the intent: the next create must carry a NEW key — the
  // armed one would be refused for a different payload forever otherwise.
  useTeamTaskStore.getState().setDraft('dev', { title: 'Export v2' })
  // The draft lives in the store: re-render so the form handler sees the edit.
  rerender(true)
  act(() => submit())
  const creates = sentOf('team-task-create') as Array<Extract<ClientMessage, { type: 'team-task-create' }>>
  expect(creates).toHaveLength(2)
  expect(creates[1]!.requestKey).not.toBe(first.requestKey)
  expect(creates[1]!.title).toBe('Export v2')
  // Without further edits the key is stable again (a replay is safe).
  rerender(false)
  rerender(true)
  rerender(true)
  act(() => submit())
  const after = sentOf('team-task-create') as Array<Extract<ClientMessage, { type: 'team-task-create' }>>
  expect(after[2]!.requestKey).toBe(creates[1]!.requestKey)
  act(() => renderer.unmount())
})
