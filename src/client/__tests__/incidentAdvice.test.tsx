// The Metrics tab's incident advice (process-quota-history-and-incident-
// advice 4.6): a fixture quota incident from the snapshot shows in the list
// with its current advice; opening it shows the alternatives frozen at the
// cutoff with exclusions and window freshness, the provisional and
// small-sample flags, unknown savings, facts/assumptions/unknowns, every
// version, and an expired evidence link — all from the snapshot, with no
// Prometheus. The store keeps the snapshot's recommendations.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ProcessAssessment, ProcessRecommendationDetail } from '@shared/processRecommendations'
import IncidentAdvice from '../components/team/metrics/IncidentAdvice'
import { closedMetricsView, useMetricsStore } from '../stores/metricsStore'

const active: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of active.splice(0)) act(() => renderer.unmount())
  useMetricsStore.setState({ views: {} })
})

const assessment = (version: number, extra: Partial<ProcessAssessment['advice']> = {}): ProcessAssessment => ({
  id: `asm-${version}`, recommendationId: 'rec-1', version, evaluatorVersion: 'incident-advice-1', evidenceHash: `h${version}`,
  state: version === 1 ? 'new' : 'strengthened', cutoff: '2026-06-01T12:00:00.000Z', createdAt: '2026-06-01T12:00:01.000Z',
  advice: {
    choice: 'switch', provisional: true, summary: 'Provisional: kimi showed fresh capacity.',
    facts: ['glm on zai hit a final limit (five_hour).'], assumptions: ['Only 0 earlier comparisons observed: the comparative metric stays insufficient.'],
    unknowns: ['Handoff, context rebuilding, execution and rework costs are unknown, so no saving is estimated.'],
    alternatives: [
      { profileId: 'kimi', providerId: 'moon', listed: true, exclusion: null, headroom: 'known', headroomReason: 'fresh', observationId: 'quota-1',
        windows: [{ key: 'zai:time_limit', percentUsed: 40, resetsAt: null, ageMs: 120_000 }] },
      { profileId: 'glm-flash', providerId: 'zai', listed: false, exclusion: { kind: 'shared-window', detail: 'same provider zai' },
        headroom: 'unknown', headroomReason: 'none', observationId: null, windows: [] },
    ],
    comparison: { wait: { until: '2026-06-01T13:00:00.000Z', basis: 'reset' },
      switchCosts: { handoff: 'unknown', contextRebuild: 'unknown', execution: 'unknown', rework: 'unknown' }, savingsMs: null },
    sample: { comparisons: 0, threshold: 10, small: true },
    ...extra,
  },
  evidence: [{ ordinal: 0, kind: 'observation', observationId: 'quota-1', expired: true, providerId: 'moon', accountAlias: 'moon@moon.test',
    outcome: 'supported', at: '2026-06-01T11:58:00.000Z', windows: [{ key: 'zai:time_limit', percentUsed: 40, resetsAt: null }] }],
})

const incident: ProcessRecommendationDetail = {
  id: 'rec-1', teamId: '/repo/.git', kind: 'quota', episodeKey: 'quota:zai:ev-1', sessionId: 'chat-1', taskId: null, groupId: 'devs',
  profileId: 'glm', providerId: 'zai', attentionId: 'plan-stall:exec-1:chg:ep-3', cutoff: '2026-06-01T12:00:00.000Z', snapshotBasis: 'incident',
  createdAt: '2026-06-01T12:00:00.000Z', current: assessment(2), versions: 2, assessments: [assessment(1, { choice: 'no-alternative' }), assessment(2)],
}

const text = (renderer: TestRenderer.ReactTestRenderer, testId: string) =>
  renderer.root.findAll(node => node.props['data-testid'] === testId && typeof node.type === 'string')

function flatten(node: TestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(flatten).join('')
}

test('a fixture quota incident lists its advice and opens alternatives, freshness, constraints and uncertainty', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<IncidentAdvice recommendations={[incident]} />) })
  active.push(renderer)
  const row = text(renderer, 'advice-row')
  expect(row).toHaveLength(1)
  expect(flatten(row[0]!)).toContain('Quota limit · glm on zai')
  expect(flatten(row[0]!)).toContain('Switch to an alternative · 2 versions')
  expect(text(renderer, 'advice-detail')).toHaveLength(0)
  act(() => row[0]!.findByType('button').props.onClick())
  const detail = flatten(text(renderer, 'advice-detail')[0]!)
  expect(detail).toContain('Attached to plan-stall:exec-1:chg:ep-3')
  expect(text(renderer, 'advice-assessment').map(node => node.props['data-version'])).toEqual([2, 1])
  expect(flatten(text(renderer, 'advice-headroom')[0]!)).toBe('fresh capacity')
  expect(flatten(text(renderer, 'advice-freshness')[0]!)).toContain('zai:time_limit 40% · 2 min old')
  expect(flatten(text(renderer, 'advice-exclusion')[0]!)).toBe('excluded — shares the limited account (same provider zai)')
  expect(text(renderer, 'advice-provisional').length).toBe(2)
  expect(flatten(text(renderer, 'advice-small-sample')[0]!)).toContain('small sample (0 of 10)')
  expect(detail).toContain('saving unknown')
  expect(flatten(text(renderer, 'advice-unknowns')[0]!)).toContain('no saving is estimated')
  expect(text(renderer, 'advice-evidence-expired').length).toBe(2)
  // Nothing here acts on the advice: the only buttons open and close rows.
  expect(renderer.root.findAllByType('button').map(button => flatten(button))).toEqual([flatten(row[0]!.findByType('button'))])
})

test('no incidents reads as such', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<IncidentAdvice recommendations={[]} />) })
  active.push(renderer)
  expect(flatten(text(renderer, 'incident-advice')[0]!)).toContain('No quota or context incidents.')
})

test('the store keeps the snapshot\'s recommendations for the requested view', () => {
  const store = useMetricsStore.getState()
  store.request('/repo', { window: '7d', slice: null })
  store.applySnapshot({
    type: 'process-metrics-snapshot', teamPath: '/repo', teamId: '/repo/.git', window: '7d', slice: null, computedAt: '2026-06-01T12:00:02.000Z',
    metrics: {} as never, reports: [], freshness: [], unproposed: [], recommendations: [incident],
  })
  expect(useMetricsStore.getState().views['/repo']!.recommendations).toEqual([incident])
  expect(closedMetricsView().recommendations).toEqual([])
})

test('an attention item\'s advice link opens that recommendation once it is listed, and the one-shot target is spent', () => {
  const revealed: number[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<IncidentAdvice recommendations={[]} reveal="rec-1" onRevealed={() => revealed.push(1)} />) })
  active.push(renderer)
  // Not listed yet: nothing opens and the target waits.
  expect(text(renderer, 'advice-detail')).toHaveLength(0)
  expect(revealed).toEqual([])
  act(() => renderer.update(<IncidentAdvice recommendations={[incident]} reveal="rec-1" onRevealed={() => revealed.push(1)} />))
  expect(text(renderer, 'advice-detail')).toHaveLength(1)
  expect(revealed).toEqual([1])
  // The store's one-shot target clears per team.
  useMetricsStore.getState().revealAdvice('/repo', 'rec-1')
  expect(useMetricsStore.getState().revealedAdvice).toEqual({ '/repo': 'rec-1' })
  useMetricsStore.getState().clearRevealedAdvice('/repo')
  expect(useMetricsStore.getState().revealedAdvice).toEqual({})
})
