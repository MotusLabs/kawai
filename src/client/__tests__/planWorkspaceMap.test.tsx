// The dependency workspace map component (plan-workspace 5.2): rows follow
// plan order with dependency depth, edges and state and checklist totals are
// separate facts per row, invalid data renders the fallback notice, filters
// narrow rows without touching the text alternative, and checklists expand
// read-only beneath their change.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { normalizePlanContent } from '@shared/plans'
import type { WorkspaceRuntimeChange, WorkspaceRuntimeView } from '@shared/planWorkspaceRuntime'
import PlanWorkspaceMap from '../components/team/PlanWorkspaceMap'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useTeamPlanWorkspaceStore.setState({ views: {} })
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const content = () => normalizePlanContent({
  goal: 'Ship', successCriteria: ['Done'], approach: '',
  changes: [
    { change: 'api', group: 'middle-devs' },
    { change: 'web', group: 'middle-devs' },
    { change: 'cli', dependsOn: ['api'], group: 'middle-devs' },
  ],
})

const runtime = (extra: WorkspaceRuntimeChange[] = []): WorkspaceRuntimeView => ({
  execution: { executionId: 'e1', revision: 1 },
  changes: [
    { change: 'api', relation: 'overlay', executionRevision: 1, modifiedSinceExecution: false,
      state: { kind: 'landed', landedAt: '2026-10-22T00:00:00.000Z', treeVerified: true }, holders: [], history: [], checklist: null },
    { change: 'web', relation: 'overlay', executionRevision: 1, modifiedSinceExecution: false,
      state: { kind: 'waiting', cause: 'dependency api' },
      holders: [{ taskId: 't-web', holder: { kind: 'group-unclaimed', groupId: 'middle-devs' }, stage: null, waitingReason: null }],
      history: [], checklist: null },
    { change: 'cli', relation: 'overlay', executionRevision: 1, modifiedSinceExecution: true,
      state: { kind: 'implementing', stage: 'writing' }, holders: [], history: [], checklist: { total: 12, checked: 12 } },
    ...extra,
  ],
  outside: { changes: [], tasks: [] },
})

const emptyView = () => {
  useTeamPlanWorkspaceStore.setState({ views: {} })
  useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
  return useTeamPlanWorkspaceStore.getState().views['/repo']!
}

const mount = (initial = emptyView(), rows = runtime()) => {
  const calls: string[] = []
  const store = useTeamPlanWorkspaceStore.getState()
  let renderer!: TestRenderer.ReactTestRenderer
  const element = (view: typeof initial) => <PlanWorkspaceMap content={content()} runtime={rows} view={view}
    onToggleExpanded={change => { calls.push(`expand:${change}`); store.toggleExpanded('/repo', change) }}
    onSelectChange={change => { calls.push(`select:${change}`); store.selectChange('/repo', change) }}
    onSetFilter={filter => { calls.push(`filter:${filter}`); store.setFilter('/repo', filter) }} />
  act(() => { renderer = TestRenderer.create(element(initial)) })
  renderers.push(renderer)
  const rerender = () => act(() => renderer.update(element(useTeamPlanWorkspaceStore.getState().views['/repo']!)))
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  return { renderer, calls, byId, rerender }
}

test('parallel roots share depth 0 and the dependent sits one column deeper, with its edges', () => {
  const { byId } = mount()
  expect(byId('wbs-row-api').props['data-depth']).toBe(0)
  expect(byId('wbs-row-web').props['data-depth']).toBe(0)
  expect(byId('wbs-row-cli').props['data-depth']).toBe(1)
  expect(byId('wbs-edge-api-cli')).toBeDefined()
  expect(textOf(byId('wbs-edge-api-cli'))).toContain('api')
})

test('state, checklist totals, holders, and modification are separate row facts', () => {
  const { byId } = mount()
  // In review is named as such — never "landed".
  expect(textOf(byId('wbs-state-api'))).toBe('Landed')
  expect(textOf(byId('wbs-state-web'))).toContain('Waiting')
  expect(textOf(byId('wbs-checklist-count-cli'))).toBe('12/12 items')
  expect(textOf(byId('wbs-modified-cli'))).toContain('modified since execution')
  expect(textOf(byId('wbs-holders'))).toContain('middle-devs (unclaimed)')
})

test('a cycle renders the diagnostic fallback, not a hang, and keeps every change listed', () => {
  const cyclic = normalizePlanContent({
    goal: 'S', successCriteria: ['S'], approach: '',
    changes: [
      { change: 'a', dependsOn: ['b'], group: 'g' },
      { change: 'b', dependsOn: ['a'], group: 'g' },
      { change: 'c', dependsOn: ['b'], group: 'g' },
    ],
  })
  let second!: TestRenderer.ReactTestRenderer
  act(() => {
    second = TestRenderer.create(<PlanWorkspaceMap content={cyclic} runtime={runtime()} view={emptyView()}
      onToggleExpanded={() => undefined} onSelectChange={() => undefined} onSetFilter={() => undefined} />)
  })
  renderers.push(second)
  const fallback = second.root.findByProps({ 'data-testid': 'wbs-fallback' })
  const text = textOf(fallback)
  expect(text).toContain('a')
  expect(text).toContain('b')
  expect(text).toContain('Cycle')
  // Every change stays visible flat (depth 0), including the dependent.
  expect(second.root.findByProps({ 'data-testid': 'wbs-row-c' }).props['data-depth']).toBe(0)
})

test('filters narrow rows; the text alternative always lists every change', () => {
  const { renderer, calls, byId, rerender } = mount()
  act(() => { byId('wbs-filter-blocked').props.onClick() })
  rerender()
  expect(calls).toContain('filter:blocked')
  expect(renderer.root.findAllByProps({ 'data-testid': 'wbs-row-api' }).length).toBe(0)
  expect(renderer.root.findAllByProps({ 'data-testid': 'wbs-row-web' }).length).toBe(1)
  // api (landed) hides under Blocked but stays in the text list.
  expect(renderer.root.findByProps({ 'data-testid': 'wbs-text-api' }).type).toBe('li')
  act(() => { byId('wbs-filter-all').props.onClick() })
  rerender()
  expect(renderer.root.findAllByProps({ 'data-testid': 'wbs-row-api' }).length).toBe(1)
})

test('expansion is a callback with the change name; a composed checklist renders read-only', () => {
  const { renderer, calls, byId, rerender } = mount()
  useTeamPlanWorkspaceStore.getState().applyChecklist({
    type: 'team-plan-workspace-checklist', teamPath: '/repo', planId: 'p1', changeName: 'api',
    checklist: { sourceHash: 'h1', sections: [{ heading: 'Tasks', depth: 0, items: [
      { key: 'k1', text: 'Land the store', checked: true, line: 5 },
    ] }] }, unavailable: null,
  })
  expect(renderer.root.findAllByProps({ 'data-testid': 'wbs-checklist-api' }).length).toBe(0)
  act(() => { byId('wbs-expand-api').props.onClick() })
  rerender()
  expect(calls).toContain('expand:api')
  expect(renderer.root.findAllByProps({ 'data-testid': 'wbs-checklist-api' }).length).toBe(1)
  const items = renderer.root.findAllByProps({ 'data-testid': 'wbs-item-api' })
  expect(textOf(items[0]!)).toContain('Land the store')
  expect(items[0]!.props['data-checked']).toBe(true)
  expect(textOf(items[0]!)).toContain('L5')
})

test('the text alternative states prerequisites and dependents per change', () => {
  const { byId } = mount()
  expect(textOf(byId('wbs-text-api'))).toContain('dependents cli')
  expect(textOf(byId('wbs-text-cli'))).toContain('prerequisites api')
  expect(textOf(byId('wbs-text-web'))).toContain('no prerequisites')
})
