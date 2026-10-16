// The Metrics tab's reports (team-process-metrics 9.4): per-window freshness,
// the newest reports opening their detail by URL, the needs-a-link and
// unproposed-changes lists, the proposal card's Accept/Reject with a reason,
// link picker over candidates, Replace link and Unlink, linker, shared
// marker, and outcome; command keys reused per payload and retired on
// success, refusals shown on the card, and every control disabled while
// disconnected.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage, Session } from '@shared/types'
import { COVERAGE_CAVEAT, USAGE_CAVEAT, type ProcessMetrics } from '@shared/processMetrics'
import type { ProcessProposal, ProcessReport, ReportFreshness, VersionChange } from '@shared/processReports'
import TeamWorkspaceView from '../components/team/TeamWorkspaceView'
import { handleMetricsMessage } from '../protocol/metricsMessages'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
import { useMetricsStore } from '../stores/metricsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import type { TeamLocation } from '../utils/teamLocation'

const sent: ClientMessage[] = []
const sendMessage: SendClientMessage = message => { sent.push(message) }
const active: TestRenderer.ReactTestRenderer[] = []

const sessions = [
  { id: 'chat-1', name: 'lead', tmuxWindow: '', projectPath: '/repo', status: 'waiting', lastActivity: '', createdAt: '', source: 'managed', kind: 'chat' },
  { id: 'chat-rev', name: 'reviewer-1', tmuxWindow: '', projectPath: '/repo', status: 'waiting', lastActivity: '', createdAt: '', source: 'managed', kind: 'chat' },
] as unknown as Session[]

const metrics: ProcessMetrics = {
  teamId: '/repo/.git', window: '7d', slice: null, periodStart: '2026-10-09T12:00:00.000Z', periodEnd: '2026-10-16T12:00:00.000Z',
  baselineStart: '2026-10-02T12:00:00.000Z', computedAt: '2026-10-16T12:00:00.000Z', minSample: 10,
  metrics: [{ id: 'finding_fail_rate', value: 0.4, n: 12, insufficient: false, baseline: { value: null, n: 0, insufficient: true }, approximate: false, partial: false, drill: { tasks: [], messages: [] } }],
  usageCaveat: USAGE_CAVEAT, coverageCaveat: COVERAGE_CAVEAT,
} as ProcessMetrics

const change = (startId: string, hash: string, previousHash = 'aaaaaaaaaaaa'): VersionChange => ({
  targetKind: 'group', target: 'reviewers', startId, sessionId: 'chat-rev', at: '2026-10-15T10:00:00.000Z', hash, previousHash,
})
const proposal = (id: string, extra: Partial<ProcessProposal> = {}): ProcessProposal => ({
  id, reportId: 'r-1', kind: 'change', targetKind: 'group', target: 'reviewers', edit: 'Ask for tests first.', rationale: 'Fail rate rose.',
  expected: [{ metric: 'finding_fail_rate', direction: 'down' }], revertToHash: null, decision: null, link: null, linkHistory: [],
  sharedWith: [], candidates: [], ...extra,
})
const accepted = { decision: 'accepted' as const, reason: null, targetHashAtDecision: 'aaaaaaaaaaaa', decidedAt: '2026-10-14T10:00:00.000Z' }
const humanLink = { changeStartId: 's-b', changeHash: 'bbbbbbbbbbbb', changeAt: '2026-10-15T10:00:00.000Z', actor: { kind: 'agent' as const, sessionId: 'chat-1' }, at: '2026-10-15T11:00:00.000Z' }

const report: ProcessReport = {
  id: 'r-1', teamId: '/repo/.git', authorSession: 'chat-1', window: '7d', periodStart: metrics.periodStart, periodEnd: metrics.periodEnd,
  summary: 'Review fail rate rose; ask reviewers for tests first.', snapshot: metrics, createdAt: '2026-10-16T12:00:00.000Z',
  proposals: [
    proposal('p-new'),
    proposal('p-open', { decision: accepted, candidates: [change('s-b', 'bbbbbbbbbbbb'), change('s-c', 'cccccccccccc')] }),
    proposal('p-done', {
      decision: accepted, link: humanLink, sharedWith: ['p-other'], candidates: [change('s-b', 'bbbbbbbbbbbb'), change('s-c', 'cccccccccccc')],
      linkHistory: [{ action: 'link', changeStartId: 's-b', changeHash: 'bbbbbbbbbbbb', changeAt: humanLink.changeAt, actor: humanLink.actor, at: humanLink.at }],
      outcome: [
        { metric: 'finding_fail_rate', direction: 'down', before: { value: 0.6, n: 10, insufficient: false }, after: { value: 0.2, n: 10, insufficient: false }, attributed: true, state: 'as-expected' },
        { metric: 'first_pass_yield', direction: 'up', before: { value: 0.4, n: 4, insufficient: true }, after: { value: null, n: 0, insufficient: true }, attributed: false, state: 'undetermined' },
      ],
    }),
  ],
}
const freshness: ReportFreshness[] = [
  { window: '1d', latestReportId: 'r-0', latestAt: '2026-10-15T06:00:00.000Z', ageHours: 30 },
  { window: '3d', latestReportId: null, latestAt: null, ageHours: null },
  { window: '7d', latestReportId: 'r-1', latestAt: report.createdAt, ageHours: 0 },
]
const unproposed: VersionChange[] = [{ ...change('s-m', 'mmmmmmmmmmmm', 'llllllllllll'), targetKind: 'memory', target: 'MEMORY.md' }]

const push = (reports = [report]) => act(() => {
  handleMetricsMessage({
    type: 'process-metrics-snapshot', teamPath: '/repo', teamId: '/repo/.git', window: '7d', slice: null, computedAt: metrics.computedAt,
    metrics, reports, freshness, unproposed,
  })
})
const result = (commandId: string, extra: { error?: string } = {}) => act(() => {
  handleMetricsMessage({ type: 'process-proposal-result', teamPath: '/repo', commandId, kind: 'decide', ...extra })
})

const mountPage = (location: TeamLocation, connected = true) => {
  useTeamLocationStore.setState({ location })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamWorkspaceView teamKey={location.teamKey} location={location} sendMessage={sendMessage}
      connected={connected} connectionEpoch={0} />)
  })
  active.push(renderer)
  return renderer
}
const find = (root: TestRenderer.ReactTestRenderer | TestRenderer.ReactTestInstance, testId: string) =>
  ('root' in root ? root.root : root).findAll(node => node.props['data-testid'] === testId && typeof node.type === 'string')
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const card = (root: TestRenderer.ReactTestRenderer, id: string) =>
  root.root.find(node => node.props['data-proposal'] === id && typeof node.type === 'string')
const button = (root: TestRenderer.ReactTestInstance, label: string) =>
  root.find(node => node.type === 'button' && textOf(node) === label)
const commands = () => sent.filter(message => message.type.startsWith('process-proposal-')) as Array<Extract<ClientMessage, { type: `process-proposal-${string}` }>>

beforeEach(() => {
  sent.length = 0
  useSessionStore.setState({ sessions, hasLoaded: true })
  useTeamWorkspaceStore.setState({ views: {} })
  useMetricsStore.setState({ views: {} })
  resetTeamLocationForTests()
})

afterEach(() => {
  for (const renderer of active.splice(0)) act(() => { renderer.unmount() })
  useTeamWorkspaceStore.setState({ views: {} })
  useMetricsStore.setState({ views: {} })
  useSessionStore.setState({ sessions: [], hasLoaded: false })
  resetTeamLocationForTests()
})

test('command keys are reused for one payload, re-minted after a change, retired on success; close clears waiting', () => {
  const store = useMetricsStore.getState()
  store.request('/repo', { window: '7d', slice: null })
  const first = store.arm('/repo', 'decide:p', { decision: 'accepted', reason: null })
  expect(store.arm('/repo', 'decide:p', { decision: 'accepted', reason: null })).toBe(first)
  const second = store.arm('/repo', 'decide:p', { decision: 'rejected', reason: null })
  expect(second).not.toBe(first)
  result(second, { error: 'No.' })
  expect(useMetricsStore.getState().views['/repo']!.commands['decide:p']).toMatchObject({ busy: false, error: 'No.' })
  expect(store.arm('/repo', 'decide:p', { decision: 'rejected', reason: null })).toBe(second)
  store.close('/repo')
  expect(useMetricsStore.getState().views['/repo']!.commands['decide:p']!.busy).toBe(false)
  result(second)
  expect(useMetricsStore.getState().views['/repo']!.commands).toEqual({})
})

test('the overview shows freshness, the reports, what needs a link, and unproposed changes; a report opens by URL', () => {
  const page = mountPage({ teamKey: '/repo', tab: 'metrics', window: '7d' })
  push()
  expect(textOf(find(page, 'report-freshness')[0]!)).toBe('Latest reports: 1d 30 h ago · 3d none yet · 7d 0 h ago')
  const [row] = find(page, 'report-row')
  expect(textOf(row!)).toContain('7d report by lead')
  expect(textOf(row!)).toContain('3 proposals · 1 awaiting a decision · 1 accepted without a link')
  expect(find(page, 'needs-link-row').map(textOf)[0]).toContain('Change group reviewers')
  expect(find(page, 'needs-link-row').map(textOf)[0]).toContain('2 candidates')
  expect(textOf(find(page, 'unproposed-change')[0]!)).toContain('memory file MEMORY.md llllllll → mmmmmmmm')
  expect(textOf(find(page, 'unproposed-change')[0]!)).toContain('first loaded by reviewer-1 (start s-m)')
  // A collapsed section stays collapsed.
  const toggle = find(page, 'metrics-section-unproposed')[0]!.findByType('button')
  act(() => { toggle.props.onClick() })
  expect(useTeamWorkspaceStore.getState().views['/repo']!.tabs.metrics.collapsedSections).toContain('unproposed')
  expect(find(page, 'unproposed-change')).toHaveLength(0)
  act(() => { button(row!, textOf(row!.findByType('button'))).props.onClick() })
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'metrics', window: '7d', id: 'r-1' })
})

test('a report\'s detail decides with a reason under one key; a refusal shows and a resend replays the key', () => {
  const page = mountPage({ teamKey: '/repo', tab: 'metrics', window: '7d', id: 'r-1' })
  push()
  expect(textOf(find(page, 'report-summary')[0]!)).toBe(report.summary)
  expect(find(page, 'metric-family')).toHaveLength(0)
  const pending = card(page, 'p-new')
  act(() => { pending.findByProps({ 'aria-label': 'Decision reason' }).props.onChange({ target: { value: ' Worth a try. ' } }) })
  act(() => { button(pending, 'Accept').props.onClick() })
  const [decide] = commands()
  expect(decide).toMatchObject({ type: 'process-proposal-decide', teamPath: '/repo', proposalId: 'p-new', decision: 'accepted', reason: 'Worth a try.' })
  expect(button(card(page, 'p-new'), 'Accept').props.disabled).toBe(true)
  result(decide!.commandId, { error: 'Proposal p-new was already rejected; a decision is final.' })
  expect(textOf(card(page, 'p-new').findByProps({ role: 'alert' }))).toContain('already rejected')
  act(() => { button(card(page, 'p-new'), 'Accept').props.onClick() })
  expect(commands()[1]!.commandId).toBe(decide!.commandId)
})

test('an accepted proposal links through its candidates; a linked one shows linker, sharing, history, and outcome', () => {
  const page = mountPage({ teamKey: '/repo', tab: 'metrics', window: '7d', id: 'r-1' })
  push()
  const open = card(page, 'p-open')
  expect(button(open, 'Link').props.disabled).toBe(true)
  act(() => { find(open, 'proposal-candidates')[0]!.props.onChange({ target: { value: 's-c' } }) })
  act(() => { button(card(page, 'p-open'), 'Link').props.onClick() })
  expect(commands().at(-1)).toMatchObject({ type: 'process-proposal-link', proposalId: 'p-open', changeStartId: 's-c' })

  const done = card(page, 'p-done')
  expect(textOf(find(done, 'proposal-link')[0]!)).toContain('Implemented by start s-b (bbbbbbbb')
  expect(textOf(find(done, 'proposal-link')[0]!)).toContain('linked by Agent lead')
  expect(textOf(find(done, 'proposal-shared')[0]!)).toBe('Shared with 1 other proposal')
  // The current link is not offered again.
  expect(find(done, 'proposal-candidates')[0]!.findAllByType('option').map(o => o.props.value)).toEqual(['', 's-c'])
  expect(textOf(find(done, 'proposal-link-history')[0]!)).toContain('link start s-b (bbbbbbbb) by Agent lead')
  const rows = find(done, 'proposal-outcome-row')
  expect(rows.map(r => r.props['data-state'])).toEqual(['as-expected', 'undetermined'])
  expect(textOf(rows[0]!)).toContain('60% (n 10)20% (n 10)Moved as expected')
  expect(textOf(rows[1]!)).toContain('Undetermined · not attributed')
  act(() => { button(done, 'Unlink').props.onClick() })
  expect(commands().at(-1)).toMatchObject({ type: 'process-proposal-link', proposalId: 'p-done', changeStartId: null })
  expect(button(card(page, 'p-done'), 'Replace link').props.disabled).toBe(true)
})

test('every proposal control disables while disconnected; an unknown report says so', () => {
  const page = mountPage({ teamKey: '/repo', tab: 'metrics', window: '7d', id: 'r-1' }, false)
  act(() => { useMetricsStore.getState().request('/repo', { window: '7d', slice: null }) })
  push()
  for (const id of ['p-new', 'p-open', 'p-done']) {
    for (const control of card(page, id).findAll(node => node.type === 'button' || node.type === 'input' || node.type === 'select')) {
      expect(control.props.disabled).toBe(true)
    }
  }
  act(() => { useTeamLocationStore.setState({ location: { teamKey: '/repo', tab: 'metrics', window: '7d', id: 'r-gone' } }) })
  act(() => { page.update(<TeamWorkspaceView teamKey="/repo" location={{ teamKey: '/repo', tab: 'metrics', window: '7d', id: 'r-gone' }}
    sendMessage={sendMessage} connected={false} connectionEpoch={0} />) })
  expect(textOf(find(page, 'report-missing')[0]!)).toContain('Report r-gone is not among the team\'s newest 20 reports.')
})
