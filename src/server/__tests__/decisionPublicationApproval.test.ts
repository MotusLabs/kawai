import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { DecisionClientMessage } from '../plans/decisions/decisionConnections'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { bindManual, decisionWriteSnapshot, LEAD, PREPARED, publicationBench, type PublicationBench } from './helpers/decisionPublicationBench'
import { APPROVAL_ORACLES, oracleOutput } from './helpers/decisionPublicationOracles'

let world: PlanWorld
let bench: PublicationBench
beforeAll(async () => { world = await createPlanWorld('kawai-decision-approval-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => { bench = publicationBench(world) })
afterEach(() => bench.db.close())

const state = () => decisionWriteSnapshot(bench.db.db)
const zeroWrite = {
  A01: 'invalid', A03: 'not-found', A04: 'replay-mismatch', A05: 'state',
  A07: 'state', A08: 'state', A09: 'stale', A10: 'state',
} as const

async function refuse(id: keyof typeof zeroWrite, command: DecisionClientMessage, why?: string) {
  const before = state()
  expect(oracleOutput(APPROVAL_ORACLES[id])).toContain('Ø')
  const reply = await bench.wire(command)
  expect(state()).toEqual(before)
  expect(reply.reason).toBe(zeroWrite[id])
  if (why) expect(reply.error).toContain(why)
  expect(reply.decision).toBeUndefined()
  expect(reply.publication).toBeUndefined()
  expect(reply.publicationReview).toBeUndefined()
  return reply
}

// @covers: plan-decisions › Fresh approval publishes only the reviewed handoff › An unauthorized or malformed approval writes nothing
test('A01 the human route rejects replacement fields and malformed approval echoes', async () => {
  const { approval } = await bindManual(bench)
  for (const extra of ['direction', 'acceptance', 'contract', 'choice', 'notify', 'taskId', 'baseRevision', 'actor']) {
    await refuse('A01', { ...approval, [extra]: 'replacement' }, extra)
  }
  for (const [field, value] of Object.entries({ expectedHandoffId: 'handoff-invalid', expectedBindingHash: '12345', cardId: '', commandId: '  ', rationale: 1 })) {
    await refuse('A01', { ...approval, [field]: value }, field)
  }
})

// @covers: plan-decisions › The owner answers open cards › No agent answers for the owner
test('A02 an agent cannot call the owner approval or read an owner review', async () => {
  const { approval } = await bindManual(bench)
  const before = state()
  const agent = { ...LEAD, team: bench.human.team }
  expect(oracleOutput(APPROVAL_ORACLES.A02)).toContain('Ø')
  await expect(bench.decide.approvePublication(agent, approval)).rejects.toMatchObject({ reason: 'forbidden' })
  expect(() => bench.decide.reviewPublication(agent, approval)).toThrow('Only the owner')
  expect(state()).toEqual(before)
})

test('A03 scope is checked before revealing an existing receipt or review', async () => {
  const { approval, card } = await bindManual(bench)
  expect((await bench.wire(approval)).publication?.cardId).toBe(card.id)
  await refuse('A03', { ...approval, teamPath: world.other })
  await refuse('A03', { ...approval, teamPath: `${world.other}/missing` })
  const otherPlan = await bench.approvedPlan()
  const other = await bench.decide.ask(LEAD, { plan_id: otherPlan, question: 'Unrelated' })
  await refuse('A03', { ...approval, cardId: other.card.id })
  await refuse('A03', { type: 'team-plan-publication-review', teamPath: world.other, requestId: 'review', planId: approval.planId, cardId: card.id })
})

// @covers: plan-decisions › One approval intent has one durable receipt › Reuse of a command id compares the action and input
test('A04 a used command key compares the exact payload and action in both directions', async () => {
  const { approval, card } = await bindManual(bench)
  const written = await bench.wire(approval)
  expect(written.publication?.cardId).toBe(card.id)
  const plain = await bench.decide.ask(LEAD, { plan_id: card.planId, question: 'An ordinary question' })
  const different: Record<string, string> = {
    cardId: plain.card.id, expectedHandoffId: `handoff-${crypto.randomUUID()}`, expectedBindingHash: 'f'.repeat(64), rationale: 'Changed',
  }
  for (const [field, value] of Object.entries(different)) {
    await refuse('A04', { ...approval, [field]: value }, field)
  }
  const answer = { type: 'team-plan-decide' as const, teamPath: world.repo, requestId: 'answer', cardId: card.id, planId: card.planId, commandId: approval.commandId, choice: 'Approve and publish' }
  await refuse('A04', answer, 'action')
  await refuse('A04', { ...answer, type: 'team-plan-override', expectedDecisionId: written.decision!.decision.id, rationale: 'Override' }, 'action')
  expect((await bench.wire({ ...answer, cardId: plain.card.id, commandId: 'ordinary-answer' })).decision?.card.id).toBe(plain.card.id)
  await refuse('A04', { ...approval, cardId: plain.card.id, commandId: 'ordinary-answer' }, 'action')
})

test('A05 a prepared key without its revision association cannot replay an approval', async () => {
  const { approval, task, card } = await bindManual(bench)
  expect((await bench.wire(approval)).publication?.cardId).toBe(card.id)
  bench.db.db.query('UPDATE team_task_revisions SET handoff_id = NULL WHERE task_id = ? AND revision = 2').run(task.id)
  await refuse('A05', approval, 'inconsistent receipt or publication evidence')
})

// @covers: plan-decisions › One approval intent has one durable receipt › Later decisions preserve the original receipt
test('A06 exact approval replay returns its receipt after the task and plan move', async () => {
  const { approval, task, planId } = await bindManual(bench)
  const first = await bench.wire(approval)
  expect(first.publication?.publishedRevision).toBe(2)
  await bench.taskService.publish(bench.human, task.id, { direction: 'Later edit', notify: false })
  bench.plans.setLifecycle(planId, 'completed')
  const before = state()
  expect(await bench.wire({ ...approval, commandId: ` ${approval.commandId} `, rationale: '  ', requestId: 'retry' })).toMatchObject({
    decision: first.decision, publication: first.publication, requestId: 'retry', replayed: true,
  })
  expect(state()).toEqual(before)
})

// @covers: plan-decisions › The human reviews the exact bound edit › Ordinary cards remain decision only
test('A07 an ordinary card with a handoff in its prose cannot publish', async () => {
  const { approval } = await bindManual(bench)
  const { card } = await bench.decide.ask(LEAD, { plan_id: approval.planId, question: `Approve ${approval.expectedHandoffId}` })
  await refuse('A07', { ...approval, cardId: card.id }, 'no publication binding')
})

// @covers: plan-decisions › The owner answers open cards › Answering a bound card publishes nothing
test('A08 an ordinary bound Answer is task-less, settles the card and publishes nothing', async () => {
  const { approval, card, task, handoff } = await bindManual(bench)
  await bench.taskService.handoffs.settle(LEAD, handoff.id, 'withdraw', 'No longer needed')
  const before = state()
  const answer = await bench.wire({
    type: 'team-plan-decide', teamPath: world.repo, requestId: 'answer', cardId: card.id,
    planId: card.planId, commandId: 'answer-only', choice: 'Approve and publish',
  })
  expect(answer.decision?.decision).toMatchObject({ choice: 'Approve and publish', decidedBy: { kind: 'human' } })
  expect(answer.publication).toBeUndefined()
  expect(bench.mail.get(answer.decision!.decision.replyMessageId!)).toMatchObject({ taskId: null, fromKind: 'human', toId: LEAD.sessionId, tags: ['decision-answer'] })
  expect(bench.tasks.get(task.id)?.revision).toBe(1)
  expect(state()).toMatchObject({
    team_task_revisions: before.team_task_revisions, team_task_handoffs: before.team_task_handoffs,
    team_task_notifications: before.team_task_notifications, plan_decision_publications: before.plan_decision_publications,
  })
  await refuse('A08', approval, 'already decided')
})

// @covers: plan-decisions › Fresh approval publishes only the reviewed handoff › A moved base or scope refuses approval
test('A09 well-formed stale echoes and drift of the bound base give zero writes', async () => {
  const { approval, task } = await bindManual(bench)
  await refuse('A09', { ...approval, expectedHandoffId: `handoff-${crypto.randomUUID()}` }, 'differs')
  await refuse('A09', { ...approval, expectedBindingHash: 'a'.repeat(64) }, 'differs')
  bench.db.db.query("UPDATE team_task_revisions SET direction = 'Other text with unchanged revision and contract' WHERE task_id = ? AND revision = 1").run(task.id)
  await refuse('A09', approval, 'baseContentHash')
})

test('A10 a late receipt write failure rolls back every row and leaves the key retryable', async () => {
  const { approval } = await bindManual(bench)
  const db = bench.db.db
  const seen: string[] = []
  const unwatch = bench.mail.subscribe((_team, message) => { if (message) seen.push(message.id) })
  try {
    db.exec(`CREATE TEMP TRIGGER refuse_combined BEFORE UPDATE OF decision_id ON plan_decision_publications
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
    await refuse('A10', approval, 'Retry the same approval')
    expect(seen).toEqual([])
  } finally {
    db.exec('DROP TRIGGER IF EXISTS refuse_combined')
    unwatch()
  }
  const retry = await bench.wire(approval)
  expect(retry.error).toBeUndefined()
  expect(retry.replayed).toBe(false)
  expect(retry.publication?.publishedRevision).toBe(2)
})

// @covers: plan-decisions › Fresh approval publishes only the reviewed handoff › The owner approves the prepared revision
test('A11 owner approval writes the exact prepared revision, decision, wakeup and receipt once', async () => {
  const { approval, card, handoff, task } = await bindManual(bench)
  const reply = await bench.wire({ ...approval, rationale: 'Owner rationale' })
  expect(reply.error).toBeUndefined()
  expect(reply.decision?.decision).toMatchObject({ seq: 1, choice: 'Approve and publish', rationale: 'Owner rationale', decidedBy: { kind: 'human' }, affected: [task.id] })
  expect(bench.tasks.revisions(task.id).at(-1)).toMatchObject({
    revision: 2, direction: PREPARED.direction, acceptance: PREPARED.acceptance, rationale: PREPARED.rationale, notify: true, author: { kind: 'human' },
  })
  expect(bench.taskService.handoffs.store.get(handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
  const wakeupId = reply.publication?.wakeupMessageId
  expect(typeof wakeupId).toBe('string')
  expect(reply.publication).toMatchObject({
    decisionId: reply.decision?.decision.id, cardId: card.id, handoffId: handoff.id, baseRevision: 1, publishedRevision: 2,
    noticeMessageIds: [], wakeupMessageId: wakeupId,
  })
  expect(bench.mail.get(wakeupId!)).toMatchObject({ taskId: null, tags: ['publication-handoff', 'handoff-published'], toId: 'lead' })
  expect(state().plan_decisions).toHaveLength(1)
})
