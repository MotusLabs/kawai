// Apply's command shape (plan-revision-apply design D3, oracle table AK,
// task 2.2) over the Apply bench: the agent refusal before any read and the
// absent agent tool (AK1), the lost-result replay reconstructed before any
// preparation even after a later Apply moved the execution on (AK2, the
// design challenge's DC3 sequence), a differing payload refused naming its
// field (AK3), two concurrent Applies on one revision (AK4), the same command
// sent twice concurrently (AK5), and a prepared cancel gone stale three
// times (AK6) — plus one stale preparation recovered by the retry.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PlanContent } from '../../shared/plans'
import { teamToolTable } from '../team/mailboxTools'
import type { TeamMailbox } from '../team/TeamMailbox'
import { applyBench, type ApplyBench } from './applyBench'

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-command')
})
afterAll(() => wired.close())

const reword = (change: string, guidance: string) => (content: PlanContent): PlanContent => ({
  ...content, changes: content.changes.map(entry => (entry.change === change ? { ...entry, guidance } : entry)),
})

/** Revision 1 running with ui in flight (held by dev), revision 2 rewording ui approved. */
async function adaptWorld() {
  const { planId, executionId } = await wired.running()
  const ui = await wired.inFlight(executionId, 'ui', 'dev')
  const next = await wired.approveNext(planId, reword('ui', 'Use the new store'))
  return { planId, executionId, ui, next }
}

describe('Apply command shape (AK)', () => {
  // @covers: plan-revision-apply › Only the owner applies a revision to a running execution › Agents cannot apply
  test('AK1 an agent caller, or a direct service call with one, is refused forbidden before any read; no agent tool applies a revision', async () => {
    const world = await adaptWorld()
    const before = wired.counts()
    const heads = wired.headReads.length
    const outcome = await wired.apply.apply({ kind: 'agent', sessionId: 'chat-lead' }, {
      executionId: world.executionId, expectedRevision: 1, revision: world.next.revision, contentHash: world.next.hash,
      choices: { ui: 'adapt' }, rationale: 'r', commandId: 'agent-apply',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(await wired.apply.preview({ kind: 'agent', sessionId: 'chat-lead' }, { executionId: world.executionId, revision: world.next.revision })).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(wired.counts()).toEqual(before)
    expect(wired.headReads.length).toBe(heads)
    const stub = {} as never
    const names = teamToolTable({} as TeamMailbox, 'chat-agent', {
      tasks: stub, results: stub, strategies: stub, plans: stub, validation: stub, decisions: stub, impact: stub,
      releases: stub, management: stub, metrics: stub, reports: stub, checkpoints: stub, capacity: stub,
    }).map(spec => spec.name)
    expect(names.filter(name => /apply|revision/i.test(name))).toEqual([])
  })

  // @covers: plan-revision-apply › Only the owner applies a revision to a running execution › A lost Apply result replays
  test('AK2 the same command id and payload after a success replays the recorded result: no second row, task revision, or notice', async () => {
    const world = await adaptWorld()
    const first = await wired.applyAs({ executionId: world.executionId, choices: { ui: 'adapt' }, commandId: 'lost-result' })
    if (!first.ok) throw new Error(first.message)
    const after = wired.counts()
    const wakes = wired.applyWakes.length
    const heads = wired.headReads.length
    const resent = await wired.apply.apply(wired.bench.human, {
      executionId: world.executionId, expectedRevision: 1, revision: world.next.revision, contentHash: world.next.hash,
      choices: { ui: 'adapt' }, rationale: 'the owner rethought it', commandId: 'lost-result',
    })
    expect(resent).toEqual({ ...first, replayed: true })
    expect(wired.counts()).toEqual(after)
    expect(wired.tasks.store.get(world.ui.taskId)!.revision).toBe(2)
    expect(wired.notices(world.ui.taskId)).toHaveLength(1)
    // Replayed before any preparation: no head read, no wake.
    expect(wired.headReads.length).toBe(heads)
    expect(wired.applyWakes.length).toBe(wakes)
  })

  test('AK2 DC3: Apply A to revision 2, Apply B to revision 3, then a resend of A still returns A\'s revision 2', async () => {
    const world = await adaptWorld()
    const a = await wired.applyAs({ executionId: world.executionId, choices: { ui: 'continue' }, commandId: 'dc3-a' })
    if (!a.ok) throw new Error(a.message)
    const third = await wired.approveNext(world.planId, reword('ui', 'Use the newest store'))
    const b = await wired.applyAs({ executionId: world.executionId, choices: { ui: 'continue' }, commandId: 'dc3-b' })
    if (!b.ok) throw new Error(b.message)
    expect(b.applied).toMatchObject({ seq: 3, revision: third.revision })
    const resent = await wired.apply.apply(wired.bench.human, {
      executionId: world.executionId, expectedRevision: 1, revision: world.next.revision, contentHash: world.next.hash,
      choices: { ui: 'continue' }, rationale: 'the owner rethought it', commandId: 'dc3-a',
    })
    expect(resent).toEqual({ ...a, replayed: true })
    expect(resent.ok && resent.applied).toMatchObject({ seq: 2, revision: world.next.revision })
    expect(wired.executions.execution(world.executionId)!.revision).toBe(third.revision)
  })

  test('AK3 the same command id with a different payload is refused naming the first differing field; nothing is written', async () => {
    const world = await adaptWorld()
    const first = await wired.applyAs({ executionId: world.executionId, choices: { ui: 'continue' }, commandId: 'payload-1' })
    expect(first.ok).toBe(true)
    const after = wired.counts()
    const outcome = await wired.applyAs({ executionId: world.executionId, expectedRevision: 1, choices: { ui: 'adapt' }, commandId: 'payload-1' })
    expect(outcome).toMatchObject({ ok: false, reason: 'payload' })
    expect(outcome.ok ? '' : outcome.message).toContain('different choices')
    expect(wired.counts()).toEqual(after)
  })

  // @covers: plan-revision-apply › Apply evaluates named preconditions › A concurrent Apply wins
  test('AK4 two command ids on the same execution revision, concurrently: one commits, the other is refused execution-revision-unchanged naming the new revision', async () => {
    const world = await adaptWorld()
    const outcomes = await Promise.all(['race-a', 'race-b'].map(commandId =>
      wired.applyAs({ executionId: world.executionId, expectedRevision: 1, choices: { ui: 'adapt' }, commandId })))
    const won = outcomes.filter(outcome => outcome.ok)
    const lost = outcomes.filter(outcome => !outcome.ok)
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    const refusal = lost[0]!
    if (refusal.ok) throw new Error('unreachable')
    expect(refusal.reason).toBe('precondition')
    // The CAS entry leads; the entries the moved execution also fails follow it in list order (AP16).
    expect(refusal.failures?.[0]).toMatchObject({ name: 'execution-revision-unchanged', message: expect.stringContaining(`now runs revision ${world.next.revision}`) })
    expect(wired.revisions.history(world.executionId)).toHaveLength(2)
    expect(wired.tasks.store.get(world.ui.taskId)!.revision).toBe(2)
    expect(wired.notices(world.ui.taskId)).toHaveLength(1)
  })

  test('AK5 the same command id and payload sent twice concurrently: one commits, the other resolves as its replay', async () => {
    const world = await adaptWorld()
    const send = () => wired.applyAs({ executionId: world.executionId, expectedRevision: 1, choices: { ui: 'adapt' }, commandId: 'twin' })
    const [one, two] = await Promise.all([send(), send()])
    if (!one!.ok || !two!.ok) throw new Error(`refused: ${JSON.stringify([one, two])}`)
    expect([one!.replayed, two!.replayed].sort()).toEqual([false, true])
    expect(one!.applied).toEqual(two!.applied)
    expect(wired.revisions.history(world.executionId)).toHaveLength(2)
    expect(wired.tasks.store.get(world.ui.taskId)!.revision).toBe(2)
    expect(wired.notices(world.ui.taskId)).toHaveLength(1)
    expect(wired.executions.attempts(world.executionId, 'ui')).toHaveLength(2)
  })
})

describe('Apply stale preparation (AK6)', () => {
  /** Revision 1 over api, ui, and docs, docs in flight with an open task; revision 2 drops docs. */
  async function removalWorld() {
    const base = { change: 'api', dependsOn: [], group: 'middle-devs', acceptance: ['API lands'], extraChecks: [], guidance: '' }
    const { planId, executionId } = await wired.running({ changes: [base, { ...base, change: 'ui', acceptance: [] }, { ...base, change: 'docs', acceptance: [] }] })
    const docs = await wired.inFlightByKawai(executionId, 'docs', 'dev')
    await wired.approveNext(planId, content => ({ ...content, changes: content.changes.filter(entry => entry.change !== 'docs') }))
    return { executionId, docs }
  }

  /** Each prepare of the docs task's cancel is followed by a status move, so its commit finds it stale. */
  async function withMovingStatus<T>(moves: number, run: () => Promise<T>): Promise<{ result: T; prepares: Array<{ taskId: string; status: string }> }> {
    const original = wired.tasks.prepareStatus.bind(wired.tasks)
    const prepares: Array<{ taskId: string; status: string }> = []
    wired.tasks.prepareStatus = async (caller, taskId, status, note) => {
      prepares.push({ taskId, status })
      expect(caller).toMatchObject({ kind: 'system', origin: { kind: 'execution' } })
      const prepared = await original(caller, taskId, status, note)
      if (prepares.length <= moves) {
        const current = wired.tasks.store.get(taskId)!.status
        wired.bench.db.db.prepare('UPDATE team_tasks SET status = ? WHERE id = ?').run(current === 'blocked' ? 'active' : 'blocked', taskId)
      }
      return prepared
    }
    try {
      return { result: await run(), prepares }
    } finally {
      wired.tasks.prepareStatus = original
    }
  }

  test('AK6 a prepared cancel gone stale three times is refused state naming the task; nothing is written', async () => {
    const world = await removalWorld()
    const before = wired.counts()
    const { result, prepares } = await withMovingStatus(3, () => wired.applyAs({ executionId: world.executionId }))
    expect(prepares).toEqual(Array.from({ length: 3 }, () => ({ taskId: world.docs.taskId, status: 'cancelled' })))
    expect(result).toMatchObject({ ok: false, reason: 'state' })
    expect(result.ok ? '' : result.message).toContain(world.docs.taskId)
    expect(wired.counts()).toEqual(before)
    expect(wired.executions.change(world.executionId, 'docs')!.state).toBe('implementing')
    expect(wired.executions.execution(world.executionId)!.revision).toBe(1)
  })

  test('AK6 a prepared cancel gone stale once is prepared again and the Apply commits with the task cancelled', async () => {
    const world = await removalWorld()
    const { result, prepares } = await withMovingStatus(1, () => wired.applyAs({ executionId: world.executionId }))
    if (!result.ok) throw new Error(result.message)
    expect(prepares).toHaveLength(2)
    expect(wired.tasks.store.get(world.docs.taskId)!.status).toBe('cancelled')
    expect(wired.executions.change(world.executionId, 'docs')).toMatchObject({ state: 'cancelled', owns: false })
  })
})
