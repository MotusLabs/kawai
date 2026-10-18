// The Audit tab's host wiring (execution-safety-recovery D9/D10): the hash
// grammar knows the tab, the Team page mounts the view only for a known team
// and passes it the connection, epoch, and URL selection — Apply returns the
// URL to the plain tab — and the attention link opens the tab on its call,
// or the plain tab for a summary item.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage, Session } from '@shared/types'
import TeamWorkspaceView from '../components/team/TeamWorkspaceView'
import { attentionKindLabel } from '../components/team/TeamAttentionQueue'
import { attentionLinkLabel, openAttentionLink } from '../components/team/attentionLinks'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamAuditStore } from '../stores/teamAuditStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import { parseTeamHash, teamHashOf, type TeamLocation } from '../utils/teamLocation'

const sent: ClientMessage[] = []
const sendMessage: SendClientMessage = message => { sent.push(message) }
const active: TestRenderer.ReactTestRenderer[] = []
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

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

const mountPage = (location: TeamLocation) => {
  let connected = true
  let epoch = 0
  let renderer!: TestRenderer.ReactTestRenderer
  const element = () => <TeamWorkspaceView teamKey={location.teamKey} location={useTeamLocationStore.getState().location ?? location}
    sendMessage={sendMessage} connected={connected} connectionEpoch={epoch} />
  act(() => { renderer = TestRenderer.create(element()) })
  active.push(renderer)
  const rerender = (next: { connected?: boolean; epoch?: number } = {}) => {
    if (next.connected !== undefined) connected = next.connected
    if (next.epoch !== undefined) epoch = next.epoch
    act(() => { renderer.update(element()) })
  }
  const opens = () => sent.filter(message => message.type === 'team-audit-open')
  return { renderer, rerender, opens }
}

describe('the tab', () => {
  test('the hash grammar parses the audit tab with its call id', () => {
    const location: TeamLocation = { teamKey: '/repo', tab: 'audit', id: 'obc-1' }
    expect(parseTeamHash(teamHashOf(location))).toEqual(location)
  })

  test('the strip labels it Audit', () => {
    const page = mountPage({ teamKey: '/repo', tab: 'audit' })
    expect(textOf(page.renderer.root.findByProps({ 'data-testid': 'team-tab-audit' }))).toBe('Audit')
  })

  test('an unknown team mounts no audit view and sends nothing', () => {
    const page = mountPage({ teamKey: '/not-a-repo', tab: 'audit' })
    expect(page.renderer.root.findAllByProps({ 'data-testid': 'team-audit' })).toHaveLength(0)
    expect(page.opens()).toHaveLength(0)
  })
})

describe('the mount passes the connection through', () => {
  test('an epoch bump re-requests exactly once; disconnected disables Apply', () => {
    const page = mountPage({ teamKey: '/repo', tab: 'audit' })
    expect(page.opens()).toHaveLength(1)
    page.rerender({ epoch: 1 })
    expect(page.opens()).toHaveLength(2)
    page.rerender({ connected: false })
    expect(page.renderer.root.findByProps({ 'data-testid': 'audit-apply-filters' }).props.disabled).toBe(true)
  })

  test('Apply on a linked call returns the URL to the plain audit tab', () => {
    act(() => useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'audit', id: 'obc-9' }))
    const page = mountPage({ teamKey: '/repo', tab: 'audit', id: 'obc-9' })
    expect(useTeamAuditStore.getState().views['/repo']!.selected).toBe('obc-9')
    act(() => page.renderer.root.findByProps({ 'data-testid': 'audit-apply-filters' }).props.onClick())
    expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'audit' })
  })
})

describe('attention', () => {
  test('the link label and kind label', () => {
    expect(attentionLinkLabel({ kind: 'audit', id: 'obc-1' })).toBe('Open audit row')
    expect(attentionKindLabel('outbound-violation')).toBe('Outbound violation')
  })

  test('an item opens the tab on its call; a summary item opens the plain tab', () => {
    const navigated: TeamLocation[] = []
    openAttentionLink('/repo', { kind: 'audit', id: 'obc-1' }, location => navigated.push(location))
    openAttentionLink('/repo', { kind: 'audit', id: '' }, location => navigated.push(location))
    expect(navigated).toEqual([{ teamKey: '/repo', tab: 'audit', id: 'obc-1' }, { teamKey: '/repo', tab: 'audit' }])
  })
})
