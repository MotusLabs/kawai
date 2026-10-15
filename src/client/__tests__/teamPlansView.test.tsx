// The Plans view (durable-plans 8.2): list rows with state, approved
// revision, and pin or Alignment unassessed; the detail's claimed alignment,
// progress, waits and tasks outside the revision, the floor beside the extra
// checks, the diff summary; Approve / Withdraw, draft discard, history, close
// and reopen with reasons; disabled controls while disconnected; refusals
// inline; focus moving into the detail and labelled dialogs; the one-column
// list → detail → back flow; the view owning its subscriptions; and an open
// Approve dialog pinning the approved revision it was shown.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import { normalizePlanContent, type PlanRevision } from '@shared/plans'
import TeamPlansView from '../components/team/TeamPlansView'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { planDetail, planSummary } from './planViewFixtures'

afterEach(() => { useTeamPlanStore.setState({ views: {} }) })

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const content = (overrides: Record<string, unknown> = {}) => normalizePlanContent({
  goal: 'Ship plans', successCriteria: ['Plans approved in the UI'], approach: 'Mirror strategy',
  alignment: { statement: 'Serves supervised autonomy', refs: ['UC1'] },
  changes: [
    { change: 'api', group: 'middle-devs', acceptance: ['Store lands'], guidance: 'Pin the hash' },
    { change: 'ui', dependsOn: ['api'], group: 'middle-devs', extraChecks: [{ name: 'a11y', description: 'Axe clean', command: 'bun run axe' }] },
  ],
  extraChecks: [{ name: 'perf', description: 'Under 50 ms' }], acceptanceRules: ['Docs updated'],
  landing: { mode: 'integration-branch', branch: 'wave-c' }, roles: [{ group: 'middle-devs', profiles: ['default', 'glm'] }], reviewGroup: 'reviewers',
  ...overrides,
})
const revision = (number: number, status: PlanRevision['status'], body = content(), pin: PlanRevision['pin'] = { strategyId: 's1', revision: 3, hash: 'abcdef0123456789abcdef' }): PlanRevision => ({
  revision: number, status, content: body, contentHash: `hash-${number}-0123456789`, pin, author: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-14T00:00:00.000Z',
})

const approvedDetail = () => {
  const plan = planSummary('p1', { currentApprovedRevision: 1, state: 'in-progress', linkedTaskCount: 2, pin: revision(1, 'approved').pin })
  return planDetail(plan, {
    revisions: [revision(1, 'approved'), revision(2, 'in_review', content({ goal: 'Ship plans faster', changes: [content().changes[1]!, content().changes[0]!, { ...content().changes[0]!, change: 'cli' }] }))],
    drafts: [{ draftId: 'lead', baseRevision: 1, author: { kind: 'agent', sessionId: 'lead' }, content: content(), contentHash: 'draft-hash-0123456789', updatedAt: '2026-10-14T01:00:00.000Z' }],
    events: [
      { id: 'e1', kind: 'created', revision: null, contentHash: null, actor: { kind: 'agent', sessionId: 'lead' }, reason: null, commandId: null, draftId: null, createdAt: '2026-10-14T00:00:00.000Z' },
      { id: 'e2', kind: 'approved', revision: 1, contentHash: 'hash-1', actor: { kind: 'human', sessionId: null }, reason: null, commandId: 'c1', draftId: null, createdAt: '2026-10-14T00:10:00.000Z' },
    ],
    linkedTasks: [{ id: 't1', title: 'Build API', status: 'active', planChange: 'api' }, { id: 't9', title: 'Old docs', status: 'open', planChange: 'docs' }],
    progress: {
      changes: [
        { change: 'api', status: 'in-progress', tasks: [{ id: 't1', title: 'Build API', status: 'active', planChange: 'api' }], waitsOn: [] },
        { change: 'ui', status: 'not-started', tasks: [], waitsOn: ['api'] },
      ],
      outsideRevision: [{ id: 't9', title: 'Old docs', status: 'open', planChange: 'docs' }],
    },
  })
}

const mount = (setup: () => void = () => {}) => {
  useTeamPlanStore.getState().open('/repo')
  act(() => { setup() })
  const sent: ClientMessage[] = []
  const focused: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  let connected = true
  // Stable like the host's socket sender, so re-renders do not re-run the subscriptions.
  const sendMessage = (message: ClientMessage) => { sent.push(message) }
  const element = (epoch = 0) => <TeamPlansView teamPath="/repo" view={useTeamPlanStore.getState().views['/repo']!} sendMessage={sendMessage}
    connected={connected} connectionEpoch={epoch} sessions={[]} />
  act(() => {
    renderer = TestRenderer.create(element(), { createNodeMock: node => ({ focus: () => focused.push(String(node.props.id ?? node.props['data-testid'] ?? node.type)) }) })
  })
  const rerender = (next: { connected?: boolean; epoch?: number } = {}) => {
    if (next.connected !== undefined) connected = next.connected
    act(() => { renderer.update(element(next.epoch ?? 0)) })
  }
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const has = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId }).length > 0
  return { renderer, sent, focused, rerender, byId, has }
}

test('the list shows title, state, approved revision, and the pin or Alignment unassessed; the view subscribes itself', () => {
  const { sent, byId, renderer } = mount(() => useTeamPlanStore.getState().applySnapshot({
    type: 'team-plans-snapshot', teamPath: '/repo', teamId: 't', plans: [
      planSummary('p1', { state: 'ready', currentApprovedRevision: 2, pin: { strategyId: 's', revision: 4, hash: 'feedbeef00112233' } }),
      planSummary('p2', { state: 'ready', currentApprovedRevision: 1, pin: null }),
      planSummary('p3'),
    ],
  }))
  expect(sent).toEqual([{ type: 'team-plans-open', teamPath: '/repo' }])
  expect(textOf(byId('plan-row-p1'))).toContain('Ready')
  expect(textOf(byId('plan-row-p1'))).toContain('Approved revision 2 · Strategy revision 4')
  expect(textOf(byId('plan-row-p2'))).toContain('Alignment unassessed')
  expect(textOf(byId('plan-row-p3'))).toContain('Draft')
  expect(textOf(byId('plan-row-p3'))).toContain('No approved revision')
  act(() => renderer.unmount())
  expect(sent.at(-1)).toEqual({ type: 'team-plans-close', teamPath: '/repo' })
})

test('an empty team explains who creates plans', () => {
  const { byId } = mount(() => useTeamPlanStore.getState().applySnapshot({ type: 'team-plans-snapshot', teamPath: '/repo', teamId: 't', plans: [] }))
  expect(textOf(byId('plans-empty'))).toContain('canCreatePlans: true')
})

test('list → detail → back: selecting opens the detail subscription and moves focus to the title', () => {
  const detail = approvedDetail()
  const { sent, focused, byId, has, rerender } = mount(() => useTeamPlanStore.getState().applySnapshot({ type: 'team-plans-snapshot', teamPath: '/repo', teamId: 't', plans: [detail.plan] }))
  act(() => byId('plan-row-p1').props.onClick())
  rerender()
  expect(sent.at(-1)).toEqual({ type: 'team-plan-open', teamPath: '/repo', planId: 'p1' })
  expect(has('plan-list')).toBe(false)
  act(() => useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail }))
  rerender()
  expect(focused).toContain('plan-title')
  expect(byId('plan-detail').props['aria-labelledby']).toBe('plan-title')
  act(() => byId('plan-back').props.onClick())
  rerender()
  expect(sent.at(-1)).toEqual({ type: 'team-plan-close', teamPath: '/repo', planId: 'p1' })
  expect(has('plan-list')).toBe(true)
})

test('the detail shows the claimed alignment, progress, waits, outside tasks, the floor beside the extra checks, and the diff', () => {
  const { byId } = mount(() => {
    useTeamPlanStore.getState().select('/repo', 'p1')
    useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: approvedDetail() })
  })
  expect(textOf(byId('plan-alignment'))).toContain('claimed by the author, not assessed')
  expect(textOf(byId('plan-alignment'))).toContain('Cites UC1')
  expect(textOf(byId('plan-pin'))).toContain('Strategy revision 3')
  expect(textOf(byId('plan-change-api'))).toContain('In progress')
  expect(textOf(byId('plan-change-api'))).toContain('Build API — Active')
  expect(textOf(byId('plan-change-ui'))).toContain('Waits on api')
  expect(textOf(byId('plan-change-ui'))).toContain('review reviewers')
  expect(textOf(byId('plan-outside-revision'))).toContain('Old docs — Open (change docs)')
  expect(textOf(byId('plan-floor'))).toContain('Lint')
  expect(textOf(byId('plan-floor'))).toContain('Clean reviewer verdict')
  expect(textOf(byId('plan-extra-checks'))).toContain('perf — Under 50 ms')
  expect(textOf(byId('plan-landing'))).toContain('Integration branch wave-c')
  expect(textOf(byId('plan-roles'))).toContain('middle-devs: default → glm')
  const diff = textOf(byId('plan-diff'))
  expect(diff).toContain('Compared with approved revision 1')
  expect(diff).toContain('changed: Goal, Changes')
  expect(diff).toContain('added cli')
  expect(diff).toContain('changes reordered')
  expect(textOf(byId('plan-history'))).toContain('Approved revision 1 · Human')
  expect(textOf(byId('plan-revision-list'))).toContain('Revision 2 — In review')
})

test('an unapproved plan shows the in-review revision as not the direction, with Alignment unassessed', () => {
  const plan = planSummary('p1')
  const { byId } = mount(() => {
    useTeamPlanStore.getState().select('/repo', 'p1')
    useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: planDetail(plan, { revisions: [revision(1, 'in_review', content(), null)] }) })
  })
  expect(textOf(byId('plan-not-approved'))).toContain('not approved')
  expect(textOf(byId('plan-pin'))).toBe('Alignment unassessed')
  expect(textOf(byId('plan-diff'))).toContain('No approved revision yet')
  expect(byId('plan-complete').props.disabled).toBe(true)
})

const openDetail = () => mount(() => {
  useTeamPlanStore.getState().select('/repo', 'p1')
  useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: approvedDetail() })
})

test('Approve names the exact revision, hash, and the approved revision seen, under the dialog\'s command id', () => {
  const { sent, byId, rerender } = openDetail()
  act(() => byId('plan-approve-2').props.onClick())
  rerender()
  const dialog = byId('plan-approve-2-dialog')
  expect(dialog.props.role).toBe('group')
  expect(dialog.props['aria-label']).toBe('Approve revision 2')
  expect(textOf(dialog)).toContain('hash-2-0123456789')
  expect(textOf(dialog)).toContain('superseding revision 1')
  act(() => byId('plan-approve-2-confirm').props.onClick())
  rerender()
  const approve = sent.find(message => message.type === 'team-plan-approve') as Extract<ClientMessage, { type: 'team-plan-approve' }>
  expect(approve).toMatchObject({ teamPath: '/repo', planId: 'p1', revision: 2, contentHash: 'hash-2-0123456789', expectedApprovedRevision: 1 })
  expect(approve.commandId).toBe(useTeamPlanStore.getState().views['/repo']!.commands['approve:p1:2']!.commandId)
  // Busy while waiting: the confirm disables.
  expect(byId('plan-approve-2-confirm').props.disabled).toBe(true)
  // A refusal shows inline with each failing precondition; the dialog stays.
  act(() => useTeamPlanStore.getState().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: approve.requestId, error: 'Approval refused',
    reason: 'precondition', failures: [{ name: 'strategy-pin-current', message: 'Ask the author to resubmit' }] }))
  rerender()
  expect(textOf(byId('plan-error'))).toContain('strategy-pin-current: Ask the author to resubmit')
  act(() => byId('plan-approve-2-confirm').props.onClick())
  const retry = sent.filter(message => message.type === 'team-plan-approve').at(-1) as typeof approve
  expect(retry.commandId).toBe(approve.commandId)
  expect(retry.requestId).not.toBe(approve.requestId)
  // Success retires the slot and closes the dialog.
  act(() => useTeamPlanStore.getState().applyResult({ type: 'team-plan-result', teamPath: '/repo', requestId: retry.requestId, replayed: false }))
  rerender()
  rerender()
  expect(byId('plan-approve-2').props.children).toBe('Approve revision 2')
})

test('Withdraw, draft discard, cancel with a required reason, and complete naming unfinished changes', () => {
  const { sent, byId, rerender } = openDetail()
  const last = () => sent.at(-1) as Record<string, unknown>
  act(() => byId('plan-withdraw-2').props.onClick())
  rerender()
  act(() => byId('plan-withdraw-2-confirm').props.onClick())
  expect(last()).toMatchObject({ type: 'team-plan-withdraw', planId: 'p1', revision: 2, commandId: expect.any(String) })
  act(() => useTeamPlanStore.getState().reconnected('/repo'))
  rerender()
  act(() => byId('plan-discard-lead').props.onClick())
  rerender()
  act(() => byId('plan-discard-lead-confirm').props.onClick())
  expect(last()).toMatchObject({ type: 'team-plan-withdraw', planId: 'p1', draftId: 'lead' })
  act(() => useTeamPlanStore.getState().reconnected('/repo'))
  rerender()
  act(() => byId('plan-cancel').props.onClick())
  rerender()
  expect(byId('plan-cancel-confirm').props.disabled).toBe(true)
  const reason = byId('plan-cancel-dialog').findByType('textarea')
  act(() => reason.props.onChange({ target: { value: 'Superseded by wave D' } }))
  rerender()
  expect(byId('plan-cancel-confirm').props.disabled).toBe(false)
  act(() => byId('plan-cancel-confirm').props.onClick())
  expect(last()).toMatchObject({ type: 'team-plan-finish', planId: 'p1', outcome: 'cancelled', reason: 'Superseded by wave D' })
  act(() => useTeamPlanStore.getState().reconnected('/repo'))
  rerender()
  act(() => byId('plan-complete').props.onClick())
  rerender()
  expect(textOf(byId('plan-complete-dialog'))).toContain('Changes not done: api, ui')
  expect(byId('plan-complete-confirm').props.disabled).toBe(true)
})

test('a closed plan offers Reopen', () => {
  const closed = approvedDetail()
  closed.plan = { ...closed.plan, lifecycle: 'cancelled', state: 'cancelled' }
  const { sent, byId, has, rerender } = mount(() => {
    useTeamPlanStore.getState().select('/repo', 'p1')
    useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: closed })
  })
  expect(has('plan-complete')).toBe(false)
  expect(byId('plan-approve-2').props.disabled).toBe(true)
  act(() => byId('plan-reopen').props.onClick())
  rerender()
  act(() => byId('plan-reopen-confirm').props.onClick())
  expect(sent.at(-1)).toMatchObject({ type: 'team-plan-reopen', planId: 'p1', commandId: expect.any(String) })
})

test('every control disables while disconnected; reconnecting re-subscribes and drops waiting requests', () => {
  const { sent, byId, rerender, renderer } = openDetail()
  act(() => useTeamPlanStore.getState().begin('/repo', 'lost', 'approve'))
  rerender({ connected: false })
  expect(textOf(renderer.root.findByProps({ role: 'status' }))).toContain('Disconnected')
  for (const id of ['plan-approve-2', 'plan-withdraw-2', 'plan-discard-lead', 'plan-complete', 'plan-cancel']) expect(byId(id).props.disabled).toBe(true)
  const before = sent.length
  rerender({ connected: true, epoch: 1 })
  expect(sent.slice(before)).toEqual([{ type: 'team-plans-open', teamPath: '/repo' }, { type: 'team-plan-open', teamPath: '/repo', planId: 'p1' }])
  expect(useTeamPlanStore.getState().views['/repo']!.pending).toEqual({})
})

test('an open Approve dialog keeps the approved revision it was shown, so an approval landing meanwhile makes it stale', () => {
  const { sent, byId, rerender } = openDetail()
  act(() => byId('plan-approve-2').props.onClick())
  rerender()
  // Another tab approves revision 3 meanwhile; the push reaches this view.
  const moved = approvedDetail()
  moved.plan = { ...moved.plan, currentApprovedRevision: 3 }
  act(() => useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: moved }))
  rerender()
  expect(textOf(byId('plan-approve-2-dialog'))).toContain('superseding revision 1')
  act(() => byId('plan-approve-2-confirm').props.onClick())
  expect(sent.find(message => message.type === 'team-plan-approve')).toMatchObject({ revision: 2, expectedApprovedRevision: 1 })
})
