// Plan content model (durable-plans 1.1, 1.3): normalization drops unknown
// fields and defaults missing ones, a new draft lands as direct landing, the
// canonical hash inputs ignore key order and bind the pin, and progress is a
// pure derivation over linked tasks.
import { describe, expect, test } from 'bun:test'
import {
  PLAN_CHECK_FLOOR,
  normalizePlanContent,
  planDiffSummary,
  planDisplayState,
  planDraftHashInput,
  planProgress,
  planRevisionHashInput,
  type PlanLinkedTask,
} from '../plans'
import { planInput } from './planFixtures'

const task = (id: string, planChange: string, status: PlanLinkedTask['status']): PlanLinkedTask => ({ id, title: id, status, planChange })

describe('normalizePlanContent', () => {
  test('drops unknown fields, including one meant to skip the floor', () => {
    const content = normalizePlanContent({ ...planInput(), skipFloor: ['lint'], extraChecks: [{ name: 'x', description: 'd', disabled: true }] })
    expect('skipFloor' in content).toBe(false)
    expect(content.extraChecks).toEqual([{ name: 'x', description: 'd', command: null }])
    expect(PLAN_CHECK_FLOOR).toEqual(['lint', 'typecheck', 'unit-tests', 'ci-e2e', 'review'])
  })

  test('defaults every missing field; a new draft is direct landing', () => {
    expect(normalizePlanContent({})).toEqual({
      goal: '', successCriteria: [], nonGoals: [], approach: '',
      alignment: { statement: '', refs: [] }, changes: [], acceptanceRules: [], extraChecks: [],
      landing: { mode: 'direct' }, roles: [], reviewGroup: null,
    })
    const change = normalizePlanContent({ changes: [{ change: ' api ' }] }).changes[0]
    expect(change).toEqual({ change: 'api', dependsOn: [], group: null, reviewGroup: null, acceptance: [], extraChecks: [], guidance: '' })
  })

  test('keeps an integration branch, and coerces an unknown mode to direct', () => {
    expect(normalizePlanContent({ landing: { mode: 'integration-branch', branch: 'wave-c/integration' } }).landing)
      .toEqual({ mode: 'integration-branch', branch: 'wave-c/integration' })
    expect(normalizePlanContent({ landing: { mode: 'yolo' } }).landing).toEqual({ mode: 'direct' })
  })
})

describe('canonical hash inputs', () => {
  test('two key orders serialize equally', () => {
    const a = normalizePlanContent(planInput())
    const reordered = normalizePlanContent(Object.fromEntries(Object.entries(planInput()).reverse()))
    expect(planDraftHashInput(a)).toBe(planDraftHashInput(reordered))
    expect(planRevisionHashInput(a, null)).toBe(planRevisionHashInput(reordered, null))
  })

  test('changing only the pin changes the revision input, not the draft input', () => {
    const content = normalizePlanContent(planInput())
    const pin = { strategyId: 's', revision: 2, hash: 'h2' }
    expect(planRevisionHashInput(content, pin)).not.toBe(planRevisionHashInput(content, null))
    expect(planRevisionHashInput(content, pin)).not.toBe(planRevisionHashInput(content, { ...pin, revision: 3 }))
  })
})

describe('planProgress', () => {
  const content = normalizePlanContent(planInput())

  test('not started, in progress, done (one done plus one cancelled), and cancelled', () => {
    expect(planProgress(content, []).changes.map(change => change.status)).toEqual(['not-started', 'not-started'])
    expect(planProgress(content, [task('t1', 'api', 'blocked')]).changes[0]!.status).toBe('in-progress')
    expect(planProgress(content, [task('t1', 'api', 'done'), task('t2', 'api', 'cancelled')]).changes[0]!.status).toBe('done')
    expect(planProgress(content, [task('t1', 'api', 'cancelled')]).changes[0]!.status).toBe('cancelled')
  })

  test('waitsOn clears when a dependency is done; a cancelled one keeps waiting', () => {
    expect(planProgress(content, [task('t1', 'api', 'active')]).changes[1]!.waitsOn).toEqual(['api'])
    expect(planProgress(content, [task('t1', 'api', 'done')]).changes[1]!.waitsOn).toEqual([])
    expect(planProgress(content, [task('t1', 'api', 'cancelled')]).changes[1]!.waitsOn).toEqual(['api'])
  })

  test('tasks of a dropped change are outside the revision; content order is kept', () => {
    const progress = planProgress(content, [task('t0', 'legacy', 'active'), task('t1', 'ui', 'open')])
    expect(progress.outsideRevision.map(entry => entry.id)).toEqual(['t0'])
    expect(progress.changes.map(change => change.change)).toEqual(['api', 'ui'])
    expect(progress.changes[1]!.tasks.map(entry => entry.id)).toEqual(['t1'])
  })
})

describe('planDisplayState', () => {
  test('Draft, Ready, In progress, and the closed lifecycles', () => {
    expect(planDisplayState({ lifecycle: 'open', currentApprovedRevision: null }, 3)).toBe('draft')
    expect(planDisplayState({ lifecycle: 'open', currentApprovedRevision: 1 }, 0)).toBe('ready')
    expect(planDisplayState({ lifecycle: 'open', currentApprovedRevision: 1 }, 1)).toBe('in-progress')
    expect(planDisplayState({ lifecycle: 'cancelled', currentApprovedRevision: 1 }, 1)).toBe('cancelled')
  })
})

describe('planDiffSummary', () => {
  test('lists changed sections and added, removed, and reordered changes', () => {
    const base = normalizePlanContent(planInput())
    const next = normalizePlanContent(planInput({
      goal: 'Another goal',
      changes: [
        { change: 'ui', group: 'middle-devs' },
        { change: 'cli', group: 'middle-devs' },
        { change: 'api', group: 'middle-devs' },
      ],
    }))
    const diff = planDiffSummary({ content: base, pin: null }, { content: next, pin: null })
    expect(diff.sections).toEqual(['Goal', 'Changes'])
    expect(diff.addedChanges).toEqual(['cli'])
    expect(diff.removedChanges).toEqual([])
    expect(diff.reordered).toBe(true)
    expect(diff.pinChanged).toBe(false)
    expect(planDiffSummary({ content: base, pin: null }, { content: base, pin: { strategyId: 's', revision: 1, hash: 'h' } }).pinChanged).toBe(true)
  })
})
