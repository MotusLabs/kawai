// review-convergence tables DO and DX (tasks 4.1, 5.1) through the matrix
// bench's production executor: a failed round's fix step opens a diagnosis
// instead of the fix when a signal fires on its review or the backstop is
// reached (DO), and the diagnosis stage applies the card's newest decision
// from the stored rows (DX). Decisions are recorded through the real
// DecisionService where its rules matter (DX3) and through the store
// elsewhere: the stage reads rows, whoever wrote them.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { foldLedger } from '../../shared/findingsLedger'
import { DecisionService } from '../plans/decisions/DecisionService'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { decisionReplyGuard } from '../plans/decisions/decisionReplyGuard'
import { roundSignals } from '../plans/execution/diagnosisOpen'
import { changeConvergence } from '../plans/execution/executionView'
import { DiagnosisStore } from '../plans/execution/diagnosisStore'
import { TeamMailbox } from '../team/TeamMailbox'
import { derivePlanSupervision } from '../plans/supervision/supervisionRead'
import { raiseStallAlerts } from '../plans/supervision/stallAlerts'
import { StallAlertStore } from '../plans/supervision/stallAlertStore'
import { decideDiagnosis, openDiagnosis } from './diagnosisTestKit'
import {
  createMatrixBench, createMatrixWorld, greenChecks, removeMatrixWorld, shapedReview, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { writeGroup } from './planHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => {
  matrix = await createMatrixWorld('kawai-diagnosis-')
  writeGroup(matrix.world, 'senior-devs', '---\nmax: 4\n---\nBuild hard things.')
})
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const teamId = () => matrix.world.team.teamId
const ROLES = {
  roles: [{ group: 'middle-devs', profiles: ['default'] }, { group: 'reviewers', profiles: [] }, { group: 'leads', profiles: ['opus'] }, { group: 'senior-devs', profiles: [] }],
  leadGroup: 'leads',
}
const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const diagnoses = (executionId: string, change: string) => new DiagnosisStore(h.bench.db.db).ofChange(executionId, change)
const cards = () => new DecisionStore(h.bench.db.db)
const fixHandoffs = (executionId: string, change: string) =>
  h.tasks.store.assignmentsOf(row(executionId, change).taskId!).filter(entry => entry.handoffKind === 'fix')
const bodyOf = (assignment: { messageId: string | null }) => h.mail.get(assignment.messageId!)!.body
const ledgerOf = (executionId: string, change: string) => {
  const taskId = row(executionId, change).taskId!
  return foldLedger(h.tasks.store.findings.countedSubmissions(taskId), h.tasks.store.findings.events(taskId))
}
const messageCount = () => (h.bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n
const journalOf = (executionId: string, change: string) => h.tasks.store.journal(row(executionId, change).taskId!).map(entry => entry.text)

/** The production DecisionService over the matrix bench's stores. */
function decisionService(): DecisionService {
  const decisions = cards()
  return new DecisionService({
    db: h.bench.db.db, decisions, plans: h.bench.plans, planService: h.bench.service, tasks: h.tasks, taskStore: h.tasks.store,
    assignments: h.assignments, getSession: id => h.bench.records.get(id),
    mailbox: new TeamMailbox(h.mail, { getSession: id => h.bench.records.get(id), homeDir: matrix.world.home, tasks: h.tasks.store, replyGuard: decisionReplyGuard(decisions) }),
    homeDir: matrix.world.home,
  })
}

let content = 0
/** One round: the implementer submits, the pipeline reaches the review, the review fails with `shape`, and the fix step runs. */
async function failedRound(executionId: string, change: string, shape: { raise: string[]; resolve: number }): Promise<void> {
  content += 1
  await submitWork(h, executionId, change, `src/${change}.ts`, `export const v = ${content}\n`)
  await h.tick()
  await shapedReview(h, executionId, change, 'fail', shape)
  await h.tick()
}

/** One round failing CI before any review. */
async function failedCi(executionId: string, change: string): Promise<void> {
  content += 1
  h.gh.defaultChecks = [...greenChecks().filter(check => check.name !== 'e2e'), { name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null }]
  try {
    await submitWork(h, executionId, change, `src/${change}.ts`, `export const v = ${content}\n`)
    await h.tick()
    await h.tick()
  } finally {
    h.gh.defaultChecks = greenChecks()
  }
}

/**
 * Three failed reviews whose open count stays flat (S4 on the third, and
 * S3 never: no review after the first raises): the change is diagnosing.
 * `raise` is the first review's findings.
 */
async function stagnating(change: string, raise = ['one thing is wrong'], extra: Array<{ change: string; group?: string }> = []): Promise<string> {
  const executionId = await startedExecution(h, [{ change }, ...extra], ROLES)
  await h.tick()
  await failedRound(executionId, change, { raise, resolve: 0 })
  await failedRound(executionId, change, { raise: [], resolve: 0 })
  await failedRound(executionId, change, { raise: [], resolve: 0 })
  return executionId
}

describe('table DO — opening a diagnosis at the fix step', () => {
  // @covers: review-convergence › A signal or the backstop opens a diagnosis instead of a fix round › A signal replaces the fix round
  // @covers: plan-supervision › A stall alerts the Lead role once per episode › A diagnosis sends one message
  // @covers: plan-execution › A failed round returns the change for fixes › A diagnosis holds the fix
  test('DO1 a signal on the newest review opens one diagnosis naming it, with its card and the Lead mail, and no fix', async () => {
    const executionId = await stagnating('do-1')
    expect(row(executionId, 'do-1')).toMatchObject({ state: 'gating', step: 'diagnosing', fixRounds: 1 })
    // Two fixes went out (after rounds 1 and 2); none after round 3.
    expect(fixHandoffs(executionId, 'do-1')).toHaveLength(2)
    const [diagnosis, ...more] = diagnoses(executionId, 'do-1')
    expect(more).toEqual([])
    expect(diagnosis!.signals).toEqual([{ kind: 'S4', counts: [1, 1, 1] }])
    expect(changeConvergence(h.bench.db.db, executionId, 'do-1', row(executionId, 'do-1').taskId)).toEqual({ counts: [1, 1, 1], signals: ['S4 stagnation'], cardId: diagnosis!.cardId })
    expect(diagnosis!.roundId).toBe(h.executions.rounds(executionId, 'do-1').at(-1)!.id)
    const card = cards().card(teamId(), diagnosis!.cardId)!
    expect(card).toMatchObject({ kind: 'diagnosis', addressedTo: 'lead', addressedGroup: 'leads', askedBy: { session: 'kawai' } })
    expect(card.options).toEqual(['Fix round', 'Reject F1', 'Amend the contract', 'Escalate'])
    expect(h.mail.get(card.messageId!)).toMatchObject({ toKind: 'group', toId: 'leads', tags: ['decision-question', 'plan-stall', 'stall:convergence'] })
    expect(journalOf(executionId, 'do-1').some(text => text.includes(`opened diagnosis ${diagnosis!.id}`))).toBe(true)
    // A10: an owned task's churn goes to the diagnosis, never the manual-task notice.
    expect(h.bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_task_convergence_notices').get()).toEqual({ n: 0 })
    expect(journalOf(executionId, 'do-1').some(text => text.startsWith('Convergence notice'))).toBe(false)
    // The stall sweep reads convergence and finds the episode written at open: it sends nothing more.
    const planId = h.executions.execution(executionId)!.planId
    const reads = { db: h.bench.db.db, mail: h.mail, executions: h.executions, plans: h.bench.plans, decisions: cards(), conditionsOf: () => [], runtime: { holder: () => null, blocker: () => null } }
    const derived = derivePlanSupervision(reads, teamId(), planId, new Date(h.clock.now))!
    expect(derived.changes[0]!.stall).toMatchObject({ kind: 'convergence', episodeKey: diagnosis!.id })
    const before = messageCount()
    expect(raiseStallAlerts({ db: h.bench.db.db, mail: h.mail, alerts: new StallAlertStore(h.bench.db.db), plans: h.bench.plans }, matrix.world.team, planId, derived)).toBe(0)
    expect(messageCount()).toBe(before)
  })

  // @covers: review-convergence › A signal or the backstop opens a diagnosis instead of a fix round › One diagnosis across a restart
  test('DO6 a standing diagnosis is never opened again: later ticks and a restarted executor add no row, card, or mail', async () => {
    const executionId = await stagnating('do-6')
    const messages = messageCount()
    await h.tick()
    const restarted = h.makeExecutor()
    try {
      await h.tick(restarted)
      await h.tick(restarted)
    } finally { restarted.close() }
    expect(diagnoses(executionId, 'do-6')).toHaveLength(1)
    expect(cards().cardsOfPlan(teamId(), h.executions.execution(executionId)!.planId).filter(card => card.kind === 'diagnosis')).toHaveLength(1)
    expect(messageCount()).toBe(messages)
    expect(row(executionId, 'do-6')).toMatchObject({ state: 'gating', step: 'diagnosing' })
  })

  // @covers: plan-execution › Failed fix rounds count toward the backstop › The fifth failed fix round opens a diagnosis
  test('DO2 a structured review with no signal at the backstop opens a backstop diagnosis; DO3 below it the fix goes out', async () => {
    const executionId = await startedExecution(h, [{ change: 'do-2' }, { change: 'do-3' }], ROLES)
    await h.tick()
    for (const change of ['do-2', 'do-3']) await failedRound(executionId, change, { raise: ['a', 'b', 'c'], resolve: 0 })
    // Four failed fix rounds counted on do-2: the next failure is the fifth.
    h.executions.transition(executionId, 'do-2', row(executionId, 'do-2'), { fixRounds: 4 })
    // A falling count and nothing raised: no signal fires.
    for (const change of ['do-2', 'do-3']) await failedRound(executionId, change, { raise: [], resolve: 1 })
    expect(row(executionId, 'do-2')).toMatchObject({ state: 'gating', step: 'diagnosing', fixRounds: 4 })
    expect(diagnoses(executionId, 'do-2').map(entry => entry.signals)).toEqual([[{ kind: 'backstop', count: 5, limit: 5 }]])
    expect(fixHandoffs(executionId, 'do-2')).toHaveLength(1)
    expect(row(executionId, 'do-3')).toMatchObject({ state: 'implementing', fixRounds: 1 })
    expect(diagnoses(executionId, 'do-3')).toEqual([])
    expect(fixHandoffs(executionId, 'do-3')).toHaveLength(2)
  })

  test('DO4 a CI-only failure at the backstop opens a backstop diagnosis on no review; DO5 below it the fix goes out', async () => {
    const executionId = await startedExecution(h, [{ change: 'do-4' }, { change: 'do-5' }], ROLES)
    await h.tick()
    for (const change of ['do-4', 'do-5']) await failedCi(executionId, change)
    h.executions.transition(executionId, 'do-4', row(executionId, 'do-4'), { fixRounds: 4 })
    for (const change of ['do-4', 'do-5']) await failedCi(executionId, change)
    const [diagnosis] = diagnoses(executionId, 'do-4')
    expect(diagnosis).toMatchObject({ reviewSubmissionId: null, signals: [{ kind: 'backstop', count: 5, limit: 5 }] })
    expect(row(executionId, 'do-4').step).toBe('diagnosing')
    expect(diagnoses(executionId, 'do-5')).toEqual([])
    expect(row(executionId, 'do-5')).toMatchObject({ state: 'implementing', fixRounds: 1 })
  })

  // @covers: review-convergence › A signal or the backstop opens a diagnosis instead of a fix round › A CI-only failure does not re-fire a signal
  test('DO7 after a Fix round closes the diagnosis, its anchor review raises nothing again, and a CI-only failure sends the fix', async () => {
    const executionId = await stagnating('do-7')
    const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'do-7')!
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'do-7', 'Fix round')
    await h.tick()
    // The anchor: re-reading the diagnosed round now finds an empty window (kills "ignore the anchor").
    const store = new DiagnosisStore(h.bench.db.db)
    expect(store.anchor(executionId, 'do-7')).toBe(diagnosis.reviewSubmissionId)
    const diagnosed = h.executions.round(diagnosis.roundId)!
    expect(roundSignals({ tasks: h.tasks.store }, store, row(executionId, 'do-7'), diagnosed).signals).toEqual([])
    // The view reads the same window (kills "count every review instead of the window"): before the anchor, 1, 1, 1; after it, none.
    expect(changeConvergence(h.bench.db.db, executionId, 'do-7', row(executionId, 'do-7').taskId)).toEqual({ counts: [], signals: null, cardId: null })
    const fixes = fixHandoffs(executionId, 'do-7').length
    await failedCi(executionId, 'do-7')
    expect(diagnoses(executionId, 'do-7')).toHaveLength(1)
    expect(fixHandoffs(executionId, 'do-7')).toHaveLength(fixes + 1)
    // The count restarted at the Fix round: this failure is the first since.
    expect(row(executionId, 'do-7')).toMatchObject({ state: 'implementing', fixRounds: 1 })
  })
})

describe('table DX — the diagnosis stage', () => {
  test('DX2 no decision: ticks write nothing', async () => {
    const executionId = await stagnating('dx-2')
    const before = { journal: journalOf(executionId, 'dx-2').length, attempts: h.executions.attempts(executionId, 'dx-2').length, generation: row(executionId, 'dx-2').generation }
    await h.tick()
    await h.tick()
    expect({ journal: journalOf(executionId, 'dx-2').length, attempts: h.executions.attempts(executionId, 'dx-2').length, generation: row(executionId, 'dx-2').generation }).toEqual(before)
    expect(openDiagnosis(h.bench.db.db, executionId, 'dx-2')).not.toBeNull()
  })

  // @covers: review-convergence › Fix round sends the fix with the decision's rationale › The Lead keeps going
  test('DX3 Fix round, recorded by the Lead through DecisionService: the fix carries the rationale, the count restarts, the diagnosis closes', async () => {
    const executionId = await stagnating('dx-3')
    const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'dx-3')!
    const decide = decisionService()
    const planId = h.executions.execution(executionId)!.planId
    await decide.record(h.bench.agent('lead'), { plan_id: planId, card_id: diagnosis.cardId, option_index: 1, rationale: 'the count is flat but the fix is small' })
    const fixes = fixHandoffs(executionId, 'dx-3').length
    await h.tick()
    expect(row(executionId, 'dx-3')).toMatchObject({ state: 'implementing', step: null, fixRounds: 0 })
    expect(fixHandoffs(executionId, 'dx-3')).toHaveLength(fixes + 1)
    const body = bodyOf(fixHandoffs(executionId, 'dx-3').at(-1)!)
    expect(body).toContain('The Lead diagnosed this change\'s review rounds and decided: Diagnosis decision (Fix round): the count is flat but the fix is small')
    expect(h.executions.attempts(executionId, 'dx-3').at(-1)!.manifest.answers?.roundId).toBe(diagnosis.roundId)
    expect(new DiagnosisStore(h.bench.db.db).get(diagnosis.id)).toMatchObject({ outcome: 'fix', closeReason: 'decision', decisionId: expect.any(String) })
    // A second tick applies nothing again.
    await h.tick()
    expect(fixHandoffs(executionId, 'dx-3')).toHaveLength(fixes + 1)
  })

  // @covers: review-convergence › Reject rejects the named findings › Rejecting every blocker passes the result
  test('DX4 Reject of every blocker: rejected events carrying the card and decision, a re-gate round passes, the count restarts', async () => {
    const executionId = await stagnating('dx-4')
    const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'dx-4')!
    const decision = decideDiagnosis(h.bench.db.db, teamId(), executionId, 'dx-4', 'Reject F1')
    const fixes = fixHandoffs(executionId, 'dx-4').length
    await h.tick()
    const events = h.tasks.store.findings.events(row(executionId, 'dx-4').taskId!).filter(event => event.kind === 'rejected')
    expect(events.map(event => ({ findingId: event.findingId, cardId: event.cardId, decisionId: event.decisionId })))
      .toEqual([{ findingId: 'F1', cardId: diagnosis.cardId, decisionId: decision.id }])
    const rounds = h.executions.rounds(executionId, 'dx-4')
    expect(rounds.at(-1)).toMatchObject({ outcome: 'pass', regateOf: diagnosis.roundId })
    expect(fixHandoffs(executionId, 'dx-4')).toHaveLength(fixes)
    expect(row(executionId, 'dx-4')).toMatchObject({ fixRounds: 0 })
    expect(row(executionId, 'dx-4').step).not.toBe('diagnosing')
    expect(new DiagnosisStore(h.bench.db.db).get(diagnosis.id)).toMatchObject({ outcome: 'reject', closeReason: 'decision' })
  })

  // @covers: review-convergence › Reject rejects the named findings › Rejecting some blockers fixes the rest
  test('DX5 Reject while one named finding now awaits its dispute: the other is rejected and the fix goes out', async () => {
    const executionId = await stagnating('dx-5', ['first problem', 'second problem'])
    const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'dx-5')!
    expect(cards().card(teamId(), diagnosis.cardId)!.options).toContain('Reject F1, F2')
    await h.results.disputeFindings(h.bench.agent('dev'), row(executionId, 'dx-5').taskId!, [{ id: 'F2', counterEvidence: 'src/dx-5.ts:1 already handles it' }])
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'dx-5', 'Reject F1, F2')
    const fixes = fixHandoffs(executionId, 'dx-5').length
    await h.tick()
    const states = Object.fromEntries(ledgerOf(executionId, 'dx-5').map(entry => [entry.id, entry.state]))
    expect(states).toEqual({ F1: 'rejected', F2: 'disputed' })
    expect(fixHandoffs(executionId, 'dx-5')).toHaveLength(fixes + 1)
    expect(row(executionId, 'dx-5')).toMatchObject({ state: 'implementing', fixRounds: 0 })
    expect(h.executions.rounds(executionId, 'dx-5').some(round => round.regateOf !== null)).toBe(false)
  })

  // @covers: review-convergence › Amend the contract waits for the owner's revision › The owner publishes the amended contract
  test('DX6 Amend waits and journals once; DX7 later ticks write nothing; DX1 the owner\'s revision closes it with the revision fix', async () => {
    const executionId = await stagnating('dx-6')
    const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'dx-6')!
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'dx-6', 'Amend the contract')
    await h.tick()
    expect(new DiagnosisStore(h.bench.db.db).get(diagnosis.id)).toMatchObject({ outcome: 'amend', closedAt: null })
    const amended = journalOf(executionId, 'dx-6').filter(text => text.includes('asks for an amended contract'))
    expect(amended).toHaveLength(1)
    const generation = row(executionId, 'dx-6').generation
    await h.tick()
    await h.tick()
    expect(journalOf(executionId, 'dx-6').filter(text => text.includes('asks for an amended contract'))).toHaveLength(1)
    expect(row(executionId, 'dx-6')).toMatchObject({ step: 'diagnosing', generation })
    // DX1: the owner republishes the task.
    const fixes = fixHandoffs(executionId, 'dx-6').length
    await h.tasks.amend(h.bench.human, row(executionId, 'dx-6').taskId!, { direction: 'Narrow the contract', rationale: 'the review asked for more than the change' })
    await h.tick()
    expect(new DiagnosisStore(h.bench.db.db).get(diagnosis.id)).toMatchObject({ closeReason: 'revision', outcome: null })
    expect(row(executionId, 'dx-6')).toMatchObject({ state: 'implementing', fixRounds: 0 })
    expect(fixHandoffs(executionId, 'dx-6')).toHaveLength(fixes + 1)
    expect(bodyOf(fixHandoffs(executionId, 'dx-6').at(-1)!)).toContain('revision 2')
  })

  // @covers: review-convergence › The first decision of an open diagnosis applies › An override while waiting for the amendment
  test('DX8 an override after the applied amend applies its own choice', async () => {
    const executionId = await stagnating('dx-8')
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'dx-8', 'Amend the contract')
    await h.tick()
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'dx-8', 'Fix round', { kind: 'override', rationale: 'the owner wants one more try' })
    const fixes = fixHandoffs(executionId, 'dx-8').length
    await h.tick()
    expect(fixHandoffs(executionId, 'dx-8')).toHaveLength(fixes + 1)
    expect(diagnoses(executionId, 'dx-8')[0]).toMatchObject({ outcome: 'fix', closeReason: 'decision' })
  })

  // @covers: review-convergence › The first decision of an open diagnosis applies › An override after a fix round went out
  test('5.3 an override after the close is journaled, and nothing is applied or dispatched', async () => {
    const executionId = await stagnating('dx-late')
    const diagnosis = openDiagnosis(h.bench.db.db, executionId, 'dx-late')!
    const first = decideDiagnosis(h.bench.db.db, teamId(), executionId, 'dx-late', 'Fix round')
    await h.tick()
    const fixes = fixHandoffs(executionId, 'dx-late').length
    const planId = h.executions.execution(executionId)!.planId
    const outcome = await decisionService().override(h.bench.human, { planId, cardId: diagnosis.cardId, expectedDecisionId: first.id, optionIndex: 4, rationale: 'stop it after all', commandId: 'late-override' })
    expect(outcome.decision.choice).toBe('Escalate')
    expect(outcome.fixTaskId).not.toBeNull()
    await h.tick()
    await h.tick()
    expect(row(executionId, 'dx-late')).toMatchObject({ state: 'implementing', stopReason: null })
    expect(fixHandoffs(executionId, 'dx-late')).toHaveLength(fixes)
    expect(diagnoses(executionId, 'dx-late')[0]).toMatchObject({ outcome: 'fix', decisionId: first.id })
    expect(journalOf(executionId, 'dx-late').filter(text => text.includes(`came after diagnosis ${diagnosis.id} closed`))).toHaveLength(1)
  })

  // @covers: review-convergence › Reassign sends the fix to another group › A stuck change goes to another group
  test('DX9 Reassign: the fix goes to the other group, and so does the next one', async () => {
    const executionId = await stagnating('dx-9', ['one thing is wrong'], [{ change: 'dx-9-other', group: 'senior-devs' }])
    expect(cards().card(teamId(), openDiagnosis(h.bench.db.db, executionId, 'dx-9')!.cardId)!.options).toContain('Reassign to senior-devs')
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'dx-9', 'Reassign to senior-devs')
    // The previous implementer, a spawned middle-devs member in the change's
    // worktree, is released once ready; a spawned senior-devs member is kept.
    const worktree = row(executionId, 'dx-9').worktree!
    const member = (sessionId: string, groupId: string) => ({ ...h.bench.records.get('dev')!, sessionId, name: sessionId, groupId, projectPath: worktree, spawned: true, archivedAt: null })
    h.bench.records.set('old-dev', member('old-dev', 'middle-devs'))
    h.bench.records.set('new-dev', member('new-dev', 'senior-devs'))
    const released: string[] = []
    let ready = false
    const executor = h.makeExecutor({
      releases: { readiness: () => ({ ready, reason: ready ? null : 'busy' }), release: sessionId => { released.push(sessionId); return { ok: true } }, pendingSpawns: () => [] },
    })
    try {
      await h.tick(executor)
      expect(row(executionId, 'dx-9')).toMatchObject({ state: 'implementing', groupOverride: 'senior-devs', fixRounds: 0 })
      expect(fixHandoffs(executionId, 'dx-9').at(-1)).toMatchObject({ targetKind: 'group', targetId: 'senior-devs' })
      await h.tick(executor)
      expect(released).toEqual([])
      ready = true
      await h.tick(executor)
      expect(released).toEqual(['old-dev'])
    } finally {
      executor.close()
      h.bench.records.delete('old-dev')
      h.bench.records.delete('new-dev')
    }
    // The next failed round's fix goes to senior-devs too (kills "override only this fix's group").
    await failedRound(executionId, 'dx-9', { raise: [], resolve: 0 })
    expect(row(executionId, 'dx-9').state).toBe('implementing')
    expect(fixHandoffs(executionId, 'dx-9').at(-1)).toMatchObject({ targetKind: 'group', targetId: 'senior-devs' })
  })

  // @covers: review-convergence › Escalate stops the change for the owner › The Lead escalates
  test('DX10 Escalate stops the change as diagnosis-escalated with the signals and the rationale, and closes the diagnosis', async () => {
    const executionId = await stagnating('dx-10')
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'dx-10', 'Escalate', { rationale: 'the direction is wrong' })
    await h.tick()
    expect(row(executionId, 'dx-10')).toMatchObject({
      state: 'stopped', stopReason: 'diagnosis-escalated',
      stopDetail: { signals: [{ kind: 'S4', counts: [1, 1, 1] }], rationale: 'the direction is wrong' },
    })
    expect(diagnoses(executionId, 'dx-10')[0]).toMatchObject({ outcome: 'escalate', closeReason: 'decision' })
  })
})

describe('Retry (task 2.2)', () => {
  // @covers: plan-execution › Retry runs again the stage the change stopped in › Retry after an escalated diagnosis
  test('Retry after an escalated diagnosis dispatches a fix whose count starts again at one', async () => {
    const executionId = await stagnating('rt-esc')
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'rt-esc', 'Escalate')
    await h.tick()
    expect(row(executionId, 'rt-esc').stopReason).toBe('diagnosis-escalated')
    const fixes = fixHandoffs(executionId, 'rt-esc').length
    expect(await h.service.retry(h.bench.human, { executionId, change: 'rt-esc', commandId: 'retry-esc' })).toMatchObject({ ok: true })
    await h.tick()
    expect(row(executionId, 'rt-esc')).toMatchObject({ state: 'implementing', fixRounds: 1, stopReason: null })
    expect(fixHandoffs(executionId, 'rt-esc')).toHaveLength(fixes + 1)
    // The closed diagnosis stands alone: Retry opened no second one.
    expect(diagnoses(executionId, 'rt-esc')).toHaveLength(1)
  })

  // @covers: plan-execution › Retry runs again the stage the change stopped in › Retry after the round limit
  test('Retry after a pre-backstop round-limit stop dispatches a fix whose count starts again at one', async () => {
    const executionId = await startedExecution(h, [{ change: 'rt-limit' }], ROLES)
    await h.tick()
    await failedCi(executionId, 'rt-limit')
    await failedCi(executionId, 'rt-limit')
    // A row stopped by the old limit: gating on its failed round, count 3.
    const current = row(executionId, 'rt-limit')
    h.executions.transition(executionId, 'rt-limit', current, { state: 'stopped', stopReason: 'round-limit', step: null, fixRounds: 3, stopDetail: { message: 'Three consecutive failed fix rounds.' } })
    const fixes = fixHandoffs(executionId, 'rt-limit').length
    expect(await h.service.retry(h.bench.human, { executionId, change: 'rt-limit', commandId: 'retry-limit' })).toMatchObject({ ok: true })
    await h.tick()
    expect(row(executionId, 'rt-limit')).toMatchObject({ state: 'implementing', fixRounds: 1, stopReason: null })
    expect(fixHandoffs(executionId, 'rt-limit')).toHaveLength(fixes + 1)
  })
})

/** Every row the replay must not duplicate, per change: rounds, attempts, fix handoffs, task mail, ledger events, diagnoses. */
function snapshot(executionId: string, change: string) {
  const taskId = row(executionId, change).taskId!
  return {
    rounds: h.executions.rounds(executionId, change).map(entry => entry.id),
    attempts: h.executions.attempts(executionId, change).map(entry => entry.number),
    fixes: fixHandoffs(executionId, change).map(entry => entry.requestKey),
    mail: h.mail.forTask(taskId).map(message => message.id),
    events: h.tasks.store.findings.events(taskId).map(event => event.id),
    diagnoses: diagnoses(executionId, change).map(entry => entry.id),
  }
}

describe('crashes and restarts (tasks 4.2, 5.2)', () => {
  test('a crash inside the diagnosis open step after the card insert stores nothing; the next tick opens exactly one', async () => {
    const executionId = await startedExecution(h, [{ change: 'cr-open' }], ROLES)
    await h.tick()
    await failedRound(executionId, 'cr-open', { raise: ['wrong'], resolve: 0 })
    await failedRound(executionId, 'cr-open', { raise: [], resolve: 0 })
    content += 1
    await submitWork(h, executionId, 'cr-open', 'src/cr-open.ts', `export const v = ${content}\n`)
    await h.tick()
    await shapedReview(h, executionId, 'cr-open', 'fail', { raise: [], resolve: 0 })
    const planId = h.executions.execution(executionId)!.planId
    const before = { cards: cards().cardsOfPlan(teamId(), planId).length, messages: messageCount() }
    const crashing = h.makeExecutor({ diagnosisAfterCardInsert: () => { throw new Error('crash after the card insert') } })
    try { await h.tick(crashing) } catch { /* the wake loop logs it */ } finally { crashing.close() }
    expect(diagnoses(executionId, 'cr-open')).toEqual([])
    expect({ cards: cards().cardsOfPlan(teamId(), planId).length, messages: messageCount() }).toEqual(before)
    expect(row(executionId, 'cr-open').step).not.toBe('diagnosing')
    expect(fixHandoffs(executionId, 'cr-open')).toHaveLength(2)
    await h.tick()
    await h.tick()
    expect(diagnoses(executionId, 'cr-open')).toHaveLength(1)
    expect(cards().cardsOfPlan(teamId(), planId).length).toBe(before.cards + 1)
    expect(row(executionId, 'cr-open').step).toBe('diagnosing')
  })

  const crashRows = [
    ['DX3', 'Fix round', ['one thing is wrong']],
    ['DX5', 'Reject F1, F2', ['first problem', 'second problem']],
    ['DX9', 'Reassign to senior-devs', ['one thing is wrong']],
  ] as const
  test.each(crashRows)('%s: a crash after the fix dispatch and before the close replays the same key and writes nothing twice', async (id, choice, raise) => {
    const change = `cr-${id.toLowerCase()}`
    const executionId = await stagnating(change, [...raise], id === 'DX9' ? [{ change: `${change}-other`, group: 'senior-devs' }] : [])
    if (id === 'DX5') await h.results.disputeFindings(h.bench.agent('dev'), row(executionId, change).taskId!, [{ id: 'F2', counterEvidence: 'src/x.ts:1 handles it' }])
    decideDiagnosis(h.bench.db.db, teamId(), executionId, change, choice)
    const crashing = h.makeExecutor({ diagnosisBeforeClose: () => { throw new Error('crash before the close') } })
    try { await h.tick(crashing) } catch { /* the wake loop logs it */ } finally { crashing.close() }
    // The dispatch stands; the close and the transition rolled back.
    expect(openDiagnosis(h.bench.db.db, executionId, change)).not.toBeNull()
    expect(row(executionId, change).step).toBe('diagnosing')
    const crashed = snapshot(executionId, change)
    await h.tick()
    await h.tick()
    const replayed = snapshot(executionId, change)
    expect(replayed).toEqual(crashed)
    expect(openDiagnosis(h.bench.db.db, executionId, change)).toBeNull()
    expect(row(executionId, change)).toMatchObject({ state: 'implementing', fixRounds: 0, groupOverride: id === 'DX9' ? 'senior-devs' : null })
  })

  test('an amend wait across a restart: the restarted executor journals nothing, and the revision still closes it', async () => {
    const executionId = await stagnating('cr-amend')
    decideDiagnosis(h.bench.db.db, teamId(), executionId, 'cr-amend', 'Amend the contract')
    await h.tick()
    const journal = journalOf(executionId, 'cr-amend').length
    const restarted = h.makeExecutor()
    try {
      await h.tick(restarted)
      await h.tick(restarted)
      expect(journalOf(executionId, 'cr-amend')).toHaveLength(journal)
      expect(row(executionId, 'cr-amend').step).toBe('diagnosing')
      await h.tasks.amend(h.bench.human, row(executionId, 'cr-amend').taskId!, { direction: 'Narrow the contract', rationale: 'amended' })
      await h.tick(restarted)
      expect(diagnoses(executionId, 'cr-amend')[0]).toMatchObject({ closeReason: 'revision' })
      expect(row(executionId, 'cr-amend').state).toBe('implementing')
    } finally { restarted.close() }
  })
})
