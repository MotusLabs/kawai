// The Plans view's host and the task form's plan link (durable-plans 8.3):
// the Team page's Plans tab mounts the view, which subscribes to the team's
// plans, follows the URL's plan id, names a selection in the URL, and
// unsubscribes when another tab opens; the task form's plan pickers offer
// only open plans' approved changes (the server's `targets.plans`), and a
// linked task is created with `planId` / `planChange`.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage, Session } from '@shared/types'
import type { PlanSummary } from '@shared/plans'
import TeamWorkspaceView from '../components/team/TeamWorkspaceView'
import TeamTasksView from '../components/team/TeamTasksView'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import type { TeamLocation } from '../utils/teamLocation'

const sent: ClientMessage[] = []
const sendMessage: SendClientMessage = message => { sent.push(message) }
const active: TestRenderer.ReactTestRenderer[] = []

beforeEach(() => {
  sent.length = 0
  useSessionStore.setState({
    sessions: [{ id: 'chat-1', name: 'dev', projectPath: '/repo', status: 'waiting', kind: 'chat' } as unknown as Session],
    hasLoaded: true,
  })
  resetTeamLocationForTests()
})

afterEach(() => {
  for (const renderer of active.splice(0)) act(() => { renderer.unmount() })
  act(() => {
    useTeamPlanStore.setState({ views: {} })
    useTeamTaskStore.setState({ views: {} })
    useTeamWorkspaceStore.setState({ views: {} })
  })
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const summary = (extra: Partial<PlanSummary> = {}): PlanSummary => ({
  id: 'p1', title: 'Wave C', lifecycle: 'open', state: 'draft', currentApprovedRevision: null, latestRevision: 1,
  creator: { kind: 'agent', sessionId: 'lead' }, strategyPin: null, linkedTaskCount: 0,
  createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', ...extra,
} as PlanSummary)

test('the Team page Plans tab mounts the view: it subscribes, follows the URL plan id, names a selection, and closes on another tab', () => {
  const element = (location: TeamLocation) => <TeamWorkspaceView teamKey="/repo" location={location}
    sendMessage={sendMessage} connected connectionEpoch={0} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element({ teamKey: '/repo', tab: 'plans' })) })
  active.push(renderer)
  const update = () => act(() => { renderer.update(element(useTeamLocationStore.getState().location!)) })
  const has = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId }).length > 0
  expect(has('team-plans')).toBe(true)
  expect(useTeamPlanStore.getState().views['/repo']?.open).toBe(true)
  expect(sent).toContainEqual({ type: 'team-plans-open', teamPath: '/repo' })

  // Selecting a plan names it in the URL; the detail subscription follows.
  act(() => useTeamPlanStore.getState().applySnapshot({ type: 'team-plans-snapshot', teamPath: '/repo', teamId: 't', plans: [summary()] }))
  act(() => renderer.root.findByProps({ 'data-testid': 'plan-row-p1' }).props.onClick())
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'plans', id: 'p1' })
  update()
  expect(sent).toContainEqual({ type: 'team-plan-open', teamPath: '/repo', planId: 'p1' })

  // A URL without an id (Back to the list) clears the selection.
  act(() => { renderer.update(element({ teamKey: '/repo', tab: 'plans' })) })
  expect(useTeamPlanStore.getState().views['/repo']?.selected).toBeNull()
  expect(sent).toContainEqual({ type: 'team-plan-close', teamPath: '/repo', planId: 'p1' })

  // Another tab unmounts the view and ends its subscription.
  act(() => renderer.root.findByProps({ 'data-testid': 'team-tab-tasks' }).props.onClick())
  update()
  expect(has('team-plans')).toBe(false)
  expect(sent).toContainEqual({ type: 'team-plans-close', teamPath: '/repo' })
})

test('a URL naming a plan opens its detail on mount', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamWorkspaceView teamKey="/repo" location={{ teamKey: '/repo', tab: 'plans', id: 'p1' }}
      sendMessage={sendMessage} connected connectionEpoch={0} />)
  })
  active.push(renderer)
  expect(useTeamPlanStore.getState().views['/repo']?.selected).toBe('p1')
  expect(sent).toContainEqual({ type: 'team-plan-open', teamPath: '/repo', planId: 'p1' })
})

const targets = (revision: number, changes: string[]) => ({ type: 'team-task-targets-result' as const, teamPath: 'dev', requestId: 'r',
  targets: { worktrees: [], changes: [], plans: [{ id: 'p1', title: 'Wave C', revision, changes }] } })

const mountTasks = () => {
  useTeamTaskStore.getState().open('dev')
  act(() => useTeamTaskStore.getState().applyTargetsResult(targets(2, ['api', 'ui']) as never))
  let renderer!: TestRenderer.ReactTestRenderer
  const render = () => <TeamTasksView teamPath="dev" projectPath="/repo"
    view={{ ...useTeamTaskStore.getState().views.dev!, loading: false, tasks: [] }}
    sendMessage={sendMessage} connected />
  act(() => { renderer = TestRenderer.create(render()) })
  active.push(renderer)
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  return { renderer, byId, update: () => act(() => renderer.update(render())) }
}

test('the plan pickers list only the approved changes the server offers, and a linked task sends planId and planChange', () => {
  const { renderer, byId, update } = mountTasks()
  const input = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
  expect(textOf(byId('task-plan-picker'))).toBe('No planWave C (revision 2)')
  expect(renderer.root.findAllByProps({ 'data-testid': 'task-plan-change-picker' })).toHaveLength(0)
  act(() => {
    input('Task title').props.onChange({ target: { value: 'Build API' } })
    input('Task direction').props.onChange({ target: { value: 'Store and routes' } })
    byId('task-plan-picker').props.onChange({ target: { value: 'p1' } })
  })
  update()
  expect(textOf(byId('task-plan-change-picker'))).toBe('Choose a change of the planapiui')
  // A plan without its change cannot be submitted.
  expect(byId('task-create-button').props.disabled).toBe(true)
  act(() => byId('task-plan-change-picker').props.onChange({ target: { value: 'api' } }))
  update()
  expect(byId('task-create-button').props.disabled).toBe(false)
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  expect(sent.filter(message => message.type === 'team-task-create')).toEqual([{ type: 'team-task-create', teamPath: 'dev',
    requestId: expect.any(String), requestKey: expect.any(String), title: 'Build API', direction: 'Store and routes', planId: 'p1', planChange: 'api' }])
})
