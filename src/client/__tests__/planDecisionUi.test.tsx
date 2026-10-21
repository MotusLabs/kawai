// The Plans view's decision cards (plan-supervision D15, §10.2): a card
// asked from a change renders inline in that change's execution row and
// cards without a change in the plan-level Decisions list; the decision
// history and each override's fix status show; Override names the decision
// it replaces and requires a rationale; Answer takes a chosen option or
// written text with an optional rationale; every control disables while
// disconnected; and a refusal keeps the dialog open with Confirm off until
// it is reopened, which arms a new command. From the attention queue (§10.5),
// a `plan` link with a change and a `card` link with a plan open the plan
// scrolled to and focused on the change row or card, the one-shot reveal
// consumed once, and an unknown target dropped silently. On every settle
// path — the detail mounting loaded, the detail arriving, a reveal after
// load, a plan switch — the rendered target keeps the focus and scroll over
// the plan title, and a reveal for another team never touches this detail.
// Renderers are created inside act() so later store updates re-render (the
// bun act trap).
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, Session } from '@shared/types'
import type { PlanDetail } from '@shared/plans'
import { normalizePlanContent } from '@shared/plans'
import type { AttentionItem, AttentionLink } from '@shared/teamWorkspace'
import type { DecisionCard, FixPhase, FixStatus, PlanDecision, PlanDecisionCardView } from '@shared/planDecisions'
import type { PlanExecutionView } from '@shared/planExecution'
import { resolveChoice } from '../../server/plans/decisions/decisionInputs'
import TeamAttentionQueue from '../components/team/TeamAttentionQueue'
import TeamPlansView from '../components/team/TeamPlansView'
import { openAttentionLink } from '../components/team/attentionLinks'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { planSummary } from './planViewFixtures'
import type { TeamLocation } from '../utils/teamLocation'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useTeamPlanStore.setState({ views: {}, reveal: null })
})

// Concatenated text of the whole tree: JSX splits a sentence across text
// nodes, so assertions match on the joined string.
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const SESSIONS = [{ id: 'dev-1', name: 'Dev One' }, { id: 'lead-1', name: 'Lead One' }] as unknown as Session[]

const queueItem = (id: string, link: AttentionLink): AttentionItem => ({
  id, kind: id.split(':')[0] as AttentionItem['kind'], cause: `cause of ${id}`,
  owner: { kind: 'human', id: null, label: 'Human' }, impact: {}, nextAction: 'Open', link, requiresHuman: true,
})

/** Click an attention item's action, routing its link like the host does (the §10.5 navigation under test). */
function openFromQueue(link: AttentionLink, itemId: string): TeamLocation[] {
  const navigated: TeamLocation[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamAttentionQueue loaded items={[queueItem(itemId, link)]}
      onOpen={entry => openAttentionLink('/repo', entry.link, location => navigated.push(location))} />)
  })
  renderers.push(renderer)
  act(() => renderer.root.findAllByProps({ 'data-testid': 'attention-action' })[0]!.props.onClick())
  act(() => renderer.unmount())
  renderers.pop()
  return navigated
}

const card = (over: Partial<DecisionCard> = {}): DecisionCard => ({
  id: 'card-1', teamId: 't', planId: 'plan-1', revision: 1, change: 'api', taskId: 'task-1',
  question: 'Keep the v1 endpoint?', options: ['keep v1', 'drop v1'], context: 'Callers may still use it.',
  askedBy: { session: 'dev-1', group: 'middle-devs', profile: 'glm' },
  addressedTo: 'lead', addressedGroup: 'lead', messageId: null, createdAt: '2026-10-14T00:00:00.000Z', ...over,
})

const decision = (over: Partial<PlanDecision> = {}): PlanDecision => ({
  id: 'decision-1', cardId: 'card-1', planId: 'plan-1', teamId: 't', seq: 1, kind: 'answer', choice: 'drop v1', optionIndex: 2,
  rationale: 'no callers left', decidedBy: { kind: 'agent', session: 'lead-1', group: 'lead', profile: 'glm' },
  affected: ['task-1'], commandId: null, replyMessageId: null, createdAt: '2026-10-14T01:00:00.000Z', ...over,
})

const fixStatus = (phase: FixPhase): FixStatus => ({ phase, revision: null, executionId: null, landings: [], outstanding: [] })

const cardView = (cardRow: DecisionCard, decisions: PlanDecision[], fixes: PlanDecisionCardView['fixes'] = [],
  commits: PlanDecisionCardView['commits'] = []): PlanDecisionCardView =>
  ({ card: cardRow, state: decisions.length === 0 ? 'open' : decisions.at(-1)!.kind === 'override' ? 'overridden' : 'decided',
    decisions, current: decisions.at(-1) ?? null, fixes, commits })

const FLOOR = { version: 1 as const, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } }
const execution = (changes: PlanExecutionView['changes']): PlanExecutionView => ({
  id: 'exec-1', planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
  landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: FLOOR, maxParallel: 2, mergeMethod: 'merge',
  state: 'running', outcome: null, stopReason: null, startedAt: '', finishedAt: null, changes,
})
const changeRow = (name: string, taskId: string): PlanExecutionView['changes'][number] => ({
  change: name, position: 0, state: 'implementing', step: null, waiting: null, stopReason: null, stopDetail: null,
  taskId, worktree: '/w', branch: name, baselineCommit: 'b', prNumber: null, prUrl: null,
  fixRounds: 0, generation: 1, passedAt: null, attempts: 1, attempt: null, instruction: null,
  latestRound: null, landing: null, effects: [],
})

// One open Lead-addressed card on `api`, one overridden card with a fix task
// and no change (its two affected tasks: one with commits, one without), and
// one owner-addressed open card on `ui`.
const decisionsFixture = (): PlanDecisionCardView[] => {
  const leadAnswer = decision({ cardId: 'card-2', id: 'decision-2' })
  const ownerOverride = decision({ cardId: 'card-2', id: 'decision-3', seq: 2, kind: 'override', choice: 'keep v1', optionIndex: 1,
    rationale: 'v1 must stay', decidedBy: { kind: 'human', session: null, group: null, profile: null },
    affected: ['task-1', 'task-nocommit'] })
  return [
    cardView(card(), []),
    cardView(card({ id: 'card-2', change: null, taskId: null, addressedTo: 'lead', question: 'Which theme ships?' }),
      [leadAnswer, ownerOverride],
      [{ decisionId: 'decision-3', taskId: 'task-fix-1', status: fixStatus('planning') }],
      [{ taskId: 'task-1', commits: ['abc1234567'] }]),
    cardView(card({ id: 'card-3', change: 'ui', taskId: 'task-2', addressedTo: 'owner', addressedGroup: null }), []),
  ]
}

const detail = (decisionViews: PlanDecisionCardView[], planId = 'plan-1'): PlanDetail => ({
  plan: planSummary(planId, { state: 'in-progress', currentApprovedRevision: 1 }),
  revisions: [{ revision: 1, status: 'approved', content: normalizePlanContent({ goal: 'Ship', changes: [{ change: 'api' }, { change: 'ui' }] }),
    contentHash: 'hash-1', pin: null, author: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-14T00:00:00.000Z' }],
  drafts: [], events: [], linkedTasks: [], progress: null,
  executions: [execution([changeRow('api', 'task-1'), changeRow('ui', 'task-2')])],
  decisions: decisionViews,
})

const mount = (decisionViews: PlanDecisionCardView[], options: { connected?: boolean; teamPath?: string; deferDetail?: boolean; planId?: string } = {}) => {
  const teamPath = options.teamPath ?? '/repo'
  const planId = options.planId ?? 'plan-1'
  useTeamPlanStore.getState().open(teamPath, planId)
  const sent: ClientMessage[] = []
  const openedTasks: string[] = []
  /** Host elements that took focus, by their id or testid (the reveal's focus). */
  const focusedNodes: string[] = []
  /** Host elements scrolled into view, with the options they were given. */
  const scrolledNodes: Array<[string, unknown]> = []
  let connectedNow = options.connected ?? true
  act(() => {
    useTeamPlanStore.getState().applySnapshot({ type: 'team-plans-snapshot', teamPath, teamId: 't', plans: [detail(decisionViews, planId).plan] })
    if (!options.deferDetail) {
      useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath, teamId: 't', detail: detail(decisionViews, planId) })
    }
  })
  const element = () => <TeamPlansView teamPath={teamPath} view={useTeamPlanStore.getState().views[teamPath]!}
    sendMessage={message => sent.push(message)} connected={connectedNow} connectionEpoch={0} sessions={SESSIONS}
    onOpenTask={taskId => openedTasks.push(taskId)} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(element(), { createNodeMock: node => ({
      focus: () => focusedNodes.push(String(node.props.id ?? node.props['data-testid'] ?? '')),
      scrollIntoView: (options: unknown) => scrolledNodes.push([String(node.props.id ?? ''), options]),
    }) })
  })
  renderers.push(renderer)
  const rerender = (next: { connected?: boolean } = {}) => {
    if (next.connected !== undefined) connectedNow = next.connected
    act(() => { renderer.update(element()) })
  }
  const text = () => textOf(renderer.root)
  const byId = (testId: string) => renderer.root.findByProps({ 'data-testid': testId })
  const allById = (testId: string) => renderer.root.findAllByProps({ 'data-testid': testId })
  const cancelButton = () => renderer.root.findAllByProps({ type: 'button' }).find(button => button.props.children === 'Cancel')!
  return { renderer, sent, openedTasks, focusedNodes, scrolledNodes, rerender, text, byId, allById, cancelButton }
}

const sectionOf = (node: TestRenderer.ReactTestInstance, testId: string): boolean => {
  let parent = node.parent
  while (parent !== null) {
    if (parent.props['data-testid'] === testId) return true
    parent = parent.parent
  }
  return false
}

test('a card asked from a change renders inline in its execution row; cards without a change render in the Decisions list', () => {
  const ui = mount(decisionsFixture())
  const cards = ui.allById('plan-decision-card')
  // Tree order: the execution section's inline cards, then the Decisions list.
  expect(cards.map(node => node.props.id)).toEqual(['decision-card-card-1', 'decision-card-card-3', 'decision-card-card-2'])
  const inline = cards.filter(node => sectionOf(node, 'plan-execution-section'))
  expect(inline.map(node => node.props.id)).toEqual(['decision-card-card-1', 'decision-card-card-3'])
  const listed = cards.filter(node => sectionOf(node, 'plan-decisions-section'))
  expect(listed.map(node => node.props.id)).toEqual(['decision-card-card-2'])
  expect(ui.text()).toContain('Keep the v1 endpoint?')
  expect(ui.text()).toContain('Which theme ships?')
  expect(ui.text()).toContain('asked by Dev One · middle-devs · glm')
  expect(ui.text()).toContain('addressed to the owner')
})

test('the history and the fix status show on an overridden card', () => {
  const ui = mount(decisionsFixture())
  expect(ui.text()).toContain('#1 Answer: drop v1 — Lead One · lead · glm — no callers left (superseded)')
  expect(ui.text()).toContain('#2 Override: keep v1 — Human (owner) — v1 must stay')
  expect(ui.text()).toContain('Forward fix task')
  expect(ui.text()).toContain('Planning')
  act(() => ui.allById('plan-decision-fix-task')[0]!.props.onClick())
  expect(ui.openedTasks).toEqual(['task-fix-1'])
})

test('every affected task is named, with its commits or the statement it has none', () => {
  const ui = mount(decisionsFixture())
  const affected = ui.allById('plan-decision-affected-task')
  expect(affected.map(node => textOf(node))).toEqual(['task-1…', 'task-nocommit…'])
  expect(ui.text()).toContain('commits since the decision: abc1234567')
  expect(ui.text()).toContain('— no commits since the decision')
  act(() => affected[1]!.props.onClick())
  expect(ui.openedTasks.at(-1)).toBe('task-nocommit')
})

// B1's contract: whatever the dialogs send must pass the server's own
// resolver — exactly one of choice and optionIndex — for an option pick and
// a written answer, in both Answer and Override.
test('every sent choice resolves through the server resolveChoice in both modes', () => {
  const ui = mount(decisionsFixture())
  const confirm = () => act(() => ui.byId('plan-decision-override-confirm').props.onClick())
  act(() => ui.allById('plan-decision-override')[0]!.props.onClick())
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Option 1: keep v1' }).props.onChange())
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'override rationale' }).props.onChange({ target: { value: 'wrong call' } }))
  confirm()
  act(() => ui.cancelButton().props.onClick())
  act(() => ui.allById('plan-decision-override')[0]!.props.onClick())
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'override rationale' }).props.onChange({ target: { value: 'still wrong' } }))
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Another choice' }).props.onChange({ target: { value: 'custom plan' } }))
  confirm()
  act(() => ui.cancelButton().props.onClick())
  act(() => ui.allById('plan-decision-answer')[0]!.props.onClick())
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Option 2: drop v1' }).props.onChange())
  act(() => ui.byId('plan-decision-answer-confirm').props.onClick())
  act(() => ui.cancelButton().props.onClick())
  act(() => ui.allById('plan-decision-answer').at(-1)!.props.onClick())
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Another choice' }).props.onChange({ target: { value: 'ship as is' } }))
  act(() => ui.byId('plan-decision-answer-confirm').props.onClick())
  const options = (cardId: string) => decisionsFixture().find(view => view.card.id === cardId)!.card.options
  const resolved = ui.sent
    .filter(entry => entry.type === 'team-plan-decide' || entry.type === 'team-plan-override')
    .map(message => {
      const choice = (message as { choice?: string | null }).choice
      const optionIndex = (message as { optionIndex?: number | null }).optionIndex
      // The decision connection forwards exactly these fields to resolveChoice.
      return resolveChoice(options((message as { cardId: string }).cardId), { choice: choice ?? null, option_index: optionIndex ?? null })
    })
  expect(resolved).toEqual([
    { choice: 'keep v1', optionIndex: 1 },
    { choice: 'custom plan', optionIndex: null },
    { choice: 'drop v1', optionIndex: 2 },
    { choice: 'ship as is', optionIndex: null },
  ])
})

test('Override names the decision it replaces and requires a rationale before confirming', () => {
  const ui = mount(decisionsFixture())
  act(() => ui.allById('plan-decision-override')[0]!.props.onClick())
  expect(ui.text()).toContain("Override Human (owner)'s decision")
  expect(ui.byId('plan-decision-override-confirm').props.disabled).toBe(true)
  // A choice without a rationale still cannot confirm — the rationale is
  // required on its own, not just as one of several missing fields.
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Option 1: keep v1' }).props.onChange())
  expect(ui.byId('plan-decision-override-confirm').props.disabled).toBe(true)
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'override rationale' }).props.onChange({ target: { value: 'wrong call' } }))
  expect(ui.byId('plan-decision-override-confirm').props.disabled).toBe(false)
  act(() => ui.byId('plan-decision-override-confirm').props.onClick())
  const message = ui.sent.find(entry => entry.type === 'team-plan-override') as { commandId: string } | undefined
  expect(message).toMatchObject({
    teamPath: '/repo', planId: 'plan-1', cardId: 'card-2', expectedDecisionId: 'decision-3',
    choice: null, optionIndex: 1, rationale: 'wrong call',
  })
  const armed = useTeamPlanStore.getState().views['/repo']!.commands['override:plan-1:card-2']
  expect(message?.commandId).toBe(armed?.commandId)
})

test('Answer takes a chosen option or written text with an optional rationale', () => {
  const ui = mount(decisionsFixture())
  expect(ui.allById('plan-decision-answer')).toHaveLength(2)
  act(() => ui.allById('plan-decision-answer')[0]!.props.onClick())
  // No rationale needed: choosing an option arms the confirm.
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Option 2: drop v1' }).props.onChange())
  expect(ui.byId('plan-decision-answer-confirm').props.disabled).toBe(false)
  act(() => ui.byId('plan-decision-answer-confirm').props.onClick())
  expect(ui.sent.find(entry => entry.type === 'team-plan-decide')).toMatchObject({
    planId: 'plan-1', cardId: 'card-1', choice: null, optionIndex: 2, rationale: null,
  })
  // The answered card's dialog stays open until its command settles; close it,
  // then answer the ui card (the last opener in tree order) in writing.
  expect(ui.allById('plan-decision-answer')).toHaveLength(1)
  act(() => ui.cancelButton().props.onClick())
  expect(ui.allById('plan-decision-answer')).toHaveLength(2)
  act(() => ui.allById('plan-decision-answer').at(-1)!.props.onClick())
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Another choice' }).props.onChange({ target: { value: 'ship as is' } }))
  act(() => ui.byId('plan-decision-answer-confirm').props.onClick())
  expect(ui.sent.filter(entry => entry.type === 'team-plan-decide').at(-1)).toMatchObject({
    cardId: 'card-3', choice: 'ship as is', optionIndex: null,
  })
})

test('controls disable while disconnected', () => {
  const ui = mount(decisionsFixture(), { connected: false })
  for (const button of ui.allById('plan-decision-answer')) expect(button.props.disabled).toBe(true)
  for (const button of ui.allById('plan-decision-override')) expect(button.props.disabled).toBe(true)
  ui.rerender({ connected: true })
  expect(ui.allById('plan-decision-answer')[0]!.props.disabled).toBe(false)
})

test('a refusal keeps the dialog open with Confirm off until it is reopened, which arms a new command', () => {
  const ui = mount(decisionsFixture())
  act(() => ui.allById('plan-decision-override')[0]!.props.onClick())
  const firstCommandId = useTeamPlanStore.getState().views['/repo']!.commands['override:plan-1:card-2']!.commandId
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'override rationale' }).props.onChange({ target: { value: 'again' } }))
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Option 1: keep v1' }).props.onChange())
  act(() => ui.byId('plan-decision-override-confirm').props.onClick())
  const requestId = (ui.sent.at(-1) as { requestId: string }).requestId
  act(() => useTeamPlanStore.getState().applyResult({
    type: 'team-plan-result', teamPath: '/repo', requestId, error: 'overrides a decision that is no longer current',
  }))
  expect(ui.text()).toContain('Refused')
  expect(ui.text()).toContain('no longer current')
  expect(ui.byId('plan-decision-override-confirm').props.disabled).toBe(true)
  // Closing and reopening arms a new command id; after refilling, Confirm works again.
  act(() => ui.cancelButton().props.onClick())
  act(() => ui.allById('plan-decision-override')[0]!.props.onClick())
  const secondCommandId = useTeamPlanStore.getState().views['/repo']!.commands['override:plan-1:card-2']!.commandId
  expect(secondCommandId).not.toBe(firstCommandId)
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'override rationale' }).props.onChange({ target: { value: 'again' } }))
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Option 1: keep v1' }).props.onChange())
  expect(ui.byId('plan-decision-override-confirm').props.disabled).toBe(false)
})

test('the Answer dialog arms the decide:<plan>:<card> slot and its command id rides the message (N4)', () => {
  const ui = mount(decisionsFixture())
  act(() => ui.allById('plan-decision-answer')[0]!.props.onClick())
  act(() => ui.renderer.root.findByProps({ 'aria-label': 'Option 2: drop v1' }).props.onChange())
  act(() => ui.byId('plan-decision-answer-confirm').props.onClick())
  const message = ui.sent.find(entry => entry.type === 'team-plan-decide') as { commandId: string }
  expect(useTeamPlanStore.getState().views['/repo']!.commands['decide:plan-1:card-1']!.commandId).toBe(message.commandId)
})

test('a plan attention link with a change opens the plan scrolled to and focused on the change row (§10.5)', () => {
  const navigated = openFromQueue({ kind: 'plan', id: 'plan-stop:exec-1:api:0', planId: 'plan-1', change: 'api' }, 'plan-stop:exec-1:api:0')
  expect(navigated).toEqual([{ teamKey: '/repo', tab: 'plans', id: 'plan-1' }])
  expect(useTeamPlanStore.getState().reveal).toEqual({ teamKey: '/repo', planId: 'plan-1', anchor: 'plan-change-api' })
  // The host mounts the Plans view on that location; the loaded detail
  // scrolls the row into view and moves focus to it — the row is the ONLY
  // element focused, so the title never takes the scroll back — and then the
  // reveal is gone.
  const ui = mount(decisionsFixture())
  expect(ui.scrolledNodes).toEqual([['plan-change-api', { block: 'center' }]])
  expect(ui.focusedNodes).toEqual(['plan-change-api'])
  expect(useTeamPlanStore.getState().reveal).toBeNull()
  // The one-shot target does not scroll again on a re-render.
  ui.rerender()
  expect(ui.scrolledNodes).toHaveLength(1)
})

test('a card attention link opens the plan scrolled to and focused on the decision card (§10.5)', () => {
  const navigated = openFromQueue({ kind: 'card', id: 'card-2', planId: 'plan-1' }, 'decision-question:card-2')
  expect(navigated).toEqual([{ teamKey: '/repo', tab: 'plans', id: 'plan-1' }])
  expect(useTeamPlanStore.getState().reveal).toEqual({ teamKey: '/repo', planId: 'plan-1', anchor: 'decision-card-card-2' })
  const ui = mount(decisionsFixture())
  // card-2 has no change, so it renders in the plan-level Decisions list.
  expect(ui.scrolledNodes).toEqual([['decision-card-card-2', { block: 'center' }]])
  expect(ui.focusedNodes).toEqual(['decision-card-card-2'])
  expect(useTeamPlanStore.getState().reveal).toBeNull()
})

test('a reveal pending while the detail loads takes the scroll and focus once the detail arrives, and the title does not retake them', () => {
  useTeamPlanStore.getState().requestReveal('/repo', 'plan-1', 'plan-change-api')
  // The detail has not arrived: the loading view has no row and nothing focuses.
  const ui = mount(decisionsFixture(), { deferDetail: true })
  expect(ui.scrolledNodes).toEqual([])
  expect(ui.focusedNodes).toEqual([])
  // The detail arrives and `loaded` flips: the row scrolls and focuses, and
  // the title-focus effect that runs in the same commit yields to it.
  act(() => useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: detail(decisionsFixture()) }))
  ui.rerender()
  expect(ui.scrolledNodes).toEqual([['plan-change-api', { block: 'center' }]])
  expect(ui.focusedNodes).toEqual(['plan-change-api'])
  expect(useTeamPlanStore.getState().reveal).toBeNull()
})

test('a reveal requested while the plan is already open and loaded scrolls and focuses the row, and the title stays put', () => {
  const ui = mount(decisionsFixture())
  expect(ui.focusedNodes).toEqual(['plan-title'])
  act(() => useTeamPlanStore.getState().requestReveal('/repo', 'plan-1', 'plan-change-api'))
  expect(ui.scrolledNodes).toEqual([['plan-change-api', { block: 'center' }]])
  expect(ui.focusedNodes).toEqual(['plan-title', 'plan-change-api'])
  expect(useTeamPlanStore.getState().reveal).toBeNull()
  ui.rerender()
  expect(ui.scrolledNodes).toHaveLength(1)
})

test('a reveal for another plan scrolls and focuses its row when the selection changes, not the title of the plan that was open', () => {
  const ui = mount(decisionsFixture())
  expect(ui.focusedNodes).toEqual(['plan-title'])
  const view = useTeamPlanStore.getState().views['/repo']!
  const planTwo = detail(decisionsFixture(), 'plan-2')
  act(() => useTeamPlanStore.getState().applySnapshot({ type: 'team-plans-snapshot', teamPath: '/repo', teamId: 't', plans: [...(view.plans ?? []), planTwo.plan] }))
  // The link names plan-2; the host requests the reveal, then selects it.
  // A detail for an unselected plan is refused (applyDetail), so the switch
  // renders the loading view first and plan-2's detail arrives after — the
  // planId change and the loaded flip must not hand focus back to the title.
  act(() => useTeamPlanStore.getState().requestReveal('/repo', 'plan-2', 'plan-change-api'))
  act(() => useTeamPlanStore.getState().select('/repo', 'plan-2'))
  ui.rerender()
  expect(ui.focusedNodes).toEqual(['plan-title'])
  act(() => useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: planTwo }))
  ui.rerender()
  expect(ui.scrolledNodes).toEqual([['plan-change-api', { block: 'center' }]])
  expect(ui.focusedNodes).toEqual(['plan-title', 'plan-change-api'])
  expect(useTeamPlanStore.getState().reveal).toBeNull()
})

test('a reveal for one team does not scroll, focus, or consume in another team\'s detail of the same plan, and is consumed when that team mounts', () => {
  // Team /other shows plan-1 loaded; its own move-in focuses its title.
  const other = mount(decisionsFixture(), { teamPath: '/other' })
  expect(other.focusedNodes).toEqual(['plan-title'])
  // The attention link names team /repo's plan while /other is shown.
  act(() => useTeamPlanStore.getState().requestReveal('/repo', 'plan-1', 'plan-change-api'))
  expect(useTeamPlanStore.getState().reveal).toEqual({ teamKey: '/repo', planId: 'plan-1', anchor: 'plan-change-api' })
  expect(other.scrolledNodes).toEqual([])
  expect(other.focusedNodes).toEqual(['plan-title'])
  // Then the host mounts team /repo's view: its row takes the scroll and
  // focus, and the reveal is consumed once, by its own team.
  const repo = mount(decisionsFixture(), { teamPath: '/repo' })
  expect(repo.scrolledNodes).toEqual([['plan-change-api', { block: 'center' }]])
  expect(repo.focusedNodes).toEqual(['plan-change-api'])
  expect(useTeamPlanStore.getState().reveal).toBeNull()
})

test('a card the detail cannot render yet (no revision shown) leaves the focus on the title', () => {
  const navigated = openFromQueue({ kind: 'card', id: 'card-1', planId: 'plan-1' }, 'decision-question:card-1')
  expect(navigated).toEqual([{ teamKey: '/repo', tab: 'plans', id: 'plan-1' }])
  expect(useTeamPlanStore.getState().reveal).toEqual({ teamKey: '/repo', planId: 'plan-1', anchor: 'decision-card-card-1' })
  // The plan has no revision to show, so no Execution or Decisions section
  // renders and the card is nowhere in the tree: nothing can take the
  // scroll, and the title keeps the focus.
  const ui = mount(decisionsFixture(), { deferDetail: true })
  const bare = detail(decisionsFixture())
  bare.revisions = []
  act(() => useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: bare }))
  ui.rerender()
  expect(ui.scrolledNodes).toEqual([])
  expect(ui.focusedNodes).toEqual(['plan-title'])
  expect(useTeamPlanStore.getState().reveal).toBeNull()
})

test('a reveal naming an unknown change is dropped silently: no scroll, the detail at its top', () => {
  const navigated = openFromQueue({ kind: 'plan', id: 'plan-stop:x:nope:0', planId: 'plan-1', change: 'nope' }, 'plan-stop:x:nope:0')
  expect(navigated).toEqual([{ teamKey: '/repo', tab: 'plans', id: 'plan-1' }])
  expect(useTeamPlanStore.getState().reveal).toEqual({ teamKey: '/repo', planId: 'plan-1', anchor: 'plan-change-nope' })
  const ui = mount(decisionsFixture())
  expect(ui.scrolledNodes).toEqual([])
  expect(ui.focusedNodes).toEqual(['plan-title'])
  expect(ui.text()).not.toContain('Unknown change')
  expect(useTeamPlanStore.getState().reveal).toBeNull()
})
