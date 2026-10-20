// The supervision loader reads every input in one read transaction
// (plan-supervision O1): a write another connection commits between the
// loader's reads — here, while it reads one change's instruction holder —
// can never leave the view showing that write for one change and not for
// another. Under the rollback journal the outside write is refused while the
// read holds its shared lock, and lands once the read ends.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import { readSupervisionInputs, type SupervisionReads } from '../plans/supervision/supervisionRead'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createSupervisionBench, T0, type SupervisionBench } from './supervisionHarness'

let world: PlanWorld
let bench: SupervisionBench
beforeAll(async () => { world = await createPlanWorld('kawai-supervision-read-tx-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createSupervisionBench(world)
})

test("a write committed between the loader's reads never yields a mixed view: both changes' rounds or neither", async () => {
  const planId = await bench.approvedPlan()
  const executionId = bench.start(planId)
  await bench.implementing(executionId, planId, new Date(T0).toISOString())
  const outside = new Database(bench.db.db.filename)
  outside.exec('PRAGMA busy_timeout = 0')
  // One outside transaction adds a round to api and to ui.
  const writeBoth = () => outside.transaction(() => {
    for (const change of ['api', 'ui']) {
      outside.prepare(`INSERT INTO plan_execution_rounds (id, execution_id, change, attempt_id, number, result_id, commit_sha, fix_round)
        VALUES (?, ?, ?, 'attempt-x', 1, 'result-x', 'c1', 0)`).run(`round-${change}`, executionId, change)
    }
  })()
  let attempted = false
  let refused: unknown = null
  const { reads } = bench.compose()
  const hooked: SupervisionReads = {
    ...reads,
    runtime: {
      ...reads.runtime,
      // api's rounds are already read here; ui's are read after.
      holder: (session, taskId) => {
        if (!attempted) {
          attempted = true
          try { writeBoth() } catch (error) { refused = error }
        }
        return reads.runtime.holder(session, taskId)
      },
    },
  }
  const read = readSupervisionInputs(hooked, world.team.teamId, planId)!
  expect(attempted).toBe(true)
  const roundsOf = (change: string) => read.inputs.find(input => input.change === change)!.rounds.length
  expect(roundsOf('api')).toBe(roundsOf('ui'))
  expect(roundsOf('api')).toBe(0)
  expect(String(refused)).toContain('locked')
  // Once the read ends the same write lands, and the next read sees both.
  writeBoth()
  const after = readSupervisionInputs(reads, world.team.teamId, planId)!
  expect(after.inputs.filter(input => input.change === 'api' || input.change === 'ui').map(input => input.rounds.length)).toEqual([1, 1])
  outside.close()
})
