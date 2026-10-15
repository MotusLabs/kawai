// The Plans view store (durable-plans 8.1): snapshot and detail application
// (closed views and unselected details ignored), reconnect replacing state,
// dialog command ids reused while the payload is unchanged and re-minted
// after a change following a lost result, success retiring the slot, and a
// lost result never leaving `busy` set. The WS dispatch join is asserted
// through the client message router, so every applying method has a caller.
import { afterEach, expect, test } from 'bun:test'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import { planDetail, planSummary } from './planViewFixtures'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { createMessageRouter } from '../protocol/messageRouter'
import type { MessageRouterDeps } from '../protocol/types'

afterEach(() => { useTeamPlanStore.setState({ views: {} }) })

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

test('the WS router dispatches every plan message into the store', () => {
  const route = createMessageRouter({} as MessageRouterDeps)
  store().open('/repo')
  route(snapshot([planSummary('p1')]))
  expect(view().plans!.map(plan => plan.id)).toEqual(['p1'])
  store().select('/repo', 'p1')
  route(detailMessage(planDetail(planSummary('p1'))))
  expect(view().detail!.plan.id).toBe('p1')
  store().begin('/repo', 'r1', 'withdraw')
  route({ type: 'team-plan-result', teamPath: '/repo', requestId: 'r1', error: 'nope' })
  expect(view()).toMatchObject({ pending: {}, error: 'nope' })
})
