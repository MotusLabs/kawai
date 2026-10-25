// The active repository role as per-team store state (plan-workspace 7.1):
// a tab pick writes `roles[teamPath]` and calls back once so the section can
// mirror the URL; the role survives unmount and remount, another team keeps
// its own, and switching roles discharges the panel's create-then-bind arm.
// (Kept apart from the main conversation suite to leave that file's size
// where it was.)
import { afterEach, describe, expect, test } from 'bun:test'
import { act } from 'react-dom/test-utils'
import TestRenderer from 'react-test-renderer'
import type { ClientMessage, ServerMessage } from '@shared/types'
import PlanWorkspaceConversation from '../components/team/PlanWorkspaceConversation'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) renderer.unmount()
  renderers.length = 0
  useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {}, roles: {}, panes: {}, retained: {} })
})

const mountPanel = (overrides: Partial<Parameters<typeof PlanWorkspaceConversation>[0]> = {}) => {
  const sendMessage = (_message: ClientMessage) => {}
  const subscribe = (_listener: (message: ServerMessage) => void) => () => {}
  let renderer!: TestRenderer.ReactTestRenderer
  const element = () => <PlanWorkspaceConversation teamPath="/repo" sessions={[]}
    connected connectionEpoch={1} sendMessage={sendMessage} subscribe={subscribe}
    selection={null} {...overrides} />
  act(() => { renderer = TestRenderer.create(element()) })
  renderers.push(renderer)
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  return { renderer, byId }
}

describe('the active role (plan-workspace 7.1)', () => {
  test('a pick writes the per-team store role and mirrors it once; it survives unmount', () => {
    let roleSelected = 0
    const first = mountPanel({ onRoleSelected: () => { roleSelected++ } })
    expect(first.byId('conversation-role-architect').props['aria-selected']).toBe(true)
    act(() => first.byId('conversation-role-lead').props.onClick())
    expect(useTeamPlanWorkspaceStore.getState().roles['/repo']).toBe('lead')
    expect(roleSelected).toBe(1)
    expect(first.byId('conversation-role-lead').props['aria-selected']).toBe(true)
    act(() => first.renderer.unmount())
    renderers.length = 0
    // The role rode the team store: the remounted panel opens on it.
    const second = mountPanel({})
    expect(second.byId('conversation-role-lead').props['aria-selected']).toBe(true)
    // Another team kept its own role.
    useTeamPlanWorkspaceStore.getState().setRole('/other', 'architect')
    expect(useTeamPlanWorkspaceStore.getState().roles['/other']).toBe('architect')
  })

  test('a linked role seed opens the panel on the Lead tab', () => {
    act(() => useTeamPlanWorkspaceStore.getState().setRole('/repo', 'lead'))
    const { byId } = mountPanel({})
    expect(byId('conversation-role-lead').props['aria-selected']).toBe(true)
    expect(byId('conversation-role-architect').props['aria-selected']).toBe(false)
  })

  test('switching roles discharges the create-then-bind arm and never crosses roles', () => {
    const { byId } = mountPanel({ onOpenNewSession: () => {} })
    act(() => byId('conversation-new-chat-architect').props.onClick())
    const armed = () => (byId('conversation-new-chat-architect').props.children as (string | undefined)[])
      .join('')
    expect(armed()).toContain('binding after creation')
    // The switch clears the arm (the old role's pick must not bind a new chat).
    act(() => byId('conversation-role-lead').props.onClick())
    act(() => byId('conversation-role-architect').props.onClick())
    expect(armed()).not.toContain('binding after creation')
  })
})
