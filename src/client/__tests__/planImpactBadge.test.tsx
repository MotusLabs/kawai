// strategy-revision-impact 6.3: the Plans view's impact badge — each gate's
// label, nothing for historical plans, the Open review link naming the
// review's strategy revision (the host opens the Strategy tab's impact
// sub-view on it), and a refused approval showing the same state as the
// badge beside its failing precondition.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { ImpactGate, PlanImpact } from '@shared/strategyImpact'
import { IMPACT_GATE_LABELS } from '@shared/strategyImpact'
import PlanImpactBadge from '../components/team/PlanImpactBadge'
import TeamPlansView from '../components/team/TeamPlansView'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { planDetail, planSummary } from './planViewFixtures'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  renderers.splice(0).forEach(renderer => act(() => renderer.unmount()))
  useTeamPlanStore.setState({ views: {} })
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const gate = (state: ImpactGate['state']): ImpactGate => ({ state, pass: state === 'current' || state === 'continue', reviewId: 'impact-2', decisionId: null, pin: null })
const impact = (state: ImpactGate['state'], group: PlanImpact['group'] = 'affected'): PlanImpact =>
  ({ group, gate: gate(state), reviewId: 'impact-2', reviewRevision: 2, revisions: [{ revision: 1, gate: gate(state) }] })
const render = (element: React.ReactElement) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element) })
  renderers.push(renderer)
  return renderer
}
const byTest = (renderer: TestRenderer.ReactTestRenderer, testId: string) =>
  renderer.root.findAll(node => node.props['data-testid'] === testId && typeof node.type === 'string')

describe('PlanImpactBadge', () => {
  test('each gate state has its label; only a non-current gate links to the review', () => {
    for (const state of Object.keys(IMPACT_GATE_LABELS) as ImpactGate['state'][]) {
      const opened: number[] = []
      const renderer = render(<PlanImpactBadge impact={impact(state)} onOpenReview={revision => opened.push(revision)} />)
      expect(textOf(byTest(renderer, 'plan-impact-state')[0]!)).toBe(`Strategy impact: ${IMPACT_GATE_LABELS[state]}`)
      expect(byTest(renderer, 'plan-impact-state')[0]!.props['data-state']).toBe(state)
      const links = byTest(renderer, 'plan-impact-open-review')
      expect(links).toHaveLength(state === 'current' ? 0 : 1)
      if (links[0]) {
        expect(links[0].props['aria-label']).toBe('Open review: impact review of strategy revision 2')
        act(() => links[0]!.props.onClick())
        expect(opened).toEqual([2])
      }
    }
  })

  test('historical plans and plans without a gate show nothing', () => {
    expect(render(<PlanImpactBadge impact={impact('withdrawn-direction', 'historical')} />).toJSON()).toBeNull()
    expect(render(<PlanImpactBadge impact={{ ...impact('current'), gate: null }} />).toJSON()).toBeNull()
    expect(render(<PlanImpactBadge impact={undefined} />).toJSON()).toBeNull()
  })
})

describe('the Plans view with impact', () => {
  const mountView = () => {
    const opened: number[] = []
    const sent: ClientMessage[] = []
    useTeamPlanStore.getState().open('/repo')
    const element = () => <TeamPlansView teamPath="/repo" view={useTeamPlanStore.getState().views['/repo']!} sendMessage={message => { sent.push(message) }}
      connected connectionEpoch={0} sessions={[]} onOpenImpactReview={revision => opened.push(revision)} />
    const renderer = render(element())
    const refresh = () => act(() => renderer.update(element()))
    return { renderer, refresh, opened, sent }
  }

  test('list rows carry the badge, and an affected plan links to its review', () => {
    const { renderer, refresh, opened } = mountView()
    act(() => useTeamPlanStore.getState().applySnapshot({
      type: 'team-plans-snapshot', teamPath: '/repo', teamId: 'team',
      plans: [planSummary('p1'), planSummary('p2')], impact: { p1: impact('decision-required'), p2: impact('current', 'unaffected') },
    }))
    refresh()
    const states = byTest(renderer, 'plan-impact-state').map(node => node.props['data-state'])
    expect(states).toEqual(['decision-required', 'current'])
    const links = byTest(renderer, 'plan-impact-open-review')
    expect(links).toHaveLength(1)
    act(() => links[0]!.props.onClick())
    expect(opened).toEqual([2])
  })

  test("a refused approval shows the same impact state as the plan's badge, with the link", () => {
    const { renderer, refresh, opened } = mountView()
    const plan = planSummary('p1')
    act(() => {
      useTeamPlanStore.getState().select('/repo', 'p1')
      useTeamPlanStore.getState().applySnapshot({ type: 'team-plans-snapshot', teamPath: '/repo', teamId: 'team', plans: [plan], impact: { p1: impact('adapt') } })
      useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 'team', detail: planDetail(plan), impact: impact('adapt') })
      useTeamPlanStore.getState().begin('/repo', 'req-1', 'approve')
      useTeamPlanStore.getState().applyResult({
        type: 'team-plan-result', teamPath: '/repo', requestId: 'req-1', error: 'Approval refused',
        failures: [{ name: 'strategy-pin-current', message: 'The pin is not the current strategy revision' }], impact: gate('adapt'),
      })
    })
    refresh()
    const badge = byTest(renderer, 'plan-impact-badge')[0]!
    const refusal = byTest(renderer, 'plan-refusal-impact')[0]!
    const stateOf = (node: TestRenderer.ReactTestInstance) => node.findAll(child => child.props['data-testid'] === 'plan-impact-state' && typeof child.type === 'string')[0]!
    expect(stateOf(refusal).props['data-state']).toBe(stateOf(badge).props['data-state'])
    expect(textOf(stateOf(refusal))).toBe('Strategy impact: Adapt')
    act(() => refusal.findAll(child => child.props['data-testid'] === 'plan-impact-open-review' && typeof child.type === 'string')[0]!.props.onClick())
    expect(opened).toEqual([2])
  })
})
