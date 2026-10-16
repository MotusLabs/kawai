// The validation tools (plan-validation design D10): the registered surface
// is exactly plan_validate, plan_validation_get, and plan_assess; handlers
// bind the calling session, other teams' ids read as not found, the revision
// defaults to the newest in review, findings are capped with a count, and
// the standing in plan_validation_get is read-only. The adapter is canned;
// no CLI runs.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { MailboxStore } from '../team/mailboxStore'
import { ValidationService } from '../plans/validation/ValidationService'
import { ValidationStore } from '../plans/validation/validationStore'
import { summarizeReport, validationHandlers, VALIDATION_FORBIDDEN_TOOL_NAMES, VALIDATION_TOOL_NAMES, TOOL_FINDING_CAP } from '../plans/validation/validationTools'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'

let world: PlanWorld
beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-validation-tools-')
  for (const change of ['api', 'ui']) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change, 'specs', 'chat'), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  fs.writeFileSync(path.join(world.repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

const fakeAdapter = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: async () => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 }),
  showDeltas: async () => ({ ok: true, error: null, touches: [] }),
}) as unknown as OpenspecAdapter

let bench: PlanBench & { validation: ValidationService; validationStore: ValidationStore } | null = null
afterEach(() => {
  bench?.db.close()
  bench = null
})
const use = () => (bench ??= (() => {
  const base = createPlanBench(world)
  const impact = new ImpactService(new ImpactStore(base.db.db), {
    strategies: base.strategies, plans: base.plans, mail: new MailboxStore(base.db.db), getSession: id => base.records.get(id), homeDir: world.home,
  })
  const validationStore = new ValidationStore(base.db.db)
  const validation = new ValidationService(validationStore, {
    plans: base.plans, strategies: base.strategies, impact, adapter: fakeAdapter(),
    getSession: id => base.records.get(id), homeDir: world.home,
  })
  return { ...base, validation, validationStore }
})())

const handlersFor = (sessionId: string) => {
  const b = use()
  return { handlers: validationHandlers(b.validation, sessionId) as Record<string, (input: unknown) => Promise<unknown>>, bench: b }
}

test('the registered surface is exactly the three tools, and no decision surface exists', () => {
  expect(VALIDATION_TOOL_NAMES).toEqual(['plan_validate', 'plan_validation_get', 'plan_assess'])
  expect(Object.keys(validationHandlers(use().validation, 'dev')).sort()).toEqual([...VALIDATION_TOOL_NAMES].sort())
  // Every name an agent might reach for is deliberately absent.
  expect(VALIDATION_FORBIDDEN_TOOL_NAMES).toEqual(expect.arrayContaining(['plan_decide', 'plan_accept_warning', 'plan_approve']))
})

test('plan_validate defaults to the newest in-review revision, else the approved one', async () => {
  const { handlers, bench } = handlersFor('dev')
  const { planId, revision } = await bench.draftInReview()
  const first = await handlers.plan_validate!({ plan_id: planId }) as { report_id: string; revision: number }
  expect(first).toMatchObject({ revision, ready: true, dry_run: false })
  expect(first.report_id).toBeTruthy()
  // After approval and a resubmission, the newest in review wins again.
  await bench.service.approve(bench.human, {
    planId, revision, contentHash: bench.plans.revision(planId, revision)!.contentHash,
    expectedApprovedRevision: null, commandId: 'approve-1',
  })
  const approvedDefault = await handlers.plan_validate!({ plan_id: planId }) as { revision: number }
  expect(approvedDefault.revision).toBe(revision)
})

test('plan_validate caps errors and warnings at 50 with the full count kept', async () => {
  const { bench } = handlersFor('dev')
  const { planId, revision } = await bench.draftInReview()
  await bench.validation.assess(bench.agent('dev'), {
    plan_id: planId, revision,
    findings: Array.from({ length: TOOL_FINDING_CAP + 9 }, () => ({ text: 'watch', subject: null })),
  })
  const summarized = summarizeReport({
    ...bench.validationStore.newestReport(planId, revision)!,
    findings: [
      ...Array.from({ length: TOOL_FINDING_CAP + 3 }, (_, index) => ({ check: 'relations', key: `relations:overlap:x${index}`, severity: 'warning' as const, row: 'scope' as const, subject: 'chat', message: 'overlap' })),
      { check: 'openspec-valid', key: 'openspec-valid:api', severity: 'error' as const, row: 'intent' as const, subject: 'api', message: 'invalid' },
    ],
  })
  expect(summarized.warnings.items).toHaveLength(TOOL_FINDING_CAP)
  expect(summarized.warnings.count).toBe(TOOL_FINDING_CAP + 3)
  expect(summarized.errors.count).toBe(1)
})

test('plan_validation_get returns the report, its standing computed now, and the records; read-only', async () => {
  const { handlers, bench } = handlersFor('dev')
  const { planId, revision } = await bench.draftInReview()
  await handlers.plan_validate!({ plan_id: planId })
  fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', 'api', 'proposal.md'), '# api (edited again)\n')
  const read = await handlers.plan_validation_get!({ plan_id: planId }) as { report: { seq: number }; standing: { state: string; changedParts?: string[] } }
  expect(read.report.seq).toBe(1)
  expect(read.standing.state).toBe('out-of-date')
  expect(read.standing.changedParts).toContain("api's artifacts")
  // Reading wrote nothing.
  expect(bench.validationStore.reports(planId, revision)).toHaveLength(1)
})

test("another team's plan reads as not found for every tool", async () => {
  const { handlers, bench } = handlersFor('stranger')
  const own = await bench.draftInReview()
  const validate = await handlers.plan_validate!({ plan_id: own.planId }) as { ok: boolean; reason?: string }
  expect(validate).toMatchObject({ ok: false, reason: 'not-found' })
  const read = await handlers.plan_validation_get!({ plan_id: own.planId }) as { ok: boolean; reason?: string }
  expect(read).toMatchObject({ ok: false, reason: 'not-found' })
  const assessed = await handlers.plan_assess!({ plan_id: own.planId, revision: own.revision, questions: [{ text: 'q', mandatory: false }] }) as { ok: boolean; reason?: string }
  expect(assessed).toMatchObject({ ok: false, reason: 'not-found' })
})

test('plan_assess returns the new record ids and never decides', async () => {
  const { handlers, bench } = handlersFor('dev')
  const { planId, revision } = await bench.draftInReview()
  const outcome = await handlers.plan_assess!({
    plan_id: planId, revision,
    questions: [{ text: 'which migration?', mandatory: true, subject: 'api' }],
    findings: [{ text: 'watch the overlap' }],
  }) as { ok: boolean; ids: { questions: string[]; findings: string[] } }
  expect(outcome.ok).toBe(true)
  expect(outcome.ids.questions).toHaveLength(1)
  expect(outcome.ids.findings).toHaveLength(1)
  expect(outcome.ids.questions[0]).toMatch(/^pas-/)
})
