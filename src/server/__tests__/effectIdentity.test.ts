// A1's enforcement units (effect lifecycle): one live effect per identity,
// proven at the two insertEffect writers. A live row of the same identity
// adopts only a matching command pin; a changed pin refuses and writes
// nothing; a row of another identity is never adopted. Provision is outside
// the identity list and keeps the exact-key dedupe.
import { beforeEach, describe, expect, test } from 'bun:test'
import { schemaDb } from './schemaDb'
import { EffectPinConflict } from '../plans/execution/executionEffectStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'

let executions: ExecutionStore
let promotions: IntegrationStore
beforeEach(() => {
  executions = new ExecutionStore(schemaDb())
  promotions = new IntegrationStore(schemaDb(), () => new Date(0))
})

const insert = (over: Partial<Parameters<ExecutionStore['insertEffect']>[0]> = {}) => executions.insertEffect({
  executionId: 'exec-1', change: 'api', roundId: 'round-1', kind: 'push',
  effectKey: 'exec-1:api:push:1:0', command: { cwd: '/repo', commit: 'c1', branch: 'api' }, ...over,
})
const throwsPin = (run: () => unknown): EffectPinConflict => {
  try {
    run()
  } catch (error) {
    if (error instanceof EffectPinConflict) return error
    throw error
  }
  throw new Error('expected EffectPinConflict')
}

describe('round identity (execution, change, kind, round)', () => {
  test('a generation-bumped key adopts the live row: one row, the original id', () => {
    const first = insert()
    const again = insert({ effectKey: 'exec-1:api:push:1:1' })
    expect(again.id).toBe(first.id)
    expect(executions.effectsOf('exec-1')).toHaveLength(1)
  })

  test('a changed pin refuses and writes nothing', () => {
    const first = insert()
    const refused = throwsPin(() => insert({ effectKey: 'exec-1:api:push:1:1', command: { cwd: '/repo', commit: 'c2', branch: 'api' } }))
    expect(refused.effectId).toBe(first.id)
    expect(executions.effectsOf('exec-1')).toHaveLength(1)
  })

  test('another round is another identity: never adopted', () => {
    const first = insert()
    const second = insert({ roundId: 'round-2', effectKey: 'exec-1:api:push:2:0', command: { cwd: '/repo', commit: 'c2', branch: 'api' } })
    expect(second.id).not.toBe(first.id)
    expect(executions.effectsOf('exec-1')).toHaveLength(2)
  })

  test('a settled row of the identity is never adopted', () => {
    const first = insert()
    executions.setEffectOutcome(first.id, { state: 'done', outcome: {} })
    const second = insert({ effectKey: 'exec-1:api:push:1:1', command: { cwd: '/repo', commit: 'c2', branch: 'api' } })
    expect(second.id).not.toBe(first.id)
    expect(executions.effectsOf('exec-1')).toHaveLength(2)
  })
})

describe('execution-level identity (execution, kind) with change null', () => {
  test('a recount key adopts the live row', () => {
    const first = executions.insertEffect({
      executionId: 'exec-1', change: null, roundId: null, kind: 'create-integration',
      effectKey: 'exec-1::create-integration:1', command: { repo: 'o/r', branch: 'int', sha: 's1' },
    })
    const again = executions.insertEffect({
      executionId: 'exec-1', change: null, roundId: null, kind: 'create-integration',
      effectKey: 'exec-1::create-integration:2', command: { repo: 'o/r', branch: 'int', sha: 's1' },
    })
    expect(again.id).toBe(first.id)
    expect(executions.effectsOf('exec-1')).toHaveLength(1)
  })

  test('a changed pin refuses', () => {
    const first = executions.insertEffect({
      executionId: 'exec-1', change: null, roundId: null, kind: 'create-integration',
      effectKey: 'exec-1::create-integration:1', command: { repo: 'o/r', branch: 'int', sha: 's1' },
    })
    const refused = throwsPin(() => executions.insertEffect({
      executionId: 'exec-1', change: null, roundId: null, kind: 'create-integration',
      effectKey: 'exec-1::create-integration:2', command: { repo: 'o/r', branch: 'int', sha: 's2' },
    }))
    expect(refused.effectId).toBe(first.id)
    expect(executions.effectsOf('exec-1')).toHaveLength(1)
  })
})

describe('promotion identity (promotion, kind, moves)', () => {
  const rerun = (over: Partial<Parameters<IntegrationStore['insertEffect']>[0]> = {}) => promotions.insertEffect({
    promotionId: 'promo-1', kind: 'rerun', effectKey: 'promo:promo-1:rerun:0',
    command: { repo: 'o/r', runIds: [7] }, ...over,
  })

  test('the same key adopts the live row', () => {
    const first = rerun()
    expect(rerun().id).toBe(first.id)
    expect(promotions.promotionEffects('promo-1')).toHaveLength(1)
  })

  test('a changed pin refuses', () => {
    const first = rerun()
    const refused = throwsPin(() => rerun({ command: { repo: 'o/r', runIds: [8] } }))
    expect(refused.effectId).toBe(first.id)
    expect(promotions.promotionEffects('promo-1')).toHaveLength(1)
  })

  test('another moves suffix is another identity: a second row inserts', () => {
    rerun()
    const moved = rerun({ effectKey: 'promo:promo-1:rerun:1' })
    expect(moved.id).not.toBe(rerun().id)
    expect(promotions.promotionEffects('promo-1')).toHaveLength(2)
  })
})

describe('provision is outside the identity list', () => {
  test('the exact key dedupes whatever the command says', () => {
    const first = insert({ kind: 'provision', roundId: null, effectKey: 'exec-1:api:provision:1:0', command: { path: '/wt' } })
    const again = insert({ kind: 'provision', roundId: null, effectKey: 'exec-1:api:provision:1:0', command: { path: '/wt' } })
    expect(again.id).toBe(first.id)
    expect(executions.effectsOf('exec-1')).toHaveLength(1)
  })
})
