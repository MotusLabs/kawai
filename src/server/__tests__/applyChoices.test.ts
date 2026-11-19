// Apply's choices on success (plan-revision-apply design D3, oracle table CH,
// task 2.2's rows CH1, CH3, CH4) over the Apply bench: a real ApplyService,
// PlanService, execution store, and TaskService with notices. Each row
// starts an execution of revision 1 over api and ui, both in flight (a
// claimed instruction, a dispatched implement attempt), approves revision 2,
// applies it, and judges the stored rows: the publication rows, the history
// row and the advanced revision columns, task revisions, notices, attempt
// rows and their manifests, and — where the fix belongs to plan-execution
// D9 — the planner's next step.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PlanContent } from '../../shared/plans'
import { APPLY_HEAD, applyBench, type ApplyBench } from './applyBench'

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-choices')
})
afterAll(() => wired.close())

/** Revision 1 running with api (held by dev2) and ui (held by dev) in flight. */
async function inFlightWorld() {
  const { planId, executionId } = await wired.running()
  const api = await wired.inFlight(executionId, 'api', 'dev2')
  const ui = await wired.inFlight(executionId, 'ui', 'dev')
  return { planId, executionId, api, ui }
}

const reword = (changes: Record<string, string>) => (content: PlanContent): PlanContent => ({
  ...content,
  changes: content.changes.map(entry => (changes[entry.change] !== undefined ? { ...entry, guidance: changes[entry.change]! } : entry)),
})

function ok<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(`Apply refused: ${JSON.stringify(outcome)}`)
  return outcome as Extract<T, { ok: true }>
}

describe('Apply choices (CH)', () => {
  test('CH1 unchanged: a publication row and nothing else', async () => {
    const world = await inFlightWorld()
    await wired.approveNext(world.planId, reword({ ui: 'Use the new store' }))
    const outcome = ok(await wired.applyAs({ executionId: world.executionId, choices: { ui: 'continue' } }))
    expect(outcome.applied.changes.find(row => row.change === 'api')).toEqual({
      executionId: world.executionId, seq: 2, change: 'api', class: 'unchanged', choice: null, fields: [], taskId: null, taskRevision: null,
    })
    expect(wired.tasks.store.get(world.api.taskId)!.revision).toBe(1)
    expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(1)
    expect(wired.notices(world.api.taskId)).toEqual([])
  })

  test('CH3 changed, continue: a publication row; the running attempt\'s manifest unchanged; later readers see the new revision', async () => {
    const world = await inFlightWorld()
    const before = wired.executions.attempts(world.executionId, 'ui')
    const next = await wired.approveNext(world.planId, reword({ ui: 'Use the new store' }))
    const outcome = ok(await wired.applyAs({ executionId: world.executionId, choices: { ui: 'continue' } }))
    expect(outcome).toMatchObject({ replayed: false, executionId: world.executionId })
    expect(outcome.applied).toMatchObject({ seq: 2, revision: next.revision, contentHash: next.hash, rationale: 'the owner rethought it' })
    expect(outcome.applied.changes.find(row => row.change === 'ui')).toMatchObject({ class: 'changed', choice: 'continue', fields: ['guidance'], taskId: null, taskRevision: null })
    // The running attempt keeps its manifest; no task revision, notice, or attempt row.
    expect(wired.executions.attempts(world.executionId, 'ui')).toEqual(before)
    expect(wired.tasks.store.get(world.ui.taskId)!.revision).toBe(1)
    expect(wired.notices(world.ui.taskId)).toEqual([])
    expect(wired.bench.assignmentStore.byId(world.ui.assignmentId)!.supersededBy).toBeNull()
    // The execution reads the new revision (D4): its columns and the history's newest row.
    expect(wired.executions.execution(world.executionId)).toMatchObject({ revision: next.revision, contentHash: next.hash, reportId: 'rep-next', inputHash: 'ih-next' })
    expect(wired.revisions.history(world.executionId).map(row => [row.seq, row.revision])).toEqual([[1, 1], [2, next.revision]])
    expect(wired.applyWakes.at(-1)).toBe(wired.teamId)
  })

  // @covers: plan-revision-apply › Each choice publishes or dispatches as recorded › Adapt notifies the developer
  test('CH4 changed, adapt, held with no round: one task revision under the apply key with its notice, the held assignment superseded after it, and one owed fix row naming both new revisions', async () => {
    const world = await inFlightWorld()
    const next = await wired.approveNext(world.planId, reword({ ui: 'Use the new store' }))
    const headsBefore = wired.headReads.length
    const outcome = ok(await wired.applyAs({ executionId: world.executionId, choices: { ui: 'adapt' }, commandId: 'adapt-held' }))
    // The publication: revision 2 with the owner's rationale and the generated text.
    const task = wired.tasks.store.get(world.ui.taskId)!
    expect(task.revision).toBe(2)
    const published = wired.tasks.store.revisions(task.id).at(-1)!
    expect(published).toMatchObject({ revision: 2, rationale: 'the owner rethought it' })
    expect(task.direction).toContain('The OpenSpec change "ui" is the authoritative direction')
    expect(task.direction).toContain('Use the new store')
    expect(outcome.applied.changes.find(row => row.change === 'ui')).toMatchObject({ class: 'changed', choice: 'adapt', taskId: task.id, taskRevision: 2 })
    // The notice reaches the claimant; its claimed instruction mail is untouched.
    const notices = wired.notices(task.id)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ toKind: 'session', toId: 'dev' })
    expect(wired.bench.mail.get(world.ui.mailId)!.state).toBe('claimed')
    // The stop branch: the held assignment superseded by this Apply.
    expect(wired.bench.assignmentStore.byId(world.ui.assignmentId)!.supersededBy).toBe('apply:adapt-held')
    // One owed fix row naming the new plan and task revisions, from the pre-transaction head read.
    const attempts = wired.executions.attempts(world.executionId, 'ui')
    expect(attempts).toHaveLength(2)
    const fix = attempts[1]!
    expect(fix).toMatchObject({ kind: 'fix', assignmentId: null })
    expect(fix.manifest).toMatchObject({
      plan: { revision: next.revision, contentHash: next.hash }, task: { id: task.id, revision: 2 },
      validation: { reportId: 'rep-next', inputHash: 'ih-next' }, startCommit: APPLY_HEAD,
    })
    expect(wired.headReads.slice(headsBefore)).toEqual([{ executionId: world.executionId, change: 'ui' }])
    expect(wired.executions.change(world.executionId, 'ui')).toMatchObject({ state: 'implementing', step: null })
    // The owed step dispatches it on the next tick.
    expect(wired.planFor().dispatches).toContainEqual(expect.objectContaining({ executionId: world.executionId, change: 'ui', kind: 'owed' }))
    // The continue-less change (api) is untouched.
    expect(wired.tasks.store.get(world.api.taskId)!.revision).toBe(1)
  })

  test('CH4 changed, adapt, with an open round: the notice, no attempt row in the transaction, and plan-execution D9\'s revision stage next', async () => {
    const world = await inFlightWorld()
    const roundId = wired.answerNewestRow(world.executionId, 'ui', 1)
    await wired.approveNext(world.planId, reword({ ui: 'Use the new store' }))
    ok(await wired.applyAs({ executionId: world.executionId, choices: { ui: 'adapt' } }))
    expect(wired.tasks.store.get(world.ui.taskId)!.revision).toBe(2)
    expect(wired.notices(world.ui.taskId)).toHaveLength(1)
    expect(wired.executions.attempts(world.executionId, 'ui')).toHaveLength(1)
    expect(wired.executions.round(roundId)!.outcome).toBeNull()
    expect(wired.planFor().stages).toContainEqual(expect.objectContaining({ executionId: world.executionId, change: 'ui', kind: 'revision', roundId }))
  })

  test('CH4 changed, adapt: the owner\'s Adapt text is published trimmed instead of the generated one', async () => {
    const world = await inFlightWorld()
    await wired.approveNext(world.planId, reword({ ui: 'Use the new store' }))
    ok(await wired.applyAs({ executionId: world.executionId, choices: { ui: 'adapt' }, adaptations: { ui: '  Rebuild the store layer first.  ' } }))
    expect(wired.tasks.store.get(world.ui.taskId)!.direction).toBe('Rebuild the store layer first.')
  })

  test('CH4 changed, adapt: an unreadable branch head refuses with nothing written', async () => {
    const world = await inFlightWorld()
    await wired.approveNext(world.planId, reword({ ui: 'Use the new store' }))
    const before = wired.counts()
    wired.useHead(() => ({ ok: false }))
    try {
      const outcome = await wired.applyAs({ executionId: world.executionId, choices: { ui: 'adapt' } })
      expect(outcome).toMatchObject({ ok: false, reason: 'state' })
      expect(outcome.ok ? '' : outcome.message).toContain('branch head on origin could not be read')
    } finally {
      wired.useHead(() => ({ ok: true, startCommit: APPLY_HEAD, artifacts: {} }))
    }
    expect(wired.counts()).toEqual(before)
    expect(wired.executions.execution(world.executionId)!.revision).toBe(1)
  })
})
