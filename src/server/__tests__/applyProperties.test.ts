// Properties P1 and P2 and the CR/CH model-based test (plan-revision-apply
// design "Properties", tasks 2.4) over the Apply bench: the real
// ApplyService, PlanService, stores, and TaskStore on a fresh test database,
// git reads through stubs that check their arguments (the bench's probe and
// head read). The sequences are `applySequence.ts`'s: approvals, Applies with
// fresh or replayed command ids, concurrent pairs on one base, Stops, landings,
// and a crash at each of B0–B4 with the owner's retry.
// - P1, one history: revision rows contiguous from seq 1, one per seq, and the
//   execution's revision columns equal to the newest row.
// - P2, publish once: each adapted change has exactly one task revision and
//   one notice per Apply command id, whatever retries and crashes occur — the
//   notice to the outstanding claimant (CH4), so an adaptation after an
//   earlier one superseded the held assignment has none, never two.
// - The model-based test runs the CR and CH tables as the reference model and
//   compares the stored rows after every step.
// Seed 0x4A99, 200 declared cases through `propertyCases`; every run must
// reach applied and refused Applies, replays, races, and every boundary.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { applyBench, type ApplyBench } from './applyBench'
import { check, emptyStats, mulberry32, publishedOnce, startCase, step } from './applySequence'
import { propertyCases } from './helpers/propertyCases'

const SEED = 0x4A99
const CASES = 200

let wired: ApplyBench

beforeAll(async () => {
  // The migrated in-memory template: hundreds of cases write many rows, and a file database's syncs dominate their time.
  wired = await applyBench('apply-properties', { database: 'template' })
})
afterAll(() => wired.close())

/** Contiguous from seq 1, one per seq, and the columns equal to the newest row. */
function oneHistory(executionId: string, label: string): void {
  const rows = wired.revisions.history(executionId)
  expect({ label, seqs: rows.map(row => row.seq) }).toEqual({ label, seqs: rows.map((_, index) => index + 1) })
  const newest = rows.at(-1)!
  const execution = wired.executions.execution(executionId)!
  expect({ label, columns: [execution.revision, execution.contentHash, execution.reportId, execution.inputHash] })
    .toEqual({ label, columns: [newest.revision, newest.contentHash, newest.reportId, newest.inputHash] })
}

describe('Apply properties over command sequences (P1, P2, CR/CH model)', () => {
  test('P1 one history: revision rows contiguous from seq 1 and the execution\'s columns equal to the newest row (seed 0x4A99, 200 cases)', async () => {
    const next = mulberry32(SEED)
    const stats = emptyStats()
    for (let index = 0; index < propertyCases(CASES); index++) {
      const model = await startCase(wired)
      const steps = 4 + Math.floor(next() * 6)
      for (let at = 0; at < steps; at++) {
        const kind = await step(wired, model, next, stats)
        oneHistory(model.executionId, `case ${index} step ${at} ${kind}`)
      }
    }
    expect(stats.applied).toBeGreaterThan(0)
    expect(stats.refused).toBeGreaterThan(0)
  }, 600_000)

  test('P2 publish once: each adapted change has one task revision and one notice per Apply command id, across retries and crashes (seed 0x4A99, 200 cases)', async () => {
    const next = mulberry32(SEED)
    const stats = emptyStats()
    let publications = 0
    for (let index = 0; index < propertyCases(CASES); index++) {
      const model = await startCase(wired)
      const steps = 4 + Math.floor(next() * 6)
      for (let at = 0; at < steps; at++) await step(wired, model, next, stats)
      for (const pair of model.published) expect({ case: index, ...publishedOnce(wired, pair) }).toEqual({ case: index, ...pair, revisions: 1, notices: pair.notified ? 1 : 0 })
      for (const [change, taskId] of model.tasks) {
        expect({ case: index, change, revisions: wired.tasks.store.get(taskId)!.revision - 1, notices: wired.notices(taskId).length })
          .toEqual({ case: index, change, revisions: model.adapts.get(taskId) ?? 0, notices: model.notices.get(taskId) ?? 0 })
      }
      publications += model.published.length
    }
    expect(publications).toBeGreaterThan(0)
  }, 600_000)

  test('the CR/CH model: the crash and choice tables as the reference model over P1\'s sequences, compared after every step (seed 0x4A99, 200 cases)', async () => {
    const next = mulberry32(SEED)
    const stats = emptyStats()
    for (let index = 0; index < propertyCases(CASES); index++) {
      const model = await startCase(wired)
      const steps = 4 + Math.floor(next() * 6)
      for (let at = 0; at < steps; at++) {
        const kind = await step(wired, model, next, stats)
        check(wired, model, `case ${index} step ${at} ${kind}`)
      }
    }
    expect(stats.replays).toBeGreaterThan(0)
    expect(stats.races).toBeGreaterThan(0)
    for (const boundary of ['none', 'B0', 'B1', 'B2', 'B3', 'B4'] as const) expect({ boundary, seen: stats.crashes[boundary] > 0 }).toEqual({ boundary, seen: true })
  }, 600_000)
})
