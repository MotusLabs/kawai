// An attention item's advice link (process-quota-history-and-incident-advice
// D6, contract r2 A5): an item that carries advice shows "View advice" beside
// its own next action — the same item, never a second one — and the default
// handler names the recommendation for the Metrics view and moves the page
// to the current team's Metrics tab. An item without advice shows no link.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AttentionItem } from '@shared/teamWorkspace'
import TeamAttentionQueue, { openAdviceInMetrics } from '../components/team/TeamAttentionQueue'
import { useMetricsStore } from '../stores/metricsStore'
import { teamHashOf } from '../utils/teamLocation'

const item = (id: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id, kind: id.split(':')[0]!, cause: `cause of ${id}`, owner: { kind: 'group', id: 'lead', label: 'lead' },
  impact: { taskId: 't-1', taskTitle: 'Export' }, nextAction: 'Unblock the holder', link: { kind: 'plan', id: 'plan-1', planId: 'plan-1' },
  requiresHuman: false, ...extra,
})

const priorWindow = (globalThis as { window?: unknown }).window
afterEach(() => {
  useMetricsStore.setState({ revealedAdvice: {} })
  ;(globalThis as { window?: unknown }).window = priorWindow
})

test('an item with advice shows View advice, which opens that recommendation; an item without advice shows none', () => {
  const opened: string[] = []
  const actions: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={entry => actions.push(entry.id)} onOpenAdvice={id => opened.push(id)}
      items={[item('plan-stall:e:api:k', { advice: { recommendationId: 'rec-9' } }), item('context-exhausted:s:t')]} />)
  })
  const advice = renderer.root.findAll(node => node.props['data-testid'] === 'attention-advice' && typeof node.type === 'string')
  expect(advice).toHaveLength(1)
  expect(renderer.root.findAll(node => node.props['data-testid'] === 'attention-item' && typeof node.type === 'string')).toHaveLength(2)
  act(() => advice[0]!.props.onClick())
  expect(opened).toEqual(['rec-9'])
  expect(actions).toEqual([])
  act(() => renderer.unmount())
})

test('the default handler names the recommendation for the team\'s Metrics view and moves to its Metrics tab', () => {
  const location = { hash: teamHashOf({ teamKey: '/repo', tab: 'tasks' }) }
  ;(globalThis as { window?: unknown }).window = { location }
  openAdviceInMetrics('rec-9')
  expect(useMetricsStore.getState().revealedAdvice).toEqual({ '/repo': 'rec-9' })
  expect(location.hash).toBe(teamHashOf({ teamKey: '/repo', tab: 'metrics' }))
  // Off a team page nothing is named or moved.
  const away = { hash: '#/chat/1' }
  ;(globalThis as { window?: unknown }).window = { location: away }
  useMetricsStore.setState({ revealedAdvice: {} })
  openAdviceInMetrics('rec-9')
  expect(useMetricsStore.getState().revealedAdvice).toEqual({})
  expect(away.hash).toBe('#/chat/1')
})
