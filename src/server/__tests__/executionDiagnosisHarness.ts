// The diagnosis property's case ownership (review-convergence properties P1,
// P3; seed 0xC0FE1D): every case opens its own world and bench, hands that
// bench to every operation it starts, and tears it down itself once its body
// and every executor it made have settled. Nothing a case reads, writes, or
// closes is reachable from another case, so a case that timed out and is
// still running cannot touch its successor's fixture.
import { expect } from 'bun:test'
import { blocking } from '../../shared/findingsLedger'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import type { ExecutionExecutor } from '../plans/execution/executor'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { DiagnosisStore, type DiagnosisRow } from '../plans/execution/diagnosisStore'
import { decideDiagnosis } from './diagnosisTestKit'
import {
  createMatrixBench, createMatrixWorld, greenChecks, removeMatrixWorld, shapedReview, startedExecution, submitWork,
  type MatrixBench, type MatrixFixture, type MatrixWorld,
} from './executionMatrixHarness'
import { writeGroup } from './planHarness'
import { pick } from './convergenceGenerator'

export const ROLES = {
  roles: [{ group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] }, { group: 'leads', profiles: ['opus'] }, { group: 'senior-devs', profiles: [] }],
  leadGroup: 'leads',
}

/** One case's fixture: its world, its bench, and what it counted. Created and closed only by its own case. */
export interface DiagnosisCase {
  readonly index: number
  readonly matrix: MatrixWorld
  readonly h: MatrixBench
  /** The classes this case reached; the file merges it once the case passed. */
  readonly reached: Map<string, number>
  content: number
  /** True once teardown has finished; `closing` is the one teardown every closer shares. */
  closed: boolean
  closing: Promise<void> | null
  /** Every executor the case made: closed and joined before the database goes. */
  readonly executors: Set<ExecutionExecutor>
}

export async function openDiagnosisCase(index: number, primary?: MatrixFixture['executor']): Promise<DiagnosisCase> {
  const matrix = await createMatrixWorld('kawai-diagnosis-props-')
  writeGroup(matrix.world, 'senior-devs', '---\nmax: 4\n---\nBuild hard things.')
  // The in-memory template: this case never reopens a file or exercises a migration.
  const h = createMatrixBench(matrix, { database: 'template', ...(primary ? { executor: primary } : {}) })
  return { index, matrix, h, reached: new Map(), content: 0, closed: false, closing: null, executors: new Set([h.executor]) }
}

/**
 * Stop the case's executor, wait for its in-flight tick (and the git it runs)
 * to settle, and only then close the database and remove the world.
 */
export function closeDiagnosisCase(c: DiagnosisCase): Promise<void> {
  c.closing ??= tearDown(c)
  return c.closing
}

async function tearDown(c: DiagnosisCase): Promise<void> {
  for (const executor of c.executors) executor.close()
  try { await Promise.all([...c.executors].map(executor => executor.idle())) } finally {
    try { c.h.bench.db.close() } finally { removeMatrixWorld(c.matrix); c.closed = true }
  }
}

/** Make the case answer for an executor it built (a restart, a crash seam, a held adapter). */
export function ownExecutor(c: DiagnosisCase, executor: ExecutionExecutor): ExecutionExecutor {
  c.executors.add(executor)
  return executor
}

export const tally = (c: DiagnosisCase, key: string) => c.reached.set(key, (c.reached.get(key) ?? 0) + 1)
export const teamIdOf = (c: DiagnosisCase) => c.matrix.world.team.teamId
export const diagnosesOf = (c: DiagnosisCase, executionId: string, change: string) => new DiagnosisStore(c.h.bench.db.db).ofChange(executionId, change)
export const fixAttempts = (c: DiagnosisCase, executionId: string, change: string, roundId: string) =>
  c.h.executions.attempts(executionId, change).filter(attempt => attempt.kind === 'fix' && attempt.manifest.answers?.roundId === roundId)

/** Tick with an executor that throws at `seam`, then let the production executor recover. */
export async function crashAt(c: DiagnosisCase, seam: 'diagnosisAfterCardInsert' | 'diagnosisBeforeClose') {
  const crashing = ownExecutor(c, c.h.makeExecutor({ [seam]: () => { throw new Error(`crash at ${seam}`) } }))
  try { await c.h.tick(crashing) } catch { /* the wake loop logs it */ } finally { crashing.close(); await crashing.idle(); c.executors.delete(crashing) }
  tally(c, `crash:${seam}`)
}

/** One round from implementing: the work, CI (sometimes failing), and the review's shape. */
async function round(c: DiagnosisCase, rng: () => number, executionId: string, change: string) {
  const { h } = c
  c.content += 1
  const ciFails = rng() < 0.12
  if (ciFails) h.gh.defaultChecks = [...greenChecks().filter(check => check.name !== 'e2e'), { name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null }]
  try {
    await submitWork(h, executionId, change, `src/${change}.ts`, `export const v = ${c.content}\n`)
    await h.tick()
  } finally { h.gh.defaultChecks = greenChecks() }
  if (ciFails) { tally(c, 'ci-fail'); await h.tick(); return }
  const latest = h.executions.change(executionId, change)!
  if (latest.step !== 'reviewing') { await h.tick(); return }
  const open = blocking(h.results.findingsLedger.ledger(latest.taskId!)).length
  const passing = rng() < 0.1
  const raise = passing ? [] : Array.from({ length: Math.floor(rng() * 3) }, (_, index) => `src/${change}-${c.content}-${index}.ts:1 wrong`)
  const resolve = passing ? open : Math.min(open, Math.floor(rng() * 2))
  // The verdict is derived: a review that leaves nothing blocking passes.
  const pass = open - resolve + raise.length === 0
  await shapedReview(h, executionId, change, pass ? 'pass' : 'fail', { raise, resolve })
  tally(c, pass ? 'review-pass' : 'review-fail')
  if (!pass && rng() < 0.25) await crashAt(c, 'diagnosisAfterCardInsert')
  await h.tick()
}

/** Decide the open diagnosis (or publish a revision under it), sometimes crashing before its close. */
async function diagnose(c: DiagnosisCase, rng: () => number, executionId: string, change: string, open: DiagnosisRow) {
  const { h } = c
  const taskId = h.executions.change(executionId, change)!.taskId!
  if (rng() < 0.15) {
    await h.tasks.amend(h.bench.human, taskId, { direction: `Revised ${c.content}`, rationale: 'the owner revised it' })
    tally(c, 'outcome:revision')
  } else {
    const card = new DecisionStore(h.bench.db.db).card(teamIdOf(c), open.cardId)!
    const options = card.options.filter(option => option !== 'Escalate' || rng() < 0.3)
    const choice = pick(rng, options)
    decideDiagnosis(h.bench.db.db, teamIdOf(c), executionId, change, choice)
    tally(c, `outcome:${choice.split(' ')[0]}`)
    if (choice !== 'Amend the contract' && rng() < 0.3) await crashAt(c, 'diagnosisBeforeClose')
    await h.tick()
    if (choice === 'Amend the contract') {
      await h.tasks.amend(h.bench.human, taskId, { direction: `Amended ${c.content}`, rationale: 'amended as asked' })
    }
  }
  await h.tick()
  await h.tick()
}

/** P1 over the change now: one diagnosis and card per round, at most one fix attempt per failed round. */
export function checkP1(c: DiagnosisCase, executionId: string, change: string, closedAttempts: Map<string, number>) {
  const { h } = c
  const diagnoses = diagnosesOf(c, executionId, change)
  const perRound = new Map<string, number>()
  for (const diagnosis of diagnoses) perRound.set(diagnosis.roundId, (perRound.get(diagnosis.roundId) ?? 0) + 1)
  expect([...perRound.values()].filter(count => count > 1)).toEqual([])
  const planId = h.executions.execution(executionId)!.planId
  const cards = new DecisionStore(h.bench.db.db).cardsOfPlan(teamIdOf(c), planId).filter(card => card.kind === 'diagnosis')
  expect(cards.map(card => card.id).sort()).toEqual(diagnoses.map(diagnosis => diagnosis.cardId).sort())
  for (const failed of h.executions.rounds(executionId, change).filter(entry => entry.outcome === 'fail')) {
    expect({ round: failed.number, twice: fixAttempts(c, executionId, change, failed.id).length > 1 }).toEqual({ round: failed.number, twice: false })
  }
  // I5: a closed diagnosis's round keeps the attempts it had when it closed.
  for (const diagnosis of diagnoses.filter(entry => entry.closedAt !== null)) {
    const now = fixAttempts(c, executionId, change, diagnosis.roundId).length
    const then = closedAttempts.get(diagnosis.id)
    if (then === undefined) closedAttempts.set(diagnosis.id, now)
    else expect({ diagnosis: diagnosis.id, attempts: now }).toEqual({ diagnosis: diagnosis.id, attempts: then })
  }
}

const FIXING = new Set(['fix', 'reassign'])

/** Test seam: runs at the top of each step of the case's loop with the case's own fixture (a witness holds the case here). */
export interface DiagnosisCaseHooks {
  beforeStep?: (c: DiagnosisCase, step: number) => Promise<void>
  /** Deps overriding the case's primary executor, from its execution store (a held adapter). */
  primary?: MatrixFixture['executor']
}

/**
 * One property case (seed 0xC0FE1D + index): open its fixture, run the nine
 * steps with P1 after each and P3 over the failed rounds, close the fixture
 * whatever happened, and return the classes it reached.
 */
export async function runDiagnosisCase(index: number, seed: number, hooks: DiagnosisCaseHooks = {}): Promise<Map<string, number>> {
  const c = await openDiagnosisCase(index, hooks.primary)
  try {
    await driveCase(c, seed, hooks)
    return c.reached
  } finally { await closeDiagnosisCase(c) }
}

const running = new Set<Promise<unknown>>()

/** The case as the property starts it: registered until it settles, so the next case can wait for it. */
export function startDiagnosisCase(index: number, seed: number, hooks: DiagnosisCaseHooks = {}): Promise<Map<string, number>> {
  const done = runDiagnosisCase(index, seed, hooks)
  running.add(done)
  done.then(() => running.delete(done), () => running.delete(done))
  return done
}

/** Wait for every started case to settle, passed or failed (a failure stays on its own promise). */
export const joinDiagnosisCases = (): Promise<unknown> => Promise.allSettled(running)

async function driveCase(c: DiagnosisCase, seed: number, hooks: DiagnosisCaseHooks): Promise<void> {
  const rng = mulberry32(seed + c.index)
  const change = `p-${c.index}`
  const executionId = await startedExecution(c.h, [{ change }, { change: `${change}-other`, group: 'senior-devs' }], ROLES)
  await c.h.tick()
  const closedAttempts = new Map<string, number>()
  let retried = false
  for (let step = 0; step < 9; step++) {
    await hooks.beforeStep?.(c, step)
    const row = c.h.executions.change(executionId, change)!
    if (row.state === 'stopped' && row.stopReason === 'diagnosis-escalated' && !retried && rng() < 0.8) {
      // The owner's Retry: the closed diagnosis's round gets its fix now (not a re-application).
      retried = true
      const escalated = diagnosesOf(c, executionId, change).at(-1)!
      expect(await c.h.service.retry(c.h.bench.human, { executionId, change, commandId: `retry-${c.index}` })).toMatchObject({ ok: true })
      await c.h.tick()
      closedAttempts.delete(escalated.id)
      tally(c, 'retry')
      checkP1(c, executionId, change, closedAttempts)
      continue
    }
    if (row.state === 'stopped' || row.state === 'landed' || row.state === 'landing' || (row.state === 'gating' && row.step !== 'diagnosing' && row.step !== 'reviewing')) break
    const open = new DiagnosisStore(c.h.bench.db.db).open(executionId, change)
    if (row.step === 'diagnosing' && open !== null) {
      tally(c, 'diagnosis-open')
      await diagnose(c, rng, executionId, change, open)
      const closed = diagnosesOf(c, executionId, change).find(entry => entry.id === open.id)!
      if (closed.closedAt !== null && rng() < 0.35) {
        // A later decision on the closed card: the stage never applies it (I5).
        checkP1(c, executionId, change, closedAttempts)
        const card = new DecisionStore(c.h.bench.db.db).card(teamIdOf(c), closed.cardId)!
        decideDiagnosis(c.h.bench.db.db, teamIdOf(c), executionId, change, pick(rng, card.options), { kind: 'override' })
        await c.h.tick()
        await c.h.tick()
        tally(c, 'late-override')
      }
    } else if (row.state === 'implementing') {
      await round(c, rng, executionId, change)
    } else {
      await c.h.tick()
    }
    checkP1(c, executionId, change, closedAttempts)
  }
  // P3 over every failed round but the newest one still waiting on its fix step.
  const diagnoses = diagnosesOf(c, executionId, change)
  const rounds = c.h.executions.rounds(executionId, change)
  const current = c.h.executions.change(executionId, change)!
  for (const failed of rounds.filter(entry => entry.outcome === 'fail')) {
    const diagnosis = diagnoses.find(entry => entry.roundId === failed.id) ?? null
    const later = rounds.some(entry => entry.number > failed.number && entry.outcome !== 'superseded')
    const fixed = fixAttempts(c, executionId, change, failed.id).length > 0
    let expected: boolean
    if (diagnosis === null) {
      // DO "fix dispatched", unless the change stopped on this round (the Retry belongs to the owner).
      expected = !(current.state === 'stopped' && !later)
      tally(c, 'p3:no-diagnosis')
    } else if (diagnosis.closedAt === null) {
      expected = false
      tally(c, 'p3:open')
    } else if (diagnosis.closeReason === 'revision') {
      expected = true
      tally(c, 'p3:revision')
    } else if (FIXING.has(diagnosis.outcome ?? '')) {
      expected = true
      tally(c, `p3:${diagnosis.outcome}`)
    } else if (diagnosis.outcome === 'reject') {
      // DX5 sends the fix when blockers remain; DX4 re-gates to a pass with none.
      const regated = rounds.some(entry => entry.number > failed.number && entry.resultId === failed.resultId && entry.outcome === 'pass')
      expected = !regated
      tally(c, regated ? 'p3:reject-pass' : 'p3:reject-fix')
    } else if (diagnosis.outcome === 'escalate' && retried) {
      // A8: Retry of the escalated change dispatches the fix.
      expected = true
      tally(c, 'p3:escalate-retried')
    } else {
      expected = false
      tally(c, `p3:${diagnosis.outcome}`)
    }
    expect({ round: failed.number, diagnosis: diagnosis?.outcome ?? diagnosis?.closeReason ?? null, fixed }).toEqual({ round: failed.number, diagnosis: diagnosis?.outcome ?? diagnosis?.closeReason ?? null, fixed: expected })
  }
}
