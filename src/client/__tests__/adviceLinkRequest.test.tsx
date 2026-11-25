// An advice link whose target is older than the snapshot's newest
// recommendations (process-quota-history-and-incident-advice D6, contract r2
// A5): the link pins the target for the team, the Metrics view asks for it
// with every open and refresh (`advice`), and once the snapshot carries it the
// view opens its detail. Without a link nothing extra is asked.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage, Session } from '@shared/types'
import { METRIC_DEFS, COVERAGE_CAVEAT, USAGE_CAVEAT, unknownToolMeasurement, type ProcessMetrics } from '@shared/processMetrics'
import type { ProcessRecommendationDetail } from '@shared/processRecommendations'
import TeamWorkspaceView from '../components/team/TeamWorkspaceView'
import { handleMetricsMessage } from '../protocol/metricsMessages'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
import { useMetricsStore } from '../stores/metricsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'

const sent: ClientMessage[] = []
const sendMessage: SendClientMessage = message => { sent.push(message) }
const active: TestRenderer.ReactTestRenderer[] = []

const metrics: ProcessMetrics = {
  toolMeasurement: unknownToolMeasurement(), teamId: '/repo/.git', window: '7d', slice: null,
  periodStart: '2026-10-09T12:00:00.000Z', periodEnd: '2026-10-16T12:00:00.000Z', baselineStart: '2026-10-02T12:00:00.000Z',
  computedAt: '2026-10-16T12:00:00.000Z', minSample: 10,
  metrics: METRIC_DEFS.map(def => ({
    id: def.id, value: null, n: 0, insufficient: true, baseline: { value: null, n: 0, insufficient: true },
    approximate: false, partial: false, drill: { tasks: [], messages: [] },
  })),
  usageCaveat: USAGE_CAVEAT, coverageCaveat: COVERAGE_CAVEAT,
}

const rec = (id: string): ProcessRecommendationDetail => ({
  id, teamId: '/repo/.git', kind: 'quota', episodeKey: `quota:zai:${id}`, sessionId: 'chat-1', taskId: null, groupId: 'devs',
  profileId: 'glm', providerId: 'zai', attentionId: null, cutoff: '2026-06-01T12:00:00.000Z', snapshotBasis: 'incident',
  createdAt: '2026-06-01T12:00:00.000Z', current: null, versions: 0, assessments: [],
})

const push = (recommendations: ProcessRecommendationDetail[]) => act(() => {
  handleMetricsMessage({
    type: 'process-metrics-snapshot', teamPath: '/repo', teamId: metrics.teamId, window: '7d', slice: null,
    computedAt: metrics.computedAt, metrics, reports: [], freshness: [], unproposed: [], recommendations,
  })
})

const mount = () => {
  const location = { teamKey: '/repo', tab: 'metrics' as const, window: '7d' }
  useTeamLocationStore.setState({ location })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamWorkspaceView teamKey="/repo" location={location} sendMessage={sendMessage} connected connectionEpoch={0} />)
  })
  active.push(renderer)
  return renderer
}

const find = (renderer: TestRenderer.ReactTestRenderer, testId: string) =>
  renderer.root.findAll(node => node.props['data-testid'] === testId && typeof node.type === 'string')
const metricsSent = () => sent.filter(message => message.type.startsWith('process-metrics-'))

beforeEach(() => {
  sent.length = 0
  useSessionStore.setState({ sessions: [{ id: 'chat-1', name: 'lead', projectPath: '/repo', kind: 'chat', source: 'managed' } as unknown as Session], hasLoaded: true })
  useTeamWorkspaceStore.setState({ views: {} })
  useMetricsStore.setState({ views: {}, revealedAdvice: {}, pinnedAdvice: {} })
  resetTeamLocationForTests()
})

afterEach(() => {
  for (const renderer of active.splice(0)) act(() => { renderer.unmount() })
  useTeamWorkspaceStore.setState({ views: {} })
  useMetricsStore.setState({ views: {}, revealedAdvice: {}, pinnedAdvice: {} })
  useSessionStore.setState({ sessions: [], hasLoaded: false })
  resetTeamLocationForTests()
})

test('a linked target outside the newest list is requested with the open and the refresh, then opened once the snapshot carries it', () => {
  useMetricsStore.getState().revealAdvice('/repo', 'rec-old')
  const renderer = mount()
  expect(metricsSent()).toEqual([{ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: null, advice: 'rec-old' }])
  const newest = Array.from({ length: 20 }, (_, index) => rec(`rec-${index}`))
  // A snapshot without the target opens nothing, and the one-shot reveal waits.
  push(newest)
  expect(find(renderer, 'advice-detail')).toHaveLength(0)
  expect(useMetricsStore.getState().revealedAdvice).toEqual({ '/repo': 'rec-old' })
  push([...newest, rec('rec-old')])
  expect(find(renderer, 'advice-detail')).toHaveLength(1)
  expect(find(renderer, 'advice-row').find(row => row.props['data-recommendation'] === 'rec-old')!.findByType('button').props['aria-expanded']).toBe(true)
  // The reveal is spent, but the subscription keeps asking for the target: no resubscribe, and refresh still names it.
  expect(useMetricsStore.getState().revealedAdvice).toEqual({})
  expect(metricsSent()).toHaveLength(1)
  act(() => { find(renderer, 'metrics-refresh')[0]!.props.onClick() })
  expect(metricsSent().at(-1)).toEqual({ type: 'process-metrics-refresh', teamPath: '/repo', window: '7d', slice: null, advice: 'rec-old' })
})

test('without an advice link the open asks for nothing extra', () => {
  mount()
  expect(metricsSent()).toEqual([{ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: null }])
})
