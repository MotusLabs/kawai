// The decision reply guard (plan-supervision 6.2, design D9): a reply to an
// open card's question is refused for an agent and for the human with
// nothing queued; after the decision a reply is queued; DecisionService's
// answers bypass it; a mailbox without a guard passes everything. The last
// test goes through SessionMailbox, the production mailbox that both the
// `reply` tool and the human composer call.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { decisionReplyGuard, QUESTION_TAG } from '../plans/decisions/decisionReplyGuard'
import { NULL_OWNERSHIP } from '../plans/execution/executionOwnership'
import { SessionMailbox } from '../team/sessionMailbox'
import { SessionTeams } from '../team/sessionTeams'
import { TeamMailbox } from '../team/TeamMailbox'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

let world: PlanWorld
let bench: DecisionBench

beforeAll(async () => { world = await createPlanWorld('kawai-decision-guard-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
})

const lead = { kind: 'agent' as const, sessionId: 'lead' }
const dev = { kind: 'agent' as const, sessionId: 'dev' }
const count = () => (bench.db.db.prepare(`SELECT COUNT(*) AS n FROM team_messages`).get() as { n: number }).n

/** A dev on a plan task asks; the question mail is delivered to the Lead. */
async function openCard() {
  const planId = await bench.approvedPlan()
  await bench.onTask('dev', planId, 'ui')
  const { card, message } = await bench.decide.ask(dev, { question: 'Which store?', options: ['sqlite', 'files'] })
  bench.db.db.prepare(`UPDATE team_messages SET state = 'delivered', claimed_by = 'lead', delivered_at = ? WHERE id = ?`).run(new Date().toISOString(), message!.id)
  return { planId, card, question: message! }
}

describe('a reply to an open card question is refused (D9)', () => {
  test('an agent is pointed at decision_record, and nothing is queued', async () => {
    const { planId, card, question } = await openCard()
    expect(question.tags).toContain(QUESTION_TAG)
    const before = count()
    await expect(bench.mailbox.reply(lead, { message_id: question.id, body: 'sqlite' }))
      .rejects.toThrow(`decision_record({ plan_id, card_id, … }) so the decision is recorded (plan_id: "${planId}", card_id: "${card.id}"); nothing was sent.`)
    expect(count()).toBe(before)
  })

  test("the human is pointed at the card's Answer in the Plans view, and nothing is queued", async () => {
    const { card, question } = await openCard()
    const before = count()
    await expect(bench.mailbox.reply(bench.human, { message_id: question.id, body: 'sqlite' }))
      .rejects.toThrow(`decision card ${card.id}. Answer it with the card's Answer in the Plans view`)
    expect(count()).toBe(before)
  })

  test('after the decision a reply is queued in the thread', async () => {
    const { planId, card, question } = await openCard()
    await bench.decide.record(lead, { plan_id: planId, card_id: card.id, option_index: 1, rationale: 'one file' })
    const before = count()
    const reply = await bench.mailbox.reply(lead, { message_id: question.id, body: 'More context on why.' })
    expect(reply.threadId).toBe(question.threadId)
    expect(count()).toBe(before + 1)
  })

  test("DecisionService's answers bypass the guard: the Lead's and the owner's", async () => {
    const first = await openCard()
    const recorded = await bench.decide.record(lead, { plan_id: first.planId, card_id: first.card.id, option_index: 2, rationale: 'r' })
    expect(recorded.message?.inReplyTo).toBe(first.question.id)
    const second = await bench.decide.ask(dev, { question: 'Which port?', options: ['1', '2'] })
    const owner = await bench.decide.answer(bench.human, { planId: first.planId, cardId: second.card.id, optionIndex: 1, commandId: 'a-1' })
    expect(owner.message?.inReplyTo).toBe(second.message!.id)
  })

  test('a mailbox without a guard passes everything', async () => {
    const { question } = await openCard()
    const bare = new TeamMailbox(bench.mail, { getSession: id => bench.records.get(id), homeDir: world.home, tasks: bench.tasks })
    const reply = await bare.reply(lead, { message_id: question.id, body: 'sqlite' })
    expect(reply.inReplyTo).toBe(question.id)
  })

  test('a reply to ordinary mail is untouched by the guard', async () => {
    const guard = decisionReplyGuard(bench.decisions)
    const { question } = await openCard()
    expect(guard({ ...question, tags: [] }, lead)).toBeNull()
  })
})

test('the production mailbox (SessionMailbox) carries the guard', async () => {
  const { card, question } = await openCard()
  const teams = new SessionTeams({ homeDir: world.home })
  for (const id of ['lead', 'dev']) await teams.track(id, bench.records.get(id)!.projectPath)
  const runtime = new SessionMailbox(bench.db.db, {
    ownership: NULL_OWNERSHIP, onTaskResultWrite: () => {},
    teams, records: () => bench.records.values(), getRecord: id => bench.records.get(id), available: record => !record.archivedAt,
    getDriver: () => ({ getPendingRequests: () => [], deliver: () => {} }) as unknown as ChatSessionDriver,
    prepare: async () => {}, restore: () => {}, watchReceipt: () => {}, archive: () => ({ ok: true }), hasLiveWorkers: () => false,
    hasRunningBackgroundTasks: () => false, transcriptFor: () => null, homeDir: world.home, onError: error => { throw error },
  })
  try {
    await expect(runtime.mailbox.reply(lead, { message_id: question.id, body: 'x' })).rejects.toThrow(`decision card ${card.id}`)
    await expect(runtime.mailbox.reply(bench.human, { message_id: question.id, body: 'x' })).rejects.toThrow("the card's Answer in the Plans view")
    expect(new DecisionStore(bench.db.db).decisionsOfCard(world.team.teamId, card.id)).toEqual([])
  } finally {
    runtime.close()
  }
})
