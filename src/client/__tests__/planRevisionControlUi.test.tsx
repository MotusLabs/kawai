// The revision-control view (revision-control 9.4, design D14; oracles
// UI1–UI5 of the design's "Remainder"): the Holds section and the
// execution's pauses render what the detail message carries — fed through
// the real team-message dispatch (`handleTeamMessage` → `applyDetail`,
// `applyResult`) — and every dialog (Hold from the detail and from the
// execution, Release, Extend, Pause, the checkpoint decision) mints its
// command id at open, reuses it while the payload is unchanged, re-mints on
// a change, renders every failing check of a refusal with Confirm off until
// reopened, and closes once the command succeeds. Every control disables
// while disconnected; Pausing shows its causes and never reads Paused
// before `paused_at`; the decision dialog offers what the target's state
// allows. Renderers are created inside act() (the bun act trap).
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { createElement } from 'react'
import type { ClientMessage, ServerMessage } from '@shared/types'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import type { PlanExecutionView } from '@shared/planExecution'
import type { CheckpointView, HoldView, PauseTargetView, PauseView } from '@shared/planRevisionControl'
import PlanExecutionSection from '../components/team/PlanExecutionSection'
import PlanHoldsSection from '../components/team/PlanHoldsSection'
import { handleTeamMessage } from '../protocol/teamMessages'
import { useTeamPlanStore } from '../stores/teamPlanStore'

const TEAM = '/repo'
let renderer: TestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  if (renderer) act(() => renderer!.unmount())
  renderer = null
  useTeamPlanStore.setState({ views: {}, reveal: null })
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const fire = (message: unknown) => act(() => handleTeamMessage(message as never, {} as never))

const changeRow = (change: string, state: string): PlanExecutionView['changes'][number] => ({
  change, position: 0, state, step: null, waiting: null, stopReason: null, stopDetail: null,
  taskId: `task-${change}`, worktree: '/w', branch: change, baselineCommit: 'b', prNumber: null, prUrl: null,
  fixRounds: 0, generation: 1, passedAt: null, attempts: 1, attempt: null, instruction: null,
  latestRound: null, landing: null, effects: [],
} as PlanExecutionView['changes'][number])
const CHANGES = ['api', 'ui', 'db', 'web', 'ops']
const execution: PlanExecutionView = {
  id: 'exec-1', planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
  landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: {} as never }, maxParallel: 2, mergeMethod: 'merge',
  state: 'running', outcome: null, stopReason: null, startedAt: '', finishedAt: null,
  changes: CHANGES.map(change => changeRow(change, 'implementing')),
}
const plan: PlanSummary = {
  id: 'plan-1', teamId: 't', title: 'P', lifecycle: 'open', createdAt: '', updatedAt: '', state: 'in-progress',
  creator: { kind: 'human', sessionId: null }, currentApprovedRevision: 1, pin: null, linkedTaskCount: 0,
}
const detail: PlanDetail = {
  plan, revisions: [{ revision: 1, contentHash: 'h' }] as unknown as PlanDetail['revisions'],
  drafts: [], events: [], linkedTasks: [], progress: null, executions: [execution],
}

const hold = (id: string, over: Partial<HoldView> = {}): HoldView => ({
  id, scope: 'changes', rationale: `why ${id}`, deadline: '2026-11-20T12:00:00.000Z', cites: null, createdAt: '2026-11-18T00:00:00.000Z',
  releasedAt: null, releaseReason: null, changes: ['api'], releasedChanges: [], ...over,
})
const checkpoint = (id: string, over: Partial<CheckpointView> = {}): CheckpointView => ({
  id, kind: 'commit', commitSha: `sha-${id}`, summary: `done ${id}`, nextSteps: `next ${id}`, unfinished: null, errorsTests: null,
  createdAt: '2026-11-18T01:00:00.000Z', supersededBy: null, ...over,
})
const target = (change: string, state: PauseTargetView['state'], over: Partial<PauseTargetView> = {}): PauseTargetView => ({
  change, stage: 'attempt', holderSession: `dev-${change}`, withdrawn: false, state, pausedAt: null, checkpoint: null, checkpoints: [],
  decision: null, decidedAt: null, ...over,
})
const pausing = (...kinds: string[]): PauseTargetView['state'] =>
  ({ state: 'pausing', causes: kinds.map(kind => ({ kind })) as never, ownerRequired: false })
const TARGETS: PauseTargetView[] = [
  target('api', { state: 'paused' }, { pausedAt: '2026-11-18T02:00:00.000Z', checkpoint: checkpoint('cp-2'), checkpoints: [checkpoint('cp-1', { supersededBy: 'cp-2' }), checkpoint('cp-2')] }),
  target('ui', pausing('holder-killed')),
  target('db', pausing('checkpoint-push-failed')),
  target('web', pausing('no-checkpoint', 'busy')),
  target('ops', { state: 'decided', decision: 'continue' }, { decision: 'continue', decidedAt: '2026-11-18T03:00:00.000Z' }),
]
const pause = (targets: PauseTargetView[] = TARGETS): PauseView => ({
  id: 'pause-1', holdId: 'hold-1', executionId: 'exec-1', deadline: '2026-11-19T12:00:00.000Z', deadlinePassed: false, note: 'stop soon',
  createdAt: '2026-11-18T00:30:00.000Z', closedAt: null, targets, noActiveWork: ['docs'], landingInProgress: [],
})
const HOLDS = [hold('hold-1'), hold('hold-3', { scope: 'plan', changes: [] }), hold('hold-2', { releasedAt: '2026-11-18T05:00:00.000Z', releaseReason: 'settled' })]

const sent: ClientMessage[] = []
function Host({ connected }: { connected: boolean }) {
  const busy = useTeamPlanStore(state => Object.keys(state.views[TEAM]?.pending ?? {}).length > 0)
  const onSend = (message: ClientMessage) => { sent.push(message) }
  return createElement('div', null,
    createElement(PlanExecutionSection, { teamPath: TEAM, plan, detail, connected, onSend, busy }),
    createElement(PlanHoldsSection, { teamPath: TEAM, planId: 'plan-1', changes: CHANGES, connected, busy, onSend }))
}

/** Open the plan, push its detail through the real dispatch, and render the detail's two sections. */
function mount(pauses: PauseView[] = [pause()], connected = true): void {
  sent.length = 0
  act(() => useTeamPlanStore.getState().open(TEAM, 'plan-1'))
  fire({ type: 'team-plan-detail', teamPath: TEAM, teamId: 't', detail, holds: HOLDS, pauses } satisfies Extract<ServerMessage, { type: 'team-plan-detail' }>)
  act(() => { renderer = TestRenderer.create(createElement(Host, { connected })) })
}

const byTestId = (id: string) => renderer!.root.findByProps({ 'data-testid': id })
const present = (id: string) => renderer!.root.findAllByProps({ 'data-testid': id }).length > 0
const byLabel = (label: string) => renderer!.root.find(node => typeof node.type === 'string' && node.props['aria-label'] === label)
const setValue = (label: string, value: string) => act(() => byLabel(label).props.onChange({ target: { value } }))
const tick = (label: string) => act(() => byLabel(label).props.onChange({ target: { checked: true } }))
const pick = (label: string) => act(() => byLabel(label).props.onChange())
const click = (id: string) => act(() => byTestId(id).props.onClick())
const cancel = (id: string) => act(() => byTestId(`${id}-dialog`).find(node => node.type === 'button' && textOf(node) === 'Cancel').props.onClick())
const last = () => sent.at(-1) as ClientMessage & { requestId: string; commandId: string }

interface DialogCase {
  name: string
  open: string
  type: ClientMessage['type']
  fill: () => void
  edit: () => void
  fields: Record<string, unknown>
}

const DIALOGS: DialogCase[] = [
  {
    name: 'Hold from the plan detail', open: 'plan-hold-place', type: 'team-plan-hold-place',
    fill: () => { pick('Some changes'); tick('Hold api'); setValue('Hold rationale', 'rethink it') },
    edit: () => setValue('Hold rationale', 'rethink it again'),
    fields: { planId: 'plan-1', scope: 'changes', changes: ['api'], rationale: 'rethink it', cites: null },
  },
  {
    // The execution's Hold opens with the in-flight changes ticked.
    name: 'Hold from the execution section', open: 'plan-hold-place-execution', type: 'team-plan-hold-place',
    fill: () => setValue('Hold rationale', 'hold the running work'),
    edit: () => { setValue('Hold cites', 'decision-card'); setValue('Cited id', 'card-9') },
    fields: { scope: 'changes', changes: CHANGES, rationale: 'hold the running work' },
  },
  {
    name: 'Release a changes hold in part', open: 'plan-hold-release-hold-1', type: 'team-plan-hold-release',
    fill: () => { pick('Release some changes'); tick('Release api'); setValue('Release reason', 'api is fine') },
    edit: () => setValue('Release reason', 'api is fine now'),
    fields: { planId: 'plan-1', holdId: 'hold-1', reason: 'api is fine', changes: ['api'] },
  },
  {
    name: 'Narrow a plan hold', open: 'plan-hold-release-hold-3', type: 'team-plan-hold-release',
    fill: () => { pick('Narrow to some changes'); tick('Keep holding db'); setValue('Release reason', 'only db') },
    edit: () => pick('Release the whole hold'),
    fields: { holdId: 'hold-3', reason: 'only db', retain: ['db'] },
  },
  {
    name: 'Extend', open: 'plan-hold-extend-hold-1', type: 'team-plan-hold-extend',
    fill: () => setValue('Extended deadline', '2030-01-02T10:00'),
    edit: () => setValue('Extended deadline', '2030-01-03T10:00'),
    fields: { holdId: 'hold-1', deadline: new Date('2030-01-02T10:00').toISOString() },
  },
  {
    name: 'Pause', open: 'plan-pause-open', type: 'team-plan-pause',
    fill: () => { setValue('Pause hold', 'hold-3'); setValue('Pause deadline', '2030-01-02T10:00') },
    edit: () => setValue('Pause note', 'checkpoint first'),
    fields: { planId: 'plan-1', holdId: 'hold-3', deadline: new Date('2030-01-02T10:00').toISOString() },
  },
  {
    name: 'the checkpoint decision', open: 'plan-checkpoint-decide-api', type: 'team-plan-pause-resolve',
    fill: () => pick('continue'),
    edit: () => { pick('adapt'); setValue('Adapted direction', 'Build api v2') },
    fields: { planId: 'plan-1', pauseId: 'pause-1', change: 'api', choice: 'continue' },
  },
]

function dialogCase(name: string): void {
  const { open, type, fill, edit, fields } = DIALOGS.find(entry => entry.name === name)!
  mount()
  click(open)
  fill()
  click(`${open}-confirm`)
  const first = last()
  expect(first.type).toBe(type)
  expect(first).toMatchObject(fields)
  // A lost result: the reconnect drops the pending request, and the resend replays under the same command id.
  act(() => useTeamPlanStore.getState().reconnected(TEAM))
  click(`${open}-confirm`)
  expect(last().commandId).toBe(first.commandId)
  expect(last().requestId).not.toBe(first.requestId)
  act(() => useTeamPlanStore.getState().reconnected(TEAM))
  edit()
  click(`${open}-confirm`)
  const changed = last()
  expect(changed.commandId).not.toBe(first.commandId)
  // A refusal lists every failing check, and Confirm stays off until the dialog is reopened.
  fire({ type: 'team-plan-result', teamPath: TEAM, requestId: changed.requestId, error: 'Refused it.',
    failures: [{ name: 'state', message: 'the plan is closed' }, { name: 'invalid', message: 'the deadline has passed' }] })
  const refusal = textOf(byTestId(`${open}-refused`))
  expect(refusal).toContain('Refused it.')
  expect(refusal).toContain('state: the plan is closed')
  expect(refusal).toContain('invalid: the deadline has passed')
  expect(byTestId(`${open}-confirm`).props.disabled).toBe(true)
  cancel(open)
  click(open)
  fill()
  expect(byTestId(`${open}-confirm`).props.disabled).toBe(false)
  click(`${open}-confirm`)
  const fresh = last()
  expect([first.commandId, changed.commandId]).not.toContain(fresh.commandId)
  // Success retires the slot and closes the dialog.
  fire({ type: 'team-plan-result', teamPath: TEAM, requestId: fresh.requestId, replayed: false })
  expect(present(`${open}-dialog`)).toBe(false)
  expect(useTeamPlanStore.getState().views[TEAM]!.commands).toEqual({})
}

test('UI1 and UI2: Hold from the plan detail mints at open, reuses on a resend, re-mints on a change, shows every failing check, and retires on success', () => dialogCase('Hold from the plan detail'))
test('UI1 and UI2: Hold from the execution section mints at open, reuses on a resend, re-mints on a change, shows every failing check, and retires on success', () => dialogCase('Hold from the execution section'))
test('UI1 and UI2: Release a changes hold in part mints at open, reuses on a resend, re-mints on a change, shows every failing check, and retires on success', () => dialogCase('Release a changes hold in part'))
test('UI1 and UI2: Narrow a plan hold mints at open, reuses on a resend, re-mints on a change, shows every failing check, and retires on success', () => dialogCase('Narrow a plan hold'))
test('UI1 and UI2: Extend mints at open, reuses on a resend, re-mints on a change, shows every failing check, and retires on success', () => dialogCase('Extend'))
test('UI1 and UI2: Pause mints at open, reuses on a resend, re-mints on a change, shows every failing check, and retires on success', () => dialogCase('Pause'))
test('UI1 and UI2: the checkpoint decision mints at open, reuses on a resend, re-mints on a change, shows every failing check, and retires on success', () => dialogCase('the checkpoint decision'))

test('UI3: every control disables while disconnected, open dialogs included, and the openers are off', () => {
  mount()
  for (const open of ['plan-hold-place', 'plan-hold-release-hold-1', 'plan-hold-extend-hold-1', 'plan-pause-open', 'plan-checkpoint-decide-api']) click(open)
  pick('adapt')
  act(() => renderer!.update(createElement(Host, { connected: false })))
  // The revision-control controls (the change rows' task links navigate and stay live).
  const controls = ['plan-pause-section', 'plan-holds-section'].flatMap(id =>
    byTestId(id).findAll(node => ['button', 'input', 'textarea', 'select'].includes(node.type as string)))
  const live = controls.filter(node => !(node.type === 'button' && textOf(node) === 'Cancel'))
  expect(live.length).toBeGreaterThan(20)
  expect(live.filter(node => node.props.disabled !== true).map(node => node.props['aria-label'] ?? node.props['data-testid'] ?? textOf(node))).toEqual([])
  act(() => renderer!.unmount())
  renderer = null
  mount([pause()], false)
  for (const opener of ['plan-hold-place', 'plan-hold-place-execution', 'plan-hold-release-hold-1', 'plan-hold-extend-hold-1', 'plan-pause-open',
    'plan-checkpoint-decide-api', 'plan-checkpoint-decide-ui', 'plan-checkpoint-decide-web']) {
    expect(byTestId(opener).props.disabled).toBe(true)
  }
})

test('UI4: Pausing shows its causes and never reads Paused before paused_at', () => {
  // A target the server calls paused but with no recorded paused_at still reads Pausing.
  mount([pause([...TARGETS, target('cli', { state: 'paused' })])])
  const label = (change: string) => textOf(byTestId(`plan-pause-state-${change}`))
  expect(label('web')).toBe('Pausing: no-checkpoint, busy')
  expect(label('ui')).toBe('Pausing: holder-killed')
  expect(label('cli')).toBe('Pausing')
  expect(label('api')).toBe('Paused since 2026-11-18T02:00:00.000Z')
  expect(label('ops')).toBe('Decided: continue')
  for (const change of ['web', 'ui', 'db', 'cli']) expect(label(change)).not.toContain('Paused')
  // The newest checkpoint leads; the superseded one stays readable behind it; the no-active-work list shows.
  const api = textOf(byTestId('plan-pause-target-api'))
  expect(api.indexOf('Checkpoint cp-2')).toBeLessThan(api.indexOf('Checkpoint cp-1'))
  expect(api).toContain('Earlier checkpoints (1)')
  expect(textOf(byTestId('plan-pause-no-active-work-pause-1'))).toBe('No active work: docs')
  // A pushed detail where api's paused_at is not yet recorded reads Pausing again: the view keeps no state of its own.
  fire({ type: 'team-plan-detail', teamPath: TEAM, teamId: 't', detail, holds: HOLDS, pauses: [pause([target('api', pausing('checkpoint-pushing'))])] })
  expect(label('api')).toBe('Pausing: checkpoint-pushing')
})

// @covers: plan-pause › Paused is recorded only when work is safe and the holder has stopped › The holder is killed first
test('UI5: a Paused target offers Continue, Adapt, Restart, and Stop; holder-killed and checkpoint-push-failed offer only Restart and Stop', () => {
  mount()
  const offered = (change: string) => {
    click(`plan-checkpoint-decide-${change}`)
    const choices = byTestId(`plan-checkpoint-decide-${change}-choices`).findAll(node => node.type === 'input').map(node => node.props.value as string)
    const stop = byTestId(`plan-checkpoint-decide-${change}-stop`).props.href as string
    cancel(`plan-checkpoint-decide-${change}`)
    return { choices, stop }
  }
  expect(offered('api')).toEqual({ choices: ['continue', 'adapt', 'restart'], stop: '#plan-execution-stop' })
  expect(offered('ui')).toEqual({ choices: ['restart'], stop: '#plan-execution-stop' })
  expect(offered('db')).toEqual({ choices: ['restart'], stop: '#plan-execution-stop' })
  // The link lands on the execution's Stop control.
  expect(renderer!.root.findByProps({ id: 'plan-execution-stop' }).findByProps({ 'data-testid': 'plan-execution-stop-open' })).toBeDefined()
  // A decided target offers no decision.
  expect(present('plan-checkpoint-decide-ops')).toBe(false)
  // Restart without a checkpoint commit says the head may predate the holder's work; Paused api's checkpoint does not.
  click('plan-checkpoint-decide-ui')
  pick('restart')
  expect(present('plan-checkpoint-decide-ui-may-predate')).toBe(true)
  cancel('plan-checkpoint-decide-ui')
  click('plan-checkpoint-decide-api')
  pick('restart')
  expect(present('plan-checkpoint-decide-api-may-predate')).toBe(false)
})

test('Adapt requires the new direction, and a review target cannot adapt', () => {
  mount([pause([target('api', { state: 'paused' }, { pausedAt: '2026-11-18T02:00:00.000Z' }),
    target('ui', { state: 'paused' }, { stage: 'review', pausedAt: '2026-11-18T02:00:00.000Z' })])])
  click('plan-checkpoint-decide-api')
  pick('adapt')
  expect(byTestId('plan-checkpoint-decide-api-confirm').props.disabled).toBe(true)
  setValue('Adapted direction', 'Build api v2')
  tick('Release the hold')
  click('plan-checkpoint-decide-api-confirm')
  expect(last()).toMatchObject({ type: 'team-plan-pause-resolve', choice: 'adapt', adapt: 'Build api v2', releaseHold: true })
  cancel('plan-checkpoint-decide-api')
  click('plan-checkpoint-decide-ui')
  expect(byLabel('adapt').props.disabled).toBe(true)
})

test('the holds section lists active holds with their scope and released ones with their reason; a plan without holds says so', () => {
  mount()
  expect(textOf(byTestId('plan-hold-hold-1'))).toContain('Hold hold-1 on api · review by 2026-11-20T12:00:00.000Z')
  expect(textOf(byTestId('plan-hold-hold-3'))).toContain('Hold hold-3 on the whole plan')
  expect(textOf(byTestId('plan-hold-released-hold-2'))).toContain('released 2026-11-18T05:00:00.000Z: settled')
  fire({ type: 'team-plan-detail', teamPath: TEAM, teamId: 't', detail, holds: [], pauses: [] })
  expect(textOf(byTestId('plan-holds-section'))).toContain('No active hold.')
  // No active hold: the execution offers Hold but not Pause.
  expect(present('plan-pause-open')).toBe(false)
  expect(present('plan-hold-place-execution')).toBe(true)
})
