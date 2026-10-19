// Decision records' pure derivations (plan-supervision 1.2): the current
// decision and card state, the fix status walk, M2 override counts, M4
// durations, and the `fixes` field format rule.
import { describe, expect, test } from 'bun:test'
import {
  cardState,
  currentDecision,
  fixDurations,
  fixesFieldErrors,
  fixLandings,
  fixStatus,
  overrideCounts,
  type FixPlanFacts,
  type PlanDecision,
} from '../planDecisions'
import { normalizePlanContent, type PlanContent } from '../plans'
import { planInput } from './planFixtures'

const FIX = 'task-11111111-2222-4333-8444-555555555555'
const OTHER = 'task-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function decision(seq: number, kind: PlanDecision['kind'], extra: Partial<PlanDecision> = {}): PlanDecision {
  return {
    id: `decision-${seq}`,
    cardId: 'card-1',
    planId: 'plan-1',
    teamId: 'team',
    seq,
    kind,
    choice: `choice ${seq}`,
    optionIndex: null,
    rationale: 'because',
    decidedBy: kind === 'override'
      ? { kind: 'human', session: null, group: null, profile: null }
      : { kind: 'agent', session: 'lead-1', group: 'lead', profile: 'opus' },
    affected: [],
    commandId: null,
    replyMessageId: null,
    createdAt: `2026-10-0${seq}T00:00:00.000Z`,
    ...extra,
  }
}

describe('currentDecision and cardState', () => {
  test('the current decision is the highest seq, whatever the order', () => {
    const decisions = [decision(2, 'override'), decision(1, 'answer'), decision(3, 'override')]
    expect(currentDecision(decisions)?.seq).toBe(3)
    expect(currentDecision([])).toBeNull()
  })

  test('states: open, decided, overridden', () => {
    expect(cardState([])).toBe('open')
    expect(cardState([decision(1, 'answer')])).toBe('decided')
    expect(cardState([decision(1, 'own-call')])).toBe('decided')
    expect(cardState([decision(1, 'answer'), decision(2, 'override')])).toBe('overridden')
  })
})

function content(changes: Array<{ change: string; fixes?: string[] }>): PlanContent {
  return normalizePlanContent(planInput({ changes: changes.map(entry => ({ group: 'middle-devs', ...entry })) }))
}

function facts(overrides: Partial<FixPlanFacts> = {}): FixPlanFacts {
  return {
    revisions: [{ revision: 1, status: 'approved', content: content([{ change: 'api' }]) }],
    currentApprovedRevision: 1,
    executions: [],
    landings: [],
    ...overrides,
  }
}

const landing = (change: string, executionId: string, landedAt: string, treeVerified = true) =>
  ({ change, executionId, mergeSha: `merge-${change}`, landedAt, treeVerified })

describe('fixStatus walks the fix phases', () => {
  const open = { taskId: FIX, status: 'open' as const, superseded: false }
  const naming = content([{ change: 'api' }, { change: 'api-fix', fixes: [FIX] }])

  test('planning: no revision names the task', () => {
    expect(fixStatus(open, facts()).phase).toBe('planning')
  })

  test('in review: a revision in review names it', () => {
    const status = fixStatus(open, facts({ revisions: [...facts().revisions, { revision: 2, status: 'in_review', content: naming }] }))
    expect(status).toMatchObject({ phase: 'in-review', revision: 2 })
  })

  test('approved: the current revision names it, naming another running execution it waits for', () => {
    const status = fixStatus(open, facts({
      revisions: [{ revision: 1, status: 'superseded', content: content([{ change: 'api' }]) }, { revision: 2, status: 'approved', content: naming }],
      currentApprovedRevision: 2,
      executions: [{ id: 'exec-1', revision: 1, state: 'running' }],
    }))
    expect(status).toMatchObject({ phase: 'approved', revision: 2, executionId: 'exec-1', outstanding: ['api-fix'] })
  })

  test('running: an execution of a naming revision runs', () => {
    const status = fixStatus(open, facts({
      revisions: [{ revision: 2, status: 'approved', content: naming }],
      currentApprovedRevision: 2,
      executions: [{ id: 'exec-2', revision: 2, state: 'running' }],
    }))
    expect(status).toMatchObject({ phase: 'running', executionId: 'exec-2' })
  })

  test('landed: a naming change landed and none is outstanding', () => {
    const status = fixStatus(open, facts({
      revisions: [{ revision: 2, status: 'approved', content: naming }],
      currentApprovedRevision: 2,
      executions: [{ id: 'exec-2', revision: 2, state: 'finished' }],
      landings: [landing('api-fix', 'exec-2', '2026-10-10T00:00:00.000Z')],
    }))
    expect(status.phase).toBe('landed')
    expect(status.landings.map(entry => entry.change)).toEqual(['api-fix'])
  })

  test('no change: done with nothing landed', () => {
    expect(fixStatus({ ...open, status: 'done' }, facts()).phase).toBe('no-change')
  })

  test('superseded: cancelled by a newer override; cancelled otherwise', () => {
    expect(fixStatus({ ...open, status: 'cancelled', superseded: true }, facts()).phase).toBe('superseded')
    expect(fixStatus({ ...open, status: 'cancelled' }, facts()).phase).toBe('cancelled')
  })
})

describe('fixLandings judges each landing by the revision it landed under', () => {
  test('a landing from revision 5 counts after revision 6 dropped the change', () => {
    const found = fixLandings(FIX, facts({
      revisions: [
        { revision: 5, status: 'superseded', content: content([{ change: 'api-fix', fixes: [FIX] }]) },
        { revision: 6, status: 'approved', content: content([{ change: 'api' }]) },
      ],
      currentApprovedRevision: 6,
      executions: [{ id: 'exec-5', revision: 5, state: 'finished' }],
      landings: [landing('api-fix', 'exec-5', '2026-10-10T00:00:00.000Z')],
    }))
    expect(found).toEqual({ landings: [landing('api-fix', 'exec-5', '2026-10-10T00:00:00.000Z')], outstanding: [] })
  })

  test('a later revision adding another naming change keeps it outstanding', () => {
    const found = fixLandings(FIX, facts({
      revisions: [
        { revision: 5, status: 'superseded', content: content([{ change: 'api-fix', fixes: [FIX] }]) },
        { revision: 6, status: 'approved', content: content([{ change: 'api-fix', fixes: [FIX] }, { change: 'ui-fix', fixes: [FIX] }]) },
      ],
      currentApprovedRevision: 6,
      executions: [{ id: 'exec-5', revision: 5, state: 'finished' }],
      landings: [landing('api-fix', 'exec-5', '2026-10-10T00:00:00.000Z')],
    }))
    expect(found.outstanding).toEqual(['ui-fix'])
  })

  test('a landing whose revision did not name the task never counts', () => {
    const found = fixLandings(FIX, facts({
      revisions: [{ revision: 1, status: 'approved', content: content([{ change: 'api', fixes: [OTHER] }]) }],
      executions: [{ id: 'exec-1', revision: 1, state: 'finished' }],
      landings: [landing('api', 'exec-1', '2026-10-10T00:00:00.000Z')],
    }))
    expect(found.landings).toEqual([])
  })

  test('a landing under a revision that did not name the task leaves the change outstanding', () => {
    const found = fixLandings(FIX, facts({
      revisions: [
        { revision: 1, status: 'superseded', content: content([{ change: 'api' }]) },
        { revision: 2, status: 'approved', content: content([{ change: 'api', fixes: [FIX] }]) },
      ],
      currentApprovedRevision: 2,
      executions: [{ id: 'exec-1', revision: 1, state: 'finished' }],
      landings: [landing('api', 'exec-1', '2026-10-10T00:00:00.000Z')],
    }))
    expect(found).toEqual({ landings: [], outstanding: ['api'] })
  })
})

describe('overrideCounts (M2)', () => {
  test('counts agent answers and own calls of the addressed group, and the overridden ones', () => {
    const counts = overrideCounts([
      { card: { addressedGroup: 'lead' }, decisions: [decision(1, 'answer'), decision(2, 'override')] },
      { card: { addressedGroup: 'lead' }, decisions: [decision(1, 'own-call')] },
      // Another group's agent decided: not a Lead decision.
      { card: { addressedGroup: 'lead' }, decisions: [decision(1, 'answer', { decidedBy: { kind: 'agent', session: 's', group: 'reviewers', profile: null } })] },
      // The owner answered: not a Lead decision, overridden or not.
      { card: { addressedGroup: 'lead' }, decisions: [decision(1, 'answer', { decidedBy: { kind: 'human', session: null, group: null, profile: null } }), decision(2, 'override')] },
      // Owner-addressed card.
      { card: { addressedGroup: null }, decisions: [decision(1, 'answer')] },
    ])
    expect(counts).toEqual({ overridden: 1, total: 2 })
  })
})

describe('fixDurations (M4)', () => {
  const landed = (landings: ReturnType<typeof landing>[]) =>
    ({ phase: 'landed' as const, revision: null, executionId: null, landings, outstanding: [] })

  test('override to the newest landing, flagged when a landing is not tree-verified', () => {
    const durations = fixDurations([
      { decisionId: 'd1', overriddenAt: '2026-10-01T00:00:00.000Z', status: landed([landing('a', 'e', '2026-10-02T02:00:00.000Z'), landing('b', 'e', '2026-10-01T10:00:00.000Z')]) },
      { decisionId: 'd2', overriddenAt: '2026-10-01T00:00:00.000Z', status: landed([landing('c', 'e', '2026-10-01T01:00:00.000Z', false)]) },
      { decisionId: 'd3', overriddenAt: '2026-10-01T00:00:00.000Z', status: { ...landed([]), phase: 'running' } },
    ])
    expect(durations.map(entry => [entry.decisionId, entry.durationMs / 3_600_000, entry.unverified])).toEqual([['d1', 26, false], ['d2', 1, true]])
  })
})

describe('fixesFieldErrors', () => {
  test('a valid list passes, and one task id may appear in two changes', () => {
    expect(fixesFieldErrors('api', [FIX, OTHER])).toEqual([])
    expect(fixesFieldErrors('ui', [FIX])).toEqual([])
    expect(fixesFieldErrors('ui', undefined)).toEqual([])
  })

  test('malformed, duplicate, and empty entries are each refused by name', () => {
    expect(fixesFieldErrors('api', ['task-1', FIX, FIX, ''])).toEqual([
      'Change "api" fixes entry "task-1" is not a task id (task-<uuid>).',
      'Change "api" lists an empty fixes entry; name a fix or correction task id (task-<uuid>).',
      `Change "api" lists fixes entry "${FIX}" more than once.`,
    ])
  })
})
