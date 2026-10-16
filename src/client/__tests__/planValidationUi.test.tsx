// The Plans view's Validation section (plan-validation 11.1/11.2): standing
// badges with counts and changed parts, the report grouped by the four UX
// rows, each decision dialog's validation, refusal, and command-id replay,
// the reused answer prefill, the Unassessed capture link, the approve
// dialog's standing with an inline validation-current refusal, and every
// control disabled while disconnected.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { PlanRevision } from '@shared/plans'
import { normalizePlanContent } from '@shared/plans'
import type { Finding, PlanRevisionValidation } from '@shared/planValidation'
import TeamPlansView from '../components/team/TeamPlansView'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { planDetail, planSummary } from './planViewFixtures'

afterEach(() => { useTeamPlanStore.setState({ views: {} }) })

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const pin = { strategyId: 's1', revision: 3, hash: 'abcdef0123456789' }
const revision = (number: number, status: PlanRevision['status']): PlanRevision => ({
  revision: number, status, content: normalizePlanContent({ goal: 'Ship', changes: [{ change: 'api', group: 'middle-devs' }] }),
  contentHash: `hash-${number}`, pin, author: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-14T00:00:00.000Z',
})

const finding = (key: string, severity: Finding['severity'], row: Finding['row'], message = key): Finding =>
  ({ check: key.split(':')[0]!, key, severity, row, subject: key, message })

const section = (overrides: Partial<PlanRevisionValidation> = {}): PlanRevisionValidation => ({
  revision: 1,
  standing: { state: 'not-validated' },
  report: null,
  assessments: [],
  decisions: [],
  ...overrides,
})

const report = (findings: Finding[], ready = false, extra: Partial<NonNullable<PlanRevisionValidation['report']>> = {}) => ({
  id: 'pvr-1', planId: 'p1', revision: 1, seq: 1, inputHash: 'h', inputs: {
    checksVersion: 1, plan: { planId: 'p1', revision: 1, contentHash: 'hash-1' }, impactStateKey: 'impact',
    adapter: { tool: 'openspec' as const, version: '1.14.2', capabilities: [] }, changes: [],
    catalog: { groups: {}, profiles: 'p' }, claims: { branch: [], changes: {} }, records: { assessments: [], decisions: [] },
  },
  findings, relations: [], evidence: { changes: {}, branch: null, capacity: [] },
  readiness: {
    ready, errors: findings.filter(entry => entry.severity === 'error').map(entry => entry.key),
    unansweredQuestions: [], unacceptedWarnings: findings.filter(entry => entry.severity === 'warning').map(entry => entry.key),
    alignment: { state: 'unassessed' as const, reason: null, effective: null }, carriedConditions: [],
  },
  ready, requestedBy: { kind: 'human' as const, sessionId: null }, createdAt: '2026-10-14T00:00:00.000Z', dryRun: false as const,
  ...extra,
})

const mount = (validation: PlanRevisionValidation[], revisionPin: PlanRevision['pin'] = pin) => {
  useTeamPlanStore.getState().open('/repo', 'p1')
  const detail = planDetail(planSummary('p1', { state: 'draft' }), {
    revisions: [{ ...revision(1, 'in_review'), pin: revisionPin }],
  })
  act(() => {
    useTeamPlanStore.getState().applySnapshot({ type: 'team-plans-snapshot', teamPath: '/repo', teamId: 't', plans: [detail.plan] })
    useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail, validation })
  })
  const sent: ClientMessage[] = []
  let connected = true
  let renderer!: TestRenderer.ReactTestRenderer
  const sendMessage = (message: ClientMessage) => { sent.push(message) }
  const element = (epoch = 0) => <TeamPlansView teamPath="/repo" view={useTeamPlanStore.getState().views['/repo']!}
    sendMessage={sendMessage} connected={connected} connectionEpoch={epoch} sessions={[]} onCaptureStrategy={() => {}} />
  act(() => {
    renderer = TestRenderer.create(element(), { createNodeMock: _node => ({ focus: () => {} }) })
  })
  const rerender = (next: { connected?: boolean } = {}) => {
    if (next.connected !== undefined) connected = next.connected
    act(() => { renderer.update(element()) })
  }
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const has = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId }).length > 0
  return { renderer, sent, rerender, byId, has }
}

test('each standing badge: Not validated, Blocked with counts, Ready, Out of date naming parts', () => {
  const blocked = mount([section({
    standing: { state: 'blocked', reportSeq: 1 },
    report: report([finding('openspec-valid:api', 'error', 'intent'), finding('relations:overlap:a+b:chat', 'warning', 'scope')]),
  })])
  expect(textOf(blocked.byId('plan-validation-1-standing'))).toContain('Blocked')
  expect(textOf(blocked.byId('plan-validation-1-standing'))).toContain('1 error, 0 unanswered questions, 1 unaccepted warning')
  act(() => blocked.renderer.unmount())

  const ready = mount([section({ standing: { state: 'current', reportSeq: 2 }, report: report([], true) })])
  expect(textOf(ready.byId('plan-validation-1-standing'))).toContain('Ready')
  act(() => ready.renderer.unmount())

  const stale = mount([section({ standing: { state: 'out-of-date', reportSeq: 1, changedParts: ["api's artifacts", 'the group reviewers'] }, report: report([], true) })])
  expect(textOf(stale.byId('plan-validation-1-standing'))).toContain("Out of date (api's artifacts, the group reviewers)")
  act(() => stale.renderer.unmount())

  const none = mount([])
  expect(textOf(none.byId('plan-validation-1-standing'))).toContain('Not validated')
  act(() => none.renderer.unmount())
})

test('the report is grouped by the four rows', () => {
  const { byId } = mount([section({
    standing: { state: 'blocked', reportSeq: 1 },
    report: report([
      finding('strategy-impact:gate', 'error', 'alignment'),
      finding('openspec-valid:api', 'error', 'intent'),
      finding('relations:overlap:a+b:chat', 'warning', 'scope'),
      finding('capacity:middle-devs', 'evidence', 'readiness'),
    ]),
  })])
  expect(textOf(byId('plan-validation-1-row-alignment'))).toContain('strategy-impact')
  expect(textOf(byId('plan-validation-1-row-intent'))).toContain('openspec-valid')
  expect(textOf(byId('plan-validation-1-row-scope'))).toContain('relations')
  expect(textOf(byId('plan-validation-1-row-readiness'))).toContain('capacity')
})

test('an empty pin shows Unassessed with the capture link', () => {
  const { byId } = mount([], null)
  expect(textOf(byId('plan-validation-1-unassessed'))).toContain('Unassessed: no approved strategy')
  expect(byId('plan-validation-1-capture')).toBeTruthy()
})

test('Validate sends the wire message and disables while disconnected', () => {
  const { sent, byId, rerender } = mount([])
  act(() => { byId('plan-validate-1').props.onClick() })
  expect(sent.at(-1)).toMatchObject({ type: 'team-plan-validate', planId: 'p1', revision: 1 })
  rerender({ connected: false })
  expect(byId('plan-validate-1').props.disabled).toBe(true)
})

test('the answer dialog blocks on text, sends with its command id, and replays the same id', () => {
  const asked = section({
    standing: { state: 'blocked', reportSeq: 1 },
    report: report([], false, { readiness: {
      ready: false, errors: [], unansweredQuestions: ['pas-q1'], unacceptedWarnings: [],
      alignment: { state: 'unassessed', reason: null, effective: null }, carriedConditions: [],
    } }),
    assessments: [{ id: 'pas-q1', revision: 1, kind: 'question', payload: { text: 'which migration?', mandatory: true, subject: null }, author: { kind: 'agent', sessionId: 'dev' }, createdAt: '2026-10-14T00:00:00.000Z' }],
  })
  const { sent, byId, has } = mount([asked])
  // Open the answer dialog.
  act(() => { byId('plan-answer-1-pas-q1').props.onClick() })
  expect(has('plan-answer-1-pas-q1-dialog')).toBe(true)
  // Confirm blocks while the text is empty.
  expect(byId('plan-answer-1-pas-q1-confirm').props.disabled).toBe(true)
  const dialog = byId('plan-answer-1-pas-q1-dialog')
  act(() => { dialog.findByProps({ value: '' }).props.onChange({ target: { value: 'the documented one' } }) })
  expect(byId('plan-answer-1-pas-q1-confirm').props.disabled).toBe(false)
  act(() => { byId('plan-answer-1-pas-q1-confirm').props.onClick() })
  const answer = sent.at(-1)!
  expect(answer).toMatchObject({ type: 'team-plan-validation-decide', kind: 'answer', target: 'pas-q1', text: 'the documented one', planId: 'p1', revision: 1 })
  const commandId = (answer as { commandId: string }).commandId
  // A resend of the same payload keeps the command id (a lost result replays).
  act(() => { byId('plan-answer-1-pas-q1-confirm').props.onClick() })
  expect((sent.at(-1) as { commandId: string }).commandId).toBe(commandId)
})

test('a refusal keeps the dialog open with Confirm off until reopened', () => {
  const asked = section({
    standing: { state: 'blocked', reportSeq: 1 },
    report: report([]),
    assessments: [{ id: 'pas-q1', revision: 1, kind: 'question', payload: { text: 'which?', mandatory: true, subject: null }, author: { kind: 'agent', sessionId: 'dev' }, createdAt: '2026-10-14T00:00:00.000Z' }],
  })
  const { sent, byId, has } = mount([asked])
  act(() => { byId('plan-answer-1-pas-q1').props.onClick() })
  const dialog = byId('plan-answer-1-pas-q1-dialog')
  act(() => { dialog.findByProps({ value: '' }).props.onChange({ target: { value: 'an answer' } }) })
  act(() => { byId('plan-answer-1-pas-q1-confirm').props.onClick() })
  // The send recorded a pending request; the server refuses it.
  const pendingId = (sent.find(message => message.type === 'team-plan-validation-decide') as { requestId: string } | undefined)?.requestId
  expect(pendingId).toBeTruthy()
  act(() => {
    useTeamPlanStore.getState().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: pendingId!, error: 'not a question' })
  })
  expect(has('plan-answer-1-pas-q1-refused')).toBe(true)
  expect(byId('plan-answer-1-pas-q1-confirm').props.disabled).toBe(true)
})

test('an earlier revision answer to the same question prefills the dialog', () => {
  const earlier = section({
    revision: 0,
    standing: { state: 'not-validated' },
    assessments: [{ id: 'pas-old', revision: 0, kind: 'question', payload: { text: 'which migration?', mandatory: true, subject: null }, author: { kind: 'agent', sessionId: 'dev' }, createdAt: '2026-10-13T00:00:00.000Z' }],
    decisions: [{ id: 'pvd-old', kind: 'answer', target: 'pas-old', text: 'the documented one', scope: null, createdAt: '2026-10-13T01:00:00.000Z' }],
  })
  const asked = section({
    standing: { state: 'blocked', reportSeq: 1 },
    report: report([]),
    assessments: [{ id: 'pas-q1', revision: 1, kind: 'question', payload: { text: 'which migration?', mandatory: true, subject: null }, author: { kind: 'agent', sessionId: 'dev' }, createdAt: '2026-10-14T00:00:00.000Z' }],
  })
  const { renderer, byId } = mount([earlier, asked])
  act(() => { byId('plan-answer-1-pas-q1').props.onClick() })
  const field = renderer.root.findByProps({ value: 'the documented one' })
  expect(field).toBeTruthy()
})

test('a warning finding carries its Accept control; unaccepted keys only', () => {
  const warned = section({
    standing: { state: 'blocked', reportSeq: 1 },
    report: report([finding('relations:overlap:api+ui:chat', 'warning', 'scope')]),
  })
  const { byId, has } = mount([warned])
  expect(has('plan-accept-1-relations:overlap:api+ui:chat')).toBe(true)
  act(() => { byId('plan-accept-1-relations:overlap:api+ui:chat').props.onClick() })
  expect(has('plan-accept-1-relations:overlap:api+ui:chat-dialog')).toBe(true)
})

test('the approve dialog shows the standing and an inline validation-current refusal with Validate', () => {
  const asked = section({ standing: { state: 'blocked', reportSeq: 1 }, report: report([finding('openspec-valid:api', 'error', 'intent')]) })
  const { sent, byId } = mount([asked])
  expect(textOf(byId('plan-approve-standing-1'))).toContain('Validation: Blocked')
  // A stored refusal lands in the view's failures: it renders inline.
  act(() => {
    const requestId = 'approve-req'
    useTeamPlanStore.getState().begin('/repo', requestId, 'approve')
    useTeamPlanStore.getState().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId,
      error: 'Approval refused: validation-current: report 1 not ready',
      failures: [{ name: 'validation-current', message: 'report 1 not ready: 1 errors, 0 unanswered questions, 1 unaccepted warnings, alignment not assessed' }] })
  })
  expect(textOf(byId('plan-approve-refused-1'))).toContain('report 1 not ready')
  expect(textOf(byId('plan-approve-refused-1'))).toContain('1 errors, 0 unanswered questions, 1 unaccepted warnings')
  act(() => { byId('plan-approve-refused-1-validate').props.onClick() })
  expect(sent.at(-1)).toMatchObject({ type: 'team-plan-validate', planId: 'p1', revision: 1 })
})
