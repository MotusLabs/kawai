import { expect, test } from 'bun:test'
import type { PlanDecisionCardView } from '../../shared/planDecisions'
import type { TaskHandoff } from '../../shared/taskHandoffs'
import type { TaskAcknowledgement } from '../../shared/teamTasks'
import type { ClientMessage } from '../../shared/types'
import { PREPARED, QUESTION } from './helpers/decisionPublicationBench'
import { publicationRuntime, waitFor, type Focus } from './helpers/decisionPublicationRuntime'

type Runtime = Awaited<ReturnType<typeof publicationRuntime>>
type Asked = {
  card_id: string; addressed_to: string; replayed: boolean
  publication: { handoff_id: string; task_id: string; base_revision: number; payload_hash: string }
}

async function bindAfterMail(runtime: Runtime, focus: Focus) {
  const { db, task, plan, lead, leadTool, teamPath, routed } = runtime
  expect(runtime.tools()).toEqual(expect.arrayContaining(['task_request_publication', 'task_get', 'decision_ask', 'plan_get']))
  expect(runtime.tools()).not.toContain('team-plan-approve-publication')
  const { handoff } = await leadTool<{ handoff: TaskHandoff }>('task_request_publication', {
    task_id: task.id, base_revision: 1, request_key: PREPARED.requestKey, direction: PREPARED.direction,
    acceptance: PREPARED.acceptance, rationale: PREPARED.rationale, evidence_refs: ['fixture-review'],
  })
  const named = { task_id: task.id, handoff_id: handoff.id }
  expect((await leadTool<{ handoff: TaskHandoff }>('task_get', named)).handoff).toMatchObject({
    id: handoff.id, taskId: task.id, state: 'open', baseRevision: 1, payloadHash: handoff.payloadHash,
    requesterSession: lead, notify: true,
  })
  const oldFocus = db.getChatSession(lead)?.taskId
  const { other, messageId } = await runtime.sendFocus(focus)
  expect(other.id).not.toBe(task.id)
  expect(other.id).not.toBe(oldFocus)
  expect(db.getChatSession(lead)?.taskId).toBe(other.id)
  expect(runtime.transcript(lead)).toContain(messageId)
  const before = runtime.snapshot()
  const asked = await leadTool<Asked>('decision_ask', {
    ...QUESTION, plan_id: plan.planId, publication_handoff_id: handoff.id,
  })
  expect(asked).toMatchObject({
    addressed_to: 'owner', replayed: false,
    publication: { handoff_id: handoff.id, task_id: task.id, base_revision: 1, payload_hash: handoff.payloadHash },
  })
  const after = runtime.snapshot()
  expect(after.plan_decision_cards).toHaveLength(1)
  expect(after.plan_decision_publications).toHaveLength(1)
  expect<Record<string, unknown[]>>({ ...after, plan_decision_cards: [], plan_decision_publications: [] }).toEqual(before)
  expect(db.getChatSession(lead)?.taskId).toBe(other.id)
  const readCard = async () => {
    const read = await leadTool<{ decisions: PlanDecisionCardView[] }>('plan_get', { plan_id: plan.planId })
    return read.decisions.find(view => view.card.id === asked.card_id)!
  }
  const view = await readCard()
  expect(view.card).toMatchObject({
    id: asked.card_id, planId: plan.planId, taskId: task.id, change: 'api', revision: plan.revision, messageId: null,
  })
  expect(view.publication).toMatchObject({ taskId: task.id, handoffId: handoff.id, baseRevision: 1, payloadHash: handoff.payloadHash, receipt: null })
  expect(JSON.stringify(view.publication)).not.toContain(PREPARED.direction)
  const result = await routed('team-plan-result', {
    type: 'team-plan-publication-review', teamPath, planId: plan.planId, cardId: asked.card_id, requestId: 'review',
  })
  expect(result.error).toBeUndefined()
  const review = result.publicationReview!
  expect(review.link.bindingHash).toBe(view.publication!.bindingHash)
  expect(review).toMatchObject({
    planId: plan.planId, change: 'api', taskTitle: task.title, approvedPlanRevision: runtime.approved.revision,
    execution: { id: runtime.execution.id, revision: plan.revision, revisionSeq: 1, attemptId: runtime.attempt.id },
    before: { direction: task.direction, acceptance: task.acceptance, contract: task.contract! },
    after: { direction: PREPARED.direction, acceptance: PREPARED.acceptance, contract: task.contract! },
    preparedRationale: PREPARED.rationale, evidenceRefs: ['fixture-review'], notify: true, availability: 'ready',
  })
  const command: Extract<ClientMessage, { type: 'team-plan-approve-publication' }> = {
    type: 'team-plan-approve-publication', teamPath, planId: plan.planId, cardId: asked.card_id, requestId: 'approve',
    commandId: 'same-approval-intent', expectedHandoffId: review.link.handoffId, expectedBindingHash: review.link.bindingHash, rationale: 'Owner approves the diff',
  }
  return { handoff, named, command, readCard, other }
}

async function lateFailure(runtime: Runtime, command: Extract<ClientMessage, { type: 'team-plan-approve-publication' }>) {
  const { frames, route, routed, teamPath, task, plan, db, manager, snapshot } = runtime
  const opened = frames.length
  route({ type: 'team-plan-open', teamPath, planId: plan.planId })
  route({ type: 'team-task-open', teamPath, taskId: task.id })
  route({ type: 'team-mailbox-open', teamPath })
  await waitFor(() => ['team-plan-detail', 'team-task-detail', 'team-mailbox-snapshot'].every(type => frames.slice(opened).some(frame => frame.type === type)), 'three subscriptions')
  const nextFrame = frames.length
  const before = snapshot()
  const mailboxChanges: string[] = []
  const unwatch = manager.mailbox.store.subscribe((_team, message) => {
    if (message?.tags.some(tag => tag === 'handoff-published' || tag === 'task-revision')) mailboxChanges.push(message.id)
  })
  db.db.exec(`CREATE TEMP TRIGGER rollback_decision_publication BEFORE UPDATE OF decision_id ON plan_decision_publications
    BEGIN SELECT RAISE(ABORT, 'late receipt failure'); END`)
  try {
    const failure = await routed('team-plan-result', { ...command, requestId: 'late-failure' })
    expect(failure.reason).toBe('state')
    expect(failure.error).toContain('late receipt failure')
    expect(failure.publication).toBeUndefined()
    expect(snapshot()).toEqual(before)
    expect(mailboxChanges).toEqual([])
    for (const frame of frames.slice(nextFrame)) {
      if (frame.type === 'team-task-detail') expect(frame.detail.task.revision).toBe(1)
      if (frame.type === 'team-plan-detail') {
        const card = frame.detail.decisions?.find(view => view.card.id === command.cardId)
        expect(card?.publication?.receipt).toBeNull()
        expect(card?.decisions).toEqual([])
      }
      if (frame.type === 'team-mailbox-snapshot') {
        expect(frame.messages.some(message => message.tags.includes('handoff-published') || message.tags.includes('task-revision'))).toBe(false)
      }
    }
  } finally {
    db.db.exec('DROP TRIGGER rollback_decision_publication')
    unwatch()
  }
}

// @covers: plan-decisions › A publication question binds one prepared handoff › A requester binds a handoff for review
// @covers: plan-decisions › The human reviews the exact bound edit › Review is scoped to the card and base
// @covers: plan-decisions › Fresh approval publishes only the reviewed handoff › The owner approves the prepared revision
// @covers: task-revision-publication › An approved handoff publishes as the human with its original notices › Publication reaches the current holder and requester
// @covers: task-revision-publication › An approved handoff publishes as the human with its original notices › Delivery and acknowledgement remain distinct
test('W01 registered handoff and focus mail reach routed approval, holder delivery and a distinct ACK', async () => {
  for (const focus of ['unlinked', 'sibling', 'other-plan'] as const) {
    const runtime = await publicationRuntime()
    try {
      const { manager, db, task, lead, holder, teamPath, routed, leadTool, holderTool, transcript, initialMessageId } = runtime
      const { handoff, named, command, readCard, other } = await bindAfterMail(runtime, focus)
      expect((await routed('team-task-result', {
        type: 'team-task-draft', teamPath, taskId: task.id, requestId: 'draft', action: 'save', baseRevision: 1, direction: 'Independent draft',
      })).error).toBeUndefined()
      const draft = manager.tasks.store.drafts.get(task.id)!
      if (focus === 'unlinked') await lateFailure(runtime, command)
      const result = await routed('team-plan-result', command)
      expect(result.error).toBeUndefined()
      expect(result.decision?.decision).toMatchObject({
        seq: 1, choice: 'Approve and publish', rationale: command.rationale, decidedBy: { kind: 'human' }, affected: [task.id],
      })
      const receipt = result.publication!
      expect(receipt).toMatchObject({ cardId: command.cardId, handoffId: handoff.id, taskId: task.id, publishedRevision: 2, baseRevision: 1 })
      const noticeIds = receipt.noticeMessageIds
      const wakeupId = receipt.wakeupMessageId!
      expect(noticeIds).toHaveLength(1)
      expect(typeof wakeupId).toBe('string')
      const noticeId = noticeIds[0]!
      const mail = manager.mailbox.store
      await waitFor(() => mail.get(noticeId)?.state === 'delivered' && mail.get(wakeupId)?.state === 'delivered', 'the holder notice and requester wakeup delivered')
      const notice = mail.get(noticeId)!
      expect(notice).toMatchObject({
        toKind: 'session', toId: holder, claimedBy: holder, taskId: task.id, taskRevision: 2,
        tags: ['task-revision'], revisionNotice: { revision: 2, previousRevision: 1, rationale: PREPARED.rationale },
      })
      expect(transcript(holder)).toContain(noticeId)
      expect(transcript(holder)).toContain(PREPARED.rationale)
      expect(transcript(holder)).toContain(PREPARED.direction)
      expect(transcript(lead)).toContain(wakeupId)
      expect(mail.get(wakeupId)).toMatchObject({ toId: lead, taskId: null, tags: ['publication-handoff', 'handoff-published'] })
      expect(db.getChatSession(lead)?.taskId).toBe(other.id)
      expect(mail.get(initialMessageId)?.taskRevision).toBe(1)
      expect(manager.tasks.store.revisions(task.id).at(-1)).toMatchObject({
        revision: 2, direction: PREPARED.direction, acceptance: PREPARED.acceptance,
        rationale: PREPARED.rationale, author: { kind: 'human' }, contractHash: task.contractHash!,
      })
      expect(manager.tasks.store.drafts.get(task.id)).toEqual(draft)
      const taskRead = () => leadTool<{ handoff: TaskHandoff; acknowledgements: TaskAcknowledgement[] }>('task_get', named)
      const beforeAck = await taskRead()
      expect(beforeAck.handoff).toMatchObject({ state: 'published', publishedRevision: 2 })
      expect((await readCard()).publication?.receipt).toEqual(receipt)
      if (focus === 'unlinked') await waitFor(() => runtime.frames.some(frame =>
        frame.type === 'team-plan-detail' && frame.detail.decisions?.some(view => view.publication?.receipt?.decisionId === receipt.decisionId)), 'the committed receipt on the plan subscription')
      expect(beforeAck.acknowledgements.find(ack => ack.sessionId === holder)).toBeUndefined()
      expect(manager.tasks.store.acknowledgements.highest(task.id, holder)).toBeNull()
      await holderTool('task_acknowledge', { task_id: task.id, revision: 2 })
      expect(manager.tasks.store.acknowledgements.highest(task.id, holder)).toBe(2)
      expect((await taskRead()).acknowledgements).toContainEqual(expect.objectContaining({ sessionId: holder, revision: 2 }))
    } finally { await runtime.teardown() }
  }
})

// @covers: plan-decisions › Fresh approval publishes only the reviewed handoff › A moved base or scope refuses approval
test('W02 an intervening direction publication with the same contract refuses approval with zero effects', async () => {
  const runtime = await publicationRuntime()
  try {
    const { handoff, command, readCard } = await bindAfterMail(runtime, 'unlinked')
    const { teamPath, task, manager, routed, snapshot } = runtime
    const intervening = await routed('team-task-result', {
      type: 'team-task-publish', teamPath, taskId: task.id, requestId: 'intervening', requestKey: 'different-publication',
      baseRevision: 1, direction: 'Independent new direction', rationale: 'Published during review', notify: false,
    })
    expect(intervening.error).toBeUndefined()
    expect(manager.tasks.store.get(task.id)).toMatchObject({ revision: 2, contractHash: task.contractHash! })
    const wakeup = runtime.db.db.query<{ message_id: string }, [string]>(
      "SELECT message_id FROM team_task_handoff_wakeups WHERE handoff_id = ? AND transition = 'stale'",
    ).get(handoff.id)!
    await waitFor(() => manager.mailbox.store.get(wakeup.message_id)?.state === 'delivered', 'the independent stale wakeup')
    const before = snapshot()
    const refused = await routed('team-plan-result', command)
    expect(refused.reason).toBe('stale')
    expect(refused.error).toContain('base moved from revision 1 to 2')
    expect(refused.publication).toBeUndefined()
    expect(refused.decision).toBeUndefined()
    expect(snapshot()).toEqual(before)
    expect((await readCard()).publication?.receipt).toBeNull()
  } finally { await runtime.teardown() }
})
