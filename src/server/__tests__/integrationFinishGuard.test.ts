// The integration finish's fast-forward pre-guard (plan (a) item 4, F5
// shape): while the change has a live landing-kind row of another kind, the
// finish inserts nothing and returns (wait); the same identity goes through
// insertEffect's adoption. At b1324bd9 the guard is absent: finish() inserts
// a fast-forward beside a live update-branch, and A8(i) then makes both due
// while the change holds the landing slot (I-B: one landing effect decides).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  createMatrixBench, createMatrixWorld, passedChange, removeMatrixWorld,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { createIntegrationBench, startedIntegration, type IntegrationBench } from './integrationMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let n = 0

beforeAll(async () => { matrix = await createMatrixWorld('kawai-ff-guard-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix); i = createIntegrationBench(h); n += 1 })
afterEach(() => { i.executor.close(); h.executor.close(); h.bench.db.close() })

const change = (executionId: string, name: string) => h.executions.change(executionId, name)!
const passed = async (executionId: string, name: string) => {
  const real = h.tick
  h.tick = () => i.tick()
  try {
    return await passedChange(h, executionId, name)
  } finally {
    h.tick = real
  }
}

describe('integration finish fast-forward pre-guard (plan (a) item 4)', () => {
  test('a live update-branch of the change blocks the fast-forward insert', async () => {
    const branch = `wave/ff-${n}`
    const name = `ff${n}`
    const executionId = await startedIntegration(h, i, branch, [{ change: name }])
    await passed(executionId, name)
    // The crash window: a prior round's update-branch is still live (unknown,
    // parked past its inspection) while the change reaches the finish step.
    const live = h.executions.insertEffect({
      executionId, change: name, roundId: null, kind: 'update-branch',
      effectKey: `${executionId}:${name}:update-branch:stale:0`,
      command: { repo: 'o/r', pr: 1, head: 'stale-head' },
    })
    h.executions.scheduleInspectionRetry(live.id, '2099-01-01T00:00:00.000Z', null)
    expect(h.executions.liveLandingEffect(executionId, name)).toMatchObject({ kind: 'update-branch' })
    const before = h.executions.effectsOf(executionId).filter(effect => effect.kind === 'fast-forward').length
    await i.tick()
    await i.tick()
    const after = h.executions.effectsOf(executionId).filter(effect => effect.kind === 'fast-forward')
    expect({
      ffInserted: after.length - before,
      fastForwards: i.refs.fastForwards.length,
      step: change(executionId, name).step,
      liveState: h.executions.effect(live.id)!.state,
    }).toEqual({ ffInserted: 0, fastForwards: 0, step: 'up-to-date', liveState: 'unknown' })
  }, 30_000)
})
