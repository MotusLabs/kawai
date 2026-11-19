// The Apply dialog (plan-revision-apply 3.2, design D5/D6, acceptance A8)
// inside the real execution section, fed through the real team-message
// dispatch (`handleTeamMessage` → `applyDetail`, `applyResult`): Apply
// revision… shows only while the running execution holds an older revision
// than the approved one; opening sends the preview frame and its answer lands
// in the store's `revisionPreviews`; the dialog lists every change's class and
// fields and asks a choice only for the preview's needed changes (changed,
// with a task); the command id is minted at open, reused while the payload is
// unchanged, re-minted on an edit; a refusal renders every failing check with
// Apply off until reopened; success closes it; every control disables while
// disconnected. Renderers are created inside act() (the bun act trap).
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { createElement } from 'react'
import type { ClientMessage, ServerMessage } from '@shared/types'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import type { PlanExecutionView } from '@shared/planExecution'
import type { ApplyPreview } from '@shared/planRevisionControl'
import PlanExecutionSection from '../components/team/PlanExecutionSection'
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

const changeRow = (change: string): PlanExecutionView['changes'][number] => ({
  change, position: 0, state: 'implementing', step: null, waiting: null, stopReason: null, stopDetail: null,
  taskId: `task-${change}`, worktree: '/w', branch: change, baselineCommit: 'b', prNumber: null, prUrl: null,
  fixRounds: 0, generation: 1, passedAt: null, attempts: 1, attempt: null, instruction: null,
  latestRound: null, landing: null, effects: [],
} as PlanExecutionView['changes'][number])
const execution = (revision: number): PlanExecutionView => ({
  id: 'exec-1', planId: 'plan-1', revision, contentHash: `h${revision}`, reportId: 'r', inputHash: 'i',
  landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: {} as never }, maxParallel: 2, mergeMethod: 'merge',
  state: 'running', outcome: null, stopReason: null, startedAt: '', finishedAt: null,
  changes: ['api', 'ui', 'docs', 'db', 'web'].map(changeRow),
})
const plan: PlanSummary = {
  id: 'plan-1', teamId: 't', title: 'P', lifecycle: 'open', createdAt: '', updatedAt: '', state: 'in-progress',
  creator: { kind: 'human', sessionId: null }, currentApprovedRevision: 2, pin: null, linkedTaskCount: 0,
}
const detailOf = (running: number): PlanDetail => ({
  plan, revisions: [{ revision: 1, contentHash: 'h1' }, { revision: 2, contentHash: 'h2' }] as unknown as PlanDetail['revisions'],
  drafts: [], events: [], linkedTasks: [], progress: null, executions: [execution(running)],
})

/** Revision 2 over revision 1: api and ui changed with tasks, docs changed unprovisioned, db metadata, web unchanged, cli added, old removed. */
const PREVIEW: ApplyPreview = {
  executionId: 'exec-1', fromRevision: 1, revision: 2, contentHash: 'h2',
  delta: {
    changes: [
      { change: 'api', class: 'changed', fields: ['guidance'], choice: 'needed' },
      { change: 'ui', class: 'changed', fields: ['acceptance', 'group'], choice: 'needed' },
      { change: 'docs', class: 'changed', fields: ['guidance'], choice: 'none' },
      { change: 'db', class: 'metadata', fields: ['fixes'], choice: null },
      { change: 'web', class: 'unchanged', fields: [], choice: null },
      { change: 'cli', class: 'added', fields: [], choice: null },
      { change: 'old', class: 'removed', fields: [], choice: null },
    ],
    findings: [{ kind: 'lead-changed', detail: 'leadGroup senior-devs → lead', changes: [] }],
  },
  needed: ['api', 'ui'],
  adaptations: { api: 'Adapted api direction', ui: 'Adapted ui direction' },
  standing: [{ name: 'plan-open', message: null }, { name: 'choices-complete', message: 'Choose for api, ui' }, { name: 'merge-quiet', message: 'A merge of api is running' }],
}

const sent: ClientMessage[] = []
function mount(connected = true, running = 1): void {
  sent.length = 0
  act(() => useTeamPlanStore.getState().open(TEAM, 'plan-1'))
  const detail = detailOf(running)
  fire({ type: 'team-plan-detail', teamPath: TEAM, teamId: 't', detail } satisfies Extract<ServerMessage, { type: 'team-plan-detail' }>)
  act(() => { renderer = TestRenderer.create(host(connected, detail)) })
}
// One stable component type, so an update re-renders the open dialog instead of remounting it.
function Host({ connected, detail }: { connected: boolean; detail: PlanDetail }) {
  const busy = useTeamPlanStore(state => Object.keys(state.views[TEAM]?.pending ?? {}).length > 0)
  return createElement(PlanExecutionSection, { teamPath: TEAM, plan, detail, connected, onSend: message => { sent.push(message) }, busy })
}
const host = (connected: boolean, detail: PlanDetail) => createElement(Host, { connected, detail })

const byTestId = (id: string) => renderer!.root.findByProps({ 'data-testid': id })
const present = (id: string) => renderer!.root.findAllByProps({ 'data-testid': id }).length > 0
const byLabel = (label: string) => renderer!.root.find(node => typeof node.type === 'string' && node.props['aria-label'] === label)
const setValue = (label: string, value: string) => act(() => byLabel(label).props.onChange({ target: { value } }))
const pick = (label: string) => act(() => byLabel(label).props.onChange())
const click = (id: string) => act(() => byTestId(id).props.onClick())
const cancel = () => act(() => byTestId('plan-apply-revision-dialog').find(node => node.type === 'button' && textOf(node) === 'Cancel').props.onClick())
const last = () => sent.at(-1) as ClientMessage & { requestId: string; commandId?: string }
const result = (requestId: string, payload: Record<string, unknown>) =>
  fire({ type: 'team-plan-result', teamPath: TEAM, requestId, ...payload })

/** Open the dialog and answer its preview frame with `preview`. */
function openWithPreview(preview: ApplyPreview = PREVIEW): void {
  click('plan-apply-revision')
  const frame = last()
  expect(frame).toMatchObject({ type: 'team-plan-execution-apply-preview', teamPath: TEAM, executionId: 'exec-1', revision: 2 })
  expect(present('plan-apply-pending')).toBe(true)
  result(frame.requestId, { applyPreview: preview })
}

const fill = () => { pick('continue api'); pick('adapt ui'); setValue('Apply rationale', 'the store moved') }

describe('the Apply dialog (A8)', () => {
  test('Apply revision… is offered only while the running execution holds an older revision than the approved one', () => {
    mount(true, 2)
    expect(present('plan-apply-revision')).toBe(false)
    act(() => renderer!.unmount())
    renderer = null
    mount(true, 1)
    expect(present('plan-apply-revision')).toBe(true)
  })

  // @covers: plan-revision-apply › Kawai classifies every change against the running revision › The preview shows the delta
  test('the preview lists every change\'s class and changed fields, and asks a choice only for changed changes with tasks', () => {
    mount()
    openWithPreview()
    const delta = textOf(byTestId('plan-apply-delta'))
    for (const fragment of ['api: changed (guidance)', 'ui: changed (acceptance, group)', 'docs: changed (guidance) — not provisioned yet', 'db: metadata (fixes)', 'web: unchanged', 'cli: added', 'old: removed']) {
      expect(delta).toContain(fragment)
    }
    expect(textOf(byTestId('plan-apply-findings'))).toContain('lead-changed')
    const asked = renderer!.root.findAll(node => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('plan-apply-choice-') && node.type === 'fieldset')
      .map(node => node.props['data-testid'])
    expect(asked).toEqual(['plan-apply-choice-api', 'plan-apply-choice-ui'])
    // The generated Adapt text shows once adapt is chosen.
    expect(present('plan-apply-adaptation-ui')).toBe(false)
    pick('adapt ui')
    expect(textOf(byTestId('plan-apply-adaptation-ui'))).toBe('Adapted ui direction')
    // The standing lists what would refuse now, leaving choices-complete to the choices.
    const standing = textOf(byTestId('plan-apply-standing'))
    expect(standing).toContain('merge-quiet')
    expect(standing).not.toContain('choices-complete')
  })

  test('Apply stays off until every needed change has a choice and the rationale is written, then sends the compared payload', () => {
    mount()
    openWithPreview()
    expect(byTestId('plan-apply-revision-confirm').props.disabled).toBe(true)
    pick('continue api')
    setValue('Apply rationale', 'the store moved')
    expect(byTestId('plan-apply-revision-confirm').props.disabled).toBe(true)
    pick('adapt ui')
    expect(byTestId('plan-apply-revision-confirm').props.disabled).toBe(false)
    click('plan-apply-revision-confirm')
    expect(last()).toMatchObject({
      type: 'team-plan-execution-apply', teamPath: TEAM, executionId: 'exec-1', expectedRevision: 1, revision: 2, contentHash: 'h2',
      choices: { api: 'continue', ui: 'adapt' }, rationale: 'the store moved',
    })
  })

  test('one command id is reused while the payload is unchanged, re-minted when it changes, and success closes the dialog', () => {
    mount()
    openWithPreview()
    fill()
    click('plan-apply-revision-confirm')
    const first = last()
    // A lost result: the reconnect drops the pending request; the resend replays under the same command id.
    act(() => useTeamPlanStore.getState().reconnected(TEAM))
    click('plan-apply-revision-confirm')
    expect(last().commandId).toBe(first.commandId!)
    act(() => useTeamPlanStore.getState().reconnected(TEAM))
    pick('restart ui')
    click('plan-apply-revision-confirm')
    const edited = last()
    expect(edited).toMatchObject({ choices: { api: 'continue', ui: 'restart' } })
    expect(edited.commandId).not.toBe(first.commandId!)
    result(edited.requestId, { replayed: false, applied: { seq: 2, revision: 2, contentHash: 'h2', rationale: 'the store moved', appliedAt: '', changes: [] } })
    expect(present('plan-apply-revision-dialog')).toBe(false)
    expect(useTeamPlanStore.getState().views[TEAM]!.commands['apply:exec-1:2']).toBeUndefined()
  })

  test('a refusal renders every failing check, keeps Apply off until reopened, and the reopened dialog is a new command', () => {
    mount()
    openWithPreview()
    fill()
    click('plan-apply-revision-confirm')
    const first = last()
    const failures = [
      { name: 'execution-revision-unchanged', message: 'The execution moved to revision 2' },
      { name: 'changes-on-base', message: 'ui is not on master' },
    ]
    result(first.requestId, { error: 'Apply refused', reason: 'precondition', failures })
    const refusal = textOf(byTestId('plan-apply-revision-refused'))
    for (const failure of failures) expect(refusal).toContain(`${failure.name}: ${failure.message}`)
    expect(byTestId('plan-apply-revision-confirm').props.disabled).toBe(true)
    cancel()
    openWithPreview()
    fill()
    click('plan-apply-revision-confirm')
    expect(last().commandId).not.toBe(first.commandId!)
  })

  test('a preview error renders in the dialog and Apply stays off', () => {
    mount()
    click('plan-apply-revision')
    result(last().requestId, { error: 'Execution not found in this team: exec-1', reason: 'not-found' })
    expect(textOf(byTestId('plan-apply-preview-error'))).toContain('Execution not found')
    setValue('Apply rationale', 'why')
    expect(byTestId('plan-apply-revision-confirm').props.disabled).toBe(true)
  })

  test('every control disables while disconnected', () => {
    mount(false)
    expect(byTestId('plan-apply-revision').props.disabled).toBe(true)
    act(() => renderer!.unmount())
    renderer = null
    // Opened while connected, then the connection drops: choices, rationale, and Apply disable.
    mount(true)
    openWithPreview()
    fill()
    act(() => renderer!.update(host(false, detailOf(1))))
    expect(byLabel('continue api').props.disabled).toBe(true)
    expect(byLabel('Apply rationale').props.disabled).toBe(true)
    expect(byTestId('plan-apply-revision-confirm').props.disabled).toBe(true)
  })
})

describe('the store\'s Apply preview slot', () => {
  test('beginApplyPreview marks the preview pending; its answer settles the preview without touching any command; a reconnect drops only a pending preview', () => {
    act(() => useTeamPlanStore.getState().open(TEAM, 'plan-1'))
    const store = () => useTeamPlanStore.getState()
    act(() => store().arm(TEAM, 'apply:exec-1:2'))
    act(() => store().beginApplyPreview(TEAM, 'req-1', 'exec-1:2'))
    expect(store().views[TEAM]!.revisionPreviews['exec-1:2']).toEqual({ state: 'pending' })
    act(() => store().reconnected(TEAM))
    expect(store().views[TEAM]!.revisionPreviews['exec-1:2']).toBeUndefined()
    act(() => store().beginApplyPreview(TEAM, 'req-2', 'exec-1:2'))
    result('req-2', { applyPreview: PREVIEW })
    const view = store().views[TEAM]!
    expect(view.revisionPreviews['exec-1:2']).toEqual({ state: 'preview', preview: PREVIEW })
    expect([view.pending, view.revisionPreviewRequests, view.error]).toEqual([{}, {}, null])
    expect(view.commands['apply:exec-1:2']).toMatchObject({ payload: null })
    expect(view.commands['apply:exec-1:2']!.refused).toBeUndefined()
    act(() => store().reconnected(TEAM))
    expect(store().views[TEAM]!.revisionPreviews['exec-1:2']).toEqual({ state: 'preview', preview: PREVIEW })
  })
})
