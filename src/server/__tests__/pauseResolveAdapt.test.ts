// The resolve command's adapt rows (revision-control 4.4, A3's A-rows):
// each row verbatim as one test, plus the completeness grid over the axes
// keyed by choice 'adapt'. The feature lands with its rows; until then the
// rows that need the adapt branch name what they await. The bench wiring and
// the paused-target worlds live in pauseResolveBench.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'

let wired: PauseResolveBench

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve-adapt')
})

afterAll(() => {
  wired.close()
})

function refusal(outcome: { ok: boolean; reason?: string; message?: string }): { reason: string; message: string } {
  if (outcome.ok) throw new Error('expected a refusal')
  return { reason: outcome.reason ?? '', message: outcome.message ?? '' }
}

// A1r | decided | adapt | * | * | refused, naming the standing decision (I1)
test('A1r: a decided target refuses adapt naming the standing decision (I1 before the choice dispatch, N2)', async () => {
  const world = await wired.pausedAttempt()
  const decided = wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' })
  expect(decided.ok).toBe(true)
  const outcome = wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Rework it', rationale: 'the direction moved' })
  const { reason, message } = refusal(outcome)
  expect(reason).toBe('state')
  // The refusal names the standing decision — the pre-move stub refused the
  // choice first with a message that named none, so this detects its return.
  expect(message).toMatch(/already decided \(continue\)/)
  expect(message).toMatch(/Nothing was written/)
})
