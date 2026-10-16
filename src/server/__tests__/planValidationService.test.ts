// The validation service's assessments and decisions (plan-validation design
// D5/D6) over the shared plan harness: target rules, shape and limit rules,
// replay by command id with the constraint-race resolution, and the
// human-only boundary on decisions. The adapter is a stub; no CLI runs.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { MailboxStore } from '../team/mailboxStore'
import { ValidationService } from '../plans/validation/ValidationService'
import { ValidationStore } from '../plans/validation/validationStore'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'
import type { AlignmentAssessment, AssessmentRow } from '../../shared/planValidation'
import type { DecisionRecord, Finding, PlanValidationReport } from '../../shared/planValidation'

let world: PlanWorld
beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-validation-service-')
  // Registered OpenSpec changes the fixture plan names, and the reviewers group.
  for (const change of ['api', 'ui']) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change, 'specs', 'chat'), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'specs', 'chat', 'spec.md'), '## ADDED Requirements\n### Requirement: X\n')
  }
  fs.writeFileSync(path.join(world.repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

/** An adapter that never spawns: the probe is fixed, every CLI call throws. */
const stubAdapter = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: () => { throw new Error('no CLI in this test') },
  showDeltas: () => { throw new Error('no CLI in this test') },
}) as unknown as OpenspecAdapter

interface ValidationBench extends PlanBench {
  validation: ValidationService
  validationStore: ValidationStore
}

let counter = 0
function bench(adapter: OpenspecAdapter = stubAdapter()): ValidationBench {
  const base = createPlanBench(world)
  const mail = new MailboxStore(base.db.db)
  const impact = new ImpactService(new ImpactStore(base.db.db), {
    strategies: base.strategies, plans: base.plans, mail, getSession: id => base.records.get(id), homeDir: world.home,
  })
  const validationStore = new ValidationStore(base.db.db)
  const validation = new ValidationService(validationStore, {
    plans: base.plans, strategies: base.strategies, impact, adapter,
    getSession: id => base.records.get(id), homeDir: world.home,
  })
  return { ...base, validation, validationStore }
}

let current: ValidationBench | null = null
let currentAdapter: OpenspecAdapter | undefined
afterEach(() => {
  current?.db.close()
  current = null
  currentAdapter = undefined
})
const use = (adapter?: OpenspecAdapter): ValidationBench => {
  if (adapter) currentAdapter = adapter
  return (current ??= bench(currentAdapter))
}

/** A fake adapter whose verdicts are canned per change; `gate` holds every validate until released, for single-flight tests. */
function fakeAdapter(options: { deltas?: Record<string, Array<{ capability: string; operation: string; requirement: string }>>; invalid?: string[]; unavailable?: boolean; gate?: Promise<void> } = {}): OpenspecAdapter {
  return {
    probe: async () => (options.unavailable
      ? { tool: 'openspec', version: null, capabilities: [], ok: false, error: 'openspec executable not found' }
      : { tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
    validate: async (_root: string, change: string) => {
      await options.gate
      return options.invalid?.includes(change)
        ? { ok: true, error: null, valid: false, issues: [{ level: 'ERROR', message: 'No deltas' }], issueCount: 1 }
        : { ok: true, error: null, valid: true, issues: [], issueCount: 0 }
    },
    showDeltas: async (_root: string, change: string) => ({ ok: true, error: null, touches: options.deltas?.[change] ?? [] }),
  } as unknown as OpenspecAdapter
}

const aligned = (overrides: Partial<AlignmentAssessment> = {}): AlignmentAssessment => ({
  assessment: 'aligned', outcomes: ['UC1'], conditions: [], experiment: null, conflicts: [], rationale: 'advances UC1', ...overrides,
})

/** A stored report with the given findings and unaccepted warning keys, so accept-warning targets exist. */
function seedReport(store: ValidationStore, planId: string, revision: number, findings: Finding[] = [], unacceptedWarnings?: string[]): PlanValidationReport {
  return store.insertReport({
    planId, revision, inputHash: `hash-${++counter}`, inputs: {
      checksVersion: 1, plan: { planId, revision, contentHash: 'hash' }, impactStateKey: 'impact',
      adapter: { tool: 'openspec', version: '1.14.2', capabilities: [] }, changes: [],
      catalog: { groups: {}, profiles: 'p' }, claims: { branch: [], changes: {} }, records: { assessments: [], decisions: [] },
    },
    findings, relations: [], evidence: { changes: {}, branch: null, capacity: [] },
    readiness: { ready: findings.length === 0, errors: [], unansweredQuestions: [], unacceptedWarnings: unacceptedWarnings ?? findings.map(finding => finding.key), alignment: { state: 'unassessed', reason: null, effective: null }, carriedConditions: [] },
    ready: findings.length === 0, requestedBy: { kind: 'human', sessionId: null },
  })
}

describe('ValidationService.assess (D5)', () => {
  test('target rules: another team reads as not found; closed plans and non-standing revisions refuse', async () => {
    const b = use()
    b.approveStrategy()
    const { planId, revision } = await b.draftInReview()
    const stranger = await b.validation.assess(b.agent('stranger'), { plan_id: planId, revision, questions: [{ text: 'q', mandatory: false, subject: null }] })
    expect(stranger).toMatchObject({ ok: false, reason: 'not-found' })
    const missing = await b.validation.assess(b.human, { plan_id: planId, revision: 99, alignment: aligned(), command_id: 'form-x' })
    expect(missing).toMatchObject({ ok: false, reason: 'target' })
    await b.service.close(b.human, { planId, outcome: 'cancelled', reason: 'done', commandId: 'close-1' })
    const closed = await b.validation.assess(b.human, { plan_id: planId, revision, alignment: aligned(), command_id: 'form-y' })
    expect(closed).toMatchObject({ ok: false, reason: 'target' })
    expect(closed.ok === false && closed.message).toContain('cancelled')
    // The owner's form records only an alignment; questions are the agents'.
    const agents = await b.validation.assess(b.human, { plan_id: planId, revision, questions: [{ text: 'q', mandatory: false, subject: null }] })
    expect(agents).toMatchObject({ ok: false, reason: 'payload' })
  })

  test('an empty pin refuses alignment: unassessed is never one of the five values', async () => {
    const b = use()
    const { planId, revision } = await b.draftInReview()
    const outcome = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, alignment: aligned() })
    expect(outcome).toMatchObject({ ok: false, reason: 'target' })
    expect(outcome.ok === false && outcome.message).toBe('no approved strategy: alignment is unassessed')
    // Questions and findings are fine without a pin.
    const questions = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [{ text: 'which migration?', mandatory: true, subject: 'a-change' }] })
    expect(questions).toMatchObject({ ok: true, replayed: false })
  })

  test('per-value shape rules and the ref check', async () => {
    const b = use()
    b.approveStrategy()
    const { planId, revision } = await b.draftInReview()
    const cases: Array<[Partial<AlignmentAssessment>, RegExp]> = [
      [{ assessment: 'aligned-with-conditions' }, /at least one condition/],
      [{ assessment: 'exploratory', experiment: null }, /experiment criteria and scope/],
      [{ assessment: 'conflicting' }, /at least one conflict/],
      [{ rationale: '  ' }, /needs its rationale/],
      [{ outcomes: ['UC1', 'GHOST-REF'] }, /"GHOST-REF" is not defined/],
      [{ conditions: [{ text: '', gate: 'ready' }], assessment: 'aligned-with-conditions' }, /needs its text/],
      [{ conditions: [{ text: 'x', gate: 'soon' as never }], assessment: 'aligned-with-conditions' }, /ready, start, or acceptance/],
    ]
    for (const [overrides, message] of cases) {
      const outcome = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, alignment: aligned(overrides) })
      expect(outcome.ok, JSON.stringify(overrides)).toBe(false)
      expect(outcome.ok === false && outcome.message).toMatch(message)
    }
    expect(b.validationStore.assessments(planId, revision)).toEqual([])
  })

  test('the 2,000-character limit is refused, never cut, and agent calls cap at 20 each', async () => {
    const b = use()
    const { planId, revision } = await b.draftInReview()
    const long = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [{ text: 'x'.repeat(2_001), mandatory: false, subject: null }] })
    expect(long.ok === false && long.message).toContain('2,000-character limit')
    const many = Array.from({ length: 21 }, () => ({ text: 'q', mandatory: false, subject: null }))
    const capped = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: many })
    expect(capped.ok === false && capped.message).toContain('at most 20 questions')
  })

  test("the owner's form writes exactly one alignment per command id and replays by it", async () => {
    const b = use()
    b.approveStrategy()
    const { planId, revision } = await b.draftInReview()
    const first = await b.validation.assess(b.human, { plan_id: planId, revision, alignment: aligned(), command_id: 'form-1' })
    expect(first).toMatchObject({ ok: true, replayed: false })
    const resend = await b.validation.assess(b.human, { plan_id: planId, revision, alignment: aligned(), command_id: 'form-1' })
    expect(resend).toMatchObject({ ok: true, replayed: true })
    expect(resend.ok && resend.ids.alignment).toBe(first.ok && first.ids.alignment)
    const edited = await b.validation.assess(b.human, { plan_id: planId, revision, alignment: aligned({ rationale: 'different' }), command_id: 'form-1' })
    expect(edited).toMatchObject({ ok: false, reason: 'payload' })
    expect(edited.ok === false && edited.message).toContain('different alignment')
    expect(b.validationStore.assessments(planId, revision)).toHaveLength(1)
  })

  test('an agent retry appends', async () => {
    const b = use()
    const { planId, revision } = await b.draftInReview()
    const question = { text: 'ambiguous migration?', mandatory: true, subject: null }
    await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [question] })
    const retried = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [question] })
    expect(retried).toMatchObject({ ok: true, replayed: false })
    expect(b.validationStore.assessments(planId, revision)).toHaveLength(2)
  })
})

describe('ValidationService.decide (D6)', () => {
  const answer = (planId: string, revision: number, target: string, overrides: Partial<Parameters<ValidationService['decide']>[1]> = {}) => ({
    caller: undefined, planId, revision, kind: 'answer' as const, target, text: 'yes', scope: null, commandId: `decide-${++counter}`, ...overrides,
  })

  test('an agent actor is refused before any read', async () => {
    const b = use()
    const outcome = await b.validation.decide(b.agent('dev'), answer('plan-does-not-exist', 1, 'pas-1'))
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(outcome.ok === false && outcome.message).toContain('Only the human')
  })

  test('a replay returns the stored decision; a different payload is refused naming the first differing field', async () => {
    const b = use()
    const { planId, revision } = await b.draftInReview()
    const asked = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [{ text: 'which?', mandatory: true, subject: null }] })
    const questionId = asked.ok ? asked.ids.questions[0]! : ''
    const input = answer(planId, revision, questionId, { commandId: 'cmd-1' })
    const first = await b.validation.decide(b.human, input)
    expect(first).toMatchObject({ ok: true, replayed: false })
    const resend = await b.validation.decide(b.human, input)
    expect(resend).toMatchObject({ ok: true, replayed: true })
    expect(resend.ok && resend.decision.id).toBe(first.ok && first.decision.id)
    const edited = await b.validation.decide(b.human, answer(planId, revision, questionId, { commandId: 'cmd-1', text: 'no' }))
    expect(edited).toMatchObject({ ok: false, reason: 'payload' })
    expect(edited.ok === false && edited.message).toContain('different text')
    expect(b.validationStore.decisions(planId, revision)).toHaveLength(1)
  })

  test('a unique-constraint hit rolls back and resolves as the replay (a concurrent resend)', async () => {
    const b = use()
    const { planId, revision } = await b.draftInReview()
    // Another writer committed this command id first, with the same payload.
    b.validationStore.insertDecision({ planId, revision, kind: 'answer', target: 'pas-1', text: 'yes', scope: null, commandId: 'raced', payload: { revision, kind: 'answer', target: 'pas-1', text: 'yes', scope: null } })
    const outcome = await b.validation.decide(b.human, answer(planId, revision, 'pas-1', { commandId: 'raced' }))
    expect(outcome).toMatchObject({ ok: true, replayed: true })
    expect(b.validationStore.decisions(planId, revision)).toHaveLength(1)
  })

  test("each kind's target rule", async () => {
    const b = use()
    b.approveStrategy()
    const { planId, revision } = await b.draftInReview()
    const asked = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [{ text: 'which?', mandatory: true, subject: null }] })
    const questionId = asked.ok ? asked.ids.questions[0]! : ''
    const assessed = await b.validation.assess(b.agent('dev'), {
      plan_id: planId, revision,
      alignment: aligned({ assessment: 'aligned-with-conditions', conditions: [{ text: 'ship schema first', gate: 'ready' }] }),
      findings: [{ text: 'watch the overlap', subject: null }],
    })
    const alignmentId = assessed.ok ? assessed.ids.alignment! : ''
    const findingId = assessed.ok ? assessed.ids.findings[0]! : ''
    const report = seedReport(b.validationStore, planId, revision, [
      { check: 'relations', key: 'relations:overlap:a+b:chat', severity: 'warning', row: 'scope', subject: 'chat', message: 'overlap' },
    ], [`relations:overlap:a+b:chat`, `finding:${findingId}`])

    // answer: a question of this revision.
    expect(await b.validation.decide(b.human, answer(planId, revision, 'pas-not-there'))).toMatchObject({ ok: false, reason: 'target' })
    expect(await b.validation.decide(b.human, answer(planId, revision, questionId))).toMatchObject({ ok: true })
    // accept-warning: a key the newest report raises.
    expect(await b.validation.decide(b.human, answer(planId, revision, 'relations:overlap:ghost:chat', { kind: 'accept-warning' }))).toMatchObject({ ok: false, reason: 'target' })
    expect(await b.validation.decide(b.human, answer(planId, revision, 'relations:overlap:a+b:chat', { kind: 'accept-warning', text: 'they stay independent' }))).toMatchObject({ ok: true })
    expect(await b.validation.decide(b.human, answer(planId, revision, `finding:${findingId}`, { kind: 'accept-warning' }))).toMatchObject({ ok: true, replayed: false })
    // A finding assessment recorded after the report is not raised by it yet.
    const later = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, findings: [{ text: 'later finding', subject: null }] })
    const laterId = later.ok ? later.ids.findings[0]! : ''
    expect(await b.validation.decide(b.human, answer(planId, revision, `finding:${laterId}`, { kind: 'accept-warning' }))).toMatchObject({ ok: false, reason: 'target' })
    // resolve-condition: <assessment id>#<n> in range.
    expect(await b.validation.decide(b.human, answer(planId, revision, `${alignmentId}#1`, { kind: 'resolve-condition' }))).toMatchObject({ ok: false, reason: 'target' })
    expect(await b.validation.decide(b.human, answer(planId, revision, `${alignmentId}#0`, { kind: 'resolve-condition' }))).toMatchObject({ ok: true })
    // alignment-exception: a conflicting assessment, with scope.
    const conflict = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, alignment: aligned({ assessment: 'conflicting', conflicts: ['violates a non-goal'] }) })
    const conflictId = conflict.ok ? conflict.ids.alignment! : ''
    expect(await b.validation.decide(b.human, answer(planId, revision, alignmentId, { kind: 'alignment-exception' }))).toMatchObject({ ok: false, reason: 'target' })
    const noScope = await b.validation.decide(b.human, answer(planId, revision, conflictId, { kind: 'alignment-exception' }))
    expect(noScope).toMatchObject({ ok: false, reason: 'target' })
    expect(noScope.ok === false && noScope.message).toContain('needs its scope')
    expect(await b.validation.decide(b.human, answer(planId, revision, conflictId, { kind: 'alignment-exception', scope: 'the owner accepts the overlap' }))).toMatchObject({ ok: true })
    // authorize-exploration: exploratory or insufficient-information, with scope.
    const exploratory = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, alignment: aligned({ assessment: 'exploratory', experiment: { criteria: 'latency', scope: 'one week' } }) })
    const exploratoryId = exploratory.ok ? exploratory.ids.alignment! : ''
    expect(await b.validation.decide(b.human, answer(planId, revision, conflictId, { kind: 'authorize-exploration' }))).toMatchObject({ ok: false, reason: 'target' })
    expect(await b.validation.decide(b.human, answer(planId, revision, exploratoryId, { kind: 'authorize-exploration', scope: 'bounded to the chat capability' }))).toMatchObject({ ok: true })
    expect(report.seq).toBe(1)
  })

  test('text and scope limits', async () => {
    const b = use()
    const { planId, revision } = await b.draftInReview()
    const asked = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [{ text: 'which?', mandatory: true, subject: null }] })
    const questionId = asked.ok ? asked.ids.questions[0]! : ''
    const empty = await b.validation.decide(b.human, answer(planId, revision, questionId, { text: '   ' }))
    expect(empty).toMatchObject({ ok: false, reason: 'limit' })
    const long = await b.validation.decide(b.human, answer(planId, revision, questionId, { text: 'x'.repeat(2_001) }))
    expect(long.ok === false && long.message).toContain('2,000-character')
    const scope = await b.validation.decide(b.human, answer(planId, revision, questionId, { scope: 's'.repeat(501) }))
    expect(scope.ok === false && scope.message).toContain('500-character')
  })

  test('a later decision on the same target supersedes and both stay readable', async () => {
    const b = use()
    b.approveStrategy()
    const { planId, revision } = await b.draftInReview()
    const conflict = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, alignment: aligned({ assessment: 'conflicting', conflicts: ['x'] }) })
    const conflictId = conflict.ok ? conflict.ids.alignment! : ''
    const first = await b.validation.decide(b.human, answer(planId, revision, conflictId, { kind: 'alignment-exception', scope: 'narrow', commandId: 'exc-1' }))
    const second = await b.validation.decide(b.human, answer(planId, revision, conflictId, { kind: 'alignment-exception', scope: 'narrower', commandId: 'exc-2' }))
    expect([first.ok && first.replayed, second.ok && second.replayed]).toEqual([false, false])
    const rows: DecisionRecord[] = b.validationStore.decisions(planId, revision)
    expect(rows.map(row => row.scope)).toEqual(['narrow', 'narrower'])
  })

  test('decisions write nothing outside the validation tables', async () => {
    const b = use()
    const { planId, revision } = await b.draftInReview()
    const before = Object.fromEntries(['team_messages', 'team_tasks', 'plan_events', 'plan_revisions'].map(table =>
      [table, (b.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]))
    const asked = await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [{ text: 'which?', mandatory: true, subject: null }] })
    const questionId = asked.ok ? asked.ids.questions[0]! : ''
    await b.validation.decide(b.human, answer(planId, revision, questionId))
    const after = Object.fromEntries(['team_messages', 'team_tasks', 'plan_events', 'plan_revisions'].map(table =>
      [table, (b.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]))
    expect(after).toEqual(before)
  })
})

describe('ValidationService.validate (D8)', () => {
  const touching = { capability: 'chat', operation: 'MODIFIED', requirement: 'Presence' } as const

  test('two concurrent requests run once and both receive its report', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const b = use(fakeAdapter({ gate }))
    const { planId, revision } = await b.draftInReview()
    const first = b.validation.validate(b.human, { planId, revision })
    const second = b.validation.validate(b.agent('dev'), { planId, revision })
    release()
    // Both callers receive the one run's outcome and its single report.
    const [a, c] = await Promise.all([first, second])
    expect(a).toMatchObject({ ok: true, stored: true, dryRun: false })
    expect(c).toMatchObject({ ok: true, dryRun: false })
    expect(a.ok && a.reportId).toBe(c.ok && c.reportId)
    expect(b.validationStore.reports(planId, revision)).toHaveLength(1)
  })

  test('unchanged inputs write nothing and return the newest report; an artifact edit writes seq + 1', async () => {
    const b = use(fakeAdapter())
    const { planId, revision } = await b.draftInReview()
    const first = await b.validation.validate(b.human, { planId, revision })
    expect(first).toMatchObject({ ok: true, stored: true })
    const again = await b.validation.validate(b.human, { planId, revision })
    expect(again).toMatchObject({ ok: true, stored: false })
    expect(again.ok && again.report.seq).toBe(1)
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', 'api', 'proposal.md'), '# api (edited)\n')
    const after = await b.validation.validate(b.human, { planId, revision })
    expect(after).toMatchObject({ ok: true, stored: true })
    expect(after.ok && after.report.seq).toBe(2)
    expect(b.validationStore.reports(planId, revision).map(report => report.seq)).toEqual([1, 2])
  })

  test('a conflicting unordered pair blocks the report; a decision makes the newest report out of date', async () => {
    const b = use(fakeAdapter({ deltas: { api: [touching], ui: [touching] } }))
    const { planId, revision } = await b.draftInReview({
      changes: [
        { change: 'api', dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' },
        { change: 'ui', dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' },
      ],
    })
    const blocked = await b.validation.validate(b.human, { planId, revision })
    expect(blocked.ok && blocked.report.ready).toBe(false)
    expect(blocked.ok && blocked.report.findings.some(finding => finding.key === 'relations:conflict:api+ui:chat/Presence')).toBe(true)
    // An assessment recorded after the report changes the records part of the identity.
    await b.validation.assess(b.agent('dev'), { plan_id: planId, revision, questions: [{ text: 'which?', mandatory: false, subject: null }] })
    const next = await b.validation.validate(b.human, { planId, revision })
    expect(next).toMatchObject({ ok: true, stored: true })
    expect(next.ok && next.report.seq).toBe(2)
  })

  test('superseded or withdrawn revisions and closed plans are refused; another team reads as not found', async () => {
    const b = use(fakeAdapter())
    const strangerPlan = await b.draftInReview()
    const stranger = await b.validation.validate(b.agent('stranger'), { planId: strangerPlan.planId, revision: strangerPlan.revision })
    expect(stranger).toMatchObject({ ok: false, reason: 'not-found' })

    const { planId, revision } = await b.draftInReview()
    await b.service.withdraw(b.human, { planId, revision, commandId: 'withdraw-1' })
    const withdrawn = await b.validation.validate(b.human, { planId, revision })
    expect(withdrawn).toMatchObject({ ok: false, reason: 'target' })
    expect(withdrawn.ok === false && withdrawn.message).toContain('withdrawn')

    const second = await b.draftInReview()
    await b.service.close(b.human, { planId: second.planId, outcome: 'cancelled', reason: 'done', commandId: 'close-1' })
    const closed = await b.validation.validate(b.human, { planId: second.planId, revision: second.revision })
    expect(closed).toMatchObject({ ok: false, reason: 'target' })
    expect(closed.ok === false && closed.message).toContain('cancelled')
  })

  test('nothing outside the three validation tables is written', async () => {
    const b = use(fakeAdapter())
    const { planId, revision } = await b.draftInReview()
    const tables = ['team_messages', 'team_tasks', 'plan_events', 'plan_revisions', 'plan_drafts', 'plans']
    const before = Object.fromEntries(tables.map(table => [table, (b.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]))
    const report = await b.validation.validate(b.human, { planId, revision })
    expect(report).toMatchObject({ ok: true, stored: true })
    const after = Object.fromEntries(tables.map(table => [table, (b.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]))
    expect(after).toEqual(before)
  })

  test('an unavailable adapter fails its checks without storing a ready report', async () => {
    const b = use(fakeAdapter({ unavailable: true }))
    const { planId, revision } = await b.draftInReview()
    const outcome = await b.validation.validate(b.human, { planId, revision })
    expect(outcome.ok && outcome.report.ready).toBe(false)
    const keys = outcome.ok ? outcome.report.findings.map(finding => finding.key) : []
    expect(keys).toContain('adapter-available:openspec')
    expect(keys).toContain('openspec-valid:openspec')
    expect(keys).toContain('relations:openspec')
  })

  test('a dry run is computed as if submitted, marked dryRun, and stores nothing', async () => {
    const b = use(fakeAdapter())
    b.approveStrategy({ useCases: [{ ref: 'UC1' }] })
    const { planId } = await b.draftInReview()
    const outcome = await b.validation.validate(b.agent('lead'), { planId, draftId: 'lead' })
    expect(outcome).toMatchObject({ ok: true, reportId: null, stored: false, dryRun: true })
    expect(outcome.ok && outcome.report.dryRun).toBe(true)
    // As if submitted: the pin the submission would take, alignment not yet assessable.
    expect(outcome.ok && outcome.report.inputs.plan.revision).toBe(2)
    expect(outcome.ok && outcome.report.readiness.alignment).toEqual({ state: 'blocked', reason: 'not assessed', effective: null })
    for (const table of ['plan_validation_reports', 'plan_assessments', 'plan_validation_decisions']) {
      expect((b.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0)
    }
    // A clean dry run satisfies no gate: a validation of the submitted revision still starts fresh.
    const submitted = await b.draftInReview()
    const fresh = await b.validation.validate(b.human, { planId: submitted.planId, revision: submitted.revision })
    expect(fresh).toMatchObject({ ok: true, stored: true, dryRun: false })
    expect(fresh.ok && fresh.report.seq).toBe(1)
  })
})
