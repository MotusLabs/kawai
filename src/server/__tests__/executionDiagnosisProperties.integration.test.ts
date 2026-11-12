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
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { blocking } from '../../shared/findingsLedger'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { DiagnosisStore, type DiagnosisRow } from '../plans/execution/diagnosisStore'
import { decideDiagnosis } from './diagnosisTestKit'
import { pick } from './convergenceGenerator'
import {
  createMatrixBench, createMatrixWorld, greenChecks, removeMatrixWorld, shapedReview, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { writeGroup } from './planHarness'

const SEED = 0xC0FE1D
const CASES = 24
const ROLES = {
  roles: [{ group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] }, { group: 'leads', profiles: ['opus'] }, { group: 'senior-devs', profiles: [] }],
  leadGroup: 'leads',
}

let matrix: MatrixWorld
let h: MatrixBench
const reached = new Map<string, number>()
const tally = (key: string) => reached.set(key, (reached.get(key) ?? 0) + 1)

beforeAll(async () => {
  matrix = await createMatrixWorld('kawai-diagnosis-props-')
  writeGroup(matrix.world, 'senior-devs', '---\nmax: 4\n---\nBuild hard things.')
})
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const teamId = () => matrix.world.team.teamId
const diagnosesOf = (executionId: string, change: string) => new DiagnosisStore(h.bench.db.db).ofChange(executionId, change)
const fixAttempts = (executionId: string, change: string, roundId: string) =>
  h.executions.attempts(executionId, change).filter(attempt => attempt.kind === 'fix' && attempt.manifest.answers?.roundId === roundId)

/** Tick with an executor that throws at `seam`, then let the production executor recover. */
async function crashAt(seam: 'diagnosisAfterCardInsert' | 'diagnosisBeforeClose') {
  const crashing = h.makeExecutor({ [seam]: () => { throw new Error(`crash at ${seam}`) } })
  try { await h.tick(crashing) } catch { /* the wake loop logs it */ } finally { crashing.close() }
  tally(`crash:${seam}`)
}

let content = 0
/** One round from implementing: the work, CI (sometimes failing), and the review's shape. */
async function round(rng: () => number, executionId: string, change: string) {
  content += 1
  const ciFails = rng() < 0.12
  if (ciFails) h.gh.defaultChecks = [...greenChecks().filter(check => check.name !== 'e2e'), { name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null }]
  try {
    await submitWork(h, executionId, change, `src/${change}.ts`, `export const v = ${content}\n`)
    await h.tick()
  } finally { h.gh.defaultChecks = greenChecks() }
  if (ciFails) { tally('ci-fail'); await h.tick(); return }
  const latest = h.executions.change(executionId, change)!
  if (latest.step !== 'reviewing') { await h.tick(); return }
  const open = blocking(h.results.findingsLedger.ledger(latest.taskId!)).length
  const passing = rng() < 0.1
  const raise = passing ? [] : Array.from({ length: Math.floor(rng() * 3) }, (_, index) => `src/${change}-${content}-${index}.ts:1 wrong`)
  const resolve = passing ? open : Math.min(open, Math.floor(rng() * 2))
  // The verdict is derived: a review that leaves nothing blocking passes.
  const pass = open - resolve + raise.length === 0
  await shapedReview(h, executionId, change, pass ? 'pass' : 'fail', { raise, resolve })
  tally(pass ? 'review-pass' : 'review-fail')
  if (!pass && rng() < 0.25) await crashAt('diagnosisAfterCardInsert')
  await h.tick()
}

/** Decide the open diagnosis (or publish a revision under it), sometimes crashing before its close. */
async function diagnose(rng: () => number, executionId: string, change: string, open: DiagnosisRow) {
  const taskId = h.executions.change(executionId, change)!.taskId!
  if (rng() < 0.15) {
    await h.tasks.amend(h.bench.human, taskId, { direction: `Revised ${content}`, rationale: 'the owner revised it' })
    tally('outcome:revision')
  } else {
    const card = new DecisionStore(h.bench.db.db).card(teamId(), open.cardId)!
    const options = card.options.filter(option => option !== 'Escalate' || rng() < 0.3)
    const choice = pick(rng, options)
    decideDiagnosis(h.bench.db.db, teamId(), executionId, change, choice)
    tally(`outcome:${choice.split(' ')[0]}`)
    if (choice !== 'Amend the contract' && rng() < 0.3) await crashAt('diagnosisBeforeClose')
    await h.tick()
    if (choice === 'Amend the contract') {
      await h.tasks.amend(h.bench.human, taskId, { direction: `Amended ${content}`, rationale: 'amended as asked' })
    }
  }
  await h.tick()
  await h.tick()
}

/** P1 over the change now: one diagnosis and card per round, at most one fix attempt per failed round. */
function checkP1(executionId: string, change: string, closedAttempts: Map<string, number>) {
  const diagnoses = diagnosesOf(executionId, change)
  const perRound = new Map<string, number>()
  for (const diagnosis of diagnoses) perRound.set(diagnosis.roundId, (perRound.get(diagnosis.roundId) ?? 0) + 1)
  expect([...perRound.values()].filter(count => count > 1)).toEqual([])
  const planId = h.executions.execution(executionId)!.planId
  const cards = new DecisionStore(h.bench.db.db).cardsOfPlan(teamId(), planId).filter(card => card.kind === 'diagnosis')
  expect(cards.map(card => card.id).sort()).toEqual(diagnoses.map(diagnosis => diagnosis.cardId).sort())
  for (const failed of h.executions.rounds(executionId, change).filter(entry => entry.outcome === 'fail')) {
    expect({ round: failed.number, twice: fixAttempts(executionId, change, failed.id).length > 1 }).toEqual({ round: failed.number, twice: false })
  }
  // I5: a closed diagnosis's round keeps the attempts it had when it closed.
  for (const diagnosis of diagnoses.filter(entry => entry.closedAt !== null)) {
    const now = fixAttempts(executionId, change, diagnosis.roundId).length
    const then = closedAttempts.get(diagnosis.id)
    if (then === undefined) closedAttempts.set(diagnosis.id, now)
    else expect({ diagnosis: diagnosis.id, attempts: now }).toEqual({ diagnosis: diagnosis.id, attempts: then })
  }
}

const FIXING = new Set(['fix', 'reassign'])

test.each(Array.from({ length: CASES }, (_, index) => index))('P1, P3 case %i (seed 0xC0FE1D + case)', async index => {
  const rng = mulberry32(SEED + index)
  const change = `p-${index}`
  const executionId = await startedExecution(h, [{ change }, { change: `${change}-other`, group: 'senior-devs' }], ROLES)
  await h.tick()
  const closedAttempts = new Map<string, number>()
  let retried = false
  for (let step = 0; step < 9; step++) {
    const row = h.executions.change(executionId, change)!
    if (row.state === 'stopped' && row.stopReason === 'diagnosis-escalated' && !retried && rng() < 0.8) {
      // The owner's Retry: the closed diagnosis's round gets its fix now (not a re-application).
      retried = true
      const escalated = diagnosesOf(executionId, change).at(-1)!
      expect(await h.service.retry(h.bench.human, { executionId, change, commandId: `retry-${index}` })).toMatchObject({ ok: true })
      await h.tick()
      closedAttempts.delete(escalated.id)
      tally('retry')
      checkP1(executionId, change, closedAttempts)
      continue
    }
    if (row.state === 'stopped' || row.state === 'landed' || row.state === 'landing' || (row.state === 'gating' && row.step !== 'diagnosing' && row.step !== 'reviewing')) break
    const open = new DiagnosisStore(h.bench.db.db).open(executionId, change)
    if (row.step === 'diagnosing' && open !== null) {
      tally('diagnosis-open')
      await diagnose(rng, executionId, change, open)
      const closed = diagnosesOf(executionId, change).find(entry => entry.id === open.id)!
      if (closed.closedAt !== null && rng() < 0.35) {
        // A later decision on the closed card: the stage never applies it (I5).
        checkP1(executionId, change, closedAttempts)
        const card = new DecisionStore(h.bench.db.db).card(teamId(), closed.cardId)!
        decideDiagnosis(h.bench.db.db, teamId(), executionId, change, pick(rng, card.options), { kind: 'override' })
        await h.tick()
        await h.tick()
        tally('late-override')
      }
    } else if (row.state === 'implementing') {
      await round(rng, executionId, change)
    } else {
      await h.tick()
    }
    checkP1(executionId, change, closedAttempts)
  }
  // P3 over every failed round but the newest one still waiting on its fix step.
  const diagnoses = diagnosesOf(executionId, change)
  const rounds = h.executions.rounds(executionId, change)
  const current = h.executions.change(executionId, change)!
  for (const failed of rounds.filter(entry => entry.outcome === 'fail')) {
    const diagnosis = diagnoses.find(entry => entry.roundId === failed.id) ?? null
    const later = rounds.some(entry => entry.number > failed.number && entry.outcome !== 'superseded')
    const fixed = fixAttempts(executionId, change, failed.id).length > 0
    let expected: boolean
    if (diagnosis === null) {
      // DO "fix dispatched", unless the change stopped on this round (the Retry belongs to the owner).
      expected = !(current.state === 'stopped' && !later)
      tally('p3:no-diagnosis')
    } else if (diagnosis.closedAt === null) {
      expected = false
      tally('p3:open')
    } else if (diagnosis.closeReason === 'revision') {
      expected = true
      tally('p3:revision')
    } else if (FIXING.has(diagnosis.outcome ?? '')) {
      expected = true
      tally(`p3:${diagnosis.outcome}`)
    } else if (diagnosis.outcome === 'reject') {
      // DX5 sends the fix when blockers remain; DX4 re-gates to a pass with none.
      const regated = rounds.some(entry => entry.number > failed.number && entry.resultId === failed.resultId && entry.outcome === 'pass')
      expected = !regated
      tally(regated ? 'p3:reject-pass' : 'p3:reject-fix')
    } else if (diagnosis.outcome === 'escalate' && retried) {
      // A8: Retry of the escalated change dispatches the fix.
      expected = true
      tally('p3:escalate-retried')
    } else {
      expected = false
      tally(`p3:${diagnosis.outcome}`)
    }
    expect({ round: failed.number, diagnosis: diagnosis?.outcome ?? diagnosis?.closeReason ?? null, fixed }).toEqual({ round: failed.number, diagnosis: diagnosis?.outcome ?? diagnosis?.closeReason ?? null, fixed: expected })
  }
})

test('the 24 cases reach the open step, every outcome, the crashes, and a late override', () => {
  for (const key of ['diagnosis-open', 'outcome:Fix', 'outcome:Reject', 'outcome:Amend', 'outcome:Reassign', 'outcome:Escalate', 'outcome:revision',
    'crash:diagnosisAfterCardInsert', 'crash:diagnosisBeforeClose', 'late-override', 'retry', 'p3:no-diagnosis', 'p3:fix', 'p3:escalate-retried']) {
    expect({ key, reached: (reached.get(key) ?? 0) > 0 }).toEqual({ key, reached: true })
  }
})
