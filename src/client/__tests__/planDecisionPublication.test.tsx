import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { DecisionPublicationReceipt, PlanDecisionCardView, PublicationReview } from '@shared/planDecisions'
import type { ClientMessage, ServerMessage } from '@shared/types'
import PlanDecisionCard from '../components/team/PlanDecisionCard'
import { useTeamPlanStore } from '../stores/teamPlanStore'

const link = { taskId: 'task-1', handoffId: 'handoff-1', baseRevision: 3, payloadHash: 'a'.repeat(64), bindingHash: 'b'.repeat(64) }
const view: PlanDecisionCardView = {
  card: {
    id: 'card-1', teamId: 't', planId: 'plan-1', revision: 5, change: 'api', taskId: link.taskId,
    kind: 'question', question: 'Prepare the export?', options: ['Wait'], context: null,
    askedBy: { session: 'lead', group: 'leads', profile: null }, addressedTo: 'owner', addressedGroup: null,
    createdAt: '2026-10-14T00:00:00.000Z', messageId: null,
  },
  state: 'open', decisions: [], current: null, fixes: [], commits: [], publication: { ...link, receipt: null },
}
const contract = { version: 1 as const, acceptance: [{ id: 'A1', text: 'Exact headers' }], invariants: [], scope: ['src/**'],
  verification: [{ id: 'V1', text: 'Run CSV tests' }], excluded: [] }
const review: PublicationReview = {
  link, planId: 'plan-1', change: 'api', approvedPlanRevision: 6,
  execution: { id: 'exec-1', revision: 5, revisionSeq: 1, changeGeneration: 2, attemptId: 'attempt-1' },
  taskTitle: 'Export CSV', baseIdentity: 'r3#abc', baseContentHash: 'c'.repeat(64),
  before: { direction: 'Initial direction\nPreserve spacing', acceptance: 'Export rows', contract },
  after: { direction: 'Prepared direction', acceptance: 'Export rows', contract },
  requester: { sessionId: 'lead', groupId: 'leads' }, preparedRationale: 'CSV evidence', notify: true,
  baseCommit: 'd'.repeat(40), evidenceRefs: ['src/export.ts', 'result-evidence'], availability: 'ready', unavailableReason: null,
}
const store = () => useTeamPlanStore.getState()
const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  renderers.splice(0).forEach(renderer => act(() => renderer.unmount()))
  useTeamPlanStore.setState({ views: {}, reveal: null })
})

function mount(teamPath = '/repo', initial = view) {
  const sent: ClientMessage[] = []
  const opened: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  const element = (cardView: PlanDecisionCardView, connected: boolean, team: string) =>
    <PlanDecisionCard teamPath={team} planId={cardView.card.planId} cardView={cardView} sessions={[]} connected={connected} busy={false}
      onSend={message => sent.push(message)} onOpenTask={taskId => opened.push(taskId)} />
  act(() => {
    store().open(teamPath, initial.card.planId)
    renderer = TestRenderer.create(element(initial, true, teamPath))
  })
  renderers.push(renderer)
  const button = (label: string) => renderer.root.findAllByType('button').find(node => node.props.children === label)
  return {
    sent, opened, renderer, button,
    text: () => JSON.stringify(renderer.toJSON()),
    click: (label: string) => { const node = button(label)!; expect(node.props.disabled).not.toBe(true); act(() => node.props.onClick()) },
    render: (cardView = initial, connected = true, team = teamPath) => act(() => renderer.update(element(cardView, connected, team))),
    review: () => sent.findLast((message): message is Extract<ClientMessage, { type: 'team-plan-publication-review' }> =>
      message.type === 'team-plan-publication-review')!,
    approvals: () => sent.filter((message): message is Extract<ClientMessage, { type: 'team-plan-approve-publication' }> =>
      message.type === 'team-plan-approve-publication'),
  }
}
const reply = (data: Omit<Extract<ServerMessage, { type: 'team-plan-result' }>, 'type'>) =>
  act(() => store().applyResult({ type: 'team-plan-result', ...data }))

// @covers: plan-decisions › The human reviews the exact bound edit › Review is scoped to the card and base
test('W10 review displays exact bound before and after fields and ignores delayed responses from another team or card', () => {
  const ui = mount()
  ui.click('Review prepared publication…')
  const first = ui.review()
  expect(ui.button('Approve and publish')).toBeUndefined()
  reply({ requestId: first.requestId, teamPath: '/other-team', publicationReview: review })
  expect(ui.text()).not.toContain(review.after.direction)
  ui.click('Close review')
  const secondCard = { ...view, card: { ...view.card, id: 'card-2' }, publication: { ...link, handoffId: 'handoff-2', receipt: null } }
  ui.render(secondCard)
  ui.click('Review prepared publication…')
  const second = ui.review()
  reply({ teamPath: '/repo', requestId: first.requestId, publicationReview: review })
  expect(ui.text()).not.toContain(review.after.direction)
  reply({ teamPath: '/repo', requestId: second.requestId, publicationReview: review })
  expect(ui.text()).toContain('The review could not be matched to this card.')
  ui.click('Close review')
  ui.render()
  ui.click('Review prepared publication…')
  reply({ teamPath: '/repo', requestId: ui.review().requestId, publicationReview: review })
  const text = ui.text()
  for (const field of [
    review.baseIdentity, review.baseContentHash, review.before.direction.replace('\n', '\\n'), review.after.direction,
    review.link.payloadHash, review.link.bindingHash, review.preparedRationale, review.baseCommit!, ...review.evidenceRefs,
  ]) expect(text).toContain(field)
  expect(text.match(/Exact headers/g)).toHaveLength(2)
  expect(text.match(/Export rows/g)).toHaveLength(2)
  expect(ui.button('Approve and publish')?.props.disabled).toBe(false)
  expect(ui.approvals()).toEqual([])
})

test('W10 disconnect disables confirmation and an explicit resend reuses the original normalized intent', () => {
  const ui = mount()
  ui.click('Review prepared publication…')
  reply({ teamPath: '/repo', requestId: ui.review().requestId, publicationReview: review })
  ui.render(view, false)
  expect(ui.button('Approve and publish')?.props.disabled).toBe(true)
  ui.render()
  act(() => ui.renderer.root.findByType('textarea').props.onChange({ target: { value: '  Approved after review  ' } }))
  ui.click('Approve and publish')
  const [first] = ui.approvals()
  expect(first).toMatchObject({
    cardId: view.card.id, teamPath: '/repo', planId: 'plan-1', expectedHandoffId: link.handoffId,
    expectedBindingHash: link.bindingHash, rationale: 'Approved after review',
  })
  expect(ui.button('Approve and publish')?.props.disabled).toBe(true)
  ui.render(view, false)
  act(() => store().reconnected('/repo'))
  ui.render()
  expect(ui.approvals()).toHaveLength(1)
  ui.click('Approve and publish')
  const [, retry] = ui.approvals()
  expect(retry!.requestId).not.toBe(first!.requestId)
  expect({ ...retry, requestId: first!.requestId }).toEqual(first)
  reply({ teamPath: '/repo', requestId: retry!.requestId, reason: 'stale', error: 'The base moved from revision 3 to 4.' })
  expect(ui.text()).toContain('The base moved from revision 3 to 4.')
  expect(ui.button('Approve and publish')?.props.disabled).toBe(true)
  expect(ui.button('Answer without publishing…')).toBeDefined()
})

test('W10 a state refusal permits only an explicit retry after another ready review', () => {
  const ui = mount()
  ui.click('Review prepared publication…')
  reply({ teamPath: '/repo', requestId: ui.review().requestId, publicationReview: review })
  ui.click('Approve and publish')
  const [first] = ui.approvals()
  reply({ teamPath: '/repo', requestId: first!.requestId, reason: 'state', error: 'Write rolled back, retry if the failure was transient.' })
  expect(ui.button('Approve and publish')?.props.disabled).toBe(true)
  ui.click('Review again to retry')
  expect(ui.approvals()).toHaveLength(1)
  reply({ teamPath: '/repo', requestId: ui.review().requestId, publicationReview: review })
  ui.click('Approve and publish')
  const [, retry] = ui.approvals()
  expect({ ...retry, requestId: first!.requestId }).toEqual(first)
})

// @covers: plan-decisions › The human reviews the exact bound edit › Ordinary cards remain decision only
// @covers: plan-decisions › The owner answers open cards › Answering a bound card publishes nothing
test('W09 answer-only and override controls distinguish ordinary text from historical publication receipts', () => {
  const ordinary = mount('/ordinary', { ...view, publication: undefined })
  expect(ordinary.button('Answer…')).toBeDefined()
  expect(ordinary.button('Review prepared publication…')).toBeUndefined()
  const bound = mount()
  bound.click('Answer without publishing…')
  const choice = bound.renderer.root.findByProps({ 'aria-label': 'Another choice' })
  act(() => choice.props.onChange({ target: { value: 'Approve and publish' } }))
  bound.click('Answer without publishing')
  expect(bound.sent).toEqual([expect.objectContaining({ type: 'team-plan-decide', choice: 'Approve and publish' })])
  const answered: PlanDecisionCardView = { ...view, state: 'decided', current: {
    id: 'answered', cardId: view.card.id, planId: view.card.planId, teamId: view.card.teamId, seq: 1, kind: 'answer',
    choice: 'Approve and publish', optionIndex: null, rationale: null, affected: [link.taskId],
    decidedBy: { kind: 'human', session: null, group: null, profile: null }, createdAt: view.card.createdAt, commandId: 'answer-only', replyMessageId: null,
  } }
  bound.render(answered)
  expect(bound.text()).not.toContain('Published task revision')
  expect(bound.button('Override…')).toBeDefined()
  const receipt: DecisionPublicationReceipt = {
    ...link, planId: view.card.planId, cardId: view.card.id, decisionId: 'published-decision', commandId: 'recorded-intent',
    publishedRevision: 4, publishedAt: '2026-10-14T00:00:00.000Z', noticeMessageIds: ['initial-notice'], wakeupMessageId: 'requester-notice',
  }
  const recovered = mount('/reloaded', { ...answered, publication: { ...link, receipt } })
  expect(recovered.text()).toContain('Published task revision ')
  expect(recovered.text()).toContain('initial-notice')
  expect(recovered.text()).toContain('recorded-intent')
  expect(recovered.approvals()).toEqual([])
  expect(recovered.button('Override…')).toBeDefined()
})
