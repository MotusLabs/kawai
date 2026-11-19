// Apply's crash and replay rows (plan-revision-apply design D3/D7, oracle
// table CR, multi-agent R17) over the Apply bench. A crash is a throw at a
// boundary — B0 before the prepare phase (the command never ran), B1 after
// it and before the transaction (the plan command's entry throws), B2 inside
// the transaction (the history row's insert throws after the per-change
// writes), B3 after commit and before the wake (the wake throws), B4 after it
// — followed by the owner's retry under the same command id. ApplyService
// keeps no state between calls, so the retry through the same instance is
// the restarted server's; the executor is a fresh one over the same stores.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import type { PlanContent } from '../../shared/plans'
import { applyBench, type ApplyBench } from './applyBench'

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-crash')
})
afterAll(() => wired.close())

const base = { dependsOn: [] as string[], group: 'middle-devs', acceptance: [] as string[], extraChecks: [], guidance: '', reviewGroup: null }
const THREE = { changes: [{ ...base, change: 'api', acceptance: ['API lands'] }, { ...base, change: 'ui', dependsOn: ['api'] }, { ...base, change: 'docs' }] }

/** Revision 2 rewords ui and drops docs. */
const rewordAndDrop = (content: PlanContent): PlanContent => ({
  ...content,
  changes: content.changes.filter(entry => entry.change !== 'docs').map(entry => (entry.change === 'ui' ? { ...entry, guidance: 'Use the new store' } : entry)),
})

/** Running over api, ui, and docs: ui in flight held by dev (with a baseline, so its fix can dispatch), docs in flight with an open task; revision 2 approved. */
async function crashWorld() {
  const { planId, executionId } = await wired.running(THREE)
  const ui = await wired.inFlightByKawai(executionId, 'ui', 'dev')
  const row = wired.executions.change(executionId, 'ui')!
  if (wired.executions.transition(executionId, 'ui', row, { state: 'implementing', baselineCommit: 'base-sha' }) === null) throw new Error('baseline')
  const docs = await wired.inFlightByKawai(executionId, 'docs', 'dev2')
  const next = await wired.approveNext(planId, rewordAndDrop)
  return { planId, executionId, ui, docs, next }
}

const input = (world: Awaited<ReturnType<typeof crashWorld>>, commandId: string) =>
  ({ executionId: world.executionId, expectedRevision: 1, revision: world.next.revision, contentHash: world.next.hash, choices: { ui: 'adapt' }, commandId })

/** The rows one committed Apply of this world wrote, and its event. */
function committedOnce(world: Awaited<ReturnType<typeof crashWorld>>, commandId: string) {
  expect(wired.revisions.history(world.executionId).map(row => [row.seq, row.commandId])).toEqual([[1, null], [2, commandId]])
  expect(wired.executions.execution(world.executionId)!.revision).toBe(world.next.revision)
  expect(wired.tasks.store.get(world.ui.taskId)!.revision).toBe(2)
  expect(wired.notices(world.ui.taskId)).toHaveLength(1)
  expect(wired.tasks.store.get(world.docs.taskId)!.status).toBe('cancelled')
  expect(wired.bench.plans.events(world.planId).filter(event => event.kind === 'revision-applied')).toHaveLength(1)
}

/** Nothing from the Apply: the counts, the execution, the tasks, and no event. */
function nothingFrom(world: Awaited<ReturnType<typeof crashWorld>>, before: Record<string, number>) {
  expect(wired.counts()).toEqual(before)
  expect(wired.executions.execution(world.executionId)!.revision).toBe(1)
  expect(wired.tasks.store.get(world.ui.taskId)!.revision).toBe(1)
  expect(wired.notices(world.ui.taskId)).toEqual([])
  expect(wired.tasks.store.get(world.docs.taskId)!.status).not.toBe('cancelled')
  expect(wired.executions.change(world.executionId, 'docs')!.state).toBe('implementing')
  expect(wired.bench.plans.events(world.planId).filter(event => event.kind === 'revision-applied')).toEqual([])
}

describe('Apply crash and replay (CR)', () => {
  test('CR1 a crash at B0 leaves nothing from the Apply; the retry runs as a first Apply', async () => {
    const world = await crashWorld()
    const before = wired.counts()
    // The command never reached the prepare phase.
    nothingFrom(world, before)
    const retry = await wired.applyAs(input(world, 'cr1-b0'))
    expect(retry).toMatchObject({ ok: true, replayed: false })
    committedOnce(world, 'cr1-b0')
  })

  test('CR1 a crash at B1 leaves nothing from the Apply; the retry runs as a first Apply, refused if a precondition now fails', async () => {
    const world = await crashWorld()
    const before = wired.counts()
    const entry = spyOn(wired.bench.service, 'recordRevisionControlEvent').mockImplementationOnce(() => { throw new Error('crash at B1') })
    try {
      await expect(wired.applyAs(input(world, 'cr1-b1'))).rejects.toThrow('crash at B1')
    } finally {
      entry.mockRestore()
    }
    // The prepare phase ran (its head read and the prepared cancel) and wrote nothing.
    nothingFrom(world, before)
    // A precondition that now fails refuses the retry: the plan approved revision 3 meanwhile.
    const third = await wired.approveNext(world.planId, content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, guidance: 'Use the newest store' } : entry)) }))
    const refused = await wired.applyAs(input(world, 'cr1-b1'))
    expect(refused).toMatchObject({ ok: false, reason: 'precondition' })
    expect(refused.ok ? [] : refused.failures?.map(failure => failure.name)).toContain('revision-current')
    nothingFrom(world, wired.counts())
    const retry = await wired.applyAs({ ...input(world, 'cr1-b1-again'), revision: third.revision, contentHash: third.hash })
    expect(retry).toMatchObject({ ok: true, replayed: false })
  })

  test('CR2 a crash at B2 rolls the transaction back: nothing from the Apply; the retry runs as a first Apply', async () => {
    const world = await crashWorld()
    const before = wired.counts()
    const insert = spyOn(wired.revisions, 'recordAt').mockImplementationOnce(() => { throw new Error('crash at B2') })
    try {
      await expect(wired.applyAs(input(world, 'cr2'))).rejects.toThrow('crash at B2')
    } finally {
      insert.mockRestore()
    }
    nothingFrom(world, before)
    const retry = await wired.applyAs(input(world, 'cr2'))
    expect(retry).toMatchObject({ ok: true, replayed: false })
    committedOnce(world, 'cr2')
  })

  test('CR3 a crash at B3 leaves the whole Apply committed and nothing dispatched; the retry replays, even after a later Apply; the startup tick dispatches once', async () => {
    const world = await crashWorld()
    wired.useWake(() => { throw new Error('crash at B3') })
    try {
      await expect(wired.applyAs(input(world, 'cr3'))).rejects.toThrow('crash at B3')
    } finally {
      wired.useWake(null)
    }
    committedOnce(world, 'cr3')
    // Nothing dispatched: the owed fix row has no assignment.
    const fix = wired.executions.attempts(world.executionId, 'ui').at(-1)!
    expect(fix).toMatchObject({ kind: 'fix', assignmentId: null })
    const retry = await wired.applyAs(input(world, 'cr3'))
    expect(retry).toMatchObject({ ok: true, replayed: true, applied: { seq: 2, revision: world.next.revision } })
    committedOnce(world, 'cr3')
    // The restarted server's executor dispatches from stored state, once.
    const executor = wired.executor()
    await executor.tick(wired.teamId)
    const sent = wired.executions.attempts(world.executionId, 'ui').at(-1)!
    expect(sent.id).toBe(fix.id)
    expect(sent.assignmentId).not.toBeNull()
    const assignments = wired.tasks.store.assignmentsOf(world.ui.taskId).length
    await executor.tick(wired.teamId)
    expect(wired.tasks.store.assignmentsOf(world.ui.taskId)).toHaveLength(assignments)
    // A later Apply moves the execution on; the resend of the first still returns its revision.
    const third = await wired.approveNext(world.planId, content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'api' ? { ...entry, guidance: 'Tighten the API' } : entry)) }))
    expect(await wired.applyAs({ executionId: world.executionId, commandId: 'cr3-later', choices: {} })).toMatchObject({ ok: true })
    expect(wired.executions.execution(world.executionId)!.revision).toBe(third.revision)
    expect(await wired.applyAs(input(world, 'cr3'))).toMatchObject({ ok: true, replayed: true, applied: { seq: 2, revision: world.next.revision } })
  })

  test('CR4 a crash at B4 leaves the Apply committed and dispatched; the retry replays and writes nothing new', async () => {
    const world = await crashWorld()
    const first = await wired.applyAs(input(world, 'cr4'))
    if (!first.ok) throw new Error(first.message)
    expect(first.replayed).toBe(false)
    await wired.executor().tick(wired.teamId)
    expect(wired.executions.attempts(world.executionId, 'ui').at(-1)!.assignmentId).not.toBeNull()
    const after = wired.counts()
    const assignments = wired.tasks.store.assignmentsOf(world.ui.taskId).length
    const retry = await wired.applyAs(input(world, 'cr4'))
    expect(retry).toEqual({ ...first, replayed: true })
    expect(wired.counts()).toEqual(after)
    expect(wired.tasks.store.assignmentsOf(world.ui.taskId)).toHaveLength(assignments)
    committedOnce(world, 'cr4')
  })
})
