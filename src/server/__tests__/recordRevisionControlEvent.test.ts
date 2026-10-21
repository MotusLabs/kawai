// `PlanService.recordRevisionControlEvent` (revision-control 2.3, design D3,
// C3, C6): each of the six kinds records through the one `plan_events`
// writer, replays by `(plan_id, command_id)` over its compared payload
// without running `within` again, and refuses a same-id different payload
// naming the first differing field. A compared payload is canonical before
// comparison (D3): map keys sort, deadlines are the same instant in one
// spelling, prose is trimmed — an equivalent resend replays, a different
// value is refused naming that field.
import { describe, expect, test } from 'bun:test'
import { normalizePlanContent } from '../../shared/plans'
import type { RevisionControlEventInput } from '../plans/revisionControl/events'
import { revisionControlCommandPayload } from '../plans/revisionControl/events'
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

// The compared payload table (D3): one case per compared field of every
// kind. The invariant under test: a compared payload is canonical before
// comparison — so a resend whose value is merely written differently
// (keys reordered, the same instant spelled otherwise, prose padded)
// replays, while a different value is refused naming that field.
type Kind = RevisionControlEventInput['kind']
type PayloadCase = {
  field: string
  base: RevisionControlEventInput
  different: RevisionControlEventInput
  /** The same payload in an equivalent spelling; absent for plain scalars. */
  equivalent?: RevisionControlEventInput
}

type HoldPlacedEvent = Extract<RevisionControlEventInput, { kind: 'hold-placed' }>
type HoldReleasedEvent = Extract<RevisionControlEventInput, { kind: 'hold-released' }>
type HoldExtendedEvent = Extract<RevisionControlEventInput, { kind: 'hold-extended' }>
type PauseRequestedEvent = Extract<RevisionControlEventInput, { kind: 'pause-requested' }>
type PauseResolvedEvent = Extract<RevisionControlEventInput, { kind: 'pause-resolved' }>
type AppliedEvent = Extract<RevisionControlEventInput, { kind: 'revision-applied' }>

const placed = (commandId: string): HoldPlacedEvent =>
  ({ kind: 'hold-placed', commandId, scope: 'changes', changes: ['alpha', 'beta'], rationale: 'wrong direction', deadline: '2026-10-25T00:00:00Z', cites: { kind: 'impact-review', id: 'review-1' } })
const released = (commandId: string): HoldReleasedEvent =>
  ({ kind: 'hold-released', commandId, holdId: 'hold-1', changes: ['alpha', 'beta'], retain: ['b', 'a'], reason: 'narrow' })
const extended = (commandId: string): HoldExtendedEvent =>
  ({ kind: 'hold-extended', commandId, holdId: 'hold-1', deadline: '2026-11-01T00:00:00Z', reason: 'still deciding' })
const pauseReq = (commandId: string): PauseRequestedEvent =>
  ({ kind: 'pause-requested', commandId, holdId: 'hold-1', deadline: '2026-10-23T00:00:00Z', note: 'checkpoint please' })
const pauseRes = (commandId: string): PauseResolvedEvent =>
  ({ kind: 'pause-resolved', commandId, pauseId: 'pause-1', change: 'alpha', choice: 'restart', adapt: 'written guidance', rationale: 'start over', releaseHold: true })
const applied = (commandId: string): AppliedEvent =>
  ({ kind: 'revision-applied', commandId, executionId: 'exec-1', expectedRevision: 1, revision: 2, contentHash: 'hash-2', choices: { alpha: 'adapt', beta: 'continue' }, adaptations: { alpha: 'new guidance', beta: 'tweaks' }, rationale: 'apply the approved revision' })

const TABLE: Array<{ kind: Kind; cases: PayloadCase[] }> = [
  {
    kind: 'hold-placed',
    cases: [
      { field: 'scope', base: placed('tbl-hold-placed-scope'), different: { ...placed('tbl-hold-placed-scope'), scope: 'plan' } },
      { field: 'changes', base: placed('tbl-hold-placed-changes'), different: { ...placed('tbl-hold-placed-changes'), changes: ['gamma'] }, equivalent: { ...placed('tbl-hold-placed-changes'), changes: ['beta', 'alpha'] } },
      { field: 'rationale', base: placed('tbl-hold-placed-rationale'), different: { ...placed('tbl-hold-placed-rationale'), rationale: 'other' }, equivalent: { ...placed('tbl-hold-placed-rationale'), rationale: ' wrong direction ' } },
      { field: 'deadline', base: placed('tbl-hold-placed-deadline'), different: { ...placed('tbl-hold-placed-deadline'), deadline: '2026-11-25T00:00:00Z' }, equivalent: { ...placed('tbl-hold-placed-deadline'), deadline: '2026-10-25T00:00:00.000Z' } },
      { field: 'cites', base: placed('tbl-hold-placed-cites'), different: { ...placed('tbl-hold-placed-cites'), cites: { kind: 'decision-card', id: 'card-9' } }, equivalent: { ...placed('tbl-hold-placed-cites'), cites: { id: 'review-1', kind: 'impact-review' } } },
    ],
  },
  {
    kind: 'hold-released',
    cases: [
      { field: 'holdId', base: released('tbl-hold-released-holdId'), different: { ...released('tbl-hold-released-holdId'), holdId: 'hold-2' } },
      { field: 'changes', base: released('tbl-hold-released-changes'), different: { ...released('tbl-hold-released-changes'), changes: ['gamma'] }, equivalent: { ...released('tbl-hold-released-changes'), changes: ['beta', 'alpha'] } },
      { field: 'retain', base: released('tbl-hold-released-retain'), different: { ...released('tbl-hold-released-retain'), retain: ['a', 'c'] }, equivalent: { ...released('tbl-hold-released-retain'), retain: ['a', 'b'] } },
      { field: 'reason', base: released('tbl-hold-released-reason'), different: { ...released('tbl-hold-released-reason'), reason: 'other' }, equivalent: { ...released('tbl-hold-released-reason'), reason: ' narrow ' } },
    ],
  },
  {
    kind: 'hold-extended',
    cases: [
      { field: 'holdId', base: extended('tbl-hold-extended-holdId'), different: { ...extended('tbl-hold-extended-holdId'), holdId: 'hold-2' } },
      { field: 'deadline', base: extended('tbl-hold-extended-deadline'), different: { ...extended('tbl-hold-extended-deadline'), deadline: '2026-11-02T00:00:00Z' }, equivalent: { ...extended('tbl-hold-extended-deadline'), deadline: '2026-11-01T02:00:00+02:00' } },
      { field: 'reason', base: extended('tbl-hold-extended-reason'), different: { ...extended('tbl-hold-extended-reason'), reason: 'other' }, equivalent: { ...extended('tbl-hold-extended-reason'), reason: ' still deciding ' } },
    ],
  },
  {
    kind: 'pause-requested',
    cases: [
      { field: 'holdId', base: pauseReq('tbl-pause-requested-holdId'), different: { ...pauseReq('tbl-pause-requested-holdId'), holdId: 'hold-2' } },
      { field: 'deadline', base: pauseReq('tbl-pause-requested-deadline'), different: { ...pauseReq('tbl-pause-requested-deadline'), deadline: '2026-10-24T00:00:00Z' }, equivalent: { ...pauseReq('tbl-pause-requested-deadline'), deadline: '2026-10-23T00:00:00.000Z' } },
      { field: 'note', base: pauseReq('tbl-pause-requested-note'), different: { ...pauseReq('tbl-pause-requested-note'), note: 'other' }, equivalent: { ...pauseReq('tbl-pause-requested-note'), note: ' checkpoint please ' } },
    ],
  },
  {
    kind: 'pause-resolved',
    cases: [
      { field: 'pauseId', base: pauseRes('tbl-pause-resolved-pauseId'), different: { ...pauseRes('tbl-pause-resolved-pauseId'), pauseId: 'pause-2' } },
      { field: 'change', base: pauseRes('tbl-pause-resolved-change'), different: { ...pauseRes('tbl-pause-resolved-change'), change: 'beta' } },
      { field: 'choice', base: pauseRes('tbl-pause-resolved-choice'), different: { ...pauseRes('tbl-pause-resolved-choice'), choice: 'continue' } },
      { field: 'adapt', base: pauseRes('tbl-pause-resolved-adapt'), different: { ...pauseRes('tbl-pause-resolved-adapt'), adapt: 'other guidance' }, equivalent: { ...pauseRes('tbl-pause-resolved-adapt'), adapt: ' written guidance ' } },
      { field: 'rationale', base: pauseRes('tbl-pause-resolved-rationale'), different: { ...pauseRes('tbl-pause-resolved-rationale'), rationale: 'other' }, equivalent: { ...pauseRes('tbl-pause-resolved-rationale'), rationale: ' start over ' } },
      { field: 'releaseHold', base: pauseRes('tbl-pause-resolved-releaseHold'), different: { ...pauseRes('tbl-pause-resolved-releaseHold'), releaseHold: false } },
    ],
  },
  {
    kind: 'revision-applied',
    cases: [
      { field: 'executionId', base: applied('tbl-revision-applied-executionId'), different: { ...applied('tbl-revision-applied-executionId'), executionId: 'exec-2' } },
      { field: 'expectedRevision', base: applied('tbl-revision-applied-expectedRevision'), different: { ...applied('tbl-revision-applied-expectedRevision'), expectedRevision: 2 } },
      { field: 'revision', base: applied('tbl-revision-applied-revision'), different: { ...applied('tbl-revision-applied-revision'), revision: 3 } },
      { field: 'contentHash', base: applied('tbl-revision-applied-contentHash'), different: { ...applied('tbl-revision-applied-contentHash'), contentHash: 'hash-3' } },
      { field: 'choices', base: applied('tbl-revision-applied-choices'), different: { ...applied('tbl-revision-applied-choices'), choices: { alpha: 'restart', beta: 'continue' } }, equivalent: { ...applied('tbl-revision-applied-choices'), choices: { beta: 'continue', alpha: 'adapt' } } },
      { field: 'adaptations', base: applied('tbl-revision-applied-adaptations'), different: { ...applied('tbl-revision-applied-adaptations'), adaptations: { alpha: 'other' } }, equivalent: { ...applied('tbl-revision-applied-adaptations'), adaptations: { beta: 'tweaks', alpha: 'new guidance' } } },
      { field: 'rationale', base: applied('tbl-revision-applied-rationale'), different: { ...applied('tbl-revision-applied-rationale'), rationale: 'other' }, equivalent: { ...applied('tbl-revision-applied-rationale'), rationale: ' apply the approved revision ' } },
    ],
  },
]

describe('compared payload table (D3)', () => {
  for (const { kind, cases } of TABLE) {
    test(`${kind}: every compared field refuses a different value and replays an equivalent one`, () => {
      for (const { field, base, different, equivalent } of cases) {
        const first = plans.recordRevisionControlEvent(planId, base, within)
        expect(first.ok).toBe(true)
        const refused = plans.recordRevisionControlEvent(planId, different, within)
        expect(!refused.ok && refused.reason === 'payload' && refused.message.includes(field)).toBe(true)
        if (equivalent) {
          const replay = plans.recordRevisionControlEvent(planId, equivalent, within)
          expect(replay.ok && replay.replayed).toBe(true)
        }
      }
    })
  }

  test('an invalid deadline is refused and writes nothing (D3)', () => {
    const refused = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-placed', commandId: 'tbl-invalid', scope: 'plan', changes: [],
      rationale: 'r', deadline: 'not-a-date', cites: null,
    }, within)
    expect(!refused.ok && refused.reason === 'invalid').toBe(true)
    // Nothing was recorded: the same command id still places a fresh hold.
    const after = plans.recordRevisionControlEvent(planId, {
      kind: 'hold-placed', commandId: 'tbl-invalid', scope: 'plan', changes: [],
      rationale: 'r', deadline: '2026-10-25T00:00:00Z', cites: null,
    }, within)
    expect(after.ok && !after.replayed).toBe(true)
  })

  test('deadlines compare as one instant, maps order-insensitively (D3)', () => {
    const spelled = revisionControlCommandPayload({ kind: 'pause-requested', commandId: 'c', holdId: 'h', deadline: '2026-10-23T00:00:00Z', note: 'n' })
    const millis = revisionControlCommandPayload({ kind: 'pause-requested', commandId: 'c', holdId: 'h', deadline: '2026-10-23T00:00:00.000Z', note: 'n' })
    expect(spelled).toEqual(millis)
    expect(() => revisionControlCommandPayload({ kind: 'pause-requested', commandId: 'c', holdId: 'h', deadline: 'nope', note: 'n' })).toThrow()
  })
})
