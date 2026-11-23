// Property P4, manifests keep their revision (plan-revision-apply design
// "Properties", invariant I5, design challenge DC1): every attempt the
// executor dispatches names, in its manifest, the revision current at its
// dispatch; no step rewrites a manifest; and an owed row left across an Apply
// is never sent — its successor at the current revision is. Same generator
// and seams as P1 (`applySequence.ts`, with holds placed and released between
// Applies), with the real executor — built over the bench's stores as a
// server builds it — ticking after every step. Seed 0x4A9B, 200 declared
// cases through `propertyCases`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { applyBench, type ApplyBench } from './applyBench'
import { afterTick, emptyStats, mulberry32, startCase, step } from './applySequence'
import { propertyCases } from './helpers/propertyCases'

const SEED = 0x4A9B
const CASES = 200

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-manifests', { database: 'template' })
})
afterAll(() => wired.close())

type Seen = Map<string, { manifest: string; assignmentId: string | null; revision: number }>

/**
 * Every stored attempt row of the execution: its manifest as stored, its assignment, and the revision it names —
 * read from the table, so a restored re-add's retired rows (no longer current, changeIncarnation.ts) are judged too.
 */
function attemptsOf(executionId: string): Seen {
  const seen: Seen = new Map()
  const rows = wired.bench.db.db.prepare('SELECT id, assignment_id, manifest_json FROM plan_execution_attempts WHERE execution_id = ? AND change = ? ORDER BY number')
  for (const change of wired.executions.changes(executionId)) {
    for (const row of rows.all(executionId, change.change) as Array<{ id: string; assignment_id: string | null; manifest_json: string }>) {
      const manifest = JSON.parse(row.manifest_json) as { plan: { revision: number } }
      seen.set(row.id, { manifest: JSON.stringify(manifest), assignmentId: row.assignment_id, revision: manifest.plan.revision })
    }
  }
  return seen
}

describe('Apply properties: manifests keep their revision (P4)', () => {
  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('P4 every dispatched attempt names the revision current at its dispatch; no manifest is rewritten; an owed row left across an Apply is never sent (seed 0x4A9B, 200 cases)', async () => {
    const next = mulberry32(SEED)
    const stats = emptyStats()
    let dispatched = 0
    let superseded = 0
    let successors = 0
    for (let index = 0; index < propertyCases(CASES); index++) {
      const model = await startCase(wired)
      // Each case starts with one change held, so owed rows meet later Applies before their release.
      const held = ['api', 'ui', 'docs'][Math.floor(next() * 3)]!
      model.holds.set(held, wired.placeHold(model.planId, [held], `hold-start-${index}`).id)
      const executor = wired.executor()
      // Longer than P1's: a held owed row needs an approval, an Apply, and a release after it.
      const steps = 6 + Math.floor(next() * 7)
      for (let at = 0; at < steps; at++) {
        const before = attemptsOf(model.executionId)
        const kind = await step(wired, model, next, stats, true)
        const label = `case ${index} step ${at} ${kind}`
        // The step itself rewrites no manifest and sends nothing stale.
        const afterStep = attemptsOf(model.executionId)
        for (const [id, row] of before) expect({ label, id, manifest: afterStep.get(id)?.manifest }).toEqual({ label, id, manifest: row.manifest })
        await executor.tick(wired.teamId)
        afterTick(model)
        const revision = wired.executions.execution(model.executionId)!.revision
        expect({ label, running: wired.executions.execution(model.executionId)!.state === 'running' }).toEqual({ label, running: model.running })
        const ticked = attemptsOf(model.executionId)
        for (const [id, row] of ticked) {
          const prior = afterStep.get(id)
          if (prior !== undefined) expect({ label, id, manifest: row.manifest }).toEqual({ label, id, manifest: prior.manifest })
          // Sent during this tick: no Apply ran during it, so the current revision is the one at its dispatch.
          if (row.assignmentId !== null && (prior === undefined || prior.assignmentId === null)) {
            dispatched += 1
            expect({ label, id, names: row.revision }).toEqual({ label, id, names: revision })
            // DC1's successor: sent in place of an unsent predecessor naming an older revision.
            const rows = [...ticked.entries()]
            const predecessor = rows[rows.findIndex(([key]) => key === id) - 1]?.[1]
            if (prior === undefined && predecessor !== undefined && predecessor.assignmentId === null && predecessor.revision < row.revision) successors += 1
          }
        }
        // An unsent row naming an older revision than the current one is never the one sent.
        for (const row of ticked.values()) if (row.assignmentId === null && row.revision < revision) superseded += 1
      }
    }
    // Non-vacuous: the executor dispatched attempts, stale owed rows met later Applies, and successors went out in their place.
    expect(dispatched).toBeGreaterThan(0)
    expect(superseded).toBeGreaterThan(0)
    expect(successors).toBeGreaterThan(0)
    expect(stats.applied).toBeGreaterThan(0)
  }, 600_000)
})
