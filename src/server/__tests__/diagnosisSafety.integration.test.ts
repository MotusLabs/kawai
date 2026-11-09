// Regression cases at the diagnosis boundary: rejecting findings preserves
// failed CI, closing a task stops the change before applying its decision,
// and deferred handoffs recover the applied decision's guidance after restart.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { DiagnosisStore } from '../plans/execution/diagnosisStore'
import { decideDiagnosis, openDiagnosis } from './diagnosisTestKit'
import {
  createMatrixBench, createMatrixWorld, greenChecks, removeMatrixWorld, shapedReview, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { writeGroup } from './planHarness'

let matrix: MatrixWorld
let h: MatrixBench
beforeAll(async () => {
  matrix = await createMatrixWorld('kawai-diagnosis-safety-')
  writeGroup(matrix.world, 'senior-devs', '---\nmax: 4\n---\nBuild hard things.')
})
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const roles = {
  roles: [
    { group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] },
    { group: 'leads', profiles: ['opus'] }, { group: 'senior-devs', profiles: [] },
  ],
  leadGroup: 'leads',
}
const teamId = () => matrix.world.team.teamId
const row = (id: string, change: string) => h.executions.change(id, change)!
const fixes = (id: string, change: string) => h.tasks.store.assignmentsOf(row(id, change).taskId!).filter(a => a.handoffKind === 'fix')
let content = 0

async function failReview(id: string, change: string, raise: string[]): Promise<void> {
  await submitWork(h, id, change, `src/${change}.ts`, `export const v = ${++content}\n`)
  await h.tick()
  await shapedReview(h, id, change, 'fail', { raise, resolve: 0 })
  await h.tick()
}

async function stagnating(change: string, extra: Array<{ change: string; group: string }> = []): Promise<string> {
  const id = await startedExecution(h, [{ change }, ...extra], roles)
  await h.tick()
  for (const raise of [['one blocker'], [], []]) await failReview(id, change, raise)
  expect(row(id, change).step).toBe('diagnosing')
  return id
}

// @covers: review-convergence › Reject rejects the named findings › Rejecting old findings preserves a CI-only failure
test('Reject at a CI-only backstop rejects old findings but still dispatches the CI fix', async () => {
  const change = 'ci-reject'
  const id = await startedExecution(h, [{ change }], roles)
  await h.tick()
  await failReview(id, change, ['one blocker'])
  h.executions.transition(id, change, row(id, change), { fixRounds: 4 })
  h.gh.defaultChecks = [
    ...greenChecks().filter(check => check.name !== 'e2e'),
    { name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null },
  ]
  await submitWork(h, id, change, `src/${change}.ts`, `export const v = ${++content}\n`)
  await h.tick()
  await h.tick()
  const diagnosis = openDiagnosis(h.bench.db.db, id, change)!
  expect(diagnosis.reviewSubmissionId).toBeNull()
  expect(h.executions.round(diagnosis.roundId)!.ci).toContainEqual(expect.objectContaining({ name: 'e2e', conclusion: 'failure' }))
  const count = fixes(id, change).length
  decideDiagnosis(h.bench.db.db, teamId(), id, change, 'Reject F1')
  await h.tick()
  expect(h.executions.rounds(id, change).some(round => round.outcome === 'pass')).toBe(false)
  expect(h.executions.round(diagnosis.roundId)!.outcome).toBe('fail')
  expect(h.tasks.store.ledger(row(id, change).taskId!)[0]!.state).toBe('rejected')
  expect(fixes(id, change)).toHaveLength(count + 1)
  expect(h.mail.get(fixes(id, change).at(-1)!.messageId!)!.body).toContain('e2e')
  expect(row(id, change).state).toBe('implementing')
  expect(new DiagnosisStore(h.bench.db.db).get(diagnosis.id)!.closedAt).not.toBeNull()
  expect(h.gh.merges).toHaveLength(0)
})

for (const status of ['done', 'cancelled'] as const) {
  for (const decided of [false, true]) {
    test(`a ${status} task stops its diagnosing change before ${decided ? 'applying Reject' : 'waiting for a decision'}`, async () => {
      const change = `closed-${status}-${decided}`
      const id = await stagnating(change)
      if (decided) decideDiagnosis(h.bench.db.db, teamId(), id, change, 'Reject F1')
      const count = fixes(id, change).length
      await h.tasks.setStatus(h.bench.human, row(id, change).taskId!, status)
      await h.tick()
      expect(row(id, change)).toMatchObject({ state: 'stopped', stopReason: 'task-closed', step: null })
      expect(fixes(id, change)).toHaveLength(count)
      expect(h.tasks.store.findings.events(row(id, change).taskId!).filter(event => event.kind === 'rejected')).toEqual([])
      expect(h.gh.merges).toHaveLength(0)
      if (!decided) {
        expect(await h.service.retry(h.bench.human, { executionId: id, change, commandId: 'closed-retry' })).toMatchObject({ ok: false })
        await h.tasks.setStatus(h.bench.human, row(id, change).taskId!, 'active')
        expect(await h.service.retry(h.bench.human, { executionId: id, change, commandId: 'open-retry' })).toMatchObject({ ok: true })
        await h.tick()
        expect(row(id, change)).toMatchObject({ state: 'gating', step: 'diagnosing' })
        expect(fixes(id, change)).toHaveLength(count)
        decideDiagnosis(h.bench.db.db, teamId(), id, change, 'Fix round')
        await h.tick()
        expect(row(id, change).state).toBe('implementing')
        expect(fixes(id, change)).toHaveLength(count + 1)
      }
    })
  }
}

for (const choice of ['Fix round', 'Reassign to senior-devs']) {
// @covers: review-convergence › Fix round sends the fix with the decision's rationale › A held fix keeps its diagnosis after restart
  test(`a held ${choice} handoff keeps the applied rationale across restart`, async () => {
    const change = choice === 'Fix round' ? 'held-fix' : 'held-reassign'
    const id = await stagnating(change, [{ change: `${change}-other`, group: 'senior-devs' }])
    const diagnosis = openDiagnosis(h.bench.db.db, id, change)!
    const count = fixes(id, change).length
    decideDiagnosis(h.bench.db.db, teamId(), id, change, choice, { rationale: 'specific diagnostic guidance' })
    const held = h.makeExecutor({ holds: { active: () => [{ id: 'hold', scope: 'plan', changes: [] }], openTargets: () => [] } })
    try { await h.tick(held) } finally { held.close() }
    expect(row(id, change).state).toBe('implementing')
    expect(fixes(id, change)).toHaveLength(count)
    expect(new DiagnosisStore(h.bench.db.db).get(diagnosis.id)!.closedAt).not.toBeNull()
    // A closed diagnosis's later override must not rewrite its owed handoff.
    decideDiagnosis(h.bench.db.db, teamId(), id, change, 'Escalate', { kind: 'override', rationale: 'later override guidance' })
    const restarted = h.makeExecutor()
    try {
      await restarted.startup()
      await h.tick(restarted)
      const fix = fixes(id, change).at(-1)!
      const body = h.mail.get(fix.messageId!)!.body
      expect(body).toContain(`Diagnosis decision (${choice}): specific diagnostic guidance`)
      expect(body).not.toContain('later override guidance')
      expect(fix.targetId).toBe(choice === 'Fix round' ? 'middle-devs' : 'senior-devs')
      expect(fixes(id, change)).toHaveLength(count + 1)
      await h.tick(restarted)
      expect(fixes(id, change)).toHaveLength(count + 1)
    } finally { restarted.close() }
  })
}
