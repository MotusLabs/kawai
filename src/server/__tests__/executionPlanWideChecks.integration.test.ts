// Plan-wide extra checks (plan-execution spec "every extra check is
// satisfied", §12.5's two extra-check scenarios, D11) over the matrix
// harness: a check the plan declares above its changes is listed in the
// implement and fix instructions, attested by the reviewer when no CI job
// reports it, decided by CI when one does — a failing one failing the round —
// gated together with a change's own check, and carried onto a round a
// clean branch update moves to a new head. The other plan-wide fields
// execution applies ride along: acceptance rules in the task and every
// instruction, and the plan's review group with its role's profiles unless a
// change names its own. Every reader goes through
// effectiveExtraChecks, so the Plans view's row shows the same labels.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { executionViewReads, executionViews } from '../plans/execution/executionView'
import type { CiCheck } from '../../shared/planExecution'
import {
  createMatrixBench, createMatrixWorld, greenChecks, passedChange, pushCommit, removeMatrixWorld, review, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { writeGroup } from './planHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => {
  matrix = await createMatrixWorld('kawai-plan-wide-checks-')
  writeGroup(matrix.world, 'auditors', '---\nmax: 2\n---\nAudit.')
})
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const assignmentsOf = (executionId: string, change: string) => h.tasks.store.assignmentsOf(row(executionId, change).taskId!)
const bodyOf = (assignment: { messageId: string | null }) => h.mail.get(assignment.messageId!)!.body
const reviewBody = (executionId: string, change: string) => bodyOf(assignmentsOf(executionId, change).filter(entry => entry.handoffKind === 'review').at(-1)!)
const instructionBodies = (executionId: string, change: string) => assignmentsOf(executionId, change).filter(entry => entry.handoffKind === null).map(bodyOf)
const viewRound = (executionId: string, change: string) => {
  const planId = h.executions.execution(executionId)!.planId
  return executionViews(h.executions, planId, executionViewReads(h.bench.plans, h.bench.db.db))
    .find(entry => entry.id === executionId)!.changes.find(entry => entry.change === change)!.latestRound!
}
const bundleSize = { name: 'bundle-size', description: 'The bundle stays under 2 MiB', command: 'bun run size' }
const a11y = { name: 'a11y', description: 'A screen reader announces the new row', command: null }
const bundleStatus = (conclusion: string): CiCheck => ({ name: 'bundle-size', source: 'status', conclusion, link: null, startedAt: null, completedAt: null })
const extraSection = (body: string) => body.slice(body.indexOf('Extra checks')).split('\n\n')[0]!

describe('plan-wide extra checks', () => {
  test('without a CI job a plan-wide check is listed in the implement instruction, attested by the reviewer, and labeled so', async () => {
    const executionId = await startedExecution(h, [{ change: 'pw-a' }], { extraChecks: [bundleSize] })
    await h.tick()
    expect(extraSection(instructionBodies(executionId, 'pw-a')[0]!)).toContain('bundle-size')
    await submitWork(h, executionId, 'pw-a', 'src/pa.ts', 'pa\n')
    await h.tick()
    expect(reviewBody(executionId, 'pw-a')).toContain('- bundle-size: The bundle stays under 2 MiB (command: bun run size)')
    // The round waits for the review: green CI alone never passes it.
    expect(h.executions.rounds(executionId, 'pw-a').at(-1)!.outcome).toBeNull()
    await review(h, executionId, 'pw-a', 'pass')
    await h.tick()
    const decided = h.executions.rounds(executionId, 'pw-a').at(-1)!
    expect(decided.outcome).toBe('pass')
    expect(decided.extra).toEqual([
      { name: 'bundle-size', description: bundleSize.description, command: 'bun run size', by: 'reviewer', outcome: 'attested' },
    ])
    expect(viewRound(executionId, 'pw-a').extraChecks).toEqual(decided.extra!)
  })

  test('a plan-wide check CI reports is CI\'s: never listed to attest, recorded as verified by CI', async () => {
    const executionId = await startedExecution(h, [{ change: 'pw-b' }], { extraChecks: [bundleSize] })
    await h.tick()
    h.gh.defaultChecks = [...greenChecks(), bundleStatus('success')]
    await submitWork(h, executionId, 'pw-b', 'src/pb.ts', 'pb\n')
    await h.tick()
    expect(reviewBody(executionId, 'pw-b')).not.toContain('Extra checks to attest')
    await review(h, executionId, 'pw-b', 'pass')
    await h.tick()
    expect(h.executions.rounds(executionId, 'pw-b').at(-1)!.extra).toEqual([
      { name: 'bundle-size', description: bundleSize.description, command: 'bun run size', by: 'ci', outcome: 'success' },
    ])
  })

  test('a failing plan-wide check CI reports fails the round, and the fix instruction lists it', async () => {
    const executionId = await startedExecution(h, [{ change: 'pw-c' }], { extraChecks: [bundleSize] })
    await h.tick()
    h.gh.defaultChecks = [...greenChecks(), bundleStatus('failure')]
    await submitWork(h, executionId, 'pw-c', 'src/pc.ts', 'pc\n')
    await h.tick()
    const failed = h.executions.rounds(executionId, 'pw-c')[0]!
    expect(failed.outcome).toBe('fail')
    expect(failed.reviewAssignmentId).toBeNull()
    // The fix attempt goes out on the next tick, as a `fix` handoff.
    await h.tick()
    const fixes = assignmentsOf(executionId, 'pw-c').filter(entry => entry.handoffKind === 'fix')
    expect(fixes).toHaveLength(1)
    expect(extraSection(bodyOf(fixes[0]!))).toContain('bundle-size')
  })

  test('mixed: a plan-wide check and a change\'s own check are both gated, plan-wide first', async () => {
    const executionId = await startedExecution(h, [{ change: 'pw-d', extraChecks: [a11y] }], { extraChecks: [bundleSize] })
    await h.tick()
    const implement = extraSection(instructionBodies(executionId, 'pw-d')[0]!)
    expect(implement).toContain('bundle-size')
    expect(implement).toContain('a11y')
    await submitWork(h, executionId, 'pw-d', 'src/pd.ts', 'pd\n')
    await h.tick()
    const attest = reviewBody(executionId, 'pw-d')
    expect(attest).toContain('- bundle-size: The bundle stays under 2 MiB (command: bun run size)')
    expect(attest).toContain('- a11y: A screen reader announces the new row')
    await review(h, executionId, 'pw-d', 'pass')
    await h.tick()
    expect(h.executions.rounds(executionId, 'pw-d').at(-1)!.extra).toEqual([
      { name: 'bundle-size', description: bundleSize.description, command: 'bun run size', by: 'reviewer', outcome: 'attested' },
      { name: 'a11y', description: a11y.description, command: null, by: 'reviewer', outcome: 'attested' },
    ])
  })

  test('a clean update carries the review: the carried round decides the plan-wide check again, still attested', async () => {
    const executionId = await startedExecution(h, [{ change: 'pw-e' }], { extraChecks: [bundleSize] })
    await passedChange(h, executionId, 'pw-e')
    pushCommit(matrix, 'master', 'other-pw-e.txt', 'e\n')
    for (let pass = 0; pass < 4 && row(executionId, 'pw-e').state !== 'landed'; pass++) await h.tick()
    const rounds = h.executions.rounds(executionId, 'pw-e')
    expect(rounds).toHaveLength(2)
    expect(rounds[1]!.carriedFrom).toBe(rounds[0]!.id)
    expect(rounds[1]!.extra).toEqual([
      { name: 'bundle-size', description: bundleSize.description, command: 'bun run size', by: 'reviewer', outcome: 'attested' },
    ])
  })
})

describe('the other plan-wide fields execution applies', () => {
  test('plan-wide acceptance rules reach the task, the implement instruction, and the fix instruction', async () => {
    const executionId = await startedExecution(h, [{ change: 'pf-a', acceptance: ['Rows render in order'] }], { acceptanceRules: ['No new dependency'] })
    await h.tick()
    expect(h.tasks.store.get(row(executionId, 'pf-a').taskId!)!.acceptance).toBe('Rows render in order\nNo new dependency')
    expect(instructionBodies(executionId, 'pf-a')[0]).toContain('No new dependency')
    h.gh.defaultChecks = [...greenChecks(), bundleStatus('failure')]
    await submitWork(h, executionId, 'pf-a', 'src/pfa.ts', 'pfa\n')
    await h.tick()
    await h.tick()
    const fixes = assignmentsOf(executionId, 'pf-a').filter(entry => entry.handoffKind === 'fix')
    expect(fixes).toHaveLength(1)
    expect(bodyOf(fixes[0]!)).toContain('No new dependency')
  })

  test('the plan\'s review group is the effective one, routed to its role\'s profiles; a change\'s own review group wins', async () => {
    const roles = [{ group: 'middle-devs', profiles: ['default'] }, { group: 'auditors', profiles: ['default'] }]
    const executionId = await startedExecution(h, [{ change: 'pf-b' }, { change: 'pf-c', reviewGroup: 'middle-devs' }], { roles, reviewGroup: 'auditors' })
    await h.tick()
    await submitWork(h, executionId, 'pf-b', 'src/pfb.ts', 'pfb\n')
    await submitWork(h, executionId, 'pf-c', 'src/pfc.ts', 'pfc\n')
    await h.tick()
    const [planWide] = assignmentsOf(executionId, 'pf-b').filter(entry => entry.handoffKind === 'review')
    expect({ kind: planWide!.targetKind, id: planWide!.targetId }).toEqual({ kind: 'group', id: 'auditors' })
    expect(h.mail.get(planWide!.messageId!)!.allowedProfiles).toEqual(['default'])
    const [own] = assignmentsOf(executionId, 'pf-c').filter(entry => entry.handoffKind === 'review')
    expect({ kind: own!.targetKind, id: own!.targetId }).toEqual({ kind: 'group', id: 'middle-devs' })
  })
})
