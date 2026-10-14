// The Plans view's host and the task form's plan link (durable-plans 8.3):
// the chat header's Plans switch opens the side-slot panel, which subscribes
// to the team's plans and closes again; the task form's plan pickers offer
// only open plans' approved changes (the server's `targets.plans`); and a
// linked task is created with `planId` / `planChange`.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, Session } from '@shared/types'
import ChatView from '../components/chat/ChatView'
import TeamTasksPanel from '../components/chat/TeamTasksPanel'
import { useChatStore } from '../stores/chatStore'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'

afterEach(() => {
  act(() => {
    useTeamPlanStore.setState({ views: {} })
    useTeamTaskStore.setState({ views: {} })
    useChatStore.setState({ sessions: {} })
  })
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

test('the Plans switch opens the side-slot panel, which subscribes to the team and closes again', () => {
  const sent: ClientMessage[] = []
  const sendMessage = (message: ClientMessage) => { sent.push(message) }
  const session = { id: 'chat-1', name: 'Chat', projectPath: '/repo', status: 'waiting', kind: 'chat' } as unknown as Session
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<ChatView session={session} sendMessage={sendMessage} connectionStatus="connected"
      connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />)
  })
  const panels = () => renderer.root.findAllByProps({ 'data-testid': 'team-plans-panel' })
  expect(panels()).toHaveLength(0)
  act(() => renderer.root.findByProps({ 'data-testid': 'chat-panel-plans' }).props.onClick())
  expect(panels()).toHaveLength(1)
  expect(useTeamPlanStore.getState().views['/repo']?.open).toBe(true)
  expect(sent).toContainEqual({ type: 'team-plans-open', teamPath: '/repo' })
  // Opening Tasks takes the shared slot.
  act(() => renderer.root.findByProps({ 'data-testid': 'chat-panel-tasks' }).props.onClick())
  expect(panels()).toHaveLength(0)
  expect(sent).toContainEqual({ type: 'team-plans-close', teamPath: '/repo' })
  act(() => renderer.unmount())
})

test('the plan pickers list only the approved changes the server offers, and a linked task sends planId and planChange', () => {
  const sent: ClientMessage[] = []
  useTeamTaskStore.getState().open('dev')
  act(() => useTeamTaskStore.getState().applyTargetsResult({ type: 'team-task-targets-result', teamPath: 'dev', requestId: 'r',
    targets: { worktrees: [], changes: [], plans: [{ id: 'p1', title: 'Wave C', revision: 2, changes: ['api', 'ui'] }] } } as never))
  let renderer!: TestRenderer.ReactTestRenderer
  const render = () => <TeamTasksPanel teamPath="dev" projectPath="/repo"
    view={{ ...useTeamTaskStore.getState().views.dev!, loading: false, tasks: [] }}
    sendMessage={message => sent.push(message)} connected onClose={() => {}} />
  act(() => { renderer = TestRenderer.create(render()) })
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const input = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
  expect(textOf(byId('task-plan-picker'))).toBe('No planWave C (revision 2)')
  expect(renderer.root.findAllByProps({ 'data-testid': 'task-plan-change-picker' })).toHaveLength(0)
  act(() => {
    input('Task title').props.onChange({ target: { value: 'Build API' } })
    input('Task direction').props.onChange({ target: { value: 'Store and routes' } })
    byId('task-plan-picker').props.onChange({ target: { value: 'p1' } })
  })
  act(() => renderer.update(render()))
  expect(textOf(byId('task-plan-change-picker'))).toBe('Choose a change of the planapiui')
  // A plan without its change cannot be submitted.
  expect(byId('task-create-button').props.disabled).toBe(true)
  act(() => byId('task-plan-change-picker').props.onChange({ target: { value: 'api' } }))
  act(() => renderer.update(render()))
  expect(byId('task-create-button').props.disabled).toBe(false)
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  expect(sent.filter(message => message.type === 'team-task-create')).toEqual([{ type: 'team-task-create', teamPath: 'dev',
    requestId: expect.any(String), requestKey: expect.any(String), title: 'Build API', direction: 'Store and routes', planId: 'p1', planChange: 'api' }])
  act(() => renderer.unmount())
})
