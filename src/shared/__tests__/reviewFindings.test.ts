// Oracle tables CR, GT, VD, and RO (review-findings-ledger design,
// "Acceptance oracles"): the citation resolver, the gate, verify-round
// dispositions, and re-raises, committed verbatim as table-driven tests over
// the pure model. Each title starts with its row id.
import { describe, expect, test } from 'bun:test'
import type { ImplementationContract } from '../implementationContract'
import { classifyFinding, resolveCitation, type CitationContext, type ScopeView } from '../reviewFindings'
import { foldLedger, planSubmission, type LedgerSubmission, type SubmittedDisposition, type SubmittedFinding } from '../findingsLedger'
import type { ResultScopeFact } from '../teamTasks'

const ID = 'r3#4f1c09ab22de'
const CONTRACT: ImplementationContract = {
  version: 1,
  acceptance: [{ id: 'A1', text: 'lists tasks' }, { id: 'A2', text: 'pins revisions' }],
  invariants: [{ id: 'I1', text: 'never twice' }],
  scope: ['src/server/team/**'],
  verification: [{ id: 'V1', text: 'check passes' }],
  excluded: [{ id: 'X1', text: 'no metrics' }],
}
const WITH: CitationContext = { identity: ID, contract: CONTRACT }
const WITHOUT: CitationContext = { identity: 'r2#0a1b2c3d4e5f', contract: null }

describe('table CR — citation resolution', () => {
  const rows: Array<[string, string | null, CitationContext, string]> = [
    ['CR1', null, WITH, 'out:cites no clause'],
    ['CR2', 'r2#0a1b2c3d4e5f', WITHOUT, 'revision:r2#0a1b2c3d4e5f'],
    ['CR3', ID, WITH, 'out:whole revision'],
    ['CR4', 'r2#0a1b2c3d4e5f › A1', WITH, 'out:stale identity'],
    ['CR4', 'r9#0a1b2c3d4e5f', WITHOUT, 'out:stale identity'],
    ['CR5', 'A1', WITHOUT, 'out:has no contract'],
    ['CR5', 'r2#0a1b2c3d4e5f › A1', WITHOUT, 'out:has no contract'],
    ['CR6', 'X1', WITH, 'out:excluded clause X1'],
    ['CR7', `${ID} › I1`, WITH, `clause:${ID} › I1`],
    ['CR8', 'A9', WITH, 'out:does not have'],
    ['CR9', 'A1', WITH, `clause:${ID} › A1`],
  ]
  for (const [id, citation, ctx, expected] of rows) {
    test(`${id} ${citation ?? '(absent)'} → ${expected}`, () => {
      const resolved = resolveCitation(citation, ctx)
      const [kind, detail] = expected.split(/:(.*)/s) as [string, string]
      expect(resolved.kind).toBe(kind as never)
      if (resolved.kind === 'out') expect(resolved.reason).toContain(detail)
      else expect(resolved.clause).toBe(detail)
    })
  }
})

const fact = (over: Partial<ResultScopeFact> = {}): ResultScopeFact =>
  ({ status: 'warn', withinScope: false, outside: [], more: 0, contractIdentity: ID, note: null, ...over })
const scope = (f: ResultScopeFact | null): ScopeView => ({
  matchesScope: path => path.startsWith('src/server/team/') || path.startsWith('openspec/changes/c/'),
  fact: f,
})
const complete = { evidence: 'see `src/server/team/taskStore.ts:88`', impact: 'wrong verdict' }

describe('table GT — classification', () => {
  type Row = [string, Parameters<typeof classifyFinding>[0], CitationContext, ScopeView | null, string, string?]
  const rows: Row[] = [
    ['GT1', { level: 'P2', clause: 'A1', ...complete }, WITH, scope(null), 'advisory'],
    ['GT2', { level: 'P1', clause: 'X1', ...complete }, WITH, scope(null), 'out-of-contract', 'X1'],
    ['GT2', { level: 'P0', clause: null, ...complete }, WITH, scope(null), 'out-of-contract', 'no clause'],
    ['GT3', { level: 'P1', clause: 'A2', impact: 'x' }, WITH, scope(null), 'unsupported', 'evidence'],
    ['GT3', { level: 'P1', clause: 'r2#0a1b2c3d4e5f', impact: 'x' }, WITHOUT, null, 'unsupported', 'evidence'],
    ['GT4', { level: 'P1', clause: 'A2', evidence: 'src/server/team/a.ts:1' }, WITH, scope(null), 'unsupported', 'impact'],
    ['GT5', { level: 'P1', clause: 'r2#0a1b2c3d4e5f', evidence: 'src/client/App.tsx:3', impact: 'x' }, WITHOUT, null, 'accepted'],
    ['GT6', { level: 'P1', clause: 'A1', evidence: 'the test output shows it', impact: 'x' }, WITH, scope(fact()), 'accepted'],
    ['GT7', { level: 'P1', clause: 'A2', ...complete }, WITH, scope(fact()), 'accepted'],
    ['GT7', { level: 'P1', clause: 'A2', evidence: 'openspec/changes/c/design.md:4', impact: 'x' }, WITH, scope(fact()), 'accepted'],
    ['GT8', { level: 'P1', clause: 'I1', evidence: 'src/client/App.tsx:3', impact: 'x' }, WITH, scope(fact({ outside: ['src/client/App.tsx'] })), 'accepted'],
    ['GT9', { level: 'P1', clause: 'A1', evidence: 'src/client/App.tsx:3', impact: 'x' }, WITH, scope(fact({ status: 'pass', withinScope: true })), 'out-of-contract', 'src/client/App.tsx'],
    ['GT10', { level: 'P1', clause: 'A1', evidence: 'src/client/App.tsx:3', impact: 'x' }, WITH, scope(fact({ status: 'unknown' })), 'accepted'],
    ['GT10', { level: 'P1', clause: 'A1', evidence: 'src/client/App.tsx:3', impact: 'x' }, WITH, scope(null), 'accepted'],
    ['GT10', { level: 'P1', clause: 'A1', evidence: 'src/client/App.tsx:3', impact: 'x' }, WITH, scope(fact({ more: 3 })), 'accepted'],
  ]
  for (const [id, input, ctx, view, cls, reason] of rows) {
    test(`${id} ${input.level} ${input.clause ?? '(none)'} → ${cls}`, () => {
      const outcome = classifyFinding(input, ctx, view)
      expect(outcome.class).toBe(cls as never)
      if (reason) expect(outcome.reason).toContain(reason)
    })
  }

  // @covers: review-findings › The gate classifies every finding mechanically › A complete P1 is accepted
  test('GT7 spec: a complete P1 in scope is accepted', () => {
    expect(classifyFinding({ level: 'P1', clause: 'A2', ...complete }, WITH, scope(fact())).class).toBe('accepted')
  })
  // @covers: review-findings › The gate classifies every finding mechanically › A P1 without evidence
  test('GT3 spec: a P1 without evidence is unsupported, naming the evidence', () => {
    const outcome = classifyFinding({ level: 'P1', clause: 'A2', impact: 'x' }, WITH, scope(null))
    expect([outcome.class, outcome.reason]).toEqual(['unsupported', 'missing evidence'])
  })
  // @covers: review-findings › The gate classifies every finding mechanically › A finding on an excluded clause
  test('GT2 spec: a P0 citing X1 is out of contract', () => {
    expect(classifyFinding({ level: 'P0', clause: 'X1', ...complete }, WITH, scope(null)).reason).toContain('X1')
  })
  // @covers: review-findings › The gate classifies every finding mechanically › Evidence only outside scope
  test('GT9 spec: evidence only outside scope and unchanged is out of contract', () => {
    const outcome = classifyFinding({ level: 'P1', clause: 'A1', evidence: 'src/client/App.tsx:9', impact: 'x' }, WITH, scope(fact()))
    expect([outcome.class, outcome.reason.includes('src/client/App.tsx')]).toEqual(['out-of-contract', true])
  })
  // @covers: review-findings › The gate classifies every finding mechanically › An out-of-scope path the result changed
  test('GT8 spec: an out-of-scope path the result changed keeps the finding accepted', () => {
    expect(classifyFinding({ level: 'P1', clause: 'I1', evidence: 'src/client/App.tsx:9', impact: 'x' }, WITH, scope(fact({ outside: ['src/client/App.tsx'] }))).class).toBe('accepted')
  })
  // @covers: review-findings › The gate classifies every finding mechanically › Scope cannot be judged
  test('GT10 spec: an unknown or absent scope fact never makes a finding out of contract', () => {
    for (const view of [scope(fact({ status: 'unknown' })), scope(null)]) {
      expect(classifyFinding({ level: 'P1', clause: 'A1', evidence: 'src/client/App.tsx:9', impact: 'x' }, WITH, view).class).toBe('accepted')
    }
  })
  // @covers: review-findings › The gate classifies every finding mechanically › Advisory findings are recorded only
  test('GT1 spec: a P2 is advisory', () => {
    expect(classifyFinding({ level: 'P2', clause: 'A1', ...complete }, WITH, scope(fact())).class).toBe('advisory')
  })
  // @covers: review-findings › A finding has an id, a level, a clause, and evidence › A bare clause id resolves against the pinned revision
  test('CR9 spec: a bare clause id records the full clause identity', () => {
    expect(classifyFinding({ level: 'P1', clause: 'I1', ...complete }, WITH, scope(fact())).clause).toBe(`${ID} › I1`)
  })
  // @covers: review-findings › A finding has an id, a level, a clause, and evidence › A citation of another revision's identity
  test('CR4 spec: another revision\'s identity is out of contract, naming it', () => {
    const outcome = classifyFinding({ level: 'P1', clause: 'r2#0a1b2c3d4e5f › A1', ...complete }, WITH, scope(fact()))
    expect([outcome.class, outcome.reason.includes('r2#0a1b2c3d4e5f')]).toEqual(['out-of-contract', true])
  })
})

// A small harness over the pure planner: each call is one counted submission on a new result.
function ledger() {
  const submissions: LedgerSubmission[] = []
  let seq = 0
  let next = 1
  return {
    submissions,
    submit(findings: SubmittedFinding[], dispositions: SubmittedDisposition[] = []) {
      const prior = foldLedger(submissions, [])
      const submission = { id: `s${seq + 1}`, resultId: `R${seq + 1}`, ledgerSeq: ++seq, contractIdentity: ID, createdAt: `2026-11-09T00:00:0${seq}Z` }
      const plan = planSubmission({ prior, findings, dispositions, citation: WITH, scope: scope(fact()), nextNumber: next, submission, priorSubmissions: submissions, events: [] })
      if (plan.ok) { submissions.push({ ...submission, items: plan.items }); next = plan.nextNumber } else seq--
      return plan
    },
    rows: () => foldLedger(submissions, []),
  }
}
const p1 = (clause: string, path: string, extra: Partial<SubmittedFinding> = {}): SubmittedFinding =>
  ({ level: 'P1', clause, evidence: `${path}:10`, impact: 'breaks it', ...extra })
const state = (l: ReturnType<typeof ledger>, id: string) => l.rows().find(row => row.id === id)?.state

describe('table VD — verify-round dispositions', () => {
  test('VD1 nothing prior, nothing given → pass', () => {
    const plan = ledger().submit([])
    expect(plan.ok && plan.verdict).toBe('pass')
  })
  test('VD2 F2 resolved → pass', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts'), p1('A2', 'src/server/team/b.ts', { level: 'P2' })])
    const plan = l.submit([], [{ id: 'F1', disposition: 'resolved' }])
    expect([plan.ok && plan.verdict, state(l, 'F1')]).toEqual(['pass', 'resolved'])
  })
  test('VD3 still-open with evidence → fail', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const plan = l.submit([], [{ id: 'F1', disposition: 'still-open', evidence: 'still at a.ts:12' }])
    expect([plan.ok && plan.verdict, state(l, 'F1')]).toEqual(['fail', 'still-open'])
  })
  test('VD4 regressed → still-open, marked regressed; fail', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const plan = l.submit([], [{ id: 'F1', disposition: 'regressed', evidence: 'worse now' }])
    const row = l.rows()[0]!
    expect([plan.ok && plan.verdict, row.state, row.regressed]).toEqual(['fail', 'still-open', true])
  })
  test('VD5 a missing disposition is refused naming it', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts'), p1('A2', 'src/server/team/b.ts')])
    const plan = l.submit([], [{ id: 'F1', disposition: 'resolved' }])
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.problems.join(' ')).toContain('missing F2')
  })
  test('VD6 still-open without evidence is refused', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const plan = l.submit([], [{ id: 'F1', disposition: 'still-open' }])
    expect(!plan.ok && plan.problems.join(' ')).toContain('F1: still-open needs evidence')
  })
  test('VD7 a disposition of a non-blocking finding is refused', () => {
    const plan = ledger().submit([], [{ id: 'F9', disposition: 'resolved' }])
    expect(!plan.ok && plan.problems.join(' ')).toContain('F9 is not blocking')
  })
  test('VD8 a disputed finding needs no disposition', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts'), p1('A2', 'src/server/team/b.ts')])
    const events = [{ id: 'e1', findingId: 'F2', ledgerSeq: 2, kind: 'disputed' as const, resultId: 'R1', cardId: null, decisionId: null, contractIdentity: ID, clause: null, text: 'no', createdAt: 'x' }]
    const prior = foldLedger(l.submissions, events)
    const plan = planSubmission({ prior, findings: [], dispositions: [{ id: 'F1', disposition: 'resolved' }], citation: WITH, scope: null, nextNumber: 3, submission: { id: 's3', resultId: 'R2', ledgerSeq: 3, contractIdentity: ID, createdAt: 'y' }, priorSubmissions: l.submissions, events })
    expect(plan.ok && plan.verdict).toBe('pass')
  })
  test('VD9 resolved plus a new accepted P1 → fail on the new one', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const plan = l.submit([p1('A2', 'src/server/team/c.ts')], [{ id: 'F1', disposition: 'resolved' }])
    expect([plan.ok && plan.verdict, state(l, 'F2')]).toEqual(['fail', 'accepted'])
  })
  test('VD10 two dispositions of one id are refused', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const plan = l.submit([], [{ id: 'F1', disposition: 'resolved' }, { id: 'F1', disposition: 'resolved' }])
    expect(!plan.ok && plan.problems.join(' ')).toContain('F1 has two dispositions')
  })
})

describe('table RO — re-raises and duplicates', () => {
  const resolvedF1 = (path = 'src/server/team/a.ts') => {
    const l = ledger(); l.submit([p1('A1', path)]); l.submit([], [{ id: 'F1', disposition: 'resolved' }]); return l
  }
  // @covers: review-findings › A re-raised finding reopens › Same clause, same file
  test('RO1 same clause, same file → the old id, reopened (line ignored)', () => {
    const l = resolvedF1()
    l.submit([{ ...p1('A1', 'src/server/team/a.ts'), evidence: 'src/server/team/a.ts:40' }])
    expect(state(l, 'F1')).toBe('reopened')
  })
  // @covers: review-findings › A re-raised finding reopens › Same clause, another file
  test('RO2 same clause, another file → a new id', () => {
    const l = resolvedF1(); l.submit([p1('A1', 'src/server/team/b.ts')])
    expect([state(l, 'F1'), state(l, 'F2')]).toEqual(['resolved', 'accepted'])
  })
  test('RO3 path-less evidence matches path-less evidence', () => {
    const l = ledger(); l.submit([p1('A1', 'x', { evidence: 'the test output' })]); l.submit([], [{ id: 'F1', disposition: 'resolved' }])
    l.submit([p1('A1', 'x', { evidence: 'the same output again' })])
    expect(state(l, 'F1')).toBe('reopened')
  })
  // @covers: review-findings › A re-raised finding reopens › A duplicate of an open finding
  test('RO4 a duplicate of a blocking finding is refused naming it', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const plan = l.submit([{ ...p1('A1', 'src/server/team/a.ts'), evidence: 'src/server/team/a.ts:12' }], [{ id: 'F1', disposition: 'still-open', evidence: 'x' }])
    expect(!plan.ok && plan.problems.join(' ')).toContain('duplicates F1')
  })
  test('RO5 the most recently resolved match wins', () => {
    const l = ledger()
    l.submit([p1('A1', 'src/server/team/a.ts'), p1('A1', 'src/server/team/a.ts', { evidence: 'src/server/team/a.ts:99' })])
    l.submit([], [{ id: 'F1', disposition: 'resolved' }, { id: 'F2', disposition: 'still-open', evidence: 'x' }])
    l.submit([], [{ id: 'F2', disposition: 'resolved' }])
    l.submit([p1('A1', 'src/server/team/a.ts')])
    expect([state(l, 'F1'), state(l, 'F2')]).toEqual(['resolved', 'reopened'])
  })
  test('RO6 a tie on resolution goes to the lowest id', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts'), p1('A1', 'src/server/team/a.ts', { evidence: 'src/server/team/a.ts:99' })])
    l.submit([], [{ id: 'F1', disposition: 'resolved' }, { id: 'F2', disposition: 'resolved' }])
    l.submit([p1('A1', 'src/server/team/a.ts')])
    expect([state(l, 'F1'), state(l, 'F2')]).toEqual(['reopened', 'resolved'])
  })
  test('RO7 a rejected finding never reopens', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const events = [
      { id: 'e1', findingId: 'F1', ledgerSeq: 2, kind: 'disputed' as const, resultId: 'R1', cardId: null, decisionId: null, contractIdentity: ID, clause: null, text: null, createdAt: 'x' },
      { id: 'e2', findingId: 'F1', ledgerSeq: 3, kind: 'rejected' as const, resultId: 'R1', cardId: null, decisionId: null, contractIdentity: ID, clause: null, text: null, createdAt: 'x' },
    ]
    const prior = foldLedger(l.submissions, events)
    const plan = planSubmission({ prior, findings: [p1('A1', 'src/server/team/a.ts')], dispositions: [], citation: WITH, scope: null, nextNumber: 2, submission: { id: 's2', resultId: 'R2', ledgerSeq: 4, contractIdentity: ID, createdAt: 'y' }, priorSubmissions: l.submissions, events })
    expect(plan.ok && plan.items.map(item => item.findingId)).toEqual(['F2'])
  })
  test('RO8 a superseded finding never reopens', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const events = [{ id: 'e1', findingId: 'F1', ledgerSeq: 2, kind: 'superseded' as const, resultId: null, cardId: null, decisionId: null, contractIdentity: ID, clause: null, text: null, createdAt: 'x' }]
    const prior = foldLedger(l.submissions, events)
    const plan = planSubmission({ prior, findings: [p1('A1', 'src/server/team/a.ts')], dispositions: [], citation: WITH, scope: null, nextNumber: 2, submission: { id: 's2', resultId: 'R2', ledgerSeq: 3, contractIdentity: ID, createdAt: 'y' }, priorSubmissions: l.submissions, events })
    expect(plan.ok && plan.items.map(item => item.findingId)).toEqual(['F2'])
  })
  test('RO9 an explicit id of a resolved finding reopens it', () => {
    const l = resolvedF1(); l.submit([p1('A2', 'src/server/team/z.ts', { id: 'F1' })])
    expect(state(l, 'F1')).toBe('reopened')
  })
  test('RO10 an explicit unknown id is refused', () => {
    const plan = ledger().submit([p1('A1', 'src/server/team/a.ts', { id: 'F99' })])
    expect(!plan.ok && plan.problems.join(' ')).toContain('F99 is not a finding')
  })
})

describe('bounds and ids', () => {
  // @covers: review-findings › Submissions are bounded › Too many findings
  test('a submission of 31 findings is refused naming 30', () => {
    const plan = ledger().submit(Array.from({ length: 31 }, (_, k) => p1('A1', `src/server/team/f${k}.ts`)))
    expect(!plan.ok && plan.problems.join(' ')).toContain('at most 30 new findings')
  })
  // @covers: review-findings › Submissions are bounded › Too many blocking findings
  test('a submission leaving 51 blocking findings is refused naming 50', () => {
    const l = ledger(); l.submit(Array.from({ length: 30 }, (_, k) => p1('A1', `src/server/team/f${k}.ts`)))
    const plan = l.submit(Array.from({ length: 21 }, (_, k) => p1('A2', `src/server/team/g${k}.ts`)),
      Array.from({ length: 30 }, (_, k) => ({ id: `F${k + 1}`, disposition: 'still-open' as const, evidence: 'x' })))
    expect(!plan.ok && plan.problems.join(' ')).toContain('at most 50 blocking findings')
  })
  // @covers: review-findings › Submissions are bounded › Every blocking finding can be disposed of
  test('50 blocking findings can all be disposed of in one review', () => {
    const l = ledger()
    l.submit(Array.from({ length: 30 }, (_, k) => p1('A1', `src/server/team/f${k}.ts`)))
    l.submit(Array.from({ length: 20 }, (_, k) => p1('A2', `src/server/team/g${k}.ts`)),
      Array.from({ length: 30 }, (_, k) => ({ id: `F${k + 1}`, disposition: 'still-open' as const, evidence: 'x' })))
    const plan = l.submit([], Array.from({ length: 50 }, (_, k) => ({ id: `F${k + 1}`, disposition: 'resolved' as const })))
    expect(plan.ok && plan.verdict).toBe('pass')
  })
  // @covers: review-findings › A finding has an id, a level, a clause, and evidence › Kawai numbers new findings
  test('new findings are numbered F1, F2, then F3', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts', { level: 'P2' }), p1('A2', 'src/server/team/b.ts', { level: 'P2' })])
    l.submit([p1('I1', 'src/server/team/c.ts', { level: 'P2' })])
    expect(l.rows().map(row => row.id)).toEqual(['F1', 'F2', 'F3'])
  })
  // @covers: review-findings › The verdict is derived from the ledger › Only accepted findings fail
  test('unsupported, out-of-contract, and advisory findings derive pass', () => {
    const plan = ledger().submit([{ level: 'P0', clause: 'A1', impact: 'x' }, p1('X1', 'src/server/team/a.ts'), p1('A1', 'src/server/team/b.ts', { level: 'P2' })])
    expect(plan.ok && plan.verdict).toBe('pass')
  })
  // @covers: review-findings › The verdict is derived from the ledger › An empty structured submission passes
  test('an empty structured submission derives pass', () => {
    expect(ledger().submit([]).ok).toBe(true)
  })
  // @covers: review-findings › A verify round disposes of every open finding › A fixed finding resolves
  test('a resolved disposition derives pass', () => {
    const l = ledger(); l.submit([p1('A2', 'src/server/team/a.ts')]); l.submit([p1('A1', 'src/server/team/b.ts')], [{ id: 'F1', disposition: 'resolved' }])
    const plan = l.submit([], [{ id: 'F2', disposition: 'resolved' }])
    expect([plan.ok && plan.verdict, state(l, 'F2')]).toEqual(['pass', 'resolved'])
  })
  // @covers: review-findings › A verify round disposes of every open finding › A missing disposition is refused
  test('a missing disposition is refused naming the id', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts'), p1('A2', 'src/server/team/b.ts'), p1('I1', 'src/server/team/c.ts')])
    const plan = l.submit([], [{ id: 'F2', disposition: 'resolved' }, { id: 'F1', disposition: 'resolved' }])
    expect(!plan.ok && plan.problems.join(' ')).toContain('missing F3')
  })
  // @covers: review-findings › A verify round disposes of every open finding › Still open keeps the round failing
  test('a still-open disposition derives fail', () => {
    const l = ledger(); l.submit([p1('A1', 'src/server/team/a.ts')])
    const plan = l.submit([], [{ id: 'F1', disposition: 'still-open', evidence: 'still there' }])
    expect(plan.ok && plan.verdict).toBe('fail')
  })
})
