// Properties P1 and P3 of review convergence (task 9.1, design "Properties",
// seed 0xC0FE1D, 24 executor cases; invariants I2, I5) at the executor seam:
// the matrix bench's production executor over seeded sequences — failed
// structured reviews that raise, resolve, and keep findings open, CI
// failures, passes, the card's decisions (every option), owner overrides
// after a diagnosis closed, task revisions while diagnosing, and a crash at
// each transaction boundary (after the open step's card insert; after an
// outcome's keyed dispatch, before its close).
// - P1: per failed round at most one diagnosis row and one diagnosis card,
//   and at most one fix attempt answering it; a closed diagnosis is never
//   re-applied (the attempts answering its round stay as they were when it
//   closed, through later decisions and ticks).
// - P3: a failed round has a fix attempt iff no diagnosis opened on it, or
//   its diagnosis closed by a task revision (DX1), Fix round (DX3), a Reject
//   that left blockers (DX5), or a Reassign (DX9) — or it escalated and the
//   owner's Retry sent the fix (A8).
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import { lsRemoteHead, gitFetch, worktreeAdd } from '../plans/landing/gitRemote'
import { provisionAdapter } from '../plans/execution/executionProvision'
import {
  closeDiagnosisCase, joinDiagnosisCases, openDiagnosisCase, ownExecutor, ROLES, startDiagnosisCase, type DiagnosisCase,
} from './executionDiagnosisHarness'
import { startedExecution } from './executionMatrixHarness'

const SEED = 0xC0FE1D
const CASES = 24

const reached = new Map<string, number>()
// A case that timed out is still running: the next waits for it.
afterEach(async () => { await joinDiagnosisCases() })

test.each(Array.from({ length: CASES }, (_, index) => index))('P1, P3 case %i (seed 0xC0FE1D + case)', async index => {
  // Merged only from a case that passed, and only by that case's own promise.
  for (const [key, count] of await startDiagnosisCase(index, SEED)) reached.set(key, (reached.get(key) ?? 0) + count)
})

test('the 24 cases reach the open step, every outcome, the crashes, and a late override', () => {
  for (const key of ['diagnosis-open', 'outcome:Fix', 'outcome:Reject', 'outcome:Amend', 'outcome:Reassign', 'outcome:Escalate', 'outcome:revision',
    'crash:diagnosisAfterCardInsert', 'crash:diagnosisBeforeClose', 'late-override', 'retry', 'p3:no-diagnosis', 'p3:fix', 'p3:escalate-retried']) {
    expect({ key, reached: (reached.get(key) ?? 0) > 0 }).toEqual({ key, reached: true })
  }
})


function deferred() {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  return { gate, release }
}
const settle = async () => { for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve)) }
const executionRows = (c: DiagnosisCase) => (c.h.bench.db.db.prepare('SELECT id FROM plan_executions ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
const pending = (promise: Promise<unknown>) => { const state = { settled: false }; promise.then(() => { state.settled = true }, () => { state.settled = true }); return state }

// A held case keeps its own fixture: while case A is held mid-run and case B is open, A's late continuation (finishing or failing), its teardown, and its world's removal never read, write, or close B.
async function heldCaseWitness(outcome: 'finishes' | 'fails with its own error') {
  const held = { a: deferred(), b: deferred() }, released = { a: deferred(), b: deferred() }
  const seen: { a?: DiagnosisCase; b?: DiagnosisCase } = {}
  const idsAt: Record<'a' | 'b', string[][]> = { a: [], b: [] }
  const boom = new Error('the held case body failed')
  const hold = (key: 'a' | 'b') => async (c: DiagnosisCase, step: number) => {
    if (step === 1) { seen[key] = c; idsAt[key].push(executionRows(c)); held[key].release(); await released[key].gate }
    if (step === 2) idsAt[key].push(executionRows(c))
    if (step === 1 && key === 'a' && outcome !== 'finishes') throw boom
  }
  const a = startDiagnosisCase(3, SEED, { beforeStep: hold('a') })
  await held.a.gate
  const b = startDiagnosisCase(4, SEED, { beforeStep: hold('b') })
  await held.b.gate
  try {
    const joined = pending(joinDiagnosisCases())
    const [ca, cb] = [seen.a!, seen.b!]
    expect(ca.h).not.toBe(cb.h)
    expect(ca.matrix.world.root).not.toBe(cb.matrix.world.root)
    const bBefore = executionRows(cb)
    expect(bBefore).toHaveLength(1)
    expect(idsAt.a[0]).toHaveLength(1)
    expect(idsAt.a[0]).not.toEqual(bBefore)

    // A resumes with B open.
    released.a.release()
    let aError: unknown = null
    try { await a } catch (error) { aError = error }
    expect(aError).toBe(outcome === 'finishes' ? null : boom)
    // A's own rows were its own on both sides of the hold (it finished its steps against them), and its fixture is gone.
    if (outcome === 'finishes') expect(idsAt.a[1]).toEqual(idsAt.a[0])
    expect(ca.closed).toBe(true)
    expect(() => ca.h.bench.db.db.prepare('SELECT 1').get()).toThrow()
    expect(fs.existsSync(ca.matrix.world.root)).toBe(false)
    // B's fixture is exactly as it was: open, its rows unchanged, nothing of A's in it, and the join still waits for B.
    expect(cb.closed).toBe(false)
    expect(executionRows(cb)).toEqual(bBefore)
    expect(fs.existsSync(cb.matrix.world.root)).toBe(true)
    await settle()
    expect(joined.settled).toBe(false)

    released.b.release()
    expect((await b).size).toBeGreaterThan(0)
    expect(idsAt.b[1]).toEqual(bBefore)
    expect(cb.closed).toBe(true)
    await joinDiagnosisCases()
    expect(joined.settled).toBe(true)
  } finally {
    // A failed assertion must not leave a case held: release both and let them finish.
    released.a.release(); released.b.release()
    await Promise.allSettled([a, b])
  }
}

test('a held case finishes on its own fixture and leaves the open successor untouched', () => heldCaseWitness('finishes'))
test('a held case fails with its own error on its own fixture and leaves the open successor untouched', () => heldCaseWitness('fails with its own error'))

// Teardown joins everything the case started: with the primary executor and an alternate (a crash seam's, a restart's) each held inside a real git fetch, closing the case waits for both, and the database closes only after each resumed on it.
test('closing a case waits for its primary and alternate executors held in git before the database closes', async () => {
  const order: string[] = []
  const gates = { primary: deferred(), alternate: deferred() }
  const entered = { primary: deferred(), alternate: deferred() }
  const resumed = { primary: deferred(), alternate: deferred() }
  const heldGit = (name: 'primary' | 'alternate', c: () => DiagnosisCase) => ({
    lsRemoteHead, worktreeAdd,
    fetch: async (...args: Parameters<typeof gitFetch>) => {
      entered[name].release()
      await gates[name].gate
      const fetched = await gitFetch(...args)
      // The tick resumes on a live database: a closed one throws here.
      order.push(`${name}-resumed:${executionRows(c()).length}`)
      resumed[name].release()
      return fetched
    },
  })
  let owned!: DiagnosisCase
  owned = await openDiagnosisCase(5, executions => ({ adapters: { provision: provisionAdapter(executions, heldGit('primary', () => owned)) } }))
  const realClose = owned.h.bench.db.close
  owned.h.bench.db.close = () => { order.push('database-closed'); realClose() }
  try {
    await startedExecution(owned.h, [{ change: 'held-a' }, { change: 'held-b' }], ROLES)
    const teamId = owned.matrix.world.team.teamId
    owned.h.executor.wake(teamId)
    await entered.primary.gate
    const alternate = ownExecutor(owned, owned.h.makeExecutor({ adapters: { provision: provisionAdapter(owned.h.executions, heldGit('alternate', () => owned)) } }))
    alternate.wake(teamId)
    await entered.alternate.gate
    const closing = pending(closeDiagnosisCase(owned))
    await settle()
    expect({ settled: closing.settled, order }).toEqual({ settled: false, order: [] })
    expect(fs.existsSync(owned.matrix.world.root)).toBe(true)
    gates.primary.release()
    await resumed.primary.gate
    await settle()
    // One executor resumed; the other is still held, so the case is still open.
    expect({ settled: closing.settled, alternateResumed: order.includes('alternate-resumed:1'), databaseClosed: order.includes('database-closed') }).toEqual({ settled: false, alternateResumed: false, databaseClosed: false })
    expect(order[0]).toBe('primary-resumed:1')
    gates.alternate.release()
    await closeDiagnosisCase(owned)
    // Whatever else the released executors ran, the database closed once, last.
    expect(order.at(-1)).toBe('database-closed')
    expect(order.filter(entry => entry === 'database-closed')).toHaveLength(1)
    expect(order).toContain('alternate-resumed:1')
    expect(order.filter(entry => entry.endsWith('-resumed:1'))).toHaveLength(order.length - 1)
    expect(fs.existsSync(owned.matrix.world.root)).toBe(false)
  } finally { gates.primary.release(); gates.alternate.release(); await closeDiagnosisCase(owned) }
})
