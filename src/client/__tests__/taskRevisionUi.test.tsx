// Task-revision publication UI (5.2/5.3): the draft editor never moves the
// shown revision, publishes once per armed key (double click, reconnect),
// keeps the text through a stale base, and disables while disconnected; the
// publication detail keeps notice state, delivered revision, and
// acknowledged revision apart, and Notify / Retry notification send one
// keyed command each.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { HumanTaskDetail, RevisionRecipient, TaskPublication, TeamTaskSummary } from '@shared/teamTasks'
import TeamTaskDetail from '../components/team/TeamTaskDetail'
import { useTeamTaskStore } from '../stores/teamTaskStore'

afterEach(() => { useTeamTaskStore.setState({ views: {} }) })

const task = (extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id: 't1', teamId: 'team', title: 'Export', status: 'active', creator: { kind: 'human', sessionId: null }, parentId: null,
  worktree: null, openspecChange: null, revision: 2, direction: 'CSV export', acceptance: 'Downloads', createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z', participants: ['dev'], assignment: null, ...extra,
})
const detail = (summary: TeamTaskSummary, extra: Partial<HumanTaskDetail> = {}): HumanTaskDetail => ({
  task: summary, journal: [], subtasks: [], assignments: [], messages: [],
  revisions: [
    { revision: 1, direction: 'CSV', acceptance: null, author: { kind: 'human', sessionId: null }, createdAt: '2026-10-14T00:00:00.000Z', rationale: null, notify: null },
    { revision: 2, direction: summary.direction, acceptance: summary.acceptance, author: { kind: 'human', sessionId: null }, createdAt: '2026-10-14T01:00:00.000Z', rationale: 'Scope changed', notify: true },
  ],
  draft: null, publications: [], acknowledgements: [], ...extra,
})

let sent: ClientMessage[]
let renderer: TestRenderer.ReactTestRenderer
let mailboxOpened: number
/** Render the detail from the store's live view, so pending actions disable controls as in the app. */
function mount(view: HumanTaskDetail, connected = true) {
  sent = []
  mailboxOpened = 0
  useTeamTaskStore.getState().open('dev', 't1')
  useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: view, directory: [] })
  const element = (isConnected: boolean) => <TeamTaskDetail teamPath="dev" projectPath="/repo" view={useTeamTaskStore.getState().views.dev!}
    sendMessage={message => sent.push(message)} connected={isConnected} sessions={[]} onOpenMailbox={() => { mailboxOpened += 1 }} />
  act(() => { renderer = TestRenderer.create(element(connected)) })
  // Revision history starts collapsed (the once-per-team seed); open it so
  // the revision-content assertions below can read it.
  act(() => { renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Revision history' }).props.onClick() })
  return { rerender: (isConnected = connected) => act(() => renderer.update(element(isConnected))) }
}
const button = (label: string | RegExp) => renderer.root.find(node => node.type === 'button' &&
  (typeof label === 'string' ? node.children.join('') === label : label.test(node.children.join(''))))
const field = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
const testId = (id: string) => renderer.root.findByProps({ 'data-testid': id })
const textOf = (node: TestRenderer.ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))
const typeDraft = (direction: string, rationale: string) => {
  act(() => field('Draft direction').props.onChange({ target: { value: direction } }))
  act(() => field('Rationale').props.onChange({ target: { value: rationale } }))
}
const publishes = () => sent.filter((message): message is Extract<ClientMessage, { type: 'team-task-publish' }> => message.type === 'team-task-publish')

test('a saved draft never moves the shown revision: the direction is the published one, the editor holds the draft', () => {
  mount(detail(task(), { draft: { taskId: 't1', baseRevision: 2, direction: 'CSV and JSON', acceptance: 'Downloads', rationale: 'Asked', updatedAt: 'now' } }))
  expect(textOf(testId('task-direction'))).toBe('CSV export')
  expect(textOf(renderer.root)).toContain('revision 2')
  expect(field('Draft direction').props.value).toBe('CSV and JSON')
  expect(textOf(testId('task-draft-status'))).toContain('based on revision 2 · not published')
  expect(textOf(testId('task-revisions'))).toContain('Rationale: Scope changed')
  // Publishing from the saved draft says so; the server discards that draft with it.
  act(() => button('Publish revision 3').props.onClick())
  expect(publishes()).toMatchObject([{ fromDraft: true, direction: 'CSV and JSON', rationale: 'Asked' }])
  // Edits beyond the saved draft still publish from it: the one draft is replaced, so fromDraft holds.
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  act(() => field('Draft direction').props.onChange({ target: { value: 'CSV, JSON, and XML' } }))
  act(() => button('Publish revision 3').props.onClick())
  expect(publishes()[1]).toMatchObject({ fromDraft: true, direction: 'CSV, JSON, and XML' })
})

test('a double click publishes once: the second send is disabled and both would carry one key', () => {
  const { rerender } = mount(detail(task()))
  typeDraft('CSV and JSON', 'Customer asked')
  act(() => button('Publish and notify').props.onClick())
  rerender()
  expect(button('Publish and notify').props.disabled).toBe(true)
  // A reconnect drops the pending waiter but keeps the armed key: the resend replays.
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  rerender()
  act(() => button('Publish and notify').props.onClick())
  expect(publishes()).toHaveLength(2)
  expect(publishes()[0]).toMatchObject({ baseRevision: 2, direction: 'CSV and JSON', rationale: 'Customer asked', notify: true })
  expect(publishes()[1]!.requestKey).toBe(publishes()[0]!.requestKey)
  // An edited payload after a lost result is a new intent: a new key.
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  rerender()
  act(() => field('Draft direction').props.onChange({ target: { value: 'CSV, JSON, and XML' } }))
  act(() => button('Publish and notify').props.onClick())
  expect(publishes()[2]!.requestKey).not.toBe(publishes()[0]!.requestKey)
  // Success retires the key: the next publication is a new intent.
  const requestId = publishes()[2]!.requestId
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId, task: task({ revision: 3 }), revision: 3 }))
  expect(useTeamTaskStore.getState().views.dev!.commands).toEqual({})
})

test('a newer revision under unsaved text keeps every word and asks to rebase before publishing', () => {
  const { rerender } = mount(detail(task()))
  typeDraft('My plan', 'Because')
  // Another publisher moves the task to revision 3 while the human types.
  act(() => useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: detail(task({ revision: 3, direction: 'Agent plan' })), directory: [] }))
  rerender()
  expect(field('Draft direction').props.value).toBe('My plan')
  expect(textOf(testId('task-draft-stale'))).toContain('based on revision 2; current is 3')
  expect(button(/^Publish revision/).props.disabled).toBe(true)
  act(() => button('Rebase onto revision 3').props.onClick())
  rerender()
  expect(button('Publish revision 4').props.disabled).toBe(false)
  act(() => button('Publish revision 4').props.onClick())
  expect(publishes().at(-1)).toMatchObject({ baseRevision: 3, direction: 'My plan' })
})

test('a refused publication keeps the text; every direction control disables while disconnected', () => {
  const { rerender } = mount(detail(task()))
  typeDraft('My plan', 'Because')
  act(() => button('Publish revision 3').props.onClick())
  const requestId = publishes()[0]!.requestId
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId, error: 'Stale: revision 3 was published since revision 2' }))
  rerender()
  expect(field('Draft direction').props.value).toBe('My plan')
  expect(field('Rationale').props.value).toBe('Because')
  rerender(false)
  for (const label of ['Save draft', 'Publish revision 3', 'Publish and notify']) expect(button(label).props.disabled).toBe(true)
  expect(field('Draft direction').props.disabled).toBe(true)
})

// Publication detail (5.3): each state on its own, never merged.
const recipientRow = (extra: Partial<RevisionRecipient>): RevisionRecipient => ({
  assignmentId: 'a1', sessionId: 'dev', noticeState: 'not-notified', noticeMessageId: null, reason: null,
  deliveredRevision: null, acknowledgedRevision: null, ...extra,
})
const publication = (recipients: RevisionRecipient[], extra: Partial<TaskPublication> = {}): TaskPublication => ({
  revision: 2, previousRevision: 1, author: { kind: 'human', sessionId: null }, rationale: 'Scope changed', notify: true,
  publishedAt: '2026-10-14T01:00:00.000Z', recipients, ...extra,
})
const recipients = () => renderer.root.findAllByProps({ 'data-testid': 'task-publication-recipient' })

test('each notice state reads on its own, beside the delivered and the acknowledged revision', () => {
  const cases: Array<[Partial<RevisionRecipient>, string, string, string]> = [
    [{}, 'Not notified', 'nothing delivered', 'not acknowledged'],
    [{ noticeState: 'queued', deliveredRevision: 1 }, 'Queued', 'delivered revision 1', 'not acknowledged'],
    [{ noticeState: 'delivered', deliveredRevision: 2, acknowledgedRevision: 1 }, 'Delivered', 'delivered revision 2', 'acknowledged revision 1'],
    [{ noticeState: 'delivered', deliveredRevision: 2, acknowledgedRevision: 2 }, 'Delivered', 'delivered revision 2', 'acknowledged revision 2'],
    [{ noticeState: 'failed', reason: 'killed-recipient' }, 'Failed (killed-recipient)', 'nothing delivered', 'not acknowledged'],
    [{ noticeState: 'uncertain', deliveredRevision: 1 }, 'Uncertain', 'delivered revision 1', 'not acknowledged'],
  ]
  for (const [state, notice, delivered, acknowledged] of cases) {
    mount(detail(task(), { publications: [publication([recipientRow(state)])] }))
    const [row] = recipients()
    expect(textOf(row!.findByProps({ 'data-testid': 'recipient-notice' }))).toBe(notice)
    expect(textOf(row!.findByProps({ 'data-testid': 'recipient-delivered' }))).toBe(delivered)
    expect(textOf(row!.findByProps({ 'data-testid': 'recipient-acknowledged' }))).toBe(acknowledged)
    act(() => renderer.unmount())
  }
})

test('Notify for a holder without a notice, Retry notification after a failure, and the mailbox link for an uncertain one', () => {
  mount(detail(task(), { publications: [
    publication([recipientRow({ noticeState: 'failed', reason: 'hop-limit' })], { revision: 2 }),
    publication([recipientRow({ noticeState: 'uncertain' })], { revision: 3, previousRevision: 2 }),
    publication([recipientRow({})], { revision: 4, previousRevision: 3, notify: false }),
  ] }))
  const article = (revision: number) => renderer.root.findAll(node => node.props['data-testid'] === 'task-publication' && node.props['data-revision'] === revision)[0]!
  expect(article(4).findAll(node => node.props['data-testid'] === 'task-notify')).toHaveLength(1)
  expect(article(2).findAll(node => node.props['data-testid'] === 'task-retry-notification')).toHaveLength(1)
  expect(article(3).findAll(node => node.props['data-testid'] === 'task-notify' || node.props['data-testid'] === 'task-retry-notification')).toHaveLength(0)
  act(() => article(3).findByProps({ 'data-testid': 'recipient-open-mailbox' }).props.onClick())
  expect(mailboxOpened).toBe(1)
  act(() => article(2).findByProps({ 'data-testid': 'task-retry-notification' }).props.onClick())
  const notify = sent.filter(message => message.type === 'team-task-notify')
  expect(notify).toMatchObject([{ type: 'team-task-notify', teamPath: 'dev', taskId: 't1', revision: 2 }])
  expect(typeof (notify[0] as { requestKey?: string }).requestKey).toBe('string')
})

test('a publication made before notifications says so, and the acknowledgement history lists every row', () => {
  mount(detail(task(), {
    publications: [publication([], { notify: null, rationale: null })],
    acknowledgements: [
      { sessionId: 'dev', revision: 1, assignmentId: 'a1', createdAt: '2026-10-14T00:30:00.000Z' },
      { sessionId: 'dev2', revision: 2, assignmentId: 'a2', createdAt: '2026-10-14T02:00:00.000Z' },
    ],
  }))
  const text = textOf(testId('task-publications'))
  expect(text).toContain('published before notifications')
  expect(text).toContain('No rationale given')
  expect(text).toContain('No claimed agent holds the assignment')
  expect(textOf(testId('task-acknowledgement-history'))).toContain('Acknowledgement history (2)')
})

// Peer rows (5.4, D9): the notice names its revision; the header is the one delivered.
test('a notice row shows "Revision N published" with its rationale beside the task header it was delivered under', async () => {
  const { default: ChatMessages } = await import('../components/chat/ChatMessages')
  const base = { type: 'peer_message' as const, sequence: 1, at: 'now', turnId: 't', senderSession: null, senderKind: 'human' as const,
    senderGroup: null, priority: 'normal' as const, originPath: '/repo', tags: ['task-revision'], body: 'Task Export revision 2 published', possibleDuplicate: false }
  const taskContext = (revision: number) => ({ id: 't1', title: 'Export', status: 'active' as const, revision, direction: `v${revision}`,
    acceptance: null, openspecChange: null, worktree: null, journal: [] })
  const notice = { ...base, id: 'p1', messageId: 'n1', threadId: 'n1', task: taskContext(3),
    revisionNotice: { revision: 2, previousRevision: 1, assignmentId: 'a1', rationale: 'Scope changed' } }
  // An earlier instruction delivered at revision 1 keeps its header after later publications.
  const instruction = { ...base, id: 'p0', messageId: 'i1', threadId: 'i1', tags: [], body: 'Build it', task: taskContext(1) }
  let view!: TestRenderer.ReactTestRenderer
  act(() => { view = TestRenderer.create(<ChatMessages events={[instruction, notice]} />) })
  expect(textOf(view.root.findByProps({ 'data-testid': 'peer-revision-notice' }))).toBe('Revision 2 published: Scope changed · delivered under revision 3')
  const headers = view.root.findAllByProps({ 'data-testid': 'peer-task' }).map(node => textOf(node.findByType('summary')))
  expect(headers).toEqual(['Task: Export · active · revision 1', 'Task: Export · active · revision 3'])
  expect(view.root.findAllByProps({ 'data-testid': 'peer-revision-notice' })).toHaveLength(1)
  act(() => view.unmount())
})

test('Retry after a lost Notify result is a new command on the first click; a double click of Retry reuses its key', () => {
  const view = (state: Partial<RevisionRecipient>) => detail(task(), { publications: [publication([recipientRow(state)])] })
  const { rerender } = mount(view({}))
  const notifies = () => sent.filter((message): message is Extract<ClientMessage, { type: 'team-task-notify' }> => message.type === 'team-task-notify')
  act(() => testId('task-notify').props.onClick())
  // Its result is lost with the connection; the notice it sent later fails.
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  act(() => useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: view({ noticeState: 'failed', reason: 'hop-limit' }), directory: [] }))
  rerender()
  act(() => testId('task-retry-notification').props.onClick())
  expect(notifies()).toHaveLength(2)
  expect(notifies()[1]!.requestKey).not.toBe(notifies()[0]!.requestKey)
  // The Retry's own resend replays under its own key.
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  rerender()
  act(() => testId('task-retry-notification').props.onClick())
  expect(notifies()[2]!.requestKey).toBe(notifies()[1]!.requestKey)
})
