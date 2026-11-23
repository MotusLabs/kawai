// DL12 end to end (plan-revision-apply spec "Only the lead group changed",
// review F4): a revision whose only difference is `leadGroup`, run through
// the real ApplyService preview and Apply over the Apply bench, then a
// decision card raised by the change's developer through the real
// DecisionService. Every change reads unchanged, the preview carries the
// informational `lead-changed` finding and asks no choice, the Apply
// succeeds with unchanged publication rows and no task revision, and the
// card raised after it goes to the new lead group — the one raised before
// the revision's approval went to the old one.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PlanContent } from '../../shared/plans'
import { applyBench, type ApplyBench } from './applyBench'
import { createDecisionBench, LEAD_ROLES, type DecisionBench } from './decisionHarness'
import { writeGroup } from './planHarness'

let wired: ApplyBench
let decisions: DecisionBench

beforeAll(async () => {
  wired = await applyBench('apply-lead-change')
  writeGroup(wired.world, 'change-leads', '---\ncanCreatePlans: true\n---\nChange lead.')
  decisions = createDecisionBench(wired.world, wired.bench)
})
afterAll(() => wired.close())

const ROLES = { roles: [...LEAD_ROLES.roles, { group: 'change-leads', profiles: ['opus'] }], leadGroup: 'leads' }

describe('only the lead group changed (DL12)', () => {
  // @covers: plan-revision-apply › Kawai classifies every change against the running revision › Only the lead group changed
  test('DL12 through the preview, the Apply, and a new card: every change unchanged, lead-changed, no choice, Apply succeeds, and later cards go to the new lead group', async () => {
    const { planId, executionId } = await wired.running(ROLES)
    const ui = await wired.inFlightByKawai(executionId, 'ui', 'dev')
    const task = { id: ui.taskId, teamId: wired.teamId, planId, planChange: 'ui' }
    const ask = (question: string) => decisions.decide.askForTask({ sessionId: 'dev', task, question, options: ['yes', 'no'], context: null }, () => {})
    const before = await ask('Before the new lead?')
    expect({ addressedTo: before.addressedTo, group: before.addressedGroup }).toEqual({ addressedTo: 'lead', group: 'leads' })

    const second = await wired.approveNext(planId, (content: PlanContent) => ({ ...content, leadGroup: 'change-leads' }))
    const previewed = await wired.apply.preview(wired.bench.human, { executionId, revision: second.revision })
    if (!previewed.ok) throw new Error(`preview refused: ${JSON.stringify(previewed)}`)
    const { preview } = previewed
    expect(preview.delta!.changes.map(entry => ({ change: entry.change, class: entry.class })))
      .toEqual([{ change: 'api', class: 'unchanged' }, { change: 'ui', class: 'unchanged' }])
    expect(preview.delta!.findings.map(finding => finding.kind)).toEqual(['lead-changed'])
    expect(preview.needed).toEqual([])
    // Every precondition stands: none names a failure.
    expect(preview.standing.filter(entry => entry.message !== null)).toEqual([])

    const revisions = wired.tasks.store.revisions(ui.taskId).length
    const outcome = await wired.apply.apply(wired.bench.human, {
      executionId, expectedRevision: preview.fromRevision, revision: second.revision, contentHash: second.hash,
      choices: {}, rationale: 'a new lead coordinates', commandId: 'dl12-apply',
    })
    if (!outcome.ok) throw new Error(`Apply refused: ${JSON.stringify(outcome)}`)
    expect(outcome.applied.changes.map(row => ({ change: row.change, class: row.class, choice: row.choice })))
      .toEqual([{ change: 'api', class: 'unchanged', choice: null }, { change: 'ui', class: 'unchanged', choice: null }])
    expect(wired.executions.execution(executionId)!.revision).toBe(second.revision)
    expect(wired.tasks.store.revisions(ui.taskId)).toHaveLength(revisions)

    const after = await ask('After the new lead?')
    expect({ addressedTo: after.addressedTo, group: after.addressedGroup, revision: after.revision })
      .toEqual({ addressedTo: 'lead', group: 'change-leads', revision: second.revision })
  })
})
