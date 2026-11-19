// Apply's remaining choices on success (plan-revision-apply design D3,
// oracle table CH, task 2.3's rows CH2, CH5–CH10) over the Apply bench — the
// rows applyChoices.test.ts does not judge. Each row starts an execution of
// revision 1, approves revision 2 from an edit, applies it, and judges the
// stored rows: the publication row, the change row, task status and
// revisions, notices, attempt rows with their manifests, effects, the slot,
// and the planner's next step.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PlanChange, PlanContent } from '../../shared/plans'
import { executionSnapshot } from '../plans/execution/executionSnapshot'
import { APPLY_HEAD, applyBench, type ApplyBench } from './applyBench'

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-rows')
})
afterAll(() => wired.close())

const base = { dependsOn: [] as string[], group: 'middle-devs', acceptance: [] as string[], extraChecks: [], guidance: '', reviewGroup: null }
/** api, ui (depending on api), and docs. */
const THREE = { changes: [{ ...base, change: 'api', acceptance: ['API lands'] }, { ...base, change: 'ui', dependsOn: ['api'] }, { ...base, change: 'docs' }] }

const edit = (change: string, over: Partial<PlanChange>) => (content: PlanContent): PlanContent => ({
  ...content, changes: content.changes.map(entry => (entry.change === change ? { ...entry, ...over } : entry)),
})
const drop = (change: string) => (content: PlanContent): PlanContent => ({ ...content, changes: content.changes.filter(entry => entry.change !== change) })
const append = (entry: PlanChange) => (content: PlanContent): PlanContent => ({ ...content, changes: [...content.changes, entry] })

function ok<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(`Apply refused: ${JSON.stringify(outcome)}`)
  return outcome as Extract<T, { ok: true }>
}

/** Mark the change landed: its landing fact and its row. */
function land(executionId: string, planId: string, change: string): void {
  wired.executions.insertLanding({
    planId, change, executionId, teamId: wired.teamId, mechanism: 'direct', prNumber: null, prUrl: null,
    headSha: 'h', baseSha: 'b', mergeSha: 'm', treeVerified: true,
  })
  const row = wired.executions.change(executionId, change)!
  if (wired.executions.transition(executionId, change, row, { state: 'landed', step: null }) === null) throw new Error('land failed')
}

type Applied = { applied: { changes: Array<{ change: string }> } }
const publication = (outcome: Applied, change: string) => outcome.applied.changes.find(row => row.change === change)

describe('Apply choices, the remaining rows (CH)', () => {
  test('CH2 metadata: a publication row; the landed change reads the target\'s dependsOn', async () => {
    // docs stays unlanded, so the execution keeps running for its readers.
    const { planId, executionId } = await wired.running(THREE)
    await wired.inFlight(executionId, 'api', 'dev2')
    land(executionId, planId, 'api')
    const ui = await wired.inFlight(executionId, 'ui', 'dev')
    land(executionId, planId, 'ui')
    await wired.approveNext(planId, edit('ui', { dependsOn: [] }))
    const attempts = wired.executions.attempts(executionId, 'ui')
    const outcome = ok(await wired.applyAs({ executionId }))
    expect(publication(outcome, 'ui')).toMatchObject({ class: 'metadata', choice: null, fields: ['dependsOn'], taskId: null, taskRevision: null })
    expect(wired.executions.change(executionId, 'ui')).toMatchObject({ state: 'landed' })
    expect(wired.executions.attempts(executionId, 'ui')).toEqual(attempts)
    expect(wired.tasks.store.get(ui.taskId)!.revision).toBe(1)
    expect(wired.notices(ui.taskId)).toEqual([])
    // The execution's readers see the target's dependsOn (D4).
    const planned = executionSnapshot(wired.teamId, wired.world.repo, wired.executions, wired.bench.plans).executions
      .find(entry => entry.row.id === executionId)!.changes.find(change => change.change === 'ui')!
    expect(planned.dependsOn).toEqual([])
  })

  test('CH5 changed, restart, no round: no task revision; the standing assignment superseded; one owed attempt of the newest kind naming the new revision, dispatched by the owed step', async () => {
    const { planId, executionId } = await wired.running()
    const ui = await wired.inFlight(executionId, 'ui', 'dev')
    const next = await wired.approveNext(planId, edit('ui', { guidance: 'Start over' }))
    const outcome = ok(await wired.applyAs({ executionId, choices: { ui: 'restart' }, commandId: 'restart-plain' }))
    expect(publication(outcome, 'ui')).toMatchObject({ class: 'changed', choice: 'restart', taskId: null, taskRevision: null })
    expect(wired.tasks.store.get(ui.taskId)!.revision).toBe(1)
    expect(wired.notices(ui.taskId)).toEqual([])
    expect(wired.bench.assignmentStore.byId(ui.assignmentId)!.supersededBy).toBe('apply:restart-plain')
    const attempts = wired.executions.attempts(executionId, 'ui')
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toMatchObject({ kind: 'implement', assignmentId: null })
    expect(attempts[1]!.manifest).toMatchObject({ plan: { revision: next.revision, contentHash: next.hash }, task: { id: ui.taskId, revision: 1 }, startCommit: APPLY_HEAD })
    expect(wired.executions.change(executionId, 'ui')).toMatchObject({ state: 'implementing', step: null })
    expect(wired.planFor().dispatches).toContainEqual(expect.objectContaining({ executionId, change: 'ui', kind: 'owed' }))
  })

  test('CH5 changed, restart, with an open round after an update attempt: the round superseded, the change back to implementing, and the owed row a fix', async () => {
    const { planId, executionId } = await wired.running()
    const ui = await wired.inFlight(executionId, 'ui', 'dev')
    const roundId = wired.answerNewestRow(executionId, 'ui', 1)
    expect(wired.executions.change(executionId, 'ui')!.state).toBe('gating')
    wired.executions.insertAttempt({ executionId, change: 'ui', kind: 'update', assignmentId: null, manifest: { ...wired.manifest(), answers: { resultId: 'r', roundId, failingChecks: [], findingsIds: [] } }, manifestHash: 'mh-update' })
    await wired.approveNext(planId, edit('ui', { guidance: 'Start over' }))
    ok(await wired.applyAs({ executionId, choices: { ui: 'restart' } }))
    expect(wired.executions.round(roundId)!.outcome).toBe('superseded')
    expect(wired.executions.change(executionId, 'ui')).toMatchObject({ state: 'implementing', step: null })
    const attempts = wired.executions.attempts(executionId, 'ui')
    expect(attempts.map(row => row.kind)).toEqual(['implement', 'update', 'fix'])
    expect(wired.tasks.store.get(ui.taskId)!.revision).toBe(1)
  })

  test('CH6 changed, no task: a publication row with choice none and nothing else', async () => {
    const { planId, executionId } = await wired.running(THREE)
    await wired.approveNext(planId, edit('docs', { guidance: 'Document the store' }))
    const before = wired.executions.change(executionId, 'docs')!
    const attempts = wired.executions.attempts(executionId, 'docs')
    const outcome = ok(await wired.applyAs({ executionId }))
    expect(publication(outcome, 'docs')).toMatchObject({ class: 'changed', choice: 'none', fields: ['guidance'], taskId: null, taskRevision: null })
    expect(wired.executions.change(executionId, 'docs')).toMatchObject({ state: before.state, taskId: null, generation: before.generation })
    expect(wired.executions.attempts(executionId, 'docs')).toEqual(attempts)
  })

  test('CH7 added, no landing fact: a waiting change row at its content position, owned, scheduled by its dependencies', async () => {
    const { planId, executionId } = await wired.running()
    await wired.approveNext(planId, content => ({ ...content, changes: [content.changes[0]!, { ...base, change: 'cli', dependsOn: ['api'] }, ...content.changes.slice(1)] }))
    const outcome = ok(await wired.applyAs({ executionId }))
    expect(publication(outcome, 'cli')).toMatchObject({ class: 'added', choice: null, taskId: null })
    expect(wired.executions.change(executionId, 'cli')).toMatchObject({ state: 'waiting', owns: true, taskId: null })
    expect(wired.executions.changes(executionId).map(row => row.change)).toEqual(['api', 'cli', 'ui'])
    // Waits on api, which has not landed: nothing provisions it yet.
    expect(wired.planFor().transitions.filter(step => step.change === 'cli')).toEqual([])
  })

  test('CH8 added, a landing fact exists: the change row landed without ownership', async () => {
    const { planId, executionId } = await wired.running()
    // An earlier execution of this plan landed cli; the running one never held it.
    wired.executions.insertLanding({
      planId, change: 'cli', executionId: 'exec-earlier', teamId: wired.teamId, mechanism: 'direct', prNumber: null, prUrl: null,
      headSha: 'h', baseSha: 'b', mergeSha: 'm', treeVerified: true,
    })
    await wired.approveNext(planId, append({ ...base, change: 'cli' }))
    const outcome = ok(await wired.applyAs({ executionId }))
    expect(publication(outcome, 'cli')).toMatchObject({ class: 'added' })
    expect(wired.executions.change(executionId, 'cli')).toMatchObject({ state: 'landed', owns: false })
    expect(wired.planFor().transitions.filter(step => step.change === 'cli')).toEqual([])
  })

  test('CH9 removed, unlanded, task open: cancelled and disowned, its pending effects cancelled, the slot given up, and the prepared cancel committed', async () => {
    const { planId, executionId } = await wired.running(THREE)
    const docs = await wired.inFlightByKawai(executionId, 'docs', 'dev')
    // docs holds the team's landing slot and has a push pending.
    const row = wired.executions.change(executionId, 'docs')!
    expect(wired.executions.transition(executionId, 'docs', row, { state: 'landing', step: 'up-to-date' })).not.toBeNull()
    expect(wired.executions.slot(wired.teamId)).not.toBeNull()
    const effect = wired.executions.insertEffect({ executionId, change: 'docs', roundId: null, kind: 'push', effectKey: `${executionId}:docs:push`, command: { branch: 'docs-branch' } })
    await wired.approveNext(planId, drop('docs'))
    const outcome = ok(await wired.applyAs({ executionId }))
    expect(publication(outcome, 'docs')).toMatchObject({ class: 'removed', choice: null, taskId: null })
    expect(wired.executions.change(executionId, 'docs')).toMatchObject({ state: 'cancelled', owns: false })
    expect(wired.executions.effectsOf(executionId).find(entry => entry.id === effect.id)!.state).toBe('cancelled')
    expect(wired.executions.slot(wired.teamId)).toBeNull()
    expect(wired.tasks.store.get(docs.taskId)!.status).toBe('cancelled')
  })

  test('CH10 removed, unlanded, task already closed: cancelled and disowned; the closed task keeps its status', async () => {
    const { planId, executionId } = await wired.running(THREE)
    const docs = await wired.inFlightByKawai(executionId, 'docs', 'dev')
    wired.bench.db.db.prepare("UPDATE team_tasks SET status = 'done' WHERE id = ?").run(docs.taskId)
    await wired.approveNext(planId, drop('docs'))
    const revisions = wired.tasks.store.revisions(docs.taskId).length
    ok(await wired.applyAs({ executionId }))
    expect(wired.executions.change(executionId, 'docs')).toMatchObject({ state: 'cancelled', owns: false })
    expect(wired.tasks.store.get(docs.taskId)!.status).toBe('done')
    expect(wired.tasks.store.revisions(docs.taskId)).toHaveLength(revisions)
  })

  test('CH10 removed, unlanded, no task: cancelled and disowned with no task write', async () => {
    const { planId, executionId } = await wired.running(THREE)
    await wired.approveNext(planId, drop('docs'))
    const before = wired.counts()
    ok(await wired.applyAs({ executionId }))
    expect(wired.executions.change(executionId, 'docs')).toMatchObject({ state: 'cancelled', owns: false, taskId: null })
    expect(wired.counts().team_task_revisions).toBe(before.team_task_revisions)
  })
})
