// The Audit tab's host (execution-safety-recovery 4.4, D9): the Team page's
// audit tab mounts the view, which subscribes over the team path, follows
// the URL's call id, and unsubscribes when another tab opens.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage, Session } from '@shared/types'
import TeamWorkspaceView from '../components/team/TeamWorkspaceView'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamAuditStore } from '../stores/teamAuditStore'
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
    useTeamAuditStore.setState({ views: {} })
    useTeamWorkspaceStore.setState({ views: {} })
  })
})

test('the audit tab mounts the view: it subscribes, follows the URL call id, and closes on another tab', () => {
  const element = (location: TeamLocation) => <TeamWorkspaceView teamKey="/repo" location={location}
    sendMessage={sendMessage} connected connectionEpoch={0} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element({ teamKey: '/repo', tab: 'audit' })) })
  active.push(renderer)
  const update = () => act(() => { renderer.update(element(useTeamLocationStore.getState().location!)) })
  const has = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId }).length > 0
  expect(has('team-audit')).toBe(true)
  expect(useTeamAuditStore.getState().views['/repo']?.open).toBe(true)
  expect(sent).toContainEqual(expect.objectContaining({ type: 'team-audit-open', teamPath: '/repo' }))

  // A URL naming a call selects it; the view clears the selection without one.
  act(() => { renderer.update(element({ teamKey: '/repo', tab: 'audit', id: 'obc-9' })) })
  expect(useTeamAuditStore.getState().views['/repo']?.selected).toBe('obc-9')
  act(() => useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'audit' }))
  expect(useTeamAuditStore.getState().views['/repo']?.selected).toBeNull()

  // Another tab unmounts the view and ends its subscription.
  act(() => renderer.root.findByProps({ 'data-testid': 'team-tab-tasks' }).props.onClick())
  update()
  expect(has('team-audit')).toBe(false)
  expect(sent).toContainEqual({ type: 'team-audit-close', teamPath: '/repo' })
})
