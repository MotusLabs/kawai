// The ledger's reads (review-findings-ledger 6.1, D10): task_get's
// findingsLedger with each finding's transitions, bounded to the newest 100
// rows; text-only findings outside the ledger; and the delivered task
// header's findings line — all over the production services and tools.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import { TaskResultService } from '../team/TaskResultService'
import { taskHandlers } from '../team/taskTools'
import { buildTaskContext, formatTaskHeader } from '../team/taskContext'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

let world: PlanWorld
let bench: DecisionBench
let results: TaskResultService

beforeAll(async () => { world = await createPlanWorld('kawai-task-get-ledger-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
  results = new TaskResultService(bench.taskService, { getSession: id => bench.records.get(id) })
})

const dev = { kind: 'agent' as const, sessionId: 'dev' }
const tools = (session: string) => taskHandlers(bench.taskService, session, results) as Record<string, (input: unknown) => Promise<any>>
const manual = () => bench.tasks.create({ teamId: world.team.teamId, title: 'Manual', direction: 'Build', creator: { kind: 'agent', sessionId: 'lead' } })
function review(taskId: string, resultId: string, findings: Array<Record<string, unknown>>, dispositions: Array<Record<string, unknown>> = []) {
  const task = bench.tasks.get(taskId)!
  return results.findingsLedger.submit({
    teamId: world.team.teamId, task, result: bench.tasks.results.get(resultId)!, author: { kind: 'agent', sessionId: 'lead2' }, handoffId: null, counted: true,
    submission: { kind: 'review', findings: findings as never, dispositions: dispositions as never },
  })
}

// @covers: review-findings › Each task has a findings ledger › The ledger shows a finding's history
test('task_get lists F2 accepted on R1, disputed, upheld, and resolved on R2, in order, each naming its result or decision', async () => {
  const task = manual()
  const r1 = await results.submit(dev, task.id, { summary: 'r1', commit: 'abc' })
  review(task.id, r1.id, [
    { level: 'P1', clause: task.identity, evidence: 'src/a.ts:1', impact: 'x' },
    { level: 'P1', clause: task.identity, evidence: 'src/b.ts:1', impact: 'y' },
  ])
  await tools('dev').task_dispute_findings({ task_id: task.id, disputes: [{ id: 'F2', counter_evidence: 'b.ts:1 is fine' }] })
  await tools('lead').task_decide_dispute({ task_id: task.id, finding_id: 'F2', decision: 'uphold', rationale: 'reproduced' })
  const r2 = await results.submit(dev, task.id, { summary: 'r2', commit: 'def' })
  review(task.id, r2.id, [], [{ id: 'F1', disposition: 'resolved' }, { id: 'F2', disposition: 'resolved' }])
  const detail = await tools('lead').task_get({ task_id: task.id })
  const f2 = detail.findingsLedger.find((row: { id: string }) => row.id === 'F2')
  expect(f2.transitions.map((entry: { kind: string }) => entry.kind)).toEqual(['accepted', 'disputed', 'upheld', 'resolved'])
  expect(f2.transitions[0]).toMatchObject({ source: 'submission', resultId: r1.id })
  expect(f2.transitions[1]).toMatchObject({ source: 'event', note: 'b.ts:1 is fine' })
  expect(f2.transitions[2]).toMatchObject({ source: 'event', note: 'reproduced' })
  expect(f2.transitions[3]).toMatchObject({ source: 'submission', resultId: r2.id })
  expect(detail.findingsLedger.map((row: { id: string }) => row.id)).toEqual(['F2', 'F1'])
  expect(detail.ledgerOlderRemaining).toBe(false)
  // Each result's findings rows carry their items, class, and counted flag.
  const rows = detail.results.flatMap((result: { findings: unknown[] }) => result.findings)
  expect(rows.find((row: { resultId: string }) => row.resultId === r1.id)).toMatchObject({ structured: true, counted: true, items: [{ findingId: 'F1', class: 'accepted' }, { findingId: 'F2', class: 'accepted' }] })
})

// @covers: review-findings › Each task has a findings ledger › Text-only findings stay readable
test('text-only findings read as unstructured with their verdict, and the ledger has no rows for them', async () => {
  const task = manual()
  const r1 = await results.submit(dev, task.id, { summary: 'r1', commit: 'abc' })
  await results.submitFindings({ kind: 'agent', sessionId: 'lead2' }, task.id, { resultId: r1.id, kind: 'review', verdict: 'fail', findings: 'the export drops rows' })
  const detail = await tools('lead').task_get({ task_id: task.id })
  expect(detail.findingsLedger).toEqual([])
  expect(detail.results[0].findings[0]).toMatchObject({ structured: false, verdict: 'fail', findings: 'the export drops rows', items: [] })
  expect(detail.task.outstandingResult.reviewVerdict).toBe('fail')
})

test('task_get bounds the ledger to the newest 100 rows and says older rows remain', async () => {
  const task = manual()
  for (let round = 0; round < 4; round++) {
    const result = await results.submit(dev, task.id, { summary: `r${round}`, commit: `c${round}` })
    review(task.id, result.id, Array.from({ length: 30 }, (_, index) => ({ level: 'P2', clause: task.identity, evidence: `src/f${round}_${index}.ts:1`, impact: 'style' })))
  }
  const detail = await tools('lead').task_get({ task_id: task.id })
  expect(detail.findingsLedger).toHaveLength(100)
  expect(detail.findingsLedger[0].id).toBe('F120')
  expect(detail.findingsLedger.at(-1).id).toBe('F21')
  expect(detail.ledgerOlderRemaining).toBe(true)
  expect(bench.tasks.detail(task.id)!.findingsLedger).toHaveLength(120)
})

test('the delivered task header names the blocking and disputed findings; a task without structured findings keeps its old header', async () => {
  const task = manual()
  expect(buildTaskContext(bench.tasks, task.id)!.findings).toBeUndefined()
  expect(formatTaskHeader(buildTaskContext(bench.tasks, task.id)!)).not.toContain('Findings:')
  const r1 = await results.submit(dev, task.id, { summary: 'r1', commit: 'abc' })
  review(task.id, r1.id, ['a', 'b', 'c'].map(name => ({ level: 'P1', clause: task.identity, evidence: `src/${name}.ts:1`, impact: 'x' })))
  await tools('dev').task_dispute_findings({ task_id: task.id, disputes: [{ id: 'F2', counter_evidence: 'b.ts:1 is fine' }] })
  expect(formatTaskHeader(buildTaskContext(bench.tasks, task.id)!)).toContain('Findings: 2 blocking (F1, F3), 1 disputed (F2) — task_get has the ledger')
})
