// Diagnosis cards (review-convergence decision 6, task group 3): Kawai asks
// them in its own name, addressed to the Lead role else the owner; the
// options come in the spec's order with `Reject` capped at ten; the card is
// closed — free text is refused for the Lead's record, the owner's answer,
// and the owner's override alike — and a decision sends no answer mail.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { LedgerRow } from '../../shared/findingsLedger'
import { isBlocking } from '../../shared/reviewFindings'
import { AMEND_CONTRACT, diagnosisOptions, diagnosisOutcome, ESCALATE, FIX_ROUND, raiseDiagnosisCard, reassignTargets, rejectable } from '../plans/decisions/diagnosisCards'
import { createDecisionBench, type DecisionBench } from './decisionHarness'
import { createPlanWorld, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: DecisionBench
beforeAll(async () => { world = await createPlanWorld('kawai-diagnosis-cards-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
})

const row = (id: string, state: LedgerRow['state'], level: LedgerRow['level'] = 'P1'): LedgerRow => ({
  id, level, clause: 'r1#aaaaaaaaaaaa › A1', clauseId: 'A1', locus: 'src/a.ts', state, regressed: false, preDispute: null,
  disputeEventId: null, disputedThisEntry: false, resolvedSeq: null, transitions: [],
})
const blocks = (entry: LedgerRow) => isBlocking(entry.level, entry.state)

async function caught(run: () => Promise<unknown>): Promise<string> {
  try { await run() } catch (error) { return (error as Error).message }
  return 'no error'
}

async function raised(lead: boolean) {
  const planId = await bench.approvedPlan(lead)
  const taskId = await bench.onTask('dev', planId)
  const card = bench.decisions.atomically(() => raiseDiagnosisCard({ decisions: bench.decisions, mail: bench.mail, plans: bench.plans }, {
    team: world.team, planId, revision: 1, change: 'api', taskId, question: 'Kawai: change api needs a diagnosis', context: 'Findings involved: F3',
    options: diagnosisOptions({ reject: ['F3', 'F4'], reassignTo: ['senior-devs'] }),
  }))
  return { planId, taskId, card }
}

describe('options', () => {
  // @covers: plan-decisions › A diagnosis card offers the outcomes that apply › Options of a stagnating change
  test('a stagnating change: Fix round, Reject F3, F4, Amend, Reassign to senior-devs, Escalate', () => {
    const ledger = [row('F3', 'accepted'), row('F4', 'still-open'), row('F5', 'resolved'), row('F6', 'accepted', 'P2')]
    const reject = rejectable([{ kind: 'S4', counts: [2, 2, 2] }], ledger, blocks)
    expect(reject).toEqual(['F3', 'F4'])
    const options = diagnosisOptions({ reject, reassignTo: reassignTargets([{ group: 'middle-devs' }, { group: 'senior-devs' }, { group: null }, { group: 'middle-devs' }], 'middle-devs') })
    expect(options).toEqual([FIX_ROUND, 'Reject F3, F4', AMEND_CONTRACT, 'Reassign to senior-devs', ESCALATE])
    expect(options.map(diagnosisOutcome)).toEqual([
      { kind: 'fix' }, { kind: 'reject', ids: ['F3', 'F4'] }, { kind: 'amend' }, { kind: 'reassign', group: 'senior-devs' }, { kind: 'escalate' },
    ])
  })

  // @covers: plan-decisions › A diagnosis card offers the outcomes that apply › Scope pressure names nothing to reject
  test('S5 alone names out-of-contract findings, none blocking: no Reject option', () => {
    const ledger = [row('F3', 'out-of-contract'), row('F6', 'out-of-contract'), row('F1', 'accepted')]
    const reject = rejectable([{ kind: 'S5', findings: ['F3', 'F6'] }], ledger, blocks)
    expect(reject).toEqual([])
    expect(diagnosisOptions({ reject, reassignTo: [] })).toEqual([FIX_ROUND, AMEND_CONTRACT, ESCALATE])
  })

  test('Reject names at most ten, by number; Reassign at most four other groups', () => {
    const ledger = Array.from({ length: 12 }, (_, index) => row(`F${12 - index}`, 'accepted'))
    expect(rejectable([{ kind: 'backstop', count: 5, limit: 5 }], ledger, blocks)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'])
    const groups = ['a', 'b', 'c', 'd', 'e', 'f'].map(group => ({ group }))
    expect(reassignTargets(groups, 'a')).toEqual(['b', 'c', 'd', 'e'])
    expect(diagnosisOptions({ reject: [], reassignTo: ['b', 'c', 'd', 'e', 'f'] })).toHaveLength(7)
  })
})

describe('raising and deciding (kills "route like askForTask", "check only the agent path")', () => {
  // @covers: plan-decisions › Kawai raises a diagnosis card in its own name › The Lead receives a diagnosis
  test('with a Lead role: one message from Kawai to the Lead group, tagged, naming the card and its options', async () => {
    const { card } = await raised(true)
    expect(card).toMatchObject({ kind: 'diagnosis', askedBy: { session: 'kawai', group: null, profile: null }, addressedTo: 'lead', addressedGroup: 'leads' })
    const message = bench.mail.get(card.messageId!)!
    expect(message).toMatchObject({ toKind: 'group', toId: 'leads', fromKind: 'system' })
    expect(message.tags).toEqual(['decision-question', 'plan-stall', 'stall:convergence'])
    expect(message.body).toContain('1. Fix round')
    expect(message.body).toContain('2. Reject F3, F4')
  })

  // @covers: plan-decisions › Kawai raises a diagnosis card in its own name › No Lead role
  test('with no Lead role: addressed to the owner, and no mail is sent', async () => {
    const before = (bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n
    const { card } = await raised(false)
    expect(card).toMatchObject({ addressedTo: 'owner', addressedGroup: null, messageId: null })
    expect((bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n).toBe(before)
  })

  // @covers: plan-decisions › A diagnosis card offers the outcomes that apply › A free-text choice is refused
  test('free text is refused for the Lead, the owner answer, and the owner override; an exact option text is accepted', async () => {
    const { planId, card } = await raised(true)
    const lead = bench.agent('lead')
    expect(await caught(() => bench.decide.record(lead, { plan_id: planId, card_id: card.id, choice: 'try harder', rationale: 'r' }))).toContain('This card takes one of its options')
    expect(await caught(() => bench.decide.answer(bench.human, { planId, cardId: card.id, choice: 'try harder', commandId: 'a-free' }))).toContain('This card takes one of its options')
    expect(bench.decisions.decisionsOfCard(world.team.teamId, card.id)).toEqual([])
    const before = (bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n
    const recorded = await bench.decide.record(lead, { plan_id: planId, card_id: card.id, choice: 'Fix round', rationale: 'the count fell' })
    expect(recorded.decision).toMatchObject({ choice: 'Fix round', optionIndex: 1 })
    // No answer mail: the outcome is the reply.
    expect(recorded.message).toBeNull()
    expect((bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n).toBe(before)
    expect(await caught(() => bench.decide.override(bench.human, { planId, cardId: card.id, expectedDecisionId: recorded.decision.id, choice: 'stop it', rationale: 'r', commandId: 'o-free' })))
      .toContain('This card takes one of its options')
  })

  test("the owner's answer sends no answer mail either", async () => {
    const { planId, card } = await raised(false)
    const outcome = await bench.decide.answer(bench.human, { planId, cardId: card.id, optionIndex: 5, rationale: 'escalate', commandId: 'a-1' })
    expect(outcome.decision.choice).toBe(ESCALATE)
    expect(outcome.message).toBeNull()
  })
})
