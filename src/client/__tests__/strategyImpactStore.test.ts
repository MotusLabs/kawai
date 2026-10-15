// strategy-revision-impact 6.1/6.3: the impact state in the client stores —
// the detail push applied beside the strategy detail, a (re)open dropping
// waiting requests so a lost result never leaves the view busy, one command
// id per dialog reused while the payload is unchanged and re-minted after a
// change, refusals kept for their dialog, success retiring the command, and
// the Plans store's badges, detail impact, and refusal gate.
import { afterEach, describe, expect, test } from 'bun:test'
import type { StrategyDetail } from '@shared/productStrategy'
import type { ImpactGate, PlanImpact, StrategyImpactDetail } from '@shared/strategyImpact'
import { useStrategyStore } from '../stores/strategyStore'
import { useTeamPlanStore } from '../stores/teamPlanStore'

afterEach(() => {
  useStrategyStore.setState({ views: {} })
  useTeamPlanStore.setState({ views: {} })
})

const impact = (extra: Partial<StrategyImpactDetail> = {}): StrategyImpactDetail => ({
  currentReviewId: 'impact-2', reviews: [], assessment: { affected: [], unaffected: [], historical: [] }, ...extra,
})
const strategyDetail = { strategy: { id: 'strategy-1' }, revisions: [], drafts: [], evidence: [], decisions: [], impactReviews: [] } as unknown as StrategyDetail
const gate = (state: ImpactGate['state']): ImpactGate => ({ state, pass: state === 'current' || state === 'continue', reviewId: 'impact-2', decisionId: null, pin: null })
const planImpact = (state: ImpactGate['state']): PlanImpact => ({ group: 'affected', gate: gate(state), reviewId: 'impact-2', reviewRevision: 2, revisions: [{ revision: 1, gate: gate(state) }] })

const store = () => useStrategyStore.getState()
const view = () => store().views.dev!

describe('strategyStore impact state', () => {
  test('the detail push carries the impact; a vanished record clears it', () => {
    store().open('dev')
    store().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: strategyDetail, impact: impact() })
    expect(view().impact?.currentReviewId).toBe('impact-2')
    store().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: strategyDetail })
    expect(view().impact).toBeNull()
    store().applyDetail({ type: 'strategy-detail', teamPath: 'dev', teamId: 'team', detail: strategyDetail, impact: impact() })
    store().applySnapshot({ type: 'strategy-snapshot', teamPath: 'dev', teamId: 'team', strategy: null })
    expect(view().impact).toBeNull()
  })

  test('a dialog reuses its command id while the payload is unchanged and re-mints after a change', () => {
    store().open('dev')
    store().armImpact('dev', 'decide:r:p')
    const armed = view().impactCommands['decide:r:p']!.commandId
    const first = store().impactCommand('dev', 'decide:r:p', '{"d":"continue"}', 'req-1')
    expect(first).toBe(armed)
    // A resend of the same payload after a lost result replays: same id.
    expect(store().impactCommand('dev', 'decide:r:p', '{"d":"continue"}', 'req-2')).toBe(armed)
    const changed = store().impactCommand('dev', 'decide:r:p', '{"d":"adapt"}', 'req-3')
    expect(changed).not.toBe(armed)
    expect(store().impactCommand('dev', 'decide:r:p', '{"d":"adapt"}', 'req-4')).toBe(changed)
    // Reopening the dialog arms a new command.
    store().armImpact('dev', 'decide:r:p')
    expect(view().impactCommands['decide:r:p']!.commandId).not.toBe(changed)
  })

  test('a refusal stays with its dialog; success retires the command and notes a sent request', () => {
    store().open('dev')
    store().armImpact('dev', 'request:r')
    store().impactCommand('dev', 'request:r', '{"g":"lead"}', 'req-1')
    store().begin('dev', 'req-1', 'request')
    store().applyResult({ type: 'strategy-result', teamPath: 'dev', requestId: 'req-1', error: 'Unknown group: lead' })
    expect(view().impactError).toEqual({ slot: 'request:r', message: 'Unknown group: lead' })
    expect(view().error).toBeNull()
    expect(view().pending).toEqual({})
    expect(view().impactCommands['request:r']).toBeDefined()
    store().impactCommand('dev', 'request:r', '{"g":"lead"}', 'req-2')
    store().begin('dev', 'req-2', 'request')
    store().applyResult({ type: 'strategy-result', teamPath: 'dev', requestId: 'req-2', messageId: 'msg-12345678abc', replayed: false })
    expect(view().impactCommands['request:r']).toBeUndefined()
    expect(view().impactError).toBeNull()
    expect(view().impactNotice).toContain('msg-1234')
  })

  test('a reconnect (re)open drops waiting requests, so a lost result never leaves the view busy', () => {
    store().open('dev')
    store().armImpact('dev', 'decide:r:p')
    store().impactCommand('dev', 'decide:r:p', '{}', 'req-1')
    store().begin('dev', 'req-1', 'decide')
    expect(Object.keys(view().pending)).toEqual(['req-1'])
    store().open('dev')
    expect(view().pending).toEqual({})
    expect(view().impactRequests).toEqual({})
    // The armed command survives, so the resend replays on the server.
    expect(view().impactCommands['decide:r:p']).toBeDefined()
    // The lost result arriving late changes nothing.
    store().applyResult({ type: 'strategy-result', teamPath: 'dev', requestId: 'req-1', error: 'late' })
    expect(view().impactError).toBeNull()
  })
})

describe('teamPlanStore impact state', () => {
  test('badges from the snapshot, the selected plan\'s from its detail, and the refusal gate', () => {
    const plans = useTeamPlanStore.getState()
    plans.open('dev', 'plan-1')
    plans.applySnapshot({ type: 'team-plans-snapshot', teamPath: 'dev', teamId: 'team', plans: [], impact: { 'plan-1': planImpact('decision-required') } })
    expect(useTeamPlanStore.getState().views.dev!.impact['plan-1']!.gate!.state).toBe('decision-required')
    plans.applyDetail({ type: 'team-plan-detail', teamPath: 'dev', teamId: 'team', detail: { plan: { id: 'plan-1' } } as never, impact: planImpact('continue') })
    expect(useTeamPlanStore.getState().views.dev!.detailImpact!.gate!.state).toBe('continue')
    plans.begin('dev', 'req-1', 'approve')
    plans.applyResult({ type: 'team-plan-result', teamPath: 'dev', requestId: 'req-1', error: 'refused', failures: [{ name: 'strategy-pin-current', message: 'x' }], impact: gate('adapt') })
    expect(useTeamPlanStore.getState().views.dev!.refusalImpact!.state).toBe('adapt')
    plans.begin('dev', 'req-2', 'approve')
    expect(useTeamPlanStore.getState().views.dev!.refusalImpact).toBeNull()
  })
})
