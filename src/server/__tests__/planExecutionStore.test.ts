// ExecutionStore (plan-execution D3): inserts, guarded transitions, owned-change
// lookups, the landing slot taken and released with the transitions that enter
// and leave `landing`, orphan slot rows cleared at startup and when the slot
// is found taken, and constraint errors mapped to named conflicts. The races
// run over two connections to one database file, the way two server writers
// would meet.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { ExecutionConflict, ExecutionStore, type NewExecution } from '../plans/execution/executionStore'

let dir: string
let file: string
let stores: ExecutionStore[]
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-execution-store-'))
  file = path.join(dir, 'db.sqlite')
  schemaDb(file).close()
  stores = [new ExecutionStore(new Database(file)), new ExecutionStore(new Database(file))]
})
afterEach(() => {
  for (const store of stores) store.db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const execution = (extra: Partial<NewExecution> = {}): NewExecution => ({
  teamId: 'team', planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i', landingMode: 'direct',
  baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
  maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }, { change: 'ui', landed: false }], ...extra,
})
const conflict = (run: () => unknown): string => {
  try { run() } catch (error) { if (error instanceof ExecutionConflict) return error.kind; throw error }
  return 'none'
}
/** Walk a change to `landing` through the guarded transitions. */
function toLanding(store: ExecutionStore, id: string, change: string) {
  for (const state of ['provisioning', 'implementing', 'gating', 'landing'] as const) {
    const row = store.change(id, change)!
    expect(store.transition(id, change, row, { state })).not.toBeNull()
  }
}

describe('inserts', () => {
  test('an execution and its changes in content order; a landed change owns nothing', () => {
    const [store] = stores
    const row = store!.insertExecution(execution({ changes: [{ change: 'api', landed: true }, { change: 'ui', landed: false }] }))
    expect(row).toMatchObject({ state: 'running', outcome: null, planId: 'plan-1', floor: { version: 1 } })
    expect(store!.changes(row.id).map(change => [change.change, change.position, change.state, change.owns])).toEqual([
      ['api', 0, 'landed', false], ['ui', 1, 'waiting', true],
    ])
    expect(store!.running('plan-1')!.id).toBe(row.id)
    expect(store!.ownerOf('team', 'ui')!.executionId).toBe(row.id)
    expect(store!.ownerOf('team', 'api')).toBeNull()
  })

  test('two racing executions of one plan: the second is one-execution and writes nothing', () => {
    stores[0]!.insertExecution(execution({ changes: [{ change: 'api', landed: false }] }))
    expect(conflict(() => stores[1]!.insertExecution(execution({ changes: [{ change: 'other', landed: false }] })))).toBe('one-execution')
    expect(stores[1]!.ownerOf('team', 'other')).toBeNull()
    expect(stores[1]!.executionsOf('plan-1')).toHaveLength(1)
  })

  test('two racing plans claiming one change: the second is changes-unclaimed and writes nothing', () => {
    stores[0]!.insertExecution(execution())
    expect(conflict(() => stores[1]!.insertExecution(execution({ planId: 'plan-2', changes: [{ change: 'web', landed: false }, { change: 'ui', landed: false }] }))))
      .toBe('changes-unclaimed')
    expect(stores[1]!.running('plan-2')).toBeNull()
    expect(stores[1]!.ownerOf('team', 'web')).toBeNull()
  })

  test('another team may own the same change name', () => {
    stores[0]!.insertExecution(execution())
    expect(stores[1]!.insertExecution(execution({ teamId: 'team-2', planId: 'plan-9' })).state).toBe('running')
  })

  test('attempts number per change; a landing fact is one per plan and change', () => {
    const [store] = stores
    const { id } = store!.insertExecution(execution())
    const manifest = { attempt: 1 } as never
    expect(store!.insertAttempt({ executionId: id, change: 'api', kind: 'implement', assignmentId: null, manifest, manifestHash: 'm' }).number).toBe(1)
    expect(store!.insertAttempt({ executionId: id, change: 'api', kind: 'fix', assignmentId: 'a', manifest, manifestHash: 'm' }).number).toBe(2)
    expect(store!.insertAttempt({ executionId: id, change: 'ui', kind: 'implement', assignmentId: null, manifest, manifestHash: 'm' }).number).toBe(1)
    const fact = { planId: 'plan-1', change: 'api', executionId: id, teamId: 'team', mechanism: 'direct', prNumber: 7, prUrl: 'u', headSha: 'h', baseSha: 'b', mergeSha: 'm', treeVerified: true }
    expect(store!.insertLanding(fact)).toMatchObject({ change: 'api', treeVerified: true, postCi: null })
    expect(() => store!.insertLanding(fact)).toThrow('UNIQUE')
  })
})

describe('guarded transitions', () => {
  test('a stale state or generation writes nothing; a match bumps the generation', () => {
    const [store] = stores
    const { id } = store!.insertExecution(execution())
    const before = store!.change(id, 'api')!
    expect(store!.transition(id, 'api', { state: 'implementing', generation: 0 }, { state: 'gating' })).toBeNull()
    expect(store!.transition(id, 'api', { state: 'waiting', generation: 5 }, { state: 'provisioning' })).toBeNull()
    const next = store!.transition(id, 'api', before, { state: 'provisioning', branch: 'kawai/api', stopDetail: { message: 'm' }, prOpenedByKawai: true })!
    expect(next).toMatchObject({ state: 'provisioning', generation: 1, branch: 'kawai/api', stopDetail: { message: 'm' }, prOpenedByKawai: true })
    expect(store!.transition(id, 'api', before, { state: 'provisioning' })).toBeNull()
    expect(store!.transition(id, 'api', next, { step: null, stopDetail: null })).toMatchObject({ state: 'provisioning', generation: 2, stopDetail: null })
  })

  test('landed and cancelled give up ownership; stopped keeps it until the execution finishes', () => {
    const [store] = stores
    const { id } = store!.insertExecution(execution())
    expect(store!.transition(id, 'api', store!.change(id, 'api')!, { state: 'cancelled' })!.owns).toBe(false)
    expect(store!.transition(id, 'ui', store!.change(id, 'ui')!, { state: 'stopped', stopReason: 'round-limit' })!.owns).toBe(true)
    expect(store!.ownedChanges('team').map(row => row.change)).toEqual(['ui'])
    expect(store!.finishExecution(id, 'stopped', 'enough')).toBe(true)
    expect(store!.finishExecution(id, 'stopped', 'again')).toBe(false)
    expect(store!.execution(id)).toMatchObject({ state: 'finished', outcome: 'stopped', stopReason: 'enough' })
    expect(store!.ownedChanges('team')).toEqual([])
  })

  test('ownerOfTask finds the owning row by task', () => {
    const [store] = stores
    const { id } = store!.insertExecution(execution())
    store!.transition(id, 'api', store!.change(id, 'api')!, { state: 'provisioning', taskId: 'task-1' })
    expect(store!.ownerOfTask('task-1')!.change).toBe('api')
    expect(store!.ownerOfTask('task-2')).toBeNull()
  })
})

describe('the landing slot', () => {
  test('entering landing takes it, leaving releases it, and finishing releases it', () => {
    const [store] = stores
    const { id } = store!.insertExecution(execution())
    toLanding(store!, id, 'api')
    expect(store!.slot('team')).toMatchObject({ holderKind: 'change', holderId: `${id}:api` })
    store!.transition(id, 'api', store!.change(id, 'api')!, { step: 'merging' })
    expect(store!.slot('team')!.holderId).toBe(`${id}:api`)
    store!.transition(id, 'api', store!.change(id, 'api')!, { state: 'landed' })
    expect(store!.slot('team')).toBeNull()
    toLanding(store!, id, 'ui')
    store!.finishExecution(id, 'stopped', 'x')
    expect(store!.slot('team')).toBeNull()
  })

  test('two racing takes: the second is slot-taken and its transition rolls back', () => {
    const first = stores[0]!.insertExecution(execution({ changes: [{ change: 'api', landed: false }] }))
    const second = stores[1]!.insertExecution(execution({ planId: 'plan-2', changes: [{ change: 'ui', landed: false }] }))
    toLanding(stores[0]!, first.id, 'api')
    for (const state of ['provisioning', 'implementing', 'gating'] as const) stores[1]!.transition(second.id, 'ui', stores[1]!.change(second.id, 'ui')!, { state })
    const gating = stores[1]!.change(second.id, 'ui')!
    expect(conflict(() => stores[1]!.transition(second.id, 'ui', gating, { state: 'landing' }))).toBe('slot-taken')
    expect(stores[1]!.change(second.id, 'ui')).toEqual(gating)
    expect(stores[1]!.slot('team')!.holderId).toBe(`${first.id}:api`)
  })

  test('an orphan slot row is cleared when the slot is found taken', () => {
    const [store] = stores
    const { id } = store!.insertExecution(execution())
    store!.db.prepare("INSERT INTO plan_landing_slots VALUES ('team', 'change', ?, 'then')").run(`${id}:ui`)
    toLanding(store!, id, 'api')
    expect(store!.slot('team')!.holderId).toBe(`${id}:api`)
  })

  test('orphans are cleared at startup; a live holder and an unknown mechanism kind are kept', () => {
    const [store] = stores
    const { id } = store!.insertExecution(execution())
    toLanding(store!, id, 'api')
    store!.db.prepare("INSERT INTO plan_landing_slots VALUES ('team-2', 'change', 'exec-gone:api', 'then')").run()
    store!.db.prepare("INSERT INTO plan_landing_slots VALUES ('team-3', 'queue', 'q1', 'then')").run()
    store!.db.prepare("INSERT INTO plan_landing_slots VALUES ('team-4', 'batch', 'b1', 'then')").run()
    store!.registerHolderKind('batch', () => false)
    expect(store!.clearOrphanSlots().map(slot => slot.teamId).sort()).toEqual(['team-2', 'team-4'])
    expect(store!.slot('team')).not.toBeNull()
    expect(store!.slot('team-3')).not.toBeNull()
  })
})
