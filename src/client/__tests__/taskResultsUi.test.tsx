// Task results UI (task-results-handoffs 7.1–7.3): claimed test outcomes,
// the Needs re-evaluation badge, supersession, the accept confirmation with
// criteria and a required reason, handoff and release forms whose command
// keys reuse across a reconnect and re-arm on a changed payload — a lost
// result never wedging the controls — and the list's result badges.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { HumanTaskDetail, TaskResult, TeamTaskSummary } from '@shared/teamTasks'
import TeamTaskDetail from '../components/team/TeamTaskDetail'
import TeamTasksPanel from '../components/team/TeamTasksView'
import { useTeamTaskStore } from '../stores/teamTaskStore'

const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async () => Response.json({ groups: [
    { id: 'reviewers', label: 'Reviewers', description: '' }, { id: 'qa', label: 'QA', description: '' }, { id: 'devs', label: 'Developers', description: '' },
  ], errors: [] })) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch; useTeamTaskStore.setState({ views: {} }) })

const task = (extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id: 't1', teamId: 'team', title: 'Export', status: 'active', creator: { kind: 'human', sessionId: null }, parentId: null,
  worktree: '/repo-feat', openspecChange: null, revision: 2, direction: 'CSV export', acceptance: 'A CSV downloads',
  createdAt: '', updatedAt: '', participants: [], assignment: null, ...extra,
})
const result = (id: string, extra: Partial<TaskResult> = {}): TaskResult => ({
  id, taskId: 't1', summary: `Result ${id}`, commit: 'abc123', diff: null, worktree: '/repo-feat',
  tests: [{ description: 'bun run test', outcome: 'pass' }], limitations: null, taskRevision: 2,
  submittedBy: { kind: 'agent', sessionId: 'dev' }, supersedesResultId: null, supersededBy: null, acceptedBy: null, acceptedAt: null,
  needsReevaluation: false, findings: [], createdAt: '2026-10-14T00:00:00.000Z', ...extra,
})
const detail = (extra: Partial<HumanTaskDetail> = {}): HumanTaskDetail => ({
  task: task(), revisions: [], journal: [], subtasks: [], assignments: [], messages: [], results: [result('r1')], ...extra,
})

let sent: ClientMessage[]
let renderer: TestRenderer.ReactTestRenderer
async function mount(view: HumanTaskDetail, connected = true) {
  sent = []
  useTeamTaskStore.getState().open('dev', 't1')
  useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: view, directory: [] })
  const element = (isConnected: boolean) => <TeamTaskDetail teamPath="dev" projectPath="/repo" view={useTeamTaskStore.getState().views.dev!}
    sendMessage={message => sent.push(message)} connected={isConnected} sessions={[]} />
  await act(async () => { renderer = TestRenderer.create(element(connected)); await new Promise(resolve => setTimeout(resolve, 0)) })
  return { rerender: (isConnected = connected) => act(() => renderer.update(element(isConnected))) }
}
const byTestId = (id: string) => renderer.root.findAllByProps({ 'data-testid': id }).filter(node => typeof node.type === 'string')
const one = (id: string) => byTestId(id)[0]!
const textOf = (node: TestRenderer.ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))
const field = (label: string) => renderer.root.find(node => node.props['aria-label'] === label && typeof node.type === 'string')
const ofType = <T extends ClientMessage['type']>(type: T) => sent.filter((message): message is Extract<ClientMessage, { type: T }> => message.type === type)

test('results show claimed outcomes, the re-evaluation badge, and supersession; findings sit on their own result', async () => {
  await mount(detail({ results: [
    result('r2', { supersedesResultId: 'r1' }),
    result('r1', { supersededBy: 'r2', needsReevaluation: true, taskRevision: 1,
      findings: [{ id: 'f1', taskId: 't1', resultId: 'r1', handoffId: null, kind: 'review', verdict: 'fail', findings: 'Header missing',
        author: { kind: 'agent', sessionId: 'reviewer' }, createdAt: '2026-10-14T01:00:00.000Z' }] }),
  ] }))
  const cards = byTestId('task-result')
  expect(cards.map(card => [card.props['data-result-id'], card.props['data-outstanding']])).toEqual([['r2', true], ['r1', false]])
  expect(textOf(cards[0]!)).toContain('Outstanding result')
  expect(textOf(cards[1]!)).toContain('Superseded result')
  expect(textOf(cards[0]!.findByProps({ 'data-testid': 'result-test' }))).toBe('bun run test: pass (claimed)')
  expect(textOf(cards[0]!)).toContain("outcomes are the submitter's claims, not verified evidence")
  expect(cards[0]!.findAllByProps({ 'data-testid': 'result-reevaluation' })).toHaveLength(0)
  expect(textOf(cards[1]!.findByProps({ 'data-testid': 'result-reevaluation' }))).toBe('Needs re-evaluation')
  expect(textOf(cards[0]!)).toContain('No findings on this result')
  expect(textOf(cards[1]!.findByProps({ 'data-testid': 'result-finding' }))).toContain('Review · fail')
  // Handoff actions sit on the outstanding result only.
  expect(cards[1]!.findAllByProps({ 'data-testid': 'task-handoff-review' })).toHaveLength(0)
})

test('accept shows the criteria and open children, needs a reason when flagged, and disables while disconnected or accepted', async () => {
  const child = { ...task({ id: 'c1', title: 'CSV header', status: 'open', parentId: 't1' }) }
  const { rerender } = await mount(detail({ subtasks: [child] }))
  act(() => one('task-accept').props.onClick())
  expect(textOf(one('accept-criteria'))).toBe('A CSV downloads')
  expect(textOf(one('accept-open-children'))).toContain('CSV header (open)')
  expect(one('task-accept-confirm-button').props.disabled).toBe(true)
  act(() => field('Acceptance reason').props.onChange({ target: { value: 'Header ships separately' } }))
  act(() => one('task-accept-confirm-button').props.onClick())
  expect(ofType('team-task-accept-result')).toMatchObject([{ resultId: 'r1', reason: 'Header ships separately', taskId: 't1' }])
  rerender(false)
  expect(one('task-accept').props.disabled).toBe(true)
  await mount(detail({ results: [result('r1', { acceptedAt: 'now', acceptedBy: { kind: 'human', sessionId: null } })] }))
  expect(one('task-accept').props.disabled).toBe(true)
  expect(textOf(one('result-accepted'))).toBe('Accepted by Human')
})

test('a handoff resend after a lost result reuses its key; a changed payload arms a new one; a refusal keeps the input', async () => {
  const { rerender } = await mount(detail())
  act(() => one('task-handoff-review').props.onClick())
  expect(field('Request review role').props.value).toBe('reviewers')
  act(() => field('Request review instructions').props.onChange({ target: { value: 'Check the header' } }))
  act(() => one('task-handoff-send').props.onClick())
  rerender()
  // Pending: the send disables until its result — or a reconnect, which never leaves it wedged.
  expect(one('task-handoff-send').props.disabled).toBe(true)
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  rerender()
  expect(one('task-handoff-send').props.disabled).toBe(false)
  act(() => one('task-handoff-send').props.onClick())
  const [first, resend] = ofType('team-task-handoff')
  expect(first).toMatchObject({ kind: 'review', resultId: 'r1', target: { kind: 'group', id: 'reviewers' }, instructions: 'Check the header' })
  expect((resend as { requestKey?: string }).requestKey).toBe((first as { requestKey?: string }).requestKey)
  // A refusal keeps the input; editing it is a new intent with a new key.
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: resend!.requestId, error: 'Unknown group: reviewers' }))
  rerender()
  expect(field('Request review instructions').props.value).toBe('Check the header')
  act(() => field('Request review instructions').props.onChange({ target: { value: 'Check the header and the footer' } }))
  act(() => one('task-handoff-send').props.onClick())
  expect((ofType('team-task-handoff')[2] as { requestKey?: string }).requestKey).not.toBe((first as { requestKey?: string }).requestKey)
})

test('the release dialog lists the members to archive and the other live sessions, then sends the review request', async () => {
  await mount(detail({ release: {
    members: [{ sessionId: 'dev', name: 'Dev one', ready: false, reason: 'it is busy' }],
    others: [{ sessionId: 'manual', name: 'Manual session' }], outstandingResultId: 'r1', unavailable: null,
  } }))
  act(() => one('task-release').props.onClick())
  expect(textOf(one('release-member'))).toBe('· Dev one — not ready: it is busy')
  expect(textOf(one('release-others'))).toContain('the spawned-writer cap does not cover them')
  expect(textOf(one('release-others'))).toContain('Manual session')
  act(() => field('Review instructions').props.onChange({ target: { value: 'Review it' } }))
  act(() => one('task-release-confirm-button').props.onClick())
  expect(ofType('team-task-release')).toMatchObject([{ taskId: 't1', target: 'reviewers', instructions: 'Review it' }])
  await mount(detail({ release: { members: [], others: [], outstandingResultId: 'r1', unavailable: 'No live spawned member holds the worktree.' } }))
  expect(textOf(one('task-release-unavailable'))).toContain('No live spawned member holds the worktree.')
})

test('the release dialog closes once its listed members are released, even when a reviewer now holds the worktree', async () => {
  const preview = (sessionId: string) => ({ members: [{ sessionId, name: sessionId, ready: true, reason: null }], others: [], outstandingResultId: 'r1', unavailable: null })
  const { rerender } = await mount(detail({ release: preview('dev') }))
  act(() => one('task-release').props.onClick())
  expect(byTestId('task-release-confirm')).toHaveLength(1)
  // A refusal push keeps the same member: the dialog stays open.
  act(() => useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: detail({ release: preview('dev') }), directory: [] }))
  rerender()
  expect(byTestId('task-release-confirm')).toHaveLength(1)
  act(() => useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: detail({ release: preview('reviewer') }), directory: [] }))
  rerender()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(byTestId('task-release-confirm')).toHaveLength(0)
  expect(byTestId('task-release')).toHaveLength(1)
})

test('list rows badge a submitted, flagged, or accepted result, and nothing for an unsubmitted task', () => {
  useTeamTaskStore.getState().open('dev')
  const rows = [
    task({ id: 'a', outstandingResult: { id: 'r', needsReevaluation: false, accepted: false } }),
    task({ id: 'b', outstandingResult: { id: 'r', needsReevaluation: true, accepted: false } }),
    task({ id: 'c', outstandingResult: { id: 'r', needsReevaluation: false, accepted: true } }),
    task({ id: 'd', outstandingResult: null }),
  ]
  act(() => { renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo"
    view={{ ...useTeamTaskStore.getState().views.dev!, loading: false, tasks: rows }} sendMessage={() => {}} connected />) })
  const badges = byTestId('task-result-badge').map(node => [textOf(node).trim(), node.props['data-state']])
  expect(badges).toEqual([['Result submitted', 'submitted'], ['Result needs re-evaluation', 'flagged'], ['Result accepted', 'accepted']])
})

test('the handoff form stays open over an earlier same-kind handoff and closes when its own lands', async () => {
  const handoff = (id: string) => ({ id, taskId: 't1', requestKey: id, targetKind: 'group' as const, targetId: 'reviewers', role: 'reviewers',
    instruction: 'Review', createdBy: { kind: 'human' as const, sessionId: null }, messageId: `m-${id}`, claimedBy: null, claimedAt: null,
    supersededBy: null, state: 'queued' as const, reason: null, createdAt: '', updatedAt: '', handoffKind: 'review' as const, resultId: 'r1', expectedResponse: null })
  const { rerender } = await mount(detail({ task: task({ assignment: handoff('earlier') }) }))
  act(() => one('task-handoff-review').props.onClick())
  rerender()
  expect(byTestId('task-handoff-form')).toHaveLength(1)
  act(() => useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team',
    detail: detail({ task: task({ assignment: handoff('mine') }) }), directory: [] }))
  rerender()
  expect(byTestId('task-handoff-form')).toHaveLength(0)
})
