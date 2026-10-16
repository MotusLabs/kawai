// The Metrics tab (team-process-metrics 7.1/7.2): the store keeps only the
// requested window's snapshot, the page mounts the view on the metrics
// location and adopts a window when the URL names none (with a notice for an
// unknown one), the subscription follows window and slice, each row shows
// value, n, baseline delta, flags, guard, markers, and breakdowns, drill-down
// opens tasks and threads, and every control disables while disconnected.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage, Session } from '@shared/types'
import {
  COVERAGE_CAVEAT, METRIC_DEFS, USAGE_CAVEAT,
  type MetricId, type MetricValue, type ProcessMetrics,
} from '@shared/processMetrics'
import TeamWorkspaceView from '../components/team/TeamWorkspaceView'
import { formatDelta, formatValue } from '../components/team/metrics/metricFormat'
import { handleMetricsMessage } from '../protocol/metricsMessages'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
import { useMetricsStore } from '../stores/metricsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import type { TeamLocation } from '../utils/teamLocation'

const sent: ClientMessage[] = []
const sendMessage: SendClientMessage = message => { sent.push(message) }
const active: TestRenderer.ReactTestRenderer[] = []

const chatAt = (projectPath: string): Session => ({
  id: 'chat-1', name: 'lead', tmuxWindow: '', projectPath, status: 'waiting', lastActivity: '', createdAt: '', source: 'managed', kind: 'chat',
} as unknown as Session)

const stat = (value: number | null, n: number) => ({ value, n, insufficient: n < 10 })
const metric = (id: MetricId, extra: Partial<MetricValue> = {}): MetricValue => ({
  id, ...stat(null, 0), baseline: stat(null, 0), approximate: false, partial: false, drill: { tasks: [], messages: [] }, ...extra,
})

function snapshot(window: '1d' | '3d' | '7d', overrides: Partial<Record<MetricId, Partial<MetricValue>>> = {}): ProcessMetrics {
  return {
    teamId: '/repo/.git', window, slice: null,
    periodStart: '2026-10-09T12:00:00.000Z', periodEnd: '2026-10-16T12:00:00.000Z', baselineStart: '2026-10-02T12:00:00.000Z',
    computedAt: '2026-10-16T12:00:00.000Z', minSample: 10,
    metrics: METRIC_DEFS.map(def => metric(def.id, overrides[def.id])),
    usageCaveat: USAGE_CAVEAT, coverageCaveat: COVERAGE_CAVEAT,
  }
}

const push = (message: ProcessMetrics, teamPath = '/repo') => act(() => {
  handleMetricsMessage({
    type: 'process-metrics-snapshot', teamPath, teamId: message.teamId, window: message.window,
    slice: message.slice, computedAt: message.computedAt, metrics: message, reports: [], freshness: [], unproposed: [],
  })
})

const mountPage = (location: TeamLocation, connected = true) => {
  useTeamLocationStore.setState({ location })
  const element = () => <TeamWorkspaceView teamKey={location.teamKey} location={location} sendMessage={sendMessage}
    connected={connected} connectionEpoch={0} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element()) })
  active.push(renderer)
  return renderer
}

const find = (root: TestRenderer.ReactTestRenderer | TestRenderer.ReactTestInstance, testId: string) =>
  ('root' in root ? root.root : root).findAll(node => node.props['data-testid'] === testId && typeof node.type === 'string')
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const row = (root: TestRenderer.ReactTestRenderer, id: MetricId) =>
  root.root.find(node => node.props['data-metric-id'] === id && typeof node.type === 'string')
const metricsSent = () => sent.filter(message => message.type.startsWith('process-metrics-'))

beforeEach(() => {
  sent.length = 0
  useSessionStore.setState({ sessions: [chatAt('/repo')], hasLoaded: true })
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

test('values format per unit; deltas read in percentage points for shares and say which way is better', () => {
  expect(formatValue(26.04, 'hours')).toBe('26 h')
  expect(formatValue(0.25, 'share')).toBe('25%')
  expect(formatValue(1234567.4, 'tokens')).toBe('1,234,567')
  expect(formatValue(null, 'count')).toBe('—')
  const lead = METRIC_DEFS.find(def => def.id === 'lead_time_p50')!
  expect(formatDelta(lead, stat(10, 12), stat(7.5, 12))).toBe('+2.5 h vs baseline (worse)')
  const yieldDef = METRIC_DEFS.find(def => def.id === 'first_pass_yield')!
  expect(formatDelta(yieldDef, stat(0.8, 12), stat(0.6, 12))).toBe('+20 pp vs baseline (better)')
  expect(formatDelta(yieldDef, stat(0.8, 12), stat(null, 0))).toBeNull()
})

test('the store keeps only the requested window\'s snapshot and nothing for a closed view', () => {
  const store = useMetricsStore.getState()
  push(snapshot('7d'))
  expect(useMetricsStore.getState().views['/repo']).toBeUndefined()
  store.request('/repo', { window: '1d', slice: null })
  push(snapshot('7d'))
  expect(useMetricsStore.getState().views['/repo']!.metrics).toBeNull()
  push(snapshot('1d'))
  expect(useMetricsStore.getState().views['/repo']).toMatchObject({ loading: false })
  expect(useMetricsStore.getState().views['/repo']!.metrics!.window).toBe('1d')
  store.rekey('/repo', '/main')
  expect(Object.keys(useMetricsStore.getState().views)).toEqual(['/main'])
})

test('a metrics location without a window adopts 7d by replacing the entry, then subscribes', () => {
  mountPage({ teamKey: '/repo', tab: 'metrics' })
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'metrics', window: '7d' })
  expect(metricsSent()).toEqual([{ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: null }])
  expect(useTeamWorkspaceStore.getState().views['/repo']!.notice).toBeNull()
})

test('an unknown window falls back to the team\'s last window with a notice', () => {
  useTeamWorkspaceStore.getState().setFilters('/repo', 'metrics', { window: '3d' })
  mountPage({ teamKey: '/repo', tab: 'metrics', window: '30d' })
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'metrics', window: '3d' })
  expect(useTeamWorkspaceStore.getState().views['/repo']!.notice).toBe('Unknown metrics window 30d; showing 3d')
})

test('a reloaded 7d location opens the 7d window; window and slice changes resubscribe; refresh recomputes', () => {
  const renderer = mountPage({ teamKey: '/repo', tab: 'metrics', window: '7d' })
  expect(metricsSent()).toEqual([{ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: null }])
  push(snapshot('7d'))
  expect(find(renderer, 'metrics-window-7d')[0]!.props['aria-checked']).toBe(true)

  act(() => { find(renderer, 'metrics-window-1d')[0]!.props.onClick() })
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'metrics', window: '1d' })

  sent.length = 0
  act(() => { find(renderer, 'metrics-slice')[0]!.props.onChange({ target: { value: 'profile' } }) })
  expect(metricsSent()).toEqual([
    { type: 'process-metrics-close', teamPath: '/repo' },
    { type: 'process-metrics-open', teamPath: '/repo', window: '1d', slice: { kind: 'profile' } },
  ])

  sent.length = 0
  act(() => { find(renderer, 'metrics-slice')[0]!.props.onChange({ target: { value: 'memoryFile' } }) })
  // A memory-file slice without a file asks for none until one is named.
  expect(metricsSent().at(-1)).toEqual({ type: 'process-metrics-open', teamPath: '/repo', window: '1d', slice: null })
  expect(find(renderer, 'metrics-slice-hint')).toHaveLength(1)

  sent.length = 0
  act(() => { find(renderer, 'metrics-refresh')[0]!.props.onClick() })
  expect(metricsSent()).toEqual([{ type: 'process-metrics-refresh', teamPath: '/repo', window: '1d', slice: null }])
  expect(textOf(find(renderer, 'metrics-computed-at')[0]!)).toBe('Loading…')
})

test('a row shows value, n, baseline delta, insufficient flag, guard, markers, and breakdown rows', () => {
  const renderer = mountPage({ teamKey: '/repo', tab: 'metrics', window: '7d' })
  push(snapshot('7d', {
    lead_time_p50: { ...stat(12, 4), baseline: stat(8, 11), approximate: true },
    accepted_result_share: { ...stat(0.5, 4), baseline: stat(null, 0) },
    tokens_per_task: { ...stat(1000, 12), baseline: stat(null, 0), partial: true, notSliceable: false },
    mail_share: {
      ...stat(null, 20), baseline: stat(null, 0), notSliceable: true,
      breakdown: [{ key: 'lead', ...stat(0.5, 20), baseline: stat(null, 0) }],
    },
  }))
  const lead = row(renderer, 'lead_time_p50')
  expect(textOf(find(lead, 'metric-value')[0]!)).toBe('12 h')
  expect(textOf(find(lead, 'metric-n')[0]!)).toBe('n=4')
  expect(textOf(find(lead, 'metric-baseline')[0]!)).toBe('+4 h vs baseline (worse)')
  expect(textOf(find(lead, 'metric-markers')[0]!)).toBe('insufficient sample (n=4 < 10) · approximate (backfilled done times)')
  expect(textOf(find(lead, 'metric-guard')[0]!)).toBe('Guard: Done tasks with an accepted result 50% (n=4)')
  expect(textOf(find(row(renderer, 'tokens_per_task'), 'metric-markers')[0]!)).toBe('partial (history predates usage records)')
  const share = row(renderer, 'mail_share')
  expect(textOf(find(share, 'metric-markers')[0]!)).toBe('not sliceable by this slice')
  expect(find(share, 'metric-breakdown-row').map(node => node.props['data-key'])).toEqual(['lead'])
  expect(textOf(find(row(renderer, 'accepted_result_share'), 'metric-baseline')[0]!)).toBe('no baseline')
  const caveats = find(renderer, 'metric-caveat').map(textOf)
  expect(caveats).toContain(USAGE_CAVEAT)
  expect(caveats).toContain(COVERAGE_CAVEAT)
})

test('families collapse per team; drill-down opens tasks and message threads', () => {
  const renderer = mountPage({ teamKey: '/repo', tab: 'metrics', window: '3d' })
  push(snapshot('3d', {
    friction_total: {
      ...stat(1, 1), drill: { tasks: [{ id: 't-1', title: 'Fix login' }], messages: [{ id: 'msg-12345678', threadId: 'thr-abcdefgh' }] },
    },
  }))
  const friction = () => row(renderer, 'friction_total')
  act(() => { find(friction(), 'metric-drill-toggle')[0]!.props.onClick() })
  expect(textOf(find(friction(), 'metric-drill-task')[0]!)).toBe('Task Fix login')
  act(() => { find(friction(), 'metric-drill-message')[0]!.props.onClick() })
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'messages', id: 'thr-abcdefgh' })

  useTeamLocationStore.setState({ location: { teamKey: '/repo', tab: 'metrics', window: '3d' } })
  const overhead = () => renderer.root.find(node => node.props['data-family'] === 'overhead' && typeof node.type === 'string')
  act(() => { find(overhead(), 'metric-drill-task')[0]!.props.onClick() })
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'tasks', id: 't-1' })

  useTeamLocationStore.setState({ location: { teamKey: '/repo', tab: 'metrics', window: '3d' } })
  act(() => { find(overhead(), 'metric-family-toggle')[0]!.props.onClick() })
  expect(find(overhead(), 'metric-row')).toHaveLength(0)
  expect(useTeamWorkspaceStore.getState().views['/repo']!.tabs.metrics.collapsedSections).toEqual(['overhead'])
})

test('disconnected: every control is disabled and nothing is sent', () => {
  const renderer = mountPage({ teamKey: '/repo', tab: 'metrics', window: '7d' }, false)
  expect(metricsSent()).toEqual([])
  for (const id of ['metrics-window-1d', 'metrics-window-3d', 'metrics-window-7d', 'metrics-slice', 'metrics-refresh']) {
    expect(find(renderer, id)[0]!.props.disabled).toBe(true)
  }
  expect(textOf(find(renderer, 'metrics-empty')[0]!)).toBe('Disconnected — reconnect to load metrics.')
})
