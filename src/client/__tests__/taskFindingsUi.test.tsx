// Findings ledger UI (review-findings-ledger 6.2, D10): the task detail's
// Findings section — rows, states, expandable transitions, Uphold/Reject with
// a required rationale on a non-plan task, the card hint on a plan task — and
// the result card's per-item classes, the not-counted label, and the kept
// text rendering of unstructured rows.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { HumanTaskDetail, LedgerItem, LedgerRow, TaskFindings, TaskResult, TeamTaskSummary } from '@shared/teamTasks'
import TeamTaskDetail from '../components/team/TeamTaskDetail'
import { useTeamTaskStore } from '../stores/teamTaskStore'

const originalFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = (async () => Response.json({ groups: [], errors: [] })) as unknown as typeof fetch })
afterEach(() => { globalThis.fetch = originalFetch; useTeamTaskStore.setState({ views: {} }) })

const task = (extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id: 't1', teamId: 'team', title: 'Export', status: 'active', creator: { kind: 'human', sessionId: null }, parentId: null,
  worktree: '/repo-feat', openspecChange: null, revision: 1, direction: 'CSV export', acceptance: null,
  createdAt: '', updatedAt: '', participants: [], assignment: null, ...extra,
})
const item = (findingId: string, extra: Partial<LedgerItem> = {}): LedgerItem => ({
  findingId, itemKind: 'finding', level: 'P1', clause: 'r1#aaaaaaaaaaaa', clauseId: null, evidence: 'src/a.ts:1 drops rows', impact: 'data loss',
  reproduction: null, locus: 'src/a.ts', class: 'accepted', reason: null, disposition: null, regressed: false, ...extra,
})
const findings = (id: string, extra: Partial<TaskFindings> = {}): TaskFindings => ({
  id, taskId: 't1', resultId: 'r1', handoffId: null, kind: 'review', verdict: 'fail', findings: '', author: { kind: 'agent', sessionId: 'rev' },
  createdAt: '2026-11-01T00:00:00.000Z', structured: true, counted: true, contractIdentity: 'r1#aaaaaaaaaaaa', ledgerSeq: 1, replacedBy: null, items: [], ...extra,
})
const result = (extra: Partial<TaskResult> = {}): TaskResult => ({
  id: 'r1', taskId: 't1', summary: 'Result r1', commit: 'abc123', diff: null, worktree: null, tests: [], limitations: null, taskRevision: 1,
  submittedBy: { kind: 'agent', sessionId: 'dev' }, supersedesResultId: null, supersededBy: null, acceptedBy: null, acceptedAt: null,
  needsReevaluation: false, findings: [], createdAt: '2026-11-01T00:00:00.000Z', ...extra,
})
const ledgerRow = (id: string, state: LedgerRow['state'], extra: Partial<LedgerRow> = {}): LedgerRow => ({
  id, level: 'P1', clause: 'r1#aaaaaaaaaaaa', clauseId: null, locus: 'src/a.ts', state, regressed: false, preDispute: null, disputeEventId: null,
  disputedThisEntry: false, resolvedSeq: null, transitions: [
    { seq: 1, kind: 'accepted', source: 'submission', sourceId: 'f1', resultId: 'r1', cardId: null, contractIdentity: 'r1#aaaaaaaaaaaa', note: null, at: '2026-11-01T00:00:00.000Z' },
    ...(state === 'disputed' ? [{ seq: 2, kind: 'disputed' as const, source: 'event' as const, sourceId: 'e1', resultId: null, cardId: null, contractIdentity: null, note: 'a.ts:1 is intended', at: '2026-11-01T01:00:00.000Z' }] : []),
  ], ...extra,
})
const detail = (extra: Partial<HumanTaskDetail> = {}): HumanTaskDetail => ({
  task: task(), revisions: [], journal: [], subtasks: [], assignments: [], messages: [], results: [result()], ...extra,
})

let sent: ClientMessage[]
let renderer: TestRenderer.ReactTestRenderer
async function mount(view: HumanTaskDetail, connected = true) {
  sent = []
  useTeamTaskStore.getState().open('dev', 't1')
  useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: view, directory: [] })
  await act(async () => {
    renderer = TestRenderer.create(<TeamTaskDetail teamPath="dev" projectPath="/repo" view={useTeamTaskStore.getState().views.dev!}
      sendMessage={message => sent.push(message)} connected={connected} sessions={[]} />)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
const byTestId = (id: string) => renderer.root.findAllByProps({ 'data-testid': id }).filter(node => typeof node.type === 'string')
const textOf = (node: TestRenderer.ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))
const button = (label: string) => renderer.root.find(node => node.type === 'button' && textOf(node) === label)
const field = (label: string) => renderer.root.find(node => node.props['aria-label'] === label && typeof node.type === 'string')

// @covers: review-findings › Each task has a findings ledger › The ledger shows a finding's history
test('the Findings section lists each finding with level, state, and clause, and its transitions behind a toggle', async () => {
  await mount(detail({ findingsLedger: [ledgerRow('F1', 'accepted'), ledgerRow('F2', 'rejected', { level: 'P2' })] }))
  const rows = byTestId('finding-row')
  expect(rows.map(row => [row.props['data-finding-id'], row.props['data-state']])).toEqual([['F1', 'accepted'], ['F2', 'rejected']])
  expect(textOf(rows[1]!)).toContain('P2')
  expect(textOf(rows[0]!)).toContain('r1#aaaaaaaaaaaa')
  expect(byTestId('finding-transitions')).toHaveLength(0)
  act(() => rows[0]!.findByProps({ 'data-testid': 'finding-history-toggle' }).props.onClick())
  const transitions = byTestId('finding-transition')
  expect(transitions.map(entry => entry.props['data-kind'])).toEqual(['accepted'])
  expect(textOf(transitions[0]!)).toContain('submission f1 on result r1')
  // No Uphold/Reject where nothing is disputed.
  expect(byTestId('finding-decision')).toHaveLength(0)
})

test('a disputed finding on a non-plan task gets Uphold and Reject, both needing a rationale', async () => {
  await mount(detail({ findingsLedger: [ledgerRow('F1', 'disputed')] }))
  expect(button('Reject F1').props.disabled).toBe(true)
  act(() => field('Rationale for F1').props.onChange({ target: { value: '  a.ts:1 is intended  ' } }))
  act(() => button('Reject F1').props.onClick())
  expect(sent.filter(message => message.type === 'team-task-decide-dispute')).toMatchObject([
    { taskId: 't1', findingId: 'F1', decision: 'reject', rationale: 'a.ts:1 is intended' },
  ])
  expect(useTeamTaskStore.getState().views.dev!.pending).toMatchObject({ [(sent.at(-1) as { requestId: string }).requestId]: 'decide-dispute' })
})

test('a disputed finding on a plan task names its decision card and offers no buttons; disconnected disables the decision', async () => {
  await mount(detail({ task: task({ planId: 'p1', planChange: 'export' }), findingsLedger: [ledgerRow('F1', 'disputed')] }))
  expect(byTestId('finding-decision')).toHaveLength(0)
  expect(textOf(byTestId('finding-card-hint')[0]!)).toContain('decision card')
  await mount(detail({ findingsLedger: [ledgerRow('F1', 'disputed')] }), false)
  act(() => field('Rationale for F1').props.onChange({ target: { value: 'x' } }))
  expect(button('Uphold F1').props.disabled).toBe(true)
})

test('an empty ledger says so', async () => {
  await mount(detail({ findingsLedger: [] }))
  expect(textOf(byTestId('task-findings-empty')[0]!)).toBe('No structured findings yet')
})

test('the result card shows each item\'s class or disposition and marks a replaced submission not counted', async () => {
  await mount(detail({ results: [result({ findings: [
    findings('s2', { items: [item('F1', { itemKind: 'disposition', class: null, disposition: 'resolved' }), item('F2', { class: 'out-of-contract', reason: 'cites no clause' })] }),
    findings('s1', { counted: false, replacedBy: 's2', items: [item('F1')] }),
  ] })] }))
  const rows = byTestId('result-finding')
  expect(rows.map(row => [row.props['data-structured'], row.props['data-counted']])).toEqual([[true, true], [true, false]])
  const items = rows[0]!.findAllByProps({ 'data-testid': 'result-finding-item' }).filter(node => typeof node.type === 'string')
  expect(items.map(entry => [entry.props['data-finding-id'], entry.props['data-class']])).toEqual([['F1', 'resolved'], ['F2', 'out-of-contract']])
  expect(textOf(items[1]!)).toContain('F2 · P1 · out of contract · r1#aaaaaaaaaaaa — cites no clause')
  expect(textOf(items[0]!)).toContain('disposition: resolved')
  expect(rows[0]!.findAllByProps({ 'data-testid': 'result-finding-not-counted' })).toHaveLength(0)
  expect(textOf(rows[1]!.findByProps({ 'data-testid': 'result-finding-not-counted' }))).toContain('not counted (replaced by s2)')
})

// @covers: review-findings › Each task has a findings ledger › Text-only findings stay readable
test('an unstructured row keeps its text and verdict, with no items and no ledger rows', async () => {
  await mount(detail({ findingsLedger: [], results: [result({ findings: [
    findings('t1f', { structured: false, counted: false, contractIdentity: null, ledgerSeq: null, findings: 'the export drops rows', items: [] }),
  ] })] }))
  const row = byTestId('result-finding')[0]!
  expect(row.props['data-structured']).toBe(false)
  expect(textOf(row)).toContain('Review · fail')
  expect(textOf(row)).toContain('the export drops rows')
  expect(row.findAllByProps({ 'data-testid': 'result-finding-item' })).toHaveLength(0)
  expect(row.findAllByProps({ 'data-testid': 'result-finding-not-counted' })).toHaveLength(0)
  expect(byTestId('finding-row')).toHaveLength(0)
})

test('a rejection that clears the last blocker reads pass now on the outstanding result; the stored fail reads at submission', async () => {
  await mount(detail({
    task: task({ outstandingResult: { id: 'r1', needsReevaluation: false, accepted: false, reviewVerdict: 'pass' } }),
    findingsLedger: [ledgerRow('F1', 'rejected')],
    results: [result({ findings: [findings('s1', { verdict: 'fail', items: [item('F1')] })] })],
  }))
  expect(textOf(byTestId('result-review-verdict')[0]!)).toBe('Review verdict now: pass')
  expect(textOf(byTestId('result-finding-verdict')[0]!)).toBe('fail at submission')
})

test('a superseded result shows no current verdict, and a text row keeps its plain verdict', async () => {
  await mount(detail({
    task: task({ outstandingResult: { id: 'r2', needsReevaluation: false, accepted: false, reviewVerdict: null } }),
    results: [result({ id: 'r2', findings: [] }), result({ supersededBy: 'r2', findings: [findings('t1f', { structured: false, counted: false, findings: 'drops rows' })] })],
  }))
  expect(byTestId('result-review-verdict')).toHaveLength(0)
  expect(textOf(byTestId('result-finding-verdict')[0]!)).toBe('fail')
})
