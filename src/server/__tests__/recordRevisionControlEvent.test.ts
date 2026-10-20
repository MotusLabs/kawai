// `PlanService.recordRevisionControlEvent` (revision-control 2.3, design D3,
// C3, C6): each of the six kinds records through the one `plan_events`
// writer, replays by `(plan_id, command_id)` over its compared payload
// without running `within` again, and refuses a same-id different payload
// naming the first differing field.
import { describe, expect, test } from 'bun:test'
import { normalizePlanContent } from '../../shared/plans'
import { PlanService } from '../plans/PlanService'
import { PlanStore } from '../plans/planStore'
import { StrategyStore } from '../strategy/strategyStore'
import { schemaDb } from './schemaDb'

const db = schemaDb()
const plansStore = new PlanStore(db)
const plans = new PlanService(plansStore, { getSession: () => null, strategies: new StrategyStore(db) })
const teamId = 'team'
const planId = plansStore.insertPlan({ teamId, title: 'P1', creator: { kind: 'human', sessionId: null } })
const revision = plansStore.atomically(() => plansStore.insertRevision(planId, {
  content: normalizePlanContent({
    goal: 'Ship it', successCriteria: ['It ships'],
    changes: [{ change: 'alpha', group: 'middle-devs', dependsOn: [], acceptance: [], extraChecks: [], guidance: '' }],
    roles: [{ group: 'middle-devs', profiles: [] }],
    landing: { mode: 'direct' },
  }),
  contentHash: 'hash-1', pin: null, author: { kind: 'human', sessionId: null },
}))
plansStore.setRevisionStatus(planId, revision, 'approved')
plansStore.setCurrentApproved(planId, revision)

let withinRuns = 0
const within = (): string => {
  withinRuns += 1
  return 'ran'
}

describe('recordRevisionControlEvent', () => {
  test('hold-placed: records, replays order-insensitively, refuses a different rationale', () => {
    const first = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-placed', commandId: 'hold-1', scope: 'changes', changes: ['beta', 'alpha'],
      rationale: ' wrong direction ', deadline: '2026-10-25T00:00:00Z',
      cites: { kind: 'impact-review', id: 'review-1' },
    }, within)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.replayed).toBe(false)
      expect(first.event.kind).toBe('hold-placed')
      expect(first.result).toBe('ran')
    }
    expect(withinRuns).toBe(1)
    // The same payload in another input order replays; `within` never runs again.
    const replay = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-placed', commandId: 'hold-1', scope: 'changes', changes: ['alpha', 'beta'],
      rationale: 'wrong direction', deadline: '2026-10-25T00:00:00Z',
      cites: { kind: 'impact-review', id: 'review-1' },
    }, within)
    expect(replay.ok && replay.replayed).toBe(true)
    expect(withinRuns).toBe(1)
    const refused = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-placed', commandId: 'hold-1', scope: 'changes', changes: ['alpha', 'beta'],
      rationale: 'different', deadline: '2026-10-25T00:00:00Z',
      cites: { kind: 'impact-review', id: 'review-1' },
    }, within)
    expect(!refused.ok && refused.reason === 'payload' && refused.message.includes('rationale')).toBe(true)
  })

  test('hold-released: replays and refuses naming retain', () => {
    const first = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-released', commandId: 'release-1', holdId: 'hold-1', changes: ['y'], retain: ['b', 'a'], reason: 'narrow',
    }, within)
    expect(first.ok).toBe(true)
    const replay = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-released', commandId: 'release-1', holdId: 'hold-1', changes: ['y'], retain: ['a', 'b'], reason: 'narrow',
    }, within)
    expect(replay.ok && replay.replayed).toBe(true)
    const refused = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-released', commandId: 'release-1', holdId: 'hold-1', changes: ['y'], retain: ['a', 'c'], reason: 'narrow',
    }, within)
    expect(!refused.ok && refused.reason === 'payload' && refused.message.includes('retain')).toBe(true)
  })

  test('hold-extended: replays and refuses naming deadline', () => {
    const first = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-extended', commandId: 'extend-1', holdId: 'hold-1', deadline: '2026-11-01T00:00:00Z', reason: ' still deciding ',
    }, within)
    expect(first.ok).toBe(true)
    const replay = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-extended', commandId: 'extend-1', holdId: 'hold-1', deadline: '2026-11-01T00:00:00Z', reason: 'still deciding',
    }, within)
    expect(replay.ok && replay.replayed).toBe(true)
    const refused = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-extended', commandId: 'extend-1', holdId: 'hold-1', deadline: '2026-11-02T00:00:00Z', reason: 'still deciding',
    }, within)
    expect(!refused.ok && refused.reason === 'payload' && refused.message.includes('deadline')).toBe(true)
  })

  test('pause-requested: replays and refuses naming note', () => {
    const first = plans.recordRevisionControlEvent(planId, {
      kind: 'pause-requested', commandId: 'pause-1', holdId: 'hold-1', deadline: '2026-10-23T00:00:00Z', note: ' checkpoint please ',
    }, within)
    expect(first.ok).toBe(true)
    const replay = plans.recordRevisionControlEvent(planId, {
      kind: 'pause-requested', commandId: 'pause-1', holdId: 'hold-1', deadline: '2026-10-23T00:00:00Z', note: 'checkpoint please',
    }, within)
    expect(replay.ok && replay.replayed).toBe(true)
    const refused = plans.recordRevisionControlEvent(planId, {
      kind: 'pause-requested', commandId: 'pause-1', holdId: 'hold-1', deadline: '2026-10-23T00:00:00Z', note: 'different',
    }, within)
    expect(!refused.ok && refused.reason === 'payload' && refused.message.includes('note')).toBe(true)
  })

  test('pause-resolved: replays and refuses naming choice', () => {
    const first = plans.recordRevisionControlEvent(planId, {
      kind: 'pause-resolved', commandId: 'resolve-1', pauseId: 'pause-1', change: 'alpha', choice: 'restart',
      adapt: null, rationale: 'start over', releaseHold: true,
    }, within)
    expect(first.ok).toBe(true)
    const replay = plans.recordRevisionControlEvent(planId, {
      kind: 'pause-resolved', commandId: 'resolve-1', pauseId: 'pause-1', change: 'alpha', choice: 'restart',
      adapt: null, rationale: 'start over', releaseHold: true,
    }, within)
    expect(replay.ok && replay.replayed).toBe(true)
    const refused = plans.recordRevisionControlEvent(planId, {
      kind: 'pause-resolved', commandId: 'resolve-1', pauseId: 'pause-1', change: 'alpha', choice: 'continue',
      adapt: null, rationale: 'start over', releaseHold: true,
    }, within)
    expect(!refused.ok && refused.reason === 'payload' && refused.message.includes('choice')).toBe(true)
  })

  test('revision-applied: replays and refuses naming expectedRevision', () => {
    const choices = { alpha: 'adapt' }
    const adaptations = { alpha: 'new guidance' }
    const first = plans.recordRevisionControlEvent(planId, {
      kind: 'revision-applied', commandId: 'apply-1', executionId: 'exec-1', expectedRevision: 1, revision: 2,
      contentHash: 'hash-2', choices, adaptations, rationale: 'apply the approved revision',
    }, within)
    expect(first.ok).toBe(true)
    const replay = plans.recordRevisionControlEvent(planId, {
      kind: 'revision-applied', commandId: 'apply-1', executionId: 'exec-1', expectedRevision: 1, revision: 2,
      contentHash: 'hash-2', choices, adaptations, rationale: 'apply the approved revision',
    }, within)
    expect(replay.ok && replay.replayed).toBe(true)
    const refused = plans.recordRevisionControlEvent(planId, {
      kind: 'revision-applied', commandId: 'apply-1', executionId: 'exec-1', expectedRevision: 2, revision: 2,
      contentHash: 'hash-2', choices, adaptations, rationale: 'apply the approved revision',
    }, within)
    expect(!refused.ok && refused.reason === 'payload' && refused.message.includes('expectedRevision')).toBe(true)
  })

  test('an empty command id is refused and writes nothing', () => {
    const refused = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-placed', commandId: '   ', scope: 'plan', changes: [], rationale: 'r',
      deadline: '2026-10-25T00:00:00Z', cites: null,
    }, within)
    expect(!refused.ok && refused.reason === 'invalid').toBe(true)
  })
})
