// The attention queue, morning summary, and bands (team-workspace 6.2/6.4):
// human-required items apart from agent waits, an unrecognized kind rendered
// not dropped, links that go to their source, five summary buckets with the
// runtime-only label, and bands that collapse per team.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AttentionItem, MorningSummary, TeamWorkspaceSnapshot } from '@shared/teamWorkspace'
import TeamAttentionQueue, { focusAfterRemoval } from '../components/team/TeamAttentionQueue'
import TeamMorningSummary from '../components/team/TeamMorningSummary'
import TeamWorkspaceBands from '../components/team/TeamWorkspaceBands'
import { openAttentionLink } from '../components/team/attentionLinks'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import type { TeamLocation } from '../utils/teamLocation'

const item = (id: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id, kind: id.split(':')[0]!, cause: `cause of ${id}`, owner: { kind: 'session', id: 's', label: 'dev one' },
  impact: { taskId: 't-1', taskTitle: 'Export' }, nextAction: 'Answer approval', link: { kind: 'chat', id: 's' },
  requiresHuman: true, ...extra,
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const byId = (root: TestRenderer.ReactTestRenderer, id: string) => root.root.findAll(node => node.props['data-testid'] === id)

const summary = (extra: Partial<MorningSummary> = {}): MorningSummary => ({
  since: '2026-10-14T00:00:00.000Z',
  completedResults: { items: [] }, capacityWaits: { items: [], runtimeOnly: true }, approvals: { items: [] },
  uncertainDeliveries: { items: [] }, finishedTurnsWithoutResult: { items: [] }, ...extra,
})
const snapshotOf = (attention: AttentionItem[], extra: Partial<MorningSummary> = {}): TeamWorkspaceSnapshot =>
  ({ tasks: [], attention, members: [], directory: [], summary: summary(extra) })

beforeEach(() => {
  useTeamWorkspaceStore.setState({ views: {} })
  useSessionStore.setState({ selectedSessionId: null })
})
afterEach(() => useTeamWorkspaceStore.setState({ views: {} }))

test('human-required items are separated from agent-owned waits, with counts', () => {
  const opened: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={entry => opened.push(entry.id)}
      items={[item('approval:a'), item('staffing-wait:m', { requiresHuman: false, nextAction: 'Wait for capacity' })]} />)
  })
  expect(textOf(byId(renderer, 'attention-summary')[0]!)).toContain('1 need you · 1 waiting on agents')
  const human = byId(renderer, 'attention-human')[0]!
  expect(human.findAll(node => node.props['data-testid'] === 'attention-item')).toHaveLength(1)
  expect(textOf(human)).toContain('Task Export')
  expect(textOf(byId(renderer, 'attention-agent')[0]!)).toContain('Wait for capacity')
  act(() => { byId(renderer, 'attention-action')[0]!.props.onClick() })
  expect(opened).toEqual(['approval:a'])
})

test('an unrecognized kind still renders with its cause, owner, impact, and action', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={() => {}}
      items={[item('plan-hold:p1', { link: { kind: 'card', id: 'card-1' }, nextAction: 'Review hold' })]} />)
  })
  const rendered = textOf(byId(renderer, 'attention-item')[0]!)
  expect(rendered).toContain('plan-hold')
  expect(rendered).toContain('cause of plan-hold:p1')
  expect(rendered).toContain('dev one')
  expect(rendered).toContain('Review hold')
})

test('before the first snapshot the queue says loading, not empty', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamAttentionQueue loaded={false} onOpen={() => {}} items={[]} />) })
  expect(textOf(byId(renderer, 'attention-summary')[0]!)).toContain('loading')
  expect(byId(renderer, 'attention-empty')).toHaveLength(0)
})

test('links go to their source: a task, a mailbox row, a chat', () => {
  const navigated: TeamLocation[] = []
  const navigate = (location: TeamLocation) => navigated.push(location)
  openAttentionLink('/repo', { kind: 'task', id: 't-1' }, navigate)
  openAttentionLink('/repo', { kind: 'message', id: 'm-1' }, navigate)
  openAttentionLink('/repo', { kind: 'chat', id: 'chat-9' }, navigate)
  openAttentionLink('/repo', { kind: 'card', id: 'chat-8' }, navigate)
  expect(navigated).toEqual([{ teamKey: '/repo', tab: 'tasks', id: 't-1' }, { teamKey: '/repo', tab: 'mailbox' }])
  expect(useTeamWorkspaceStore.getState().views['/repo']?.tabs.mailbox.expanded).toEqual(['m-1'])
  // A chat link selects the chat (which leaves the Team page).
  expect(useSessionStore.getState().selectedSessionId).toBe('chat-8')
})

test('the summary shows five buckets, the runtime-only label, and links', () => {
  const opened: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamMorningSummary onOpen={entry => opened.push(entry.id)} summary={summary({
      capacityWaits: { runtimeOnly: true, items: [{ id: 'w', label: 'Waiting on devs cap', link: { kind: 'message', id: 'm' } }] },
      finishedTurnsWithoutResult: { items: [{ id: 'f', label: 'dev two finished a turn', link: { kind: 'chat', id: 's2' } }] },
    })} />)
  })
  const buckets = byId(renderer, 'summary-bucket')
  expect(buckets.map(bucket => bucket.props['data-bucket'])).toEqual([
    'Completed results', 'Capacity waits', 'Approvals', 'Uncertain deliveries', 'Finished turns without a result',
  ])
  expect(textOf(buckets[1]!)).toContain('Runtime only')
  expect(textOf(buckets[0]!)).toContain('None.')
  expect(textOf(buckets[4]!)).toContain('dev two finished a turn')
  act(() => { byId(renderer, 'summary-item')[0]!.props.onClick() })
  expect(opened).toEqual(['w'])
})

test('bands collapse per team: attention starts open, the summary collapsed', () => {
  const element = (key: string) => <TeamWorkspaceBands teamKey={key} navigate={() => {}} snapshot={snapshotOf([item('approval:a')])} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element('/repo')) })
  expect(byId(renderer, 'team-attention-queue')).toHaveLength(1)
  expect(byId(renderer, 'team-morning-summary')).toHaveLength(0)
  expect(byId(renderer, 'band-toggle-attention')[0]!.props['aria-expanded']).toBe(true)
  act(() => { byId(renderer, 'band-toggle-summary')[0]!.props.onClick() })
  expect(byId(renderer, 'team-morning-summary')).toHaveLength(1)
  act(() => { byId(renderer, 'band-toggle-attention')[0]!.props.onClick() })
  expect(byId(renderer, 'team-attention-queue')).toHaveLength(0)
  // Another team keeps its own defaults.
  act(() => { renderer.update(element('/other')) })
  expect(byId(renderer, 'team-attention-queue')).toHaveLength(1)
  expect(byId(renderer, 'team-morning-summary')).toHaveLength(0)
})

test('focus after a resolved item goes to the item now in its place, else the heading', () => {
  expect(focusAfterRemoval(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
  expect(focusAfterRemoval(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b')
  expect(focusAfterRemoval(['a'], [], 'a')).toBeNull()
  expect(focusAfterRemoval(['a', 'b'], ['a', 'b'], 'a')).toBeNull()
  expect(focusAfterRemoval(['a', 'b'], ['b'], null)).toBeNull()
})

test('the counts line is a polite status region and every action has a name', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={() => {}} items={[item('approval:a')]} />) })
  const summary = byId(renderer, 'attention-summary')[0]!
  expect(summary.props.role).toBe('status')
  expect(summary.props['aria-live']).toBe('polite')
  expect(String(byId(renderer, 'attention-action')[0]!.props['aria-label'])).toContain('Answer approval')
})
