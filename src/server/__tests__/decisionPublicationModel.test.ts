import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { decisionHandlers } from '../plans/decisions/decisionTools'
import { ExecutionStore } from '../plans/execution/executionStore'
import { HoldService } from '../plans/revisionControl/holdService'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { ImpactStore } from '../strategy/impactStore'
import { loadHandoffDraft } from '../team/taskHandoffDrafts'
import { taskHandlers } from '../team/taskTools'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { decisionWriteSnapshot, HUMAN, LEAD, PREPARED, publicationBench, QUESTION, reopenPublicationBench } from './helpers/decisionPublicationBench'
import { type Command, COMMANDS, compareLedger, current, initial, type Handles, type Model, ready, apply } from './helpers/decisionPublicationModel'
import { propertyCases } from './helpers/propertyCases'

const CASES = 200
const SEED = 0xDEC10002
const OPENINGS: Command[][] = [
  ['prepare', 'ask', 'review', 'approve', 'approve', 'approve changed', 'answer', 'standalone', 'ordinary', 'reopen', 'approve', 'override'],
  ['prepare', 'ask', 'answer', 'approve', 'answer', 'reopen', 'ask', 'ask changed', 'review'],
  ['prepare', 'ask', 'standalone', 'approve', 'reopen', 'ask', 'standalone'],
  ['prepare', 'ask', 'ordinary', 'approve', 'review', 'reopen', 'ask'],
  ['prepare', 'ask', 'draft', 'linked', 'approve', 'reopen', 'ask'],
  ['prepare', 'ask', 'replace', 'ask', 'withdraw', 'approve', 'reopen', 'prepare', 'ask', 'decline', 'approve'],
  ['prepare', 'ask', 'hold', 'review', 'fault', 'reopen', 'approve', 'close', 'reopen', 'approve'],
  ['prepare', 'ask', 'draft', 'approve', 'linked', 'reopen', 'approve'],
  ['prepare', 'ask', 'close', 'reopen', 'approve', 'ask', 'answer', 'override'],
]
const FAULTS = [
  'AFTER INSERT ON team_task_revisions',
  'AFTER UPDATE OF handoff_id ON team_task_revisions',
  'AFTER INSERT ON team_task_handoff_events',
  'AFTER INSERT ON team_task_handoff_wakeups',
  'AFTER INSERT ON plan_decisions',
  'AFTER UPDATE OF decision_id ON plan_decision_publications',
]

let world: PlanWorld
beforeAll(async () => { world = await createPlanWorld('kawai-decision-command-model-') })
afterAll(() => { fs.rmSync(world.root, { recursive: true, force: true }) })

const MISSING_HANDOFF = 'handoff-00000000-0000-0000-0000-000000000001'
const MISSING_CARD = 'card-00000000-0000-0000-0000-000000000001'
type Bench = ReturnType<typeof publicationBench>

function approvalFor(planId: string, model: Model, handles: Handles) {
  const intent = current(model)
  const entry = intent && handles.get(intent.token)
  return {
    type: 'team-plan-approve-publication' as const, teamPath: world.repo, planId, cardId: entry?.cardId ?? MISSING_CARD,
    expectedHandoffId: entry?.handoff.id ?? MISSING_HANDOFF, expectedBindingHash: entry?.bindingHash ?? '0'.repeat(64),
    commandId: `approve:${intent?.token ?? 'missing'}`, requestId: 'approve',
  }
}

async function exercise(bench: Bench, planId: string, taskId: string, before: Model, handles: Handles,
  command: Command, token: string, faultIndex: number): Promise<{ error?: string; replayed?: boolean }> {
  const approve = approvalFor(planId, before, handles)
  const handoffId = approve.expectedHandoffId
  const { teamPath, cardId } = approve
  const task = bench.taskService
  switch (command) {
    case 'prepare':
    case 'replace': {
      const output = await taskHandlers(task, LEAD.sessionId).task_request_publication({
        task_id: taskId, base_revision: before.revisions.length, notify: true, direction: PREPARED.direction,
        acceptance: PREPARED.acceptance, rationale: PREPARED.rationale, request_key: token,
      })
      handles.set(token, { handoff: output.handoff })
      return { replayed: output.replay }
    }
    case 'ask':
    case 'ask changed': {
      const reply = await decisionHandlers(bench.decide, LEAD.sessionId).decision_ask({
        ...QUESTION, question: command === 'ask' ? QUESTION.question : 'Different question', publication_handoff_id: handoffId,
      })
      const row = bench.db.db.query<{ binding_hash: string }, [string]>('SELECT binding_hash FROM plan_decision_publications WHERE card_id = ?').get(reply.card_id)
      const existing = handles.get(current(before)!.token)!
      expect(row).not.toBeNull()
      if (existing.cardId) expect(reply.card_id).toBe(existing.cardId)
      existing.cardId = reply.card_id
      existing.bindingHash = row!.binding_hash
      return { replayed: 'replayed' in reply && reply.replayed === true }
    }
    case 'review': {
      const reply = await bench.wire({ type: 'team-plan-publication-review', teamPath, planId, cardId, requestId: token })
      const intent = current(before)
      if (intent?.card) expect(reply.publicationReview).toMatchObject({
        availability: intent.card.decision ? 'decided' : ready(before, intent) ? 'ready' : 'stale',
        link: { taskId, handoffId, baseRevision: intent.base },
      })
      return reply
    }
    case 'approve': return bench.wire(approve)
    case 'approve changed': return bench.wire({ ...approve, expectedBindingHash: 'e'.repeat(64) })
    case 'answer':
      return bench.wire({ type: 'team-plan-decide', teamPath, planId, cardId, requestId: token, commandId: `answer:${cardId}`, choice: 'Approve and publish' })
    case 'override': {
      const latest = bench.decisions.decisionsOfCard(world.team.teamId, cardId).at(-1)
      return bench.wire({ type: 'team-plan-override', teamPath, planId, cardId, requestId: token, commandId: token,
        expectedDecisionId: latest?.id ?? 'missing', choice: 'Forward fix', rationale: 'Newer owner decision' })
    }
    case 'ordinary':
      return task.publish(bench.human, taskId, { requestKey: token, baseRevision: before.revisions.length,
        direction: 'Independent direction', acceptance: null, rationale: 'Independent', notify: false }).then(output => ({ replayed: output.replay }))
    case 'standalone':
      return task.handoffs.publish(bench.human, taskId, handoffId, []).then(output => ({ replayed: output.replay }))
    case 'draft':
      await loadHandoffDraft(task, bench.human, taskId, handoffId, true)
      return {}
    case 'linked': {
      const saved = bench.tasks.drafts.get(taskId)
      if (!saved || !before.draft) return { error: 'No loaded draft to publish' }
      const output = await task.publish(bench.human, taskId, { requestKey: token, baseRevision: before.draft.base,
        direction: 'Edited linked direction', acceptance: PREPARED.acceptance, rationale: 'Draft edit', notify: true,
        fromDraft: true, observedDraft: saved.lineageId ?? null })
      return { replayed: output.replay }
    }
    case 'withdraw':
    case 'decline':
      await task.handoffs.settle(command === 'withdraw' ? LEAD : bench.human, handoffId, command, token)
      return {}
    case 'close':
      await task.setStatus(bench.human, taskId, 'cancelled')
      return {}
    case 'hold': {
      const result = new HoldService({
        holds: new HoldStore(bench.db.db), plans: bench.plans, planService: bench.service,
        strategies: bench.strategies, impact: new ImpactStore(bench.db.db), decisions: bench.decisions, executions: new ExecutionStore(bench.db.db),
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      }).place(bench.human, {
        planId, scope: 'changes', changes: ['api'], rationale: 'Hold dispatch while reviewing',
        deadline: '2026-01-02T00:00:00.000Z', commandId: 'hold-for-review',
      })
      return result.ok ? { replayed: result.replayed } : { error: result.message }
    }
    case 'fault': {
      const db = bench.db.db
      db.exec(`CREATE TEMP TRIGGER aborted_intent ${FAULTS[faultIndex]} BEGIN SELECT RAISE(ABORT, 'modeled approval fault'); END`)
      try {
        const reply = await bench.wire(approve)
        const intent = current(before)
        if (intent?.card && !intent.card.decision && ready(before, intent)) expect(reply.error).toContain('modeled approval fault')
        return reply
      } finally {
        db.exec('DROP TRIGGER aborted_intent')
      }
    }
    case 'reopen': return {}
  }
}

async function runShard(from: number, to: number) {
  const seen = new Set<Command>()
  const faults = new Set<number>()
  const approvedPrefix: Command[] = ['prepare', 'ask', 'review', 'fault', 'reopen', 'approve', 'reopen', 'approve']
  const openings = [...OPENINGS, ...FAULTS.map(() => approvedPrefix)]
  for (let index = from; index < Math.min(to, propertyCases(CASES)); index++) {
    const random = mulberry32(SEED ^ index)
    const prefix = openings[index % openings.length]!
    const length = 12 + Math.floor(random() * 9)
    const history = [...prefix, ...Array.from({ length: length - prefix.length }, () => COMMANDS[Math.floor(random() * COMMANDS.length)]!)]
    const file = path.join(world.root, `run-${index}.db`)
    let bench = publicationBench(world)
    try {
      const planId = await bench.approvedPlan()
      const taskId = bench.tasks.create({ teamId: world.team.teamId, title: `History ${index}`,
        direction: 'Original direction', acceptance: 'Original acceptance', creator: HUMAN, planId, planChange: 'api' }).id
      const model = initial()
      const handles: Handles = new Map()
      for (const [position, command] of history.entries()) {
        seen.add(command)
        const token = `step-${position}`
        const old = structuredClone(model)
        const expected = apply(model, command, token)
        const before = decisionWriteSnapshot(bench.db.db)
        let reply: { error?: string; replayed?: boolean }
        try {
          if (command === 'reopen') bench = reopenPublicationBench(world, bench, file)
          const fault = (index + FAULTS.length - OPENINGS.length) % FAULTS.length
          if (command === 'fault' && current(old)?.card?.decision === null && ready(old, current(old)!)) faults.add(fault)
          reply = await exercise(bench, planId, taskId, old, handles, command, token, fault)
        } catch (error) {
          if (!(error instanceof Error)) throw error
          reply = { error: error.message }
        }
        try {
          expect(reply.error === undefined).toBe(expected !== 'refused')
          if (expected === 'replay') expect(reply.replayed).toBe(true)
          if (expected !== 'write') expect(decisionWriteSnapshot(bench.db.db)).toEqual(before)
          compareLedger(bench.db.db, model, handles, taskId, planId)
        } catch (error) {
          throw new Error(`History ${index} at ${position}: ${history.slice(0, position + 1).join(', ')}; expected ${expected}; reply ${JSON.stringify(reply)}`, { cause: error })
        }
      }
    } finally { bench.db.close() }
  }
  if (from === 0) {
    expect([...seen].sort()).toEqual([...COMMANDS].sort())
    expect([...faults].sort()).toEqual(FAULTS.map((_, index) => index))
  }
}

test('I2 seed 0xDEC10002 — histories 1–50 compare the durable ledger after every command', () => runShard(0, 50))
test('I2 seed 0xDEC10002 — histories 51–100 compare the durable ledger after every command', () => runShard(50, 100))
test('I2 seed 0xDEC10002 — histories 101–150 compare the durable ledger after every command', () => runShard(100, 150))
test('I2 seed 0xDEC10002 — histories 151–200 compare the durable ledger after every command', () => runShard(150, 200))
