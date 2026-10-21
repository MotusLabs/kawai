// The Plans view store (durable-plans 8.1): snapshot and detail application
// (closed views and unselected details ignored), reconnect replacing state,
// dialog command ids reused while the payload is unchanged and re-minted
// after a change following a lost result, success retiring the slot, and a
// lost result never leaving `busy` set. The supervision fields
// (plan-supervision D15) ride the selected plan's detail and drop when the
// selection changes, and the Answer/Override dialogs arm their own slots by
// the same rules. The WS dispatch join is asserted through the client
// message router, so every applying method has a caller.
import { afterEach, expect, test } from 'bun:test'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import type { DecisionCard, PlanDecision, PlanDecisionCardView } from '@shared/planDecisions'
import { planReport, type PlanSupervisionView } from '@shared/planReport'
import { planUsage } from '@shared/planUsage'
import { planDetail, planSummary } from './planViewFixtures'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { createMessageRouter } from '../protocol/messageRouter'
import type { MessageRouterDeps } from '../protocol/types'

// A decided card with its supervision and usage views, as the server's detail carries them (plan-supervision D15).
const card: DecisionCard = {
  id: 'card-1', teamId: '/repo/.git', planId: 'p1', revision: 1, change: 'api', taskId: 'task-1',
  question: 'Keep the v1 endpoint?', options: ['keep', 'drop'], context: null,
  askedBy: { session: 'dev-1', group: 'middle-devs', profile: 'glm' },
  addressedTo: 'lead', addressedGroup: 'lead', messageId: null, createdAt: '2026-10-14T00:00:00.000Z',
}
const decision: PlanDecision = {
  id: 'decision-1', cardId: 'card-1', planId: 'p1', teamId: '/repo/.git', seq: 1, kind: 'answer', choice: 'keep', optionIndex: 1,
  rationale: 'v1 still has callers', decidedBy: { kind: 'agent', session: 'lead-1', group: 'lead', profile: 'glm' },
  affected: ['task-1'], commandId: null, replyMessageId: null, createdAt: '2026-10-14T01:00:00.000Z',
}
const cardView = (): PlanDecisionCardView => ({ card, state: 'decided', decisions: [decision], current: decision, fixes: [], commits: [] })
const supervisionView = (): PlanSupervisionView => ({
  changes: [],
  report: planReport({ supervision: [], content: { changes: [], successCriteria: [] }, decisions: [], candidates: [], impact: null }),
  computedAt: '2026-10-14T00:00:00.000Z',
})
const usageView = () => planUsage([])

afterEach(() => { useTeamPlanStore.setState({ views: {}, reveal: null }) })

const store = () => useTeamPlanStore.getState()
const view = () => store().views['/repo']!
const snapshot = (plans: PlanSummary[]) => ({ type: 'team-plans-snapshot' as const, teamPath: '/repo', teamId: '/repo/.git', plans })
const detailMessage = (detail: PlanDetail) => ({ type: 'team-plan-detail' as const, teamPath: '/repo', teamId: '/repo/.git', detail })

test('snapshots apply to an open view only; a detail applies only for the selected plan', () => {
  store().applySnapshot(snapshot([planSummary('p1')]))
  expect(store().views['/repo']).toBeUndefined()
  store().open('/repo')
  expect(view()).toMatchObject({ open: true, loading: true, plans: null })
  store().applySnapshot(snapshot([planSummary('p1')]))
  expect(view()).toMatchObject({ loading: false, plans: [{ id: 'p1' }] })
  store().applyDetail(detailMessage(planDetail(planSummary('p1'))))
  expect(view().detail).toBeNull()
  store().select('/repo', 'p1')
  store().applyDetail(detailMessage(planDetail(planSummary('p2'))))
  expect(view().detail).toBeNull()
  store().applyDetail(detailMessage(planDetail(planSummary('p1'))))
  expect(view().detail!.plan.id).toBe('p1')
  store().select('/repo', null)
  expect(view()).toMatchObject({ selected: null, detail: null })
  store().close('/repo')
  expect(store().views['/repo']).toBeUndefined()
})

test('a reconnect snapshot replaces the list whole and drops waiting requests', () => {
  store().open('/repo')
  store().applySnapshot(snapshot([planSummary('p1'), planSummary('p2')]))
  store().begin('/repo', 'r1', 'approve')
  store().reconnected('/repo')
  expect(view().pending).toEqual({})
  store().applySnapshot(snapshot([planSummary('p2', { state: 'ready' })]))
  expect(view().plans!.map(plan => [plan.id, plan.state])).toEqual([['p2', 'ready']])
})

test('a reconnect drops pending standings and their preview requests; settled standings stay (N4)', () => {
  store().open('/repo')
  store().beginPreview('/repo', 'q1', 'p1:1')
  store().beginPreview('/repo', 'q2', 'p2:1')
  store().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: 'q2', preview: { failures: [], ready: true } })
  store().reconnected('/repo')
  expect(view().pending).toEqual({})
  expect(view().previewRequests).toEqual({})
  expect(view().standings).toEqual({ 'p2:1': { state: 'standing', ready: true, failures: [] } })
  // The lost answer arriving late changes nothing.
  store().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: 'q1', preview: { failures: [], ready: true } })
  expect(view().standings['p1:1']).toBeUndefined()
})

test('a dialog keeps its command id while the payload is unchanged and re-mints after a change', () => {
  store().open('/repo')
  store().arm('/repo', 'finish:p1')
  const armed = view().commands['finish:p1']!.commandId
  // The first send uses the id minted when the dialog opened.
  expect(store().command('/repo', 'finish:p1', '{"reason":"a"}', 'r1')).toBe(armed)
  store().begin('/repo', 'r1', 'finish')
  // The result is lost with the connection; the same payload replays.
  store().reconnected('/repo')
  expect(store().command('/repo', 'finish:p1', '{"reason":"a"}', 'r2')).toBe(armed)
  // The reason was edited after the lost result: a new command.
  store().reconnected('/repo')
  const next = store().command('/repo', 'finish:p1', '{"reason":"b"}', 'r3')
  expect(next).not.toBe(armed)
  // Reopening the dialog mints a fresh id.
  store().arm('/repo', 'finish:p1')
  expect(view().commands['finish:p1']!.commandId).not.toBe(next)
})

test('success retires the slot, a refusal keeps it marked refused with the failures shown, and a lost result never wedges busy', () => {
  store().open('/repo')
  store().arm('/repo', 'approve:p1:1')
  const id = store().command('/repo', 'approve:p1:1', 'x', 'r1')
  store().begin('/repo', 'r1', 'approve')
  store().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: 'r1', error: 'Approval refused', reason: 'precondition',
    failures: [{ name: 'hash-matches', message: 'differs' }] })
  expect(view()).toMatchObject({ pending: {}, error: 'Approval refused', failures: [{ name: 'hash-matches' }] })
  expect(view().commands['approve:p1:1']).toEqual({ commandId: id, payload: 'x', refused: true })
  store().command('/repo', 'approve:p1:1', 'x', 'r2')
  store().begin('/repo', 'r2', 'approve')
  expect(view().error).toBeNull()
  // A result for a request this view no longer waits for changes nothing.
  store().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: 'stale', error: 'late' })
  expect(view().error).toBeNull()
  store().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: 'r2', replayed: false })
  expect(view()).toMatchObject({ pending: {}, error: null, failures: [] })
  expect(view().commands['approve:p1:1']).toBeUndefined()
  // A lost result: begin, then the connection drops before any answer.
  store().begin('/repo', 'r3', 'reopen')
  expect(Object.keys(view().pending)).toHaveLength(1)
  store().reconnected('/repo')
  expect(view().pending).toEqual({})
})

test('the supervision detail rides the selected plan and drops when the selection changes', () => {
  const detail = planDetail(planSummary('p1'), { decisions: [cardView()], supervision: supervisionView(), usage: usageView() })
  store().open('/repo')
  // An unselected detail applies nothing (the whole detail is dropped)…
  store().applyDetail(detailMessage(detail))
  expect(view().detail).toBeNull()
  store().select('/repo', 'p1')
  store().applyDetail(detailMessage(detail))
  expect(view().detail!.decisions!.map(row => row.card.id)).toEqual(['card-1'])
  expect(view().detail!.supervision!.report.delivery).toBe('All 0 changes landed')
  expect(view().detail!.usage!.notes.length).toBeGreaterThan(0)
  // Re-selecting the same plan keeps the held detail; another plan drops it.
  store().select('/repo', 'p1')
  expect(view().detail!.decisions).toHaveLength(1)
  store().select('/repo', 'p2')
  expect(view().detail).toBeNull()
  // Reopening the view naming another plan drops it too; it returns with the plan's next detail.
  store().open('/repo', 'p2')
  store().applyDetail(detailMessage(detail))
  expect(view().detail).toBeNull()
  store().open('/repo', 'p1')
  store().applyDetail(detailMessage(detail))
  expect(view().detail!.supervision!.report.delivery).toBe('All 0 changes landed')
})

test('a decide or override dialog re-mints its command id only when the payload changes', () => {
  store().open('/repo')
  store().arm('/repo', 'decide:p1:card-1')
  const answerId = view().commands['decide:p1:card-1']!.commandId
  expect(store().command('/repo', 'decide:p1:card-1', '{"choice":"keep"}', 'd1')).toBe(answerId)
  store().begin('/repo', 'd1', 'decide')
  // A lost result replays under the same id while the payload is unchanged.
  store().reconnected('/repo')
  expect(store().command('/repo', 'decide:p1:card-1', '{"choice":"keep"}', 'd2')).toBe(answerId)
  // An edited answer is a new command.
  expect(store().command('/repo', 'decide:p1:card-1', '{"choice":"drop"}', 'd3')).not.toBe(answerId)
  store().begin('/repo', 'd3', 'decide')
  // The Override dialog has its own slot, keyed by the card it overrides.
  store().arm('/repo', 'override:p1:card-1')
  expect(view().commands['override:p1:card-1']!.commandId).not.toBe(answerId)
  // Success retires the slot; the refreshed card arrives in the re-pushed detail.
  store().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: 'd3', decision: { card, decision } })
  expect(view().pending).toEqual({})
  expect(view().commands['decide:p1:card-1']).toBeUndefined()
  expect(view().commands['override:p1:card-1']).toBeDefined()
})

test('the attention reveal is requested, replaced, consumed once by its team, and moved by a rekey', () => {
  store().requestReveal('/isolated', 'p1', 'plan-change-api')
  expect(store().reveal).toEqual({ teamKey: '/isolated', planId: 'p1', anchor: 'plan-change-api' })
  // Another team's consume leaves it; the team's consumes it once.
  store().consumeReveal('/other-team')
  expect(store().reveal).not.toBeNull()
  store().consumeReveal('/isolated')
  expect(store().reveal).toBeNull()
  // A second link replaces the target; a rekey moves it with the team.
  store().requestReveal('/isolated', 'p1', 'decision-card-card-1')
  store().requestReveal('/isolated', 'p1', 'plan-change-ui')
  expect(store().reveal!.anchor).toBe('plan-change-ui')
  store().rekey('/isolated', '/moved-isolated')
  expect(store().reveal).toEqual({ teamKey: '/moved-isolated', planId: 'p1', anchor: 'plan-change-ui' })
  // Closing the team's view drops it unconsumed.
  store().close('/moved-isolated')
  expect(store().reveal).toBeNull()
})

test('the WS router dispatches every plan message into the store', () => {
  const route = createMessageRouter({} as MessageRouterDeps)
  store().open('/repo')
  route(snapshot([planSummary('p1')]))
  expect(view().plans!.map(plan => plan.id)).toEqual(['p1'])
  store().select('/repo', 'p1')
  route(detailMessage(planDetail(planSummary('p1'), { decisions: [cardView()], supervision: supervisionView(), usage: usageView() })))
  expect(view().detail!.plan.id).toBe('p1')
  expect(view().detail!.decisions!.map(row => row.card.id)).toEqual(['card-1'])
  expect(view().detail!.supervision!.report.total).toBe(0)
  expect(view().detail!.usage!.notes.length).toBeGreaterThan(0)
  store().begin('/repo', 'r1', 'withdraw')
  route({ type: 'team-plan-result', teamPath: '/repo', requestId: 'r1', error: 'nope' })
  expect(view()).toMatchObject({ pending: {}, error: 'nope' })
  store().arm('/repo', 'override:p1:card-1')
  store().command('/repo', 'override:p1:card-1', '{}', 'o1')
  store().begin('/repo', 'o1', 'override')
  route({ type: 'team-plan-result', teamPath: '/repo', requestId: 'o1', decision: { card, decision, fixTaskId: null } })
  expect(view()).toMatchObject({ pending: {}, error: null })
  expect(view().commands['override:p1:card-1']).toBeUndefined()
})
