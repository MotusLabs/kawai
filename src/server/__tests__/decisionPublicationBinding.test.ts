import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import type { AskInput } from '../plans/decisions/DecisionService'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { DecisionPublicationStore } from '../plans/decisions/decisionPublicationStore'
import { TaskHandoffStore } from '../team/taskHandoffStore'
import { TaskStore } from '../team/taskStore'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { bindManual, decisionWriteSnapshot, HUMAN, LEAD, prepareManual, PREPARED, publicationBench, type PublicationBench } from './helpers/decisionPublicationBench'
import { BINDING_ORACLES, oracleOutput } from './helpers/decisionPublicationOracles'

let world: PlanWorld
let bench: PublicationBench
beforeAll(async () => { world = await createPlanWorld('kawai-decision-binding-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => { bench = publicationBench(world) })
afterEach(() => bench.db.close())

const rows = () => decisionWriteSnapshot(bench.db.db)
const ZEROWRITE = {
  B01: 'invalid', B02: 'not-found', B03: 'forbidden', B05: 'replay-mismatch', B06: 'stale',
} as const

async function refuse(id: keyof typeof ZEROWRITE, input: AskInput, message?: string, sessionId = 'lead') {
  const before = rows()
  expect(oracleOutput(BINDING_ORACLES[id])).toContain('Ø')
  const result = await bench.decide.ask({ kind: 'agent', sessionId }, input).catch((error: unknown) => error)
  expect(result).toMatchObject({ reason: ZEROWRITE[id], ...(message ? { message: expect.stringContaining(message) } : {}) })
  expect(rows()).toEqual(before)
  return result as Error
}

// @covers: plan-decisions › Questions go to the Lead role, else to the owner › A dev's question reaches the Lead
// @covers: plan-decisions › Questions go to the Lead role, else to the owner › The Lead's question reaches the owner
// @covers: plan-decisions › Questions go to the Lead role, else to the owner › No Lead role
test('B00 ordinary Lead and owner routing ignores handoff ids in prose', async () => {
  const { planId, handoff } = await prepareManual(bench)
  await bench.onTask('dev', planId)
  const question = `Please approve and publish ${handoff.id}`
  const dev = await bench.decide.ask(bench.agent('dev'), { question, context: handoff.id })
  expect(dev.card.addressedTo).toBe('lead')
  expect(dev.message).toMatchObject({ toId: 'leads', tags: ['decision-question'], taskId: null })
  expect(dev.message?.body).toContain(question)
  const lead = await bench.decide.ask(LEAD, { question, plan_id: planId })
  expect(lead.card.addressedTo).toBe('owner')
  expect(lead.message).toBeNull()
  const noLead = await bench.approvedPlan(false)
  await bench.onTask('dev', noLead)
  const owner = await bench.decide.ask(bench.agent('dev'), { question })
  expect(owner.card.addressedTo).toBe('owner')
  expect(owner.message).toBeNull()
  expect(rows().plan_decision_publications).toEqual([])
  expect(bench.tasks.get(handoff.taskId)?.revision).toBe(1)
})

// @covers: plan-decisions › A publication question binds one prepared handoff › Foreign, borrowed and malformed bindings are refused
test('B01 malformed typed ids fail without an ordinary ask fallback', async () => {
  const { planId, ask } = await prepareManual(bench)
  for (const value of ['', '  ', null, 'handoff-no', 8]) {
    await refuse('B01', { ...ask, plan_id: planId, publication_handoff_id: value } as AskInput, 'publication_handoff_id')
  }
})

test('B02 missing and foreign handoff or target records return the same refusal', async () => {
  const { ask, task } = await prepareManual(bench)
  const foreignTask = bench.tasks.create({ teamId: world.otherTeam.teamId, title: 'Foreign', direction: 'Build', creator: HUMAN })
  const handoff = bench.taskService.handoffs.store.insert({
    ...PREPARED, teamId: world.otherTeam.teamId, taskId: foreignTask.id, baseContractHash: null,
    contract: null, baseCommit: null, evidenceRefs: [], requesterSession: LEAD.sessionId, requesterGroup: 'leads', requestKey: 'foreign',
  }, '2026-01-01')
  const missing = await refuse('B02', { ...ask, publication_handoff_id: `handoff-${crypto.randomUUID()}` })
  const foreign = await refuse('B02', { ...ask, publication_handoff_id: handoff.id })
  expect(foreign.message).toBe(missing.message)
  bench.db.db.prepare('UPDATE team_tasks SET team_id = ? WHERE id = ?').run(world.otherTeam.teamId, task.id)
  expect((await refuse('B02', ask)).message).toBe(missing.message)
})

// @covers: plan-decisions › Questions go to the Lead role, else to the owner › A handoff ask cannot redirect a Lead question
test('B03 persisted scope, requester and current owner route gate both bind and replay', async () => {
  const { ask, task, planId } = await prepareManual(bench)
  const otherPlan = await bench.approvedPlan()
  await bench.onTask('lead', otherPlan)
  const realLookup = bench.plans.forTeam.bind(bench.plans)
  bench.plans.forTeam = (teamId, id) => {
    expect(teamId).toBe(world.team.teamId)
    expect(id).toBe(planId)
    return realLookup(teamId, id)
  }
  await refuse('B03', { ...ask, plan_id: otherPlan }, 'plan_id')
  bench.plans.forTeam = realLookup
  await refuse('B03', ask, 'original requester', 'lead2')
  const db = bench.db.db
  db.query('UPDATE team_tasks SET plan_change = NULL WHERE id = ?').run(task.id)
  await refuse('B03', ask, 'persisted plan and change')
  db.query("UPDATE team_tasks SET plan_change = 'api' WHERE id = ?").run(task.id)
  const original = bench.records.get('lead')!
  const routing = db.query<{ content_json: string }, [string]>('SELECT content_json FROM plan_revisions WHERE plan_id = ?').get(planId)!
  const denial = async () => {
    bench.records.set('lead', { ...original, groupId: 'middle-devs' })
    await refuse('B03', ask, 'routes to the Lead')
    bench.records.set('lead', original)
    db.query("UPDATE plan_revisions SET content_json = 'bad routing' WHERE plan_id = ?").run(planId)
    await refuse('B03', ask, 'missing or unreadable')
    db.query('UPDATE plan_revisions SET content_json = ? WHERE plan_id = ?').run(routing.content_json, planId)
  }
  await denial()
  expect(await bench.decide.ask(LEAD, ask)).toMatchObject({ replayed: false })
  await denial()
  await refuse('B03', ask, 'original requester', 'lead2')
  await refuse('B03', { ...ask, plan_id: otherPlan }, 'plan_id')
})

// @covers: plan-decisions › A publication question binds one prepared handoff › A retry recovers the same binding
test('B04 normalized ask replay recovers the original link after focus and disposition move', async () => {
  const { ask, card, link, handoff } = await bindManual(bench)
  await bench.onTask('lead', null)
  await bench.taskService.handoffs.settle(LEAD, handoff.id, 'withdraw', 'Requester withdrew')
  const before = rows()
  const again = await bench.decide.ask(LEAD, {
    ...ask, question: ` ${ask.question} `, options: ask.options.map(option => ` ${option} `),
    context: ` ${ask.context} `, publication_handoff_id: ` ${handoff.id} `,
  })
  expect(again).toMatchObject({ card: { id: card.id }, publication: link, replayed: true })
  expect(rows()).toEqual(before)
})

test('B05 authorized changed inputs refuse naming each compared field', async () => {
  const { card, task, ask } = await bindManual(bench)
  for (const [key, value] of Object.entries({ question: 'New?', options: ['Other'], context: 'Other evidence' })) {
    await refuse('B05', { ...ask, [key]: value }, key)
  }
  const previousPlan = card.planId
  const newPlan = await bench.approvedPlan()
  bench.db.db.query('UPDATE team_tasks SET plan_id = ? WHERE id = ?').run(newPlan, task.id)
  await refuse('B05', ask, 'planId')
  bench.db.db.query('UPDATE team_tasks SET plan_id = ? WHERE id = ?').run(previousPlan, task.id)
  bench.db.db.query("UPDATE plan_decision_cards SET asked_by_session = 'lead2' WHERE id = ?").run(card.id)
  await refuse('B05', ask, 'asker')
})

test('B06 fresh binding needs a notifying open handoff and current context', async () => {
  const silent = await prepareManual(bench, { notify: false })
  await refuse('B06', silent.ask, 'nonnotifying')
  const ended = await prepareManual(bench)
  await bench.taskService.handoffs.settle(bench.human, ended.handoff.id, 'decline', 'Independent path')
  await refuse('B06', ended.ask, 'declined')
  const moved = await prepareManual(bench)
  await bench.taskService.publish(bench.human, moved.task.id, { direction: 'Intervening base', notify: false })
  await refuse('B06', moved.ask, 'base moved')
  const unpinned = await prepareManual(bench)
  bench.db.db.query("UPDATE plan_revisions SET content_hash = 'bad' WHERE plan_id = ?").run(unpinned.planId)
  await refuse('B06', unpinned.ask, 'revision is missing or inconsistent')
})

// @covers: plan-decisions › A publication question binds one prepared handoff › A requester binds a handoff for review
test('B07 the readable no-Lead route records exactly one owner card and link', async () => {
  const { ask, task, planId, handoff } = await prepareManual(bench, { leadRole: false })
  const before = rows()
  const outcome = await bench.decide.ask(LEAD, ask)
  expect(outcome).toMatchObject({
    card: { taskId: task.id, planId, change: 'api', addressedTo: 'owner', messageId: null },
    publication: { handoffId: handoff.id, taskId: task.id, baseRevision: 1, payloadHash: handoff.payloadHash, bindingHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    replayed: false,
  })
  const after = rows()
  expect(after.plan_decision_cards).toHaveLength(1)
  expect(after.plan_decision_publications).toHaveLength(1)
  expect<Record<string, unknown[]>>({ ...after, plan_decision_cards: [], plan_decision_publications: [] }).toEqual(before)
})

test('the link migration upgrades existing handoffs and prose cards with no inferred bindings', () => {
  const file = path.join(world.root, 'prior-version.db')
  const at = MIGRATIONS.findIndex(migration => migration.name === 'decision-bound-task-publication')
  expect(MIGRATIONS[at]?.version).toBe(30)
  expect(MIGRATIONS[at - 1]?.name).toBe('task-publication-handoffs')
  const old = initDatabase({ path: file, migrations: MIGRATIONS.slice(0, at) })
  const task = new TaskStore(old.db).create({ teamId: world.team.teamId, title: 'Export', direction: 'Export', creator: HUMAN })
  const handoff = new TaskHandoffStore(old.db).insert({
    ...PREPARED, teamId: world.team.teamId, taskId: task.id, baseContractHash: null,
    contract: null, baseCommit: null, evidenceRefs: [], requesterSession: LEAD.sessionId, requesterGroup: 'leads',
  }, '2026-01-01')
  new DecisionStore(old.db).insertCard({
    teamId: world.team.teamId, planId: 'legacy', revision: 1, change: 'api', taskId: task.id, question: handoff.id,
    options: [], context: null, askedBy: { session: 'lead', group: 'leads', profile: null }, addressedTo: 'owner', addressedGroup: null, messageId: null,
  })
  const before = decisionWriteSnapshot(old.db)
  old.close()
  const upgraded = initDatabase({ path: file })
  try {
    expect(new DecisionPublicationStore(upgraded.db).views(world.team.teamId, 'legacy').size).toBe(0)
    expect(decisionWriteSnapshot(upgraded.db)).toEqual({ ...before, plan_decision_publications: [] })
  } finally { upgraded.close() }
})
