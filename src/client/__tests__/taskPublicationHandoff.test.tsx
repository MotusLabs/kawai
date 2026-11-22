// The publication handoff panel and the editor's draft provenance
// (owner-publication-handoff D3, D11, task 11.1) in the real task detail
// over the real task store: each action's request payload and command key
// (outside the reserved `handoff:` prefix), the replace confirmation, the
// disabled states of a stale and an ended handoff, the observed draft
// identity on save and publish, the H43 refresh prompt keeping the unsaved
// text, and the intent traces — the publish intent and identity are those the
// form captured when its edit began, never re-read from a later draft
// snapshot (captured `true` with no identity, and captured `false`).
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { TaskHandoff } from '@shared/taskHandoffs'
import type { HumanTaskDetail, TaskDraft, TeamTaskSummary } from '@shared/teamTasks'
import TeamTaskDetail from '../components/team/TeamTaskDetail'
import { REPLACED_DRAFT_MARK } from '../components/team/TaskDirectionEditor'
import { REPLACED_DRAFT_REFUSAL } from '../../server/team/taskDrafts'
import { useTeamTaskStore } from '../stores/teamTaskStore'

afterEach(() => { useTeamTaskStore.setState({ views: {} }) })

const task = (extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id: 't1', teamId: 'team', title: 'Export', status: 'active', creator: { kind: 'human', sessionId: null }, parentId: null,
  worktree: null, openspecChange: null, revision: 1, direction: 'CSV', acceptance: 'Downloads', createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z', participants: ['dev'], assignment: null, ...extra,
})
const handoff = (extra: Partial<TaskHandoff> = {}): TaskHandoff => ({
  id: 'h1', teamId: 'team', taskId: 't1', baseRevision: 1, baseContractHash: null, payloadHash: 'a'.repeat(64), baseCommit: 'b'.repeat(40),
  evidenceRefs: ['src/export.ts'], requesterSession: 'lead', requesterGroup: 'leads', requestKey: 'k1', state: 'open', stateReason: null, stateActor: null,
  publishedRevision: null, publishedPayloadHash: null, supersededBy: null, createdAt: 'now', updatedAt: 'now',
  direction: 'CSV with headers', acceptance: null, contract: null, rationale: 'Headers were missing', notify: true, ...extra,
})
const linked = (lineageId: string, extra: Partial<TaskDraft> = {}): TaskDraft => ({
  taskId: 't1', baseRevision: 1, direction: 'CSV with headers', acceptance: 'Downloads', rationale: 'Headers were missing',
  handoffId: 'h1', lineageId, updatedAt: lineageId, ...extra,
})
const detail = (extra: Partial<HumanTaskDetail> = {}): HumanTaskDetail => ({
  task: task(), journal: [], subtasks: [], assignments: [], messages: [],
  revisions: [{ revision: 1, direction: 'CSV', acceptance: 'Downloads', author: { kind: 'human', sessionId: null }, createdAt: 'now', rationale: null, notify: null }],
  draft: null, publications: [], acknowledgements: [], handoffs: [handoff()], ...extra,
})

let sent: ClientMessage[]
let renderer: TestRenderer.ReactTestRenderer
const push = (view: HumanTaskDetail) => act(() => {
  useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: view, directory: [] })
})
const element = () => <TeamTaskDetail teamPath="dev" projectPath="/repo" view={useTeamTaskStore.getState().views.dev!}
  sendMessage={message => sent.push(message)} connected sessions={[]} onOpenMailbox={() => {}} />
function mount(view: HumanTaskDetail) {
  sent = []
  useTeamTaskStore.getState().open('dev', 't1')
  push(view)
  act(() => { renderer = TestRenderer.create(element()) })
}
const rerender = () => act(() => renderer.update(element()))
const testId = (id: string) => renderer.root.findByProps({ 'data-testid': id })
const field = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
const textOf = (node: TestRenderer.ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))
const click = (id: string) => act(() => testId(id).props.onClick())
const ofType = <T extends ClientMessage['type']>(type: T) => sent.filter((message): message is Extract<ClientMessage, { type: T }> => message.type === type)
/** Settle the last sent action so the next control is enabled again. */
const settle = (error?: string) => {
  const last = sent.at(-1) as { requestId: string }
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: last.requestId, ...(error ? { error } : {}) }))
  rerender()
}

test('the panel shows provenance and the diff; Publish and notify sends only the handoff id with an ordinary command key, and a resend reuses it', () => {
  mount(detail())
  expect(textOf(testId('handoff-provenance'))).toBe(`Base contract none · base commit ${'b'.repeat(40)} · payload aaaaaaaaaaaa · evidence: src/export.ts`)
  expect(textOf(testId('handoff-diff-direction'))).toBe('DirectionCSVCSV with headers')
  expect(textOf(testId('handoff-publish'))).toBe('Publish and notify')
  click('handoff-publish')
  const [first] = ofType('team-task-handoff-publish')
  expect(Object.keys(first!).sort()).toEqual(['handoffId', 'requestId', 'requestKey', 'taskId', 'teamPath', 'type'])
  expect(first).toMatchObject({ handoffId: 'h1', taskId: 't1' })
  expect(first!.requestKey.startsWith('handoff:')).toBe(false)
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  rerender()
  click('handoff-publish')
  expect(ofType('team-task-handoff-publish')[1]!.requestKey).toBe(first!.requestKey)
})

test('Edit before publishing loads directly without a draft and asks before replacing one; Decline needs a reason', () => {
  mount(detail({ handoffs: [handoff({ notify: false })] }))
  expect(textOf(testId('handoff-publish'))).toBe('Publish prepared revision')
  click('handoff-edit')
  expect(ofType('team-task-handoff-load-draft')).toMatchObject([{ handoffId: 'h1', replace: false }])
  settle()
  push(detail({ handoffs: [handoff({ notify: false })], draft: { taskId: 't1', baseRevision: 1, direction: 'Mine', acceptance: null, rationale: null, updatedAt: 'x' } }))
  rerender()
  click('handoff-edit')
  expect(ofType('team-task-handoff-load-draft')).toHaveLength(1)
  expect(textOf(testId('handoff-replace-confirm'))).toContain('will be replaced')
  click('handoff-replace-yes')
  expect(ofType('team-task-handoff-load-draft')[1]).toMatchObject({ handoffId: 'h1', replace: true })
  settle()
  expect(testId('handoff-decline').props.disabled).toBe(true)
  act(() => field('Decline reason').props.onChange({ target: { value: '  Not now  ' } }))
  click('handoff-decline')
  const [decline] = ofType('team-task-handoff-decline')
  expect(decline).toMatchObject({ handoffId: 'h1', reason: 'Not now' })
  expect(decline!.requestKey.startsWith('handoff:')).toBe(false)
})

test('a stale handoff can only be declined; an ended one is history, published as edited with both hashes', () => {
  mount(detail({ task: task({ revision: 2 }), handoffs: [handoff({ state: 'stale' })] }))
  expect(textOf(testId('handoff-stale'))).toContain('Revision 2 was published since revision 1')
  expect([testId('handoff-publish').props.disabled, testId('handoff-edit').props.disabled]).toEqual([true, true])
  act(() => field('Decline reason').props.onChange({ target: { value: 'Superseded' } }))
  expect(testId('handoff-decline').props.disabled).toBe(false)
  push(detail({ task: task({ revision: 2 }), handoffs: [handoff({ state: 'published', publishedRevision: 2, publishedPayloadHash: 'c'.repeat(64) })] }))
  rerender()
  expect(renderer.root.findAll(node => node.props['data-testid'] === 'handoff-publish')).toHaveLength(0)
  expect(textOf(testId('handoff-ended-h1'))).toContain('published as revision 2 (published as edited: prepared aaaaaaaaaaaa, published cccccccccccc)')
})

test('a form on the loaded draft sends its observed identity with save and publish; an H43 refusal keeps the text and offers a refresh', () => {
  expect(REPLACED_DRAFT_REFUSAL.startsWith(REPLACED_DRAFT_MARK)).toBe(true)
  mount(detail({ draft: linked('L1') }))
  act(() => field('Draft direction').props.onChange({ target: { value: 'CSV with headers and a BOM' } }))
  click('task-save-draft')
  expect(ofType('team-task-draft')).toMatchObject([{ action: 'save', observedDraft: 'L1', baseRevision: 1 }])
  settle()
  click('task-publish')
  expect(ofType('team-task-publish')).toMatchObject([{ fromDraft: true, observedDraft: 'L1', direction: 'CSV with headers and a BOM' }])
  // Another window re-loaded the handoff meanwhile: the server refuses (H43).
  push(detail({ draft: linked('L2', { direction: 'Replacement' }) }))
  settle(REPLACED_DRAFT_REFUSAL)
  expect(textOf(testId('task-draft-replaced'))).toContain('Your text is kept here')
  expect(field('Draft direction').props.value).toBe('CSV with headers and a BOM')
  click('task-draft-refresh')
  rerender()
  expect(field('Draft direction').props.value).toBe('Replacement')
  click('task-publish')
  expect(ofType('team-task-publish')[1]).toMatchObject({ fromDraft: true, observedDraft: 'L2' })
})

test('intent trace: a form editing an ordinary draft keeps fromDraft true and no identity after a replacement linked draft arrives', () => {
  mount(detail({ handoffs: [], draft: { taskId: 't1', baseRevision: 1, direction: 'My ordinary edit', acceptance: 'Downloads', rationale: 'Mine', updatedAt: 'x' } }))
  act(() => field('Draft direction').props.onChange({ target: { value: 'My ordinary edit, longer' } }))
  push(detail({ draft: linked('L9') }))
  rerender()
  click('task-publish')
  const [publish] = ofType('team-task-publish')
  expect(publish).toMatchObject({ fromDraft: true, direction: 'My ordinary edit, longer' })
  expect('observedDraft' in publish!).toBe(false)
})

test('intent trace: a form that began without a draft keeps fromDraft false after a draft snapshot arrives', () => {
  mount(detail({ handoffs: [] }))
  act(() => field('Draft direction').props.onChange({ target: { value: 'Straight to a revision' } }))
  act(() => field('Rationale').props.onChange({ target: { value: 'Why' } }))
  push(detail({ draft: linked('L3') }))
  rerender()
  click('task-publish')
  const [publish] = ofType('team-task-publish')
  expect(publish).toMatchObject({ fromDraft: false, direction: 'Straight to a revision' })
  expect('observedDraft' in publish!).toBe(false)
})
