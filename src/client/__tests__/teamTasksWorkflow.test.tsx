// The Tasks tab's workflow stage and filters (team-workspace 3.x client half):
// stage and status are separate on a row, the accountable party falls back to
// the requested role, closed tasks are absent by default but searchable, and
// the filters narrow and survive leaving the list.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { TeamTaskSummary } from '@shared/teamTasks'
import type { TeamTaskRow } from '@shared/teamWorkspace'
import TeamTasksView from '../components/team/TeamTasksView'
import { useTeamTaskStore, type TaskView } from '../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'

const summary = (id: string, extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id, teamId: 'team', title: `Task ${id}`, status: 'open', creator: { kind: 'human', sessionId: null }, parentId: null,
  worktree: null, openspecChange: null, revision: 1, direction: `Direction of ${id}`, acceptance: null,
  createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', participants: [], assignment: null, ...extra,
})
const row = (id: string, extra: Partial<TeamTaskRow> = {}): TeamTaskRow => ({
  id, title: `Task ${id}`, status: 'open', stage: 'unstarted', accountable: null, groupId: null, worktree: null,
  waitingReason: null, needsReevaluation: false, acknowledgement: null, nextAction: null, requiresHuman: false, ...extra,
})

const tasks = [summary('a'), summary('b', { status: 'blocked' }), summary('c', { status: 'done' }), summary('d')]
const rows = [
  row('a', { stage: 'implementing', accountable: { kind: 'session', id: 's1', label: 'dev one' }, groupId: 'devs', worktree: '/repo/.worktrees/x' }),
  row('b', { status: 'blocked', stage: 'unstarted', accountable: { kind: 'group', id: 'devs', label: 'devs' }, groupId: 'devs',
    waitingReason: { blocker: { kind: 'group-cap', counts: { live: 1, cap: 1 } }, others: [] }, nextAction: 'Wait for capacity', requiresHuman: true }),
  row('c', { status: 'done', stage: null }),
  row('d', { stage: 'awaiting-acceptance', worktree: '/repo' }),
]

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll(node => node.props['data-testid'] === id)
const visible = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAll(node => node.type === 'article' && !!node.props['data-task-id']).map(node => node.props['data-task-id'])

const mounted: TestRenderer.ReactTestRenderer[] = []
const mount = (withRows = true) => {
  useTeamTaskStore.getState().open('dev')
  const view = { ...useTeamTaskStore.getState().views.dev!, loading: false, tasks } as TaskView
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamTasksView teamPath="dev" projectPath="/repo" view={view} sendMessage={() => {}} connected
      {...(withRows ? { rows } : {})} />)
  })
  mounted.push(renderer)
  return renderer
}
const setFilter = (patch: Record<string, string | boolean | undefined>) =>
  act(() => { useTeamWorkspaceStore.getState().setFilters('dev', 'tasks', patch) })

const realFetch = globalThis.fetch
beforeEach(() => {
  // The groups picker fetches on mount; a pending request keeps its later update out of the tests.
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  useTeamWorkspaceStore.setState({ views: {} })
})
afterEach(() => {
  globalThis.fetch = realFetch
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount())
  useTeamTaskStore.setState({ views: {} }); useTeamWorkspaceStore.setState({ views: {} })
})

test('a row shows its stage apart from its status, the accountable party, and the wait', () => {
  const renderer = mount()
  const a = renderer.root.find(node => node.props['data-task-id'] === 'a')
  expect(textOf(a.findByProps({ 'data-testid': 'task-status' }))).toBe('open')
  expect(textOf(a.findByProps({ 'data-testid': 'task-stage' }))).toBe('Implementing')
  expect(textOf(a.findByProps({ 'data-testid': 'task-accountable' }))).toBe('dev one')
  const b = renderer.root.find(node => node.props['data-task-id'] === 'b')
  // A queued group assignment names the requested role, no session.
  expect(textOf(b.findByProps({ 'data-testid': 'task-accountable' }))).toBe('devs')
  expect(textOf(b.findByProps({ 'data-testid': 'task-waiting' }))).toContain('Group is at capacity (1/1)')
  expect(textOf(b.findByProps({ 'data-testid': 'task-next-action' }))).toContain('Wait for capacity (needs you)')
})

test('Phase 2 stages and badges: Awaiting acceptance, Needs re-evaluation, and Delivered rev 2 · Acknowledged rev 1', () => {
  rows[3] = row('d', { stage: 'awaiting-acceptance', worktree: '/repo', needsReevaluation: true,
    acknowledgement: { revision: 3, deliveredRevision: 2, acknowledgedRevision: 1 }, nextAction: 'Accept result', requiresHuman: true })
  const renderer = mount()
  const d = renderer.root.find(node => node.props['data-task-id'] === 'd')
  expect(textOf(d.findByProps({ 'data-testid': 'task-stage' }))).toBe('Awaiting acceptance')
  expect(textOf(d.findByProps({ 'data-testid': 'task-badge-reevaluation' }))).toBe('Needs re-evaluation')
  expect(textOf(d.findByProps({ 'data-testid': 'task-badge-acknowledgement' })))
    .toBe('Awaiting acknowledgement of revision 3 · Delivered rev 2 · Acknowledged rev 1')
  // A task without badges shows none.
  expect(renderer.root.find(node => node.props['data-task-id'] === 'a').findAllByProps({ 'data-testid': 'task-badges' })).toHaveLength(0)
  rows[3] = row('d', { stage: 'awaiting-acceptance', worktree: '/repo' })
})

test('before the read model arrives rows show without workflow lines, and closed tasks are still absent', () => {
  const renderer = mount(false)
  // Done tasks never flash into the default list while the snapshot is in flight.
  expect(visible(renderer)).toEqual(['a', 'b', 'd'])
  expect(byId(renderer, 'task-stage')).toHaveLength(0)
  expect(byId(renderer, 'task-filters')).toHaveLength(0)
  act(() => { useTeamWorkspaceStore.getState().setSearch('dev', 'tasks', 'Direction of c') })
  expect(visible(renderer)).toEqual(['c'])
})

test('closed tasks are absent by default and found by search', () => {
  const renderer = mount()
  expect(visible(renderer)).toEqual(['a', 'b', 'd'])
  act(() => { useTeamWorkspaceStore.getState().setSearch('dev', 'tasks', 'Direction of c') })
  expect(visible(renderer)).toEqual(['c'])
  // A closed task shows no stage.
  expect(textOf(renderer.root.find(node => node.props['data-task-id'] === 'c'))).toContain('No stage (closed)')
})

test('each filter narrows the list', () => {
  const renderer = mount()
  setFilter({ status: 'blocked' })
  expect(visible(renderer)).toEqual(['b'])
  setFilter({ status: 'done' })
  expect(visible(renderer)).toEqual(['c'])
  setFilter({ status: undefined, awaitingHuman: true })
  expect(visible(renderer)).toEqual(['b'])
  setFilter({ awaitingHuman: undefined, awaitingAcceptance: true })
  expect(visible(renderer)).toEqual(['d'])
  setFilter({ awaitingAcceptance: undefined, group: 'devs' })
  expect(visible(renderer)).toEqual(['a', 'b'])
  setFilter({ group: undefined, worktree: '/repo' })
  expect(visible(renderer)).toEqual(['d'])
})

test('filters survive leaving the list and coming back', () => {
  const first = mount()
  setFilter({ worktree: '/repo/.worktrees/x' })
  expect(visible(first)).toEqual(['a'])
  act(() => first.unmount())
  expect(visible(mount())).toEqual(['a'])
})

test('the filter controls are named and clearing restores the default list', () => {
  const renderer = mount()
  setFilter({ group: 'devs', awaitingHuman: true })
  expect(visible(renderer)).toEqual(['b'])
  act(() => { byId(renderer, 'task-filter-clear')[0]!.props.onClick() })
  expect(visible(renderer)).toEqual(['a', 'b', 'd'])
  expect(textOf(byId(renderer, 'task-filters')[0]!)).toContain('Awaiting acceptance')
})

test('a filter that hides everything says so', () => {
  const renderer = mount()
  setFilter({ status: 'cancelled' })
  expect(textOf(byId(renderer, 'task-no-matches')[0]!)).toBe('No tasks match the filters')
})

// 8.1: the Tasks tab is a single pane at every width — the list, or one task
// with an explicit Back (**All tasks**). Filters and the search live in the
// per-team store, so Back returns the list exactly as it was left.
function Host() {
  const view = useTeamTaskStore(state => state.views.dev!)
  return <TeamTasksView teamPath="dev" projectPath="/repo" view={{ ...view, loading: false, tasks }} rows={rows} sendMessage={() => {}} connected />
}

test('filter, open a task, Back: the filtered list and search are unchanged', () => {
  useTeamTaskStore.getState().open('dev')
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<Host />) })
  mounted.push(renderer)
  setFilter({ group: 'devs' })
  act(() => { useTeamWorkspaceStore.getState().setSearch('dev', 'tasks', 'Task') })
  expect(visible(renderer)).toEqual(['a', 'b'])
  act(() => { renderer.root.find(node => node.props['data-task-id'] === 'b').findAllByType('button')[0]!.props.onClick() })
  expect(visible(renderer)).toEqual([])
  const back = renderer.root.findAllByType('button').find(button => textOf(button) === 'All tasks')!
  act(() => { back.props.onClick() })
  expect(visible(renderer)).toEqual(['a', 'b'])
  expect(useTeamWorkspaceStore.getState().views.dev!.tabs.tasks).toMatchObject({ search: 'Task', filters: { group: 'devs' } })
})
