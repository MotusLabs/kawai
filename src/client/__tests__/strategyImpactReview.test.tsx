// strategy-revision-impact 6.2: the Strategy tab's impact sub-view — each
// review state, the three groups with pins, gates, and the unassessed mark,
// the decision history, the Decide dialog requiring a rationale, Use proposal
// (a disposition change drops the proposal, a rationale edit keeps it), Ask to
// assess preselecting `lead`, controls disabled while disconnected, refusals
// inline in their dialog, and keyboard focus and labels.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage } from '@shared/types'
import type { ImpactDecision, ImpactGate, ImpactPlanRow, ImpactReviewRecord, StrategyImpactDetail } from '@shared/strategyImpact'
import StrategyImpactReview from '../components/team/StrategyImpactReview'
import { useStrategyStore } from '../stores/strategyStore'

const originalFetch = globalThis.fetch
const renderers: TestRenderer.ReactTestRenderer[] = []
beforeEach(() => {
  useStrategyStore.getState().open('dev')
  globalThis.fetch = (async () => new Response(JSON.stringify({
    groups: [{ id: 'devs', label: 'Devs', description: '' }, { id: 'lead', label: 'Lead', description: '' }],
  }))) as unknown as typeof fetch
})
afterEach(() => {
  renderers.splice(0).forEach(renderer => act(() => renderer.unmount()))
  useStrategyStore.setState({ views: {} })
  globalThis.fetch = originalFetch
})

const pin = (revision: number) => ({ strategyId: 'strategy-1', revision, hash: `hash-${revision}` })
const gate = (state: ImpactGate['state'], decisionId: string | null = null): ImpactGate =>
  ({ state, pass: state === 'current' || state === 'continue', reviewId: 'impact-3', decisionId, pin: null })
const decision = (id: string, disposition: ImpactDecision['disposition'], rationale: string): ImpactDecision => ({
  id, reviewId: 'impact-3', planId: 'plan-a', disposition, rationale, proposalId: null, supersedesDecisionId: null,
  planSnapshot: [], actor: { kind: 'human', sessionId: null }, commandId: `c-${id}`, createdAt: '2026-10-15T01:00:00.000Z',
})
const row = (planId: string, extra: Partial<ImpactPlanRow> = {}): ImpactPlanRow => ({
  planId, title: `Plan ${planId}`, lifecycle: 'open',
  revisions: [{ revision: 1, status: 'approved', pin: pin(1), gate: gate('decision-required'), unassessed: false }],
  effectiveDecision: null, decisionHistory: [], latestProposal: null, proposalCount: 0, ...extra,
})
const review = (revision: number, state: ImpactReviewRecord['state'], extra: Partial<ImpactReviewRecord> = {}): ImpactReviewRecord => ({
  reviewId: `impact-${revision}`, revision, contentHash: `0123456789abcdef-${revision}`, createdAt: '2026-10-15T00:00:00.000Z',
  state, decisions: [], proposals: [], requests: [], ...extra,
})

const adapted = decision('d1', 'adapt', 'Narrow the users')
const continued = { ...decision('d2', 'continue', 'Fits after all'), supersedesDecisionId: 'd1' }
const impact = (): StrategyImpactDetail => ({
  currentReviewId: 'impact-3',
  reviews: [
    review(3, 'needs-decisions'), review(2, 'superseded', { decisions: [{ ...adapted, reviewId: 'impact-2' }] }),
    review(1, 'withdrawn'),
  ],
  assessment: {
    affected: [
      row('plan-a', { effectiveDecision: continued, decisionHistory: [adapted, continued], revisions: [{ revision: 1, status: 'approved', pin: pin(1), gate: gate('continue', 'd2'), unassessed: false }] }),
      row('plan-b', {
        revisions: [{ revision: 1, status: 'in_review', pin: null, gate: gate('decision-required'), unassessed: true }],
        latestProposal: { id: 'p1', reviewId: 'impact-3', planId: 'plan-b', disposition: 'reconsider', rationale: 'Off direction', author: { kind: 'agent', sessionId: 'chat-lead' }, createdAt: '' },
        proposalCount: 2,
      }),
    ],
    unaffected: [row('plan-c', { revisions: [{ revision: 2, status: 'approved', pin: pin(3), gate: gate('current'), unassessed: false }] })],
    historical: [],
  },
})

const sent: ClientMessage[] = []
const sendMessage: SendClientMessage = message => { sent.push(message) }
const focused: string[] = []
function mount({ connected = true, revision, detail = impact() }: { connected?: boolean; revision?: string; detail?: StrategyImpactDetail } = {}) {
  sent.length = 0
  focused.length = 0
  const selected: number[] = []
  const element = () => <StrategyImpactReview teamPath="dev" view={useStrategyStore.getState().views.dev!} impact={detail} strategyId="strategy-1"
    connected={connected} sessions={[]} sendMessage={sendMessage} {...(revision ? { revision } : {})} onSelectRevision={next => selected.push(next)} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(element(), {
      createNodeMock: node => ({ focus: () => focused.push(String(node.props['data-testid'] ?? node.type)) }),
    })
  })
  renderers.push(renderer)
  const refresh = () => act(() => renderer.update(element()))
  return { renderer, refresh, selected }
}
const find = (renderer: TestRenderer.ReactTestRenderer, testId: string) =>
  renderer.root.findAll(node => node.props['data-testid'] === testId && typeof node.type === 'string')
const one = (renderer: TestRenderer.ReactTestRenderer, testId: string) => find(renderer, testId)[0]!
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

describe('StrategyImpactReview', () => {
  test('every review lists with its state; the current one shows its groups with pins, gates, and the unassessed mark', () => {
    const { renderer, selected } = mount()
    expect(['3', '2', '1'].map(revision => textOf(one(renderer, `impact-review-tab-${revision}`))))
      .toEqual(['Revision 3 · Needs decisions', 'Revision 2 · Superseded', 'Revision 1 · Withdrawn'])
    expect(one(renderer, 'impact-review-tab-3').props['aria-current']).toBe('true')
    expect(textOf(one(renderer, 'impact-review-state'))).toContain('Needs decisions')
    expect(textOf(one(renderer, 'impact-revision-plan-a-1'))).toContain('Strategy revision 1')
    expect(textOf(one(renderer, 'impact-revision-plan-a-1'))).toContain('Continues on its pin')
    expect(textOf(one(renderer, 'impact-revision-plan-b-1'))).toContain('No strategy pin')
    expect(find(renderer, 'impact-unassessed')).toHaveLength(1)
    expect(textOf(one(renderer, 'impact-group-unaffected'))).toContain('Current')
    expect(textOf(one(renderer, 'impact-group-historical'))).toContain('None.')
    act(() => one(renderer, 'impact-review-tab-2').props.onClick())
    expect(selected).toEqual([2])
  })

  test('an earlier review shows only its records; the reviewed state labels', () => {
    const { renderer } = mount({ revision: '2' })
    expect(find(renderer, 'impact-group-affected')).toEqual([])
    expect(textOf(one(renderer, 'impact-record-decision'))).toContain('Adapt — Narrow the users')
    const reviewed = impact()
    reviewed.reviews[0] = review(3, 'reviewed')
    const again = mount({ detail: reviewed })
    expect(textOf(one(again.renderer, 'impact-review-state'))).toContain('Reviewed')
  })

  test('the effective decision with its history, and the newest proposal with the count', () => {
    const { renderer } = mount()
    const planA = one(renderer, 'impact-row-plan-a')
    expect(textOf(planA)).toContain('Decision: Continue — Fits after all')
    act(() => planA.findAll(node => node.props['data-testid'] === 'impact-history-toggle' && node.type === 'button')[0]!.props.onClick())
    expect(textOf(one(renderer, 'impact-decision-history'))).toMatch(/Adapt — Narrow the users.*Continue — Fits after all/)
    expect(textOf(one(renderer, 'impact-row-plan-b'))).toContain('Reconsider by chat-lead — Off direction (2 in total)')
  })

  test('Decide requires a disposition and a rationale, then sends one keyed command with the expected predecessor', () => {
    const { renderer, refresh } = mount()
    act(() => one(renderer, 'impact-decide-open-plan-a').props.onClick())
    refresh()
    const dialog = one(renderer, 'impact-decide-dialog')
    expect(dialog.props.role).toBe('dialog')
    expect(textOf(renderer.root.findAll(node => node.props.id === dialog.props['aria-labelledby'])[0]!)).toBe('Decide: Plan plan-a')
    expect(focused).toContain('impact-disposition-continue')
    act(() => one(renderer, 'impact-decide-confirm').props.onClick())
    expect(sent).toEqual([])
    expect(textOf(one(renderer, 'impact-rationale-error'))).toContain('A rationale is required')
    act(() => one(renderer, 'impact-disposition-adapt').props.onChange())
    act(() => one(renderer, 'impact-rationale').props.onChange({ target: { value: 'Users narrowed in revision 3' } }))
    act(() => one(renderer, 'impact-decide-confirm').props.onClick())
    expect(sent).toHaveLength(1)
    const message = sent[0] as Extract<ClientMessage, { type: 'strategy-impact-decide' }>
    expect(message).toMatchObject({ type: 'strategy-impact-decide', teamPath: 'dev', reviewId: 'impact-3', planId: 'plan-a', disposition: 'adapt', rationale: 'Users narrowed in revision 3', expectedDecisionId: 'd2' })
    expect(message.proposalId).toBeUndefined()
    expect(message.commandId).toBe(useStrategyStore.getState().views.dev!.impactCommands['decide:impact-3:plan-a']!.commandId)
  })

  test('the dialog states and pins the decision it opened over, even when a newer one arrives meanwhile', () => {
    const detail = impact()
    const { renderer, refresh } = mount({ detail })
    act(() => one(renderer, 'impact-decide-open-plan-a').props.onClick())
    refresh()
    expect(textOf(one(renderer, 'impact-decide-replaces'))).toContain('Replaces the effective decision: Continue — Fits after all')
    const newer = { ...decision('d3', 'reconsider', 'Another tab'), supersedesDecisionId: 'd2' }
    detail.assessment!.affected[0] = { ...detail.assessment!.affected[0]!, effectiveDecision: newer, decisionHistory: [adapted, continued, newer] }
    refresh()
    act(() => one(renderer, 'impact-disposition-adapt').props.onChange())
    act(() => one(renderer, 'impact-rationale').props.onChange({ target: { value: 'Why' } }))
    act(() => one(renderer, 'impact-decide-confirm').props.onClick())
    expect(sent.at(-1)).toMatchObject({ expectedDecisionId: 'd2' })
    const fresh = mount()
    act(() => one(fresh.renderer, 'impact-decide-open-plan-b').props.onClick())
    fresh.refresh()
    expect(textOf(one(fresh.renderer, 'impact-decide-replaces'))).toBe('No decision recorded yet.')
  })

  test('Use proposal pre-fills; a disposition change drops the proposal, a rationale edit keeps it', () => {
    const { renderer, refresh } = mount()
    act(() => one(renderer, 'impact-decide-open-plan-b').props.onClick())
    refresh()
    act(() => one(renderer, 'impact-use-proposal').props.onClick())
    expect(one(renderer, 'impact-disposition-reconsider').props.checked).toBe(true)
    expect(one(renderer, 'impact-rationale').props.value).toBe('Off direction')
    act(() => one(renderer, 'impact-rationale').props.onChange({ target: { value: 'Off direction, edited' } }))
    expect(find(renderer, 'impact-proposal-used')).toHaveLength(1)
    act(() => one(renderer, 'impact-decide-confirm').props.onClick())
    expect(sent.at(-1)).toMatchObject({ disposition: 'reconsider', rationale: 'Off direction, edited', proposalId: 'p1' })
    act(() => one(renderer, 'impact-disposition-continue').props.onChange())
    expect(find(renderer, 'impact-proposal-used')).toEqual([])
    act(() => one(renderer, 'impact-decide-confirm').props.onClick())
    const last = sent.at(-1) as Extract<ClientMessage, { type: 'strategy-impact-decide' }>
    expect([last.disposition, last.proposalId]).toEqual(['continue', undefined])
  })

  test('a refusal shows inline in its dialog; success closes it', () => {
    const { renderer, refresh } = mount()
    act(() => one(renderer, 'impact-decide-open-plan-a').props.onClick())
    refresh()
    act(() => one(renderer, 'impact-disposition-adapt').props.onChange())
    act(() => one(renderer, 'impact-rationale').props.onChange({ target: { value: 'Why' } }))
    act(() => one(renderer, 'impact-decide-confirm').props.onClick())
    const requestId = (sent.at(-1) as { requestId: string }).requestId
    act(() => useStrategyStore.getState().applyResult({ type: 'strategy-result', teamPath: 'dev', requestId, error: 'Another decision was recorded meanwhile' }))
    refresh()
    expect(textOf(one(renderer, 'impact-decide-error'))).toContain('Another decision was recorded meanwhile')
    expect(one(renderer, 'impact-decide-error').props.role).toBe('alert')
    act(() => one(renderer, 'impact-decide-confirm').props.onClick())
    const retry = (sent.at(-1) as { requestId: string }).requestId
    act(() => useStrategyStore.getState().applyResult({ type: 'strategy-result', teamPath: 'dev', requestId: retry, decision: continued, replayed: false }))
    refresh()
    refresh()
    expect(find(renderer, 'impact-decide-dialog')).toEqual([])
  })

  test('Ask to assess preselects lead and sends the review and group', async () => {
    const { renderer, refresh } = mount()
    act(() => one(renderer, 'impact-ask-open').props.onClick())
    refresh()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    refresh()
    expect(focused).toContain('impact-ask-group')
    expect(one(renderer, 'impact-ask-group').props.value).toBe('lead')
    act(() => one(renderer, 'impact-ask-confirm').props.onClick())
    expect(sent.at(-1)).toMatchObject({ type: 'strategy-impact-request', teamPath: 'dev', reviewId: 'impact-3', group: 'lead' })
  })

  test('every control disables while disconnected', () => {
    const { renderer } = mount({ connected: false })
    expect(one(renderer, 'impact-ask-open').props.disabled).toBe(true)
    expect(one(renderer, 'impact-decide-open-plan-a').props.disabled).toBe(true)
    expect(one(renderer, 'impact-decide-open-plan-b').props.disabled).toBe(true)
  })

  test('no review yet says how one opens', () => {
    const { renderer } = mount({ detail: { currentReviewId: null, reviews: [], assessment: null } })
    expect(textOf(one(renderer, 'impact-none'))).toContain('approving a strategy revision opens one')
  })
})
