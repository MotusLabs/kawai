// The plan attention sources (plan-supervision D13, tasks 9.2): one test per
// kind — the owner, next action, and link follow the D13 table; a fix task's
// owner follows its fixStatus phase, corrections alike; each item clears
// when its cause clears; the promotion item never sits beside an open
// correction and returns when it closes; another team's plans never appear
// (through the real stores at the bottom). The summary rows (9.3) read the
// durable stores' window queries: the 24-hour edge is inclusive, older rows
// fall outside, and a reopened database still reads them.
import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { DecisionCard } from '../../shared/planDecisions'
import type { ChangeSupervision, SupervisionCause, SupervisionWait } from '../../shared/planSupervision'
import type { AttentionItem } from '../../shared/teamWorkspace'
import {
  planAttentionFacts, planSummaryRows, type PlanAttentionFact, type PlanAttentionReads, type PlanChangeFact,
  type PlanFixFact, type PlanSummaryRowReads,
} from '../team/planAttention'
import { attentionItems, type AttentionInput } from '../team/workspaceRead'
import { morningSummary } from '../team/workspaceSummary'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import { PlanStore } from '../plans/planStore'
import { StallAlertStore } from '../plans/supervision/stallAlertStore'
import { schemaDb } from './schemaDb'

const supervision = (overrides: Partial<ChangeSupervision> & Pick<ChangeSupervision, 'change' | 'outcome'>): ChangeSupervision => ({
  cause: { kind: 'stage', stage: 'kawai', step: null },
  alsoApplying: [],
  stage: null,
  holder: null,
  progress: null,
  activity: null,
  stall: null,
  landing: null,
  lastRound: null,
  ...overrides,
})

const change = (overrides: Partial<PlanChangeFact> & Pick<PlanChangeFact, 'supervision'>): PlanChangeFact => ({
  taskId: `task-${overrides.supervision.change ?? 'api'}`,
  generation: 3,
  ...overrides,
})

const stopped = (reason = 'ci-timeout'): PlanChangeFact =>
  change({ supervision: supervision({ change: 'api', outcome: 'stopped', cause: { kind: 'stopped', reason, detail: null } }) })

const stalled = (episodeKey = '2026-10-20T10:00:00.000Z'): PlanChangeFact =>
  change({
    supervision: supervision({
      change: 'api', outcome: 'stalled', stage: 'implement',
      cause: { kind: 'stall', stall: 'no-progress' },
      stall: { kind: 'no-progress', episodeKey, anchorAt: episodeKey, deadlineAt: '2026-10-20T12:00:00.000Z', idle: false },
    }),
  })

const conditioned = (where: 'cause' | 'also'): PlanChangeFact => {
  const wait: SupervisionWait = { kind: 'condition', conditions: ['CI green on the base'] }
  return change({
    supervision: supervision({
      change: 'api', outcome: 'waiting',
      ...(where === 'cause'
        ? { cause: wait as SupervisionCause }
        : { cause: { kind: 'ci', pending: ['ci'] } as SupervisionCause, alsoApplying: [wait] }),
    }),
  })
}

const card = (overrides: Partial<DecisionCard> = {}): DecisionCard => ({
  id: 'card-1', teamId: 'team', planId: 'plan-1', revision: 2, change: 'api', taskId: 'task-api',
  question: 'Which schema?', options: ['A', 'B'], context: null,
  askedBy: { session: 'chat-dev', group: 'middle-devs', profile: 'glm' },
  addressedTo: 'owner', addressedGroup: null, messageId: null, createdAt: '2026-10-20T09:00:00.000Z',
  ...overrides,
})

const fixStatus = (phase: PlanFixFact['status']['phase'], revision: number | null = null): PlanFixFact['status'] => ({
  phase, revision, executionId: null, landings: [], outstanding: [],
})

const fix = (overrides: Partial<PlanFixFact> = {}): PlanFixFact => ({
  taskId: 'task-fix-1', title: 'Forward fix: schema', status: fixStatus('planning'), ...overrides,
})

const fact = (overrides: Partial<PlanAttentionFact> = {}): PlanAttentionFact => ({
  teamId: 'team', planId: 'plan-1', planTitle: 'Wave D', leadGroup: 'lead', executionId: 'exec-1',
  changes: [], openCards: [], fixes: [], failedPromotion: null, correctionOpen: false,
  ...overrides,
})

/** The six sources over one fact set, everything else empty. */
const items = (facts: PlanAttentionFact[]): AttentionItem[] =>
  attentionItems({
    sessions: [], messages: [], waiting: {}, taskTitle: () => null, nameOf: (id: string) => id,
    pendingAcceptance: [], outboundViolations: [], plans: facts,
  } as unknown as AttentionInput)

const byKind = (items: AttentionItem[], kind: string) => items.filter(item => item.kind === kind)

describe('plan-stop (D13)', () => {
  test('a stopped change is the human\'s item, naming the reason, linked to its plan and change', () => {
    const [item] = items([fact({ changes: [stopped()] })]).filter(item => item.kind === 'plan-stop')
    expect(item).toMatchObject({
      id: 'plan-stop:exec-1:api:3',
      owner: { kind: 'human', id: null, label: 'Human' },
      cause: 'Change api of plan "Wave D" stopped: CI did not finish in time',
      nextAction: 'Retry or stop execution',
      requiresHuman: true,
    })
    expect(item!.link).toEqual({ kind: 'plan', id: 'plan-1', planId: 'plan-1', change: 'api' })
  })

  test('retrying or landing the change clears the item (the outcome is no longer stopped)', () => {
    expect(byKind(items([fact({ changes: [stopped()] })]), 'plan-stop')).toHaveLength(1)
    expect(byKind(items([fact({
      changes: [change({ supervision: supervision({ change: 'api', outcome: 'running' }) })],
    })]), 'plan-stop')).toEqual([])
    expect(byKind(items([fact({})]), 'plan-stop')).toEqual([])
  })
})

describe('plan-stall (D13)', () => {
  test('the plan\'s Lead role owns the stall as an agent wait', () => {
    const [item] = byKind(items([fact({ changes: [stalled()] })]), 'plan-stall')
    expect(item).toMatchObject({
      id: 'plan-stall:exec-1:api:2026-10-20T10:00:00.000Z',
      owner: { kind: 'group', id: 'lead', label: 'lead' },
      nextAction: 'Unblock the holder',
      requiresHuman: false,
    })
    expect(item!.link).toEqual({ kind: 'plan', id: 'plan-1', planId: 'plan-1', change: 'api' })
  })

  test('without a Lead role the human owns it, and a change no longer stalled raises nothing', () => {
    const [item] = byKind(items([fact({ leadGroup: null, changes: [stalled()] })]), 'plan-stall')
    expect(item).toMatchObject({ owner: { kind: 'human' }, requiresHuman: true })
    const cleared = change({
      supervision: supervision({ change: 'api', outcome: 'running', stage: 'implement' }),
    })
    expect(byKind(items([fact({ changes: [cleared] })]), 'plan-stall')).toEqual([])
  })
})

describe('decision-question (D13)', () => {
  test('an owner-addressed card is the human\'s item, linked to the card', () => {
    const [item] = byKind(items([fact({ openCards: [card()] })]), 'decision-question')
    expect(item).toMatchObject({
      id: 'decision-question:card-1',
      owner: { kind: 'human', id: null, label: 'Human' },
      cause: 'Decision card asks: Which schema?',
      nextAction: 'Answer the question',
      requiresHuman: true,
    })
    expect(item!.link).toEqual({ kind: 'card', id: 'card-1', planId: 'plan-1' })
  })

  test('a Lead-addressed card is its group\'s wait, and deciding it clears the item', () => {
    const leadCard = card({ addressedTo: 'lead', addressedGroup: 'lead' })
    expect(byKind(items([fact({ openCards: [leadCard] })]), 'decision-question')[0])
      .toMatchObject({ owner: { kind: 'group', id: 'lead' }, requiresHuman: false })
    expect(byKind(items([fact({})]), 'decision-question')).toEqual([])
  })
})

describe('plan-fix (D13)', () => {
  test('planning: the Lead role plans the fix; unassigned, the human assigns', () => {
    const [led] = byKind(items([fact({ fixes: [fix()] })]), 'plan-fix')
    expect(led).toMatchObject({
      id: 'plan-fix:task-fix-1',
      owner: { kind: 'group', id: 'lead', label: 'lead' },
      cause: 'Fix task "Forward fix: schema" of plan "Wave D" is planning',
      nextAction: 'Plan the fix',
      requiresHuman: false,
    })
    expect(led!.link).toEqual({ kind: 'plan', id: 'plan-1', planId: 'plan-1' })
    const [unassigned] = byKind(items([fact({ leadGroup: null, fixes: [fix()] })]), 'plan-fix')
    expect(unassigned).toMatchObject({ owner: { kind: 'human' }, nextAction: 'Assign', requiresHuman: true })
  })

  test('in review: the human approves revision N; approved and not running: the human starts the execution', () => {
    const [review] = byKind(items([fact({ fixes: [fix({ status: fixStatus('in-review', 3) })] })]), 'plan-fix')
    expect(review).toMatchObject({
      owner: { kind: 'human' }, nextAction: 'Approve revision 3', requiresHuman: true,
      cause: 'Fix task "Forward fix: schema" of plan "Wave D" is in review',
    })
    const [approved] = byKind(items([fact({ fixes: [fix({ status: fixStatus('approved', 3) })] })]), 'plan-fix')
    expect(approved).toMatchObject({ owner: { kind: 'human' }, nextAction: 'Start execution', requiresHuman: true })
  })

  test('running: the fix is the Lead role\'s dispatched work until it lands', () => {
    const [running] = byKind(items([fact({ fixes: [fix({ status: fixStatus('running', 3) })] })]), 'plan-fix')
    expect(running).toMatchObject({
      owner: { kind: 'group', id: 'lead' }, nextAction: 'Wait for the fix to land', requiresHuman: false,
      cause: 'Fix task "Forward fix: schema" of plan "Wave D" is running',
    })
    const [unled] = byKind(items([fact({ leadGroup: null, fixes: [fix({ status: fixStatus('running', 3) })] })]), 'plan-fix')
    // While the fix runs it is a wait on agents even unassigned (D13, S3):
    // Needs you is for unassigned, awaiting approval, or approved-not-running.
    expect(unled).toMatchObject({ owner: { kind: 'human' }, requiresHuman: false })
  })

  test('closing the task, or its changes landing while it is open, clears the item', () => {
    expect(byKind(items([fact({ fixes: [fix({ status: fixStatus('landed', 3) })] })]), 'plan-fix')).toEqual([])
    expect(byKind(items([fact({})]), 'plan-fix')).toEqual([])
  })

  test('a correction task follows the same phases as a fix task\'s', () => {
    const [item] = byKind(items([fact({ fixes: [fix({ taskId: 'task-corr-1', title: 'Correct failed promotion', status: fixStatus('in-review', 4) })] })]), 'plan-fix')
    expect(item).toMatchObject({
      id: 'plan-fix:task-corr-1', owner: { kind: 'human' }, nextAction: 'Approve revision 4',
      cause: 'Fix task "Correct failed promotion" of plan "Wave D" is in review',
    })
  })
})

describe('plan-condition (D13)', () => {
  test('a condition holding a change is the human\'s item, named by its target', () => {
    const [item] = byKind(items([fact({ changes: [conditioned('cause')] })]), 'plan-condition')
    expect(item).toMatchObject({
      id: 'plan-condition:exec-1:api:CI green on the base',
      owner: { kind: 'human', id: null, label: 'Human' },
      cause: 'Change api of plan "Wave D" waits on acceptance condition: CI green on the base',
      nextAction: 'Resolve condition',
      requiresHuman: true,
    })
    expect(item!.link).toEqual({ kind: 'plan', id: 'plan-1', planId: 'plan-1', change: 'api' })
  })

  test('each condition target is its own item, deduped across cause and also-applying', () => {
    const both: PlanChangeFact = change({
      supervision: supervision({
        change: 'api', outcome: 'waiting', stage: 'review',
        cause: { kind: 'condition', conditions: ['CI green on the base', 'Owner sign-off'] },
        alsoApplying: [{ kind: 'condition', conditions: ['CI green on the base'] }],
      }),
    })
    expect(byKind(items([fact({ changes: [both] })]), 'plan-condition').map(item => item.id)).toEqual([
      'plan-condition:exec-1:api:CI green on the base',
      'plan-condition:exec-1:api:Owner sign-off',
    ])
  })

  test('a condition among the also-applying waits still holds the item, and resolving clears it', () => {
    expect(byKind(items([fact({ changes: [conditioned('also')] })]), 'plan-condition')).toHaveLength(1)
    expect(byKind(items([fact({
      changes: [change({ supervision: supervision({ change: 'api', outcome: 'running', stage: 'implement' }) })],
    })]), 'plan-condition')).toEqual([])
  })
})

describe('plan-promotion (D13)', () => {
  const failedPromotion = { id: 'promo-1', targetBranch: 'master', reason: 'ci-failed' }

  test('the newest failed promotion is the human\'s item with Promote again', () => {
    const [item] = byKind(items([fact({ failedPromotion })]), 'plan-promotion')
    expect(item).toMatchObject({
      id: 'plan-promotion:promo-1',
      owner: { kind: 'human', id: null, label: 'Human' },
      cause: 'Promotion of plan "Wave D" to master failed: ci-failed',
      nextAction: 'Promote again',
      requiresHuman: true,
    })
    expect(item!.link).toEqual({ kind: 'plan', id: 'plan-1', planId: 'plan-1' })
  })

  test('it never sits beside an open correction, and returns when the correction closes', () => {
    expect(byKind(items([fact({ failedPromotion, correctionOpen: true })]), 'plan-promotion')).toEqual([])
    expect(byKind(items([fact({ failedPromotion, correctionOpen: false })]), 'plan-promotion')).toHaveLength(1)
  })

  test('a later promotion started (none failed), or the newest promotion merged, raises nothing', () => {
    expect(byKind(items([fact({})]), 'plan-promotion')).toEqual([])
  })
})

describe('planAttentionFacts over the real stores', () => {
  const readsFor = (db: Database): PlanAttentionReads => ({
    // Never reached on these paths: the plans hold no execution, so the
    // derivation stops before the runtime and mailbox facts.
    db, mail: {} as never, runtime: { holder: () => null, blocker: () => null }, conditionsOf: () => [],
    tasks: { get: () => null },
    executions: new ExecutionStore(db), plans: new PlanStore(db), decisions: new DecisionStore(db),
  })

  test('another team\'s plans never appear (9.2, D13)', () => {
    const db = schemaDb()
    const plans = new PlanStore(db)
    const decisions = new DecisionStore(db)
    const planA = plans.insertPlan({ teamId: 'team-a', title: 'A wave', creator: { kind: 'human', sessionId: null } })
    const planB = plans.insertPlan({ teamId: 'team-b', title: 'B wave', creator: { kind: 'human', sessionId: null } })
    decisions.insertCard({
      teamId: 'team-b', planId: planB, revision: null, change: null, taskId: null, question: 'Ship B now?', options: [],
      context: null, askedBy: { session: 'chat-dev', group: 'middle-devs', profile: 'glm' },
      addressedTo: 'owner', addressedGroup: null, messageId: null,
    })
    const itemsOf = (teamId: string) => {
      const facts = planAttentionFacts(readsFor(db), teamId, new Date('2026-10-20T12:00:00.000Z'))
      return { facts, items: items(facts) }
    }
    const a = itemsOf('team-a')
    expect(a.facts.map(f => f.planId)).toEqual([planA])
    expect(byKind(a.items, 'decision-question')).toEqual([])
    expect(a.facts[0]!.planTitle).toBe('A wave')
    const b = itemsOf('team-b')
    expect(b.facts.map(f => f.planId)).toEqual([planB])
    expect(byKind(b.items, 'decision-question').map(item => item.cause)).toEqual(['Decision card asks: Ship B now?'])
  })
})

/** One row per plan bucket at the window's exact edge, one older, over a real database. */
function seedWindowRows(db: Database, teamId: string): string {
  const plans = new PlanStore(db)
  let clock = new Date('2026-10-19T11:00:00.000Z')
  const at = () => new Date(clock)
  const executions = new ExecutionStore(db, at)
  const decisions = new DecisionStore(db, at)
  const alerts = new StallAlertStore(db, at)
  const planId = plans.insertPlan({ teamId, title: 'Wave D', creator: { kind: 'human', sessionId: null } })
  const execution = executions.insertExecution({
    teamId, planId, revision: 1, contentHash: 'hash', reportId: 'report-1', inputHash: 'inputs', landingMode: 'direct',
    baseBranch: 'master', baseCommit: 'base0', floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } }, maxParallel: 3, mergeMethod: 'merge',
    changes: [{ change: 'alpha', landed: false }, { change: 'beta', landed: false }, { change: 'gamma', landed: false }],
  })
  // Before the window: a stop, an override, and a stall alert — all excluded.
  executions.transition(execution.id, 'beta', { state: 'waiting', generation: 0 }, { state: 'stopped', stopReason: 'ci-timeout' })
  const asked = (question: string) => decisions.insertCard({
    teamId, planId, revision: null, change: null, taskId: null, question, options: [], context: null,
    askedBy: { session: 'chat-dev', group: 'middle-devs', profile: 'glm' },
    addressedTo: 'owner', addressedGroup: null, messageId: null,
  }).id
  const answered = (cardId: string, kind: 'answer' | 'override' = 'answer') => decisions.insertDecision({
    cardId, planId, teamId, seq: 1, kind, choice: 'Continue', optionIndex: null, rationale: null,
    decidedBy: { kind: 'human', session: null, group: null, profile: null }, affected: [],
  }).id
  answered(asked('Before the window?'))
  decisions.insertDecision({ cardId: asked('Override before?'), planId, teamId, seq: 1, kind: 'override', choice: 'Reconsider',
    optionIndex: null, rationale: 'earlier', decidedBy: { kind: 'human', session: null, group: null, profile: null }, affected: [] })
  alerts.insert({ teamId, planId, executionId: execution.id, change: 'beta', kind: 'no-progress', episodeKey: 'old',
    detail: {}, messageId: null })
  // At the exact 24-hour edge — still inside (>=): one row per bucket.
  clock = new Date('2026-10-19T12:00:00.000Z')
  executions.transition(execution.id, 'alpha', { state: 'waiting', generation: 0 }, { state: 'stopped', stopReason: 'review-unavailable' })
  executions.insertLanding({ planId, change: 'gamma', executionId: execution.id, teamId, mechanism: 'direct', prNumber: 7,
    prUrl: null, headSha: 'head1', baseSha: 'base1', mergeSha: 'merge1', treeVerified: true })
  answered(asked('Ship now?'))
  answered(asked('Reconsider?'), 'override')
  alerts.insert({ teamId, planId, executionId: execution.id, change: 'alpha', kind: 'repeating-failure', episodeKey: 'edge',
    detail: {}, messageId: null })
  return planId
}

const summaryReads = (db: Database): PlanSummaryRowReads => ({
  plans: new PlanStore(db), executions: new ExecutionStore(db), decisions: new DecisionStore(db), alerts: new StallAlertStore(db),
})

const SINCE = '2026-10-19T12:00:00.000Z' // the 24-hour edge before 2026-10-20T12:00:00Z

describe('planSummaryRows over the durable stores (9.3, D13)', () => {
  test('the window holds the rows at its edge and excludes the older ones', () => {
    const db = schemaDb()
    const planId = seedWindowRows(db, 'team-a')
    const rows = planSummaryRows(summaryReads(db), 'team-a', SINCE)
    expect(rows.landings.map(row => [row.change, row.planId, row.planTitle])).toEqual([['gamma', planId, 'Wave D']])
    // `beta` stopped before the window and falls outside; `alpha` at the edge is in.
    expect(rows.stops.map(row => [row.change, row.reason])).toEqual([['alpha', 'review-unavailable']])
    expect(rows.stallAlerts.map(row => [row.change, row.kind])).toEqual([['alpha', 'repeating-failure']])
    // The pre-window answer and override are excluded; decisions and overrides split by kind.
    expect(rows.decisions).toHaveLength(1)
    expect(rows.overrides).toHaveLength(1)
    expect(rows.decisions[0]!.decisionId).not.toBe(rows.overrides[0]!.decisionId)
  })

  test('another team\'s durable rows never enter the window', () => {
    const db = schemaDb()
    seedWindowRows(db, 'team-a')
    for (const key of ['landings', 'stops', 'stallAlerts', 'decisions', 'overrides'] as const) {
      expect(planSummaryRows(summaryReads(db), 'team-b', SINCE)[key]).toEqual([])
    }
  })

  test('the rows survive a restart: a reopened database reads them again', () => {
    const path = join(tmpdir(), `kawai-plan-summary-${crypto.randomUUID()}.db`)
    try {
      const write = schemaDb(path)
      seedWindowRows(write, 'team-a')
      write.close()
      const reopened = schemaDb(path)
      const rows = planSummaryRows(summaryReads(reopened), 'team-a', SINCE)
      expect(rows.landings).toHaveLength(1)
      expect(rows.stops.map(row => row.change)).toEqual(['alpha'])
      expect(rows.stallAlerts).toHaveLength(1)
      expect(rows.decisions).toHaveLength(1)
      expect(rows.overrides).toHaveLength(1)
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('the morning summary\'s plan buckets (9.3, D13)', () => {
  test('each durable row renders once, linked to its plan, with no runtimeOnly', () => {
    const db = schemaDb()
    const planId = seedWindowRows(db, 'team-a')
    const rows = planSummaryRows(summaryReads(db), 'team-a', SINCE)
    const summary = morningSummary({
      now: '2026-10-20T12:00:00.000Z', sessions: [], messages: [], messageEvents: () => [], waiting: {}, turnEnds: [],
      nameOf: (id: string) => id, hasResult: () => false, results: [], outboundCounts: { allowed: 0, unknown: 0, violations: 0 },
      plans: rows,
    })
    for (const key of ['landings', 'stops', 'stallAlerts', 'decisions', 'overrides'] as const) {
      expect(summary[key].items).toHaveLength(1)
      expect('runtimeOnly' in summary[key]).toBe(false)
      const link = summary[key].items[0]!.link
      expect(link.kind).toBe('plan')
      expect(link.planId).toBe(planId)
    }
    // Change-scoped rows carry their change; decisions point at the plan alone.
    expect(summary.landings.items[0]!.link).toEqual({ kind: 'plan', id: planId, planId, change: 'gamma' })
    expect(summary.decisions.items[0]!.link).toEqual({ kind: 'plan', id: planId, planId })
    expect(summary.stops.items[0]!.id).toBe(`stop:${planId}:alpha:2026-10-19T12:00:00.000Z`)
    expect(summary.stops.items[0]!.label).toBe('Change alpha of plan "Wave D" stopped: An author claimed the review')
    // Without plan rows (the manager seam absent) the buckets stay empty.
    const empty = morningSummary({
      now: '2026-10-20T12:00:00.000Z', sessions: [], messages: [], messageEvents: () => [], waiting: {}, turnEnds: [],
      nameOf: (id: string) => id, hasResult: () => false, results: [], outboundCounts: { allowed: 0, unknown: 0, violations: 0 },
    })
    for (const key of ['landings', 'stops', 'stallAlerts', 'decisions', 'overrides'] as const) {
      expect(empty[key].items).toEqual([])
    }
  })
})
