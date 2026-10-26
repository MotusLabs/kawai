// The worker picker of the human dispatch forms (dispatch-worker-choice 4.3):
// shown for a group target only (I3) in the create form, the detail's Assign,
// the handoff form, and the release dialog; it reads the team's capacity over
// `team-task-capacity` and groups the group's workers by provider with usage
// and cooldown; and the chosen worker is part of every armed request key's
// payload (I2) — reused while unchanged, re-minted after a change, including
// Retry assignment and the detail form's sent payload.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { TeamCapacityAnswer } from '@shared/teamCapacity'
import type { HumanTaskDetail, TaskResult, TeamTaskAssignment, TeamTaskSummary } from '@shared/teamTasks'
import TeamTaskDetail from '../components/team/TeamTaskDetail'
import TeamTasksPanel from '../components/team/TeamTasksView'
import { useTeamTaskStore } from '../stores/teamTaskStore'

const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async () => Response.json({ groups: [
    { id: 'reviewers', label: 'Reviewers', description: '' }, { id: 'devs', label: 'Developers', description: '' },
  ], errors: [] })) as unknown as typeof fetch
})
afterEach(() => {
  // Unmounted first: a store reset under a mounted picker would update it outside act.
  act(() => renderer?.unmount())
  globalThis.fetch = originalFetch
  useTeamTaskStore.setState({ views: {} })
})

const COOLING = '2026-10-26T18:00:00.000Z'
const capacity: TeamCapacityAnswer = {
  computedAt: '2026-10-26T12:00:00.000Z',
  groups: [
    { id: 'devs', max: 3, live: 1, strategy: 'first-available', workers: [
      { model: 'sonnet', provider: 'claude', cap: 2, live: 1, cooldownUntil: null },
      { model: 'glm', provider: 'zai', cap: null, live: 0, cooldownUntil: COOLING },
      { model: 'glm-flash', provider: 'zai', cap: 1, live: 0, cooldownUntil: COOLING },
    ] },
    { id: 'reviewers', max: 1, live: 0, strategy: 'first-available', workers: [
      { model: 'mimo', provider: 'xiaomi', cap: null, live: 0, cooldownUntil: null },
      { model: 'sonnet', provider: 'claude', cap: null, live: 0, cooldownUntil: null },
    ] },
  ],
  providers: [
    { id: 'claude', label: 'Claude', usage: { status: 'allowed', windows: [{ key: 'five_hour', percentUsed: 40, resetsAt: null }], receivedAt: '', source: 'push' }, cooldownUntil: null, sharesLoginWith: [] },
    { id: 'zai', label: 'Z.AI', usage: null, cooldownUntil: COOLING, sharesLoginWith: [] },
    { id: 'xiaomi', label: 'MiMo', usage: null, cooldownUntil: null, sharesLoginWith: [] },
  ],
}
const giveCapacity = () => act(() => useTeamTaskStore.getState().applyCapacityResult({ type: 'team-task-capacity-result', teamPath: 'dev', requestId: 'cap', capacity }))

let sent: ClientMessage[]
let renderer: TestRenderer.ReactTestRenderer | undefined
const byTestId = (id: string) => renderer!.root.findAllByProps({ 'data-testid': id }).filter(node => typeof node.type === 'string')
const one = (id: string) => byTestId(id)[0]!
const textOf = (node: TestRenderer.ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''))
const fields = (label: string) => renderer!.root.findAll(node => node.props['aria-label'] === label && typeof node.type === 'string')
const field = (label: string) => fields(label)[0]!
const change = (label: string, value: string) => act(() => field(label).props.onChange({ target: { value } }))
const ofType = <T extends ClientMessage['type']>(type: T) => sent.filter((message): message is Extract<ClientMessage, { type: T }> => message.type === type)
const keyOf = (message: unknown) => (message as { requestKey?: string }).requestKey
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

async function mountPanel() {
  sent = []
  useTeamTaskStore.getState().open('dev')
  const element = () => <TeamTasksPanel teamPath="dev" projectPath="/repo" view={{ ...useTeamTaskStore.getState().views.dev!, loading: false }}
    sendMessage={message => sent.push(message)} connected />
  await act(async () => { renderer = TestRenderer.create(element()); await new Promise(resolve => setTimeout(resolve, 0)) })
  return () => act(() => renderer!.update(element()))
}

const task = (extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id: 't1', teamId: 'team', title: 'Export', status: 'active', creator: { kind: 'human', sessionId: null }, parentId: null,
  worktree: '/repo-feat', openspecChange: null, revision: 1, direction: 'CSV export', acceptance: null,
  createdAt: '', updatedAt: '', participants: [], assignment: null, ...extra,
})
const result = (id: string): TaskResult => ({
  id, taskId: 't1', summary: `Result ${id}`, commit: 'abc123', diff: null, worktree: '/repo-feat',
  tests: [], limitations: null, taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'dev' }, supersedesResultId: null,
  supersededBy: null, acceptedBy: null, acceptedAt: null, needsReevaluation: false, findings: [], createdAt: '2026-10-26T00:00:00.000Z',
})
const detail = (extra: Partial<HumanTaskDetail> = {}): HumanTaskDetail => ({
  task: task(), revisions: [], journal: [], subtasks: [], assignments: [], messages: [], results: [result('r1')], ...extra,
})

async function mountDetail(view: HumanTaskDetail) {
  sent = []
  act(() => renderer?.unmount())
  useTeamTaskStore.getState().open('dev', 't1')
  useTeamTaskStore.getState().applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: view, directory: [] })
  const element = () => <TeamTaskDetail teamPath="dev" projectPath="/repo" view={useTeamTaskStore.getState().views.dev!}
    sendMessage={message => sent.push(message)} connected sessions={[]} />
  await act(async () => { renderer = TestRenderer.create(element()); await new Promise(resolve => setTimeout(resolve, 0)) })
  return () => act(() => renderer!.update(element()))
}

test('store: Retry assignment reuses the key while the worker is unchanged and re-mints it when the worker changes', () => {
  useTeamTaskStore.getState().open('dev')
  const store = useTeamTaskStore.getState()
  store.armFlow('dev', 'create-and-assign')
  const armed = useTeamTaskStore.getState().views.dev!.flow!.requestKey
  store.setDraft('dev', { title: 'Export', direction: 'CSV', targetKind: 'group', targetId: 'devs', worker: 'zai', instruction: 'Go' })
  store.flowSendAssign('dev', { targetKind: 'group', targetId: 'devs', worker: 'zai', instruction: 'Go' })
  const refuse = (requestId: string) => {
    store.begin('dev', requestId, 'assign')
    store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId, error: 'refused' })
  }
  refuse('a1')
  store.retryAssign('dev')
  expect(useTeamTaskStore.getState().views.dev!.flow!.requestKey).toBe(armed)
  refuse('a2')
  store.setDraft('dev', { worker: 'zai/glm-flash' })
  store.retryAssign('dev')
  const flow = useTeamTaskStore.getState().views.dev!.flow!
  expect(flow.requestKey).not.toBe(armed)
  expect(flow.sentPayload).toEqual({ targetKind: 'group', targetId: 'devs', worker: 'zai/glm-flash', instruction: 'Go' })
})

test('create form: the picker shows for a group target only, reads the team\'s capacity, and groups workers by provider with usage and cooldown', async () => {
  const rerender = await mountPanel()
  expect(byTestId('task-assign-worker')).toHaveLength(0)
  change('Assignment target kind', 'session')
  rerender()
  change('Assignment session', 'chat-dev')
  rerender()
  expect(byTestId('task-assign-worker')).toHaveLength(0)
  expect(ofType('team-task-capacity')).toHaveLength(0)
  change('Assignment target kind', 'group')
  rerender()
  change('Assignment group', 'devs')
  rerender()
  await flush()
  expect(ofType('team-task-capacity').map(message => message.teamPath)).toEqual(['dev'])
  giveCapacity()
  rerender()
  const groups = renderer!.root.findAllByType('optgroup')
  expect(groups.map(group => group.props.label)).toEqual(['Claude — allowed (five_hour 40%)', 'Z.AI — usage unknown'])
  expect(groups.map(group => group.findAllByType('option').map(option => option.props.value))).toEqual([
    ['claude', 'claude/sonnet'], ['zai', 'zai/glm', 'zai/glm-flash'],
  ])
  expect(textOf(groups[1]!.findAllByType('option')[2]!)).toContain('glm-flash · 0/1 live · cooling until')
  expect(textOf(one('task-assign-worker-provider-zai'))).toContain('Z.AI: usage unknown · cooling until')
  expect(textOf(one('task-assign-worker-provider-claude'))).toBe('Claude: allowed (five_hour 40%)')
  // Back to a session target: the picker is gone, and so is the choice.
  change('Assignment worker', 'zai')
  change('Assignment target kind', 'session')
  rerender()
  expect(byTestId('task-assign-worker')).toHaveLength(0)
  expect(useTeamTaskStore.getState().views.dev!.draft.worker).toBe('')
})

test('create form: the preview and the assign leg carry the worker; changing the group clears it', async () => {
  const rerender = await mountPanel()
  change('Task title', 'Export')
  change('Task direction', 'CSV')
  change('Assignment target kind', 'group')
  rerender()
  change('Assignment group', 'devs')
  rerender()
  giveCapacity()
  rerender()
  change('Assignment worker', 'zai/glm-flash')
  change('Assignment instruction', 'Go')
  rerender()
  act(() => one('task-assign-preview-button').props.onClick())
  expect(ofType('team-task-preview').at(-1)).toMatchObject({ target: { kind: 'group', id: 'devs' }, worker: 'zai/glm-flash' })
  const previewed = ofType('team-task-preview').at(-1)!
  act(() => useTeamTaskStore.getState().applyPreviewResult({ type: 'team-task-preview-result', teamPath: 'dev', requestId: previewed.requestId, preview: {
    target: { kind: 'group', id: 'devs' }, worktree: null, role: 'devs', profile: 'glm-flash', approval: 'manual', sessionWorktree: null, idleMembers: [],
    spawn: { allowed: false, profile: 'glm-flash', blockedBy: 'worker zai/glm-flash (glm-flash) is cooling' },
    warning: 'Worker zai/glm-flash is cooling; the instruction waits until then',
    worker: { selector: 'zai/glm-flash', profiles: ['glm-flash'], cooldownUntil: COOLING },
  } }))
  rerender()
  expect(textOf(one('task-preview-worker'))).toContain('Worker: zai/glm-flash (glm-flash) · cooling until')
  expect(textOf(one('task-assign-preview'))).toContain('Effective profile: glm-flash')
  act(() => one('task-create-assign-button').props.onClick())
  const [create] = ofType('team-task-create')
  // team-task-create takes no worker: it rides the assign leg (Q1).
  expect(Object.keys(create!)).not.toContain('worker')
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: create!.requestId, task: task() }))
  rerender()
  await flush()
  const [assign] = ofType('team-task-assign')
  expect(assign).toMatchObject({ taskId: 't1', target: { kind: 'group', id: 'devs' }, worker: 'zai/glm-flash', instruction: 'Go' })
  expect(keyOf(assign)).toBe(keyOf(create))
  expect(useTeamTaskStore.getState().views.dev!.flow!.sentPayload).toMatchObject({ worker: 'zai/glm-flash' })
  change('Assignment group', 'reviewers')
  expect(useTeamTaskStore.getState().views.dev!.draft.worker).toBe('')
})

test('detail Assign: the worker is part of the sent payload — unchanged reuses the key, changed re-mints; a session target sends none', async () => {
  const rerender = await mountDetail(detail())
  change('Assignment target kind', 'group')
  rerender()
  change('Assignment group', 'devs')
  rerender()
  giveCapacity()
  rerender()
  change('Assignment worker', 'zai')
  change('Assignment instruction', 'Go')
  rerender()
  act(() => one('task-assign-send').props.onClick())
  act(() => one('task-assign-send').props.onClick())
  const [first, again] = ofType('team-task-assign')
  expect(first).toMatchObject({ target: { kind: 'group', id: 'devs' }, worker: 'zai', instruction: 'Go' })
  expect(keyOf(again)).toBe(keyOf(first))
  change('Assignment worker', 'claude/sonnet')
  rerender()
  act(() => one('task-assign-send').props.onClick())
  const changed = ofType('team-task-assign')[2]!
  expect(changed).toMatchObject({ worker: 'claude/sonnet' })
  expect(keyOf(changed)).not.toBe(keyOf(first))
  // Any worker again: the field is absent, and that too is a new intent.
  change('Assignment worker', '')
  rerender()
  act(() => one('task-assign-send').props.onClick())
  const anyWorker = ofType('team-task-assign')[3]!
  expect(Object.keys(anyWorker)).not.toContain('worker')
  expect(keyOf(anyWorker)).not.toBe(keyOf(changed))
  // A session target has no picker and never sends a worker (I3).
  change('Assignment target kind', 'session')
  rerender()
  expect(byTestId('task-detail-worker')).toHaveLength(0)
  change('Assignment session', 'chat-dev')
  rerender()
  expect(byTestId('task-detail-worker')).toHaveLength(0)
  act(() => one('task-assign-send').props.onClick())
  const session = ofType('team-task-assign').at(-1)!
  expect([session.target, Object.keys(session).includes('worker')]).toEqual([{ kind: 'session', id: 'chat-dev' }, false])
})

test('handoff form: the role\'s worker rides the handoff and its armed key; a changed worker re-mints, a changed role clears it', async () => {
  const rerender = await mountDetail(detail())
  act(() => one('task-handoff-review').props.onClick())
  rerender()
  expect(field('Request review role').props.value).toBe('reviewers')
  await flush()
  expect(ofType('team-task-capacity').at(-1)).toMatchObject({ teamPath: 'dev' })
  giveCapacity()
  rerender()
  change('Request review worker', 'xiaomi')
  change('Request review instructions', 'Check it')
  rerender()
  act(() => one('task-handoff-send').props.onClick())
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  rerender()
  act(() => one('task-handoff-send').props.onClick())
  const [first, resend] = ofType('team-task-handoff')
  expect(first).toMatchObject({ kind: 'review', target: { kind: 'group', id: 'reviewers' }, worker: 'xiaomi' })
  expect(keyOf(resend)).toBe(keyOf(first))
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: resend!.requestId, error: 'refused' }))
  rerender()
  change('Request review worker', 'claude/sonnet')
  rerender()
  act(() => one('task-handoff-send').props.onClick())
  const changed = ofType('team-task-handoff')[2]!
  expect([changed.worker, keyOf(changed) === keyOf(first)]).toEqual(['claude/sonnet', false])
  change('Request review role', 'devs')
  expect(field('Request review worker').props.value).toBe('')
})

test('release dialog: names a claimed standing review that stays live, and sends the worker as part of its armed key', async () => {
  const review: TeamTaskAssignment = {
    id: 'as1', taskId: 't1', requestKey: 'k', targetKind: 'group', targetId: 'reviewers', role: 'reviewers', instruction: 'Review',
    createdBy: { kind: 'human', sessionId: null }, messageId: 'm1', claimedBy: 'chat-reviewer', claimedAt: '', supersededBy: null,
    state: 'claimed', reason: null, createdAt: '', updatedAt: '', handoffKind: 'review', resultId: 'r1', workerChoice: 'claude',
  }
  const release = { members: [{ sessionId: 'dev', name: 'Dev one', ready: true, reason: null }], others: [], outstandingResultId: 'r1', unavailable: null }
  const rerender = await mountDetail(detail({ task: task({ assignment: review }), release }))
  act(() => one('task-release').props.onClick())
  rerender()
  expect(textOf(one('release-live-review'))).toContain('already claimed by chat-reviewer (gone) (worker claude)')
  giveCapacity()
  rerender()
  change('Review worker', 'xiaomi/mimo')
  change('Review instructions', 'Review it')
  rerender()
  act(() => one('task-release-confirm-button').props.onClick())
  act(() => useTeamTaskStore.getState().reconnected('dev'))
  rerender()
  act(() => one('task-release-confirm-button').props.onClick())
  const [first, resend] = ofType('team-task-release')
  expect(first).toMatchObject({ target: 'reviewers', instructions: 'Review it', worker: 'xiaomi/mimo' })
  expect(keyOf(resend)).toBe(keyOf(first))
  act(() => useTeamTaskStore.getState().applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: resend!.requestId, error: 'refused' }))
  rerender()
  change('Review worker', 'xiaomi')
  rerender()
  act(() => one('task-release-confirm-button').props.onClick())
  expect(keyOf(ofType('team-task-release')[2])).not.toBe(keyOf(first))
  // A queued standing review is cancelled by a different worker's release: nothing to name.
  await mountDetail(detail({ task: task({ assignment: { ...review, state: 'queued', claimedBy: null } }), release }))
  act(() => one('task-release').props.onClick())
  expect(byTestId('release-live-review')).toHaveLength(0)
})
