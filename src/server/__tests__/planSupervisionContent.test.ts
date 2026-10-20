// Plan content's Lead role and `fixes` (plan-supervision 2.1, 2.2): unset
// fields stay absent so every earlier revision keeps its canonical form and
// hash byte-for-byte (the pins below were computed on the base commit before
// the fields existed), set fields round-trip, and the structure check refuses
// a Lead role outside the roles and malformed or repeated `fixes` entries.
import { describe, expect, test } from 'bun:test'
import { normalizePlanContent, planDraftHashInput } from '../../shared/plans'
import { planStructureErrors } from '../../shared/planChecks'
import { planInput } from '../../shared/__tests__/planFixtures'
import { hashPlanDraft, hashPlanRevision } from '../plans/planHash'

const FIX = 'task-11111111-2222-4333-8444-555555555555'
const PIN = { strategyId: 's', revision: 2, hash: 'h' }

// [fixture, draft hash, revision hash unpinned, revision hash pinned] on 9bf88c56.
const PINNED: Array<[Record<string, unknown>, string, string, string]> = [
  [planInput(), 'a14fbcf42536cf2d62c34f636d58097cb760a0d4ad611f6986eef65b23e3efbb', '767d7781948ef16728be030b44f52a2f88b01671d999406e89d815d7dc582dbe', '89250843d97386e2604f655e69f6fe5f465dd8c09d3bdadb0752c8219010821d'],
  [
    planInput({ landing: { mode: 'integration-branch', branch: 'integ/x' }, extraChecks: [{ name: 'walk', description: 'd', command: 'c' }] }),
    'b382a07848832ec0f3def64f952fbd0feb2558a40e9f58a30f0b5e1669e4a172', '92be86d0b8cfde275f5ac67e608352187ae82fdd0912097bcabaa3f0cac90488', 'b0a0d48044165a92873c546f563aba81f5e12f528a9534ed4d891e78db1813cc',
  ],
]

describe('leadGroup and fixes normalization', () => {
  test('pre-existing fixtures keep their hashes byte-for-byte', () => {
    for (const [input, draft, unpinned, pinned] of PINNED) {
      const content = normalizePlanContent(input)
      expect('leadGroup' in content).toBe(false)
      expect(content.changes.some(change => 'fixes' in change)).toBe(false)
      expect([hashPlanDraft(content), hashPlanRevision(content, null), hashPlanRevision(content, PIN)]).toEqual([draft, unpinned, pinned])
    }
  })

  test('empty values normalize to absent, never null or []', () => {
    const [input, draft] = PINNED[0]!
    const blanks = {
      ...input,
      leadGroup: '   ',
      changes: (input.changes as Array<Record<string, unknown>>).map(change => ({ ...change, fixes: [] })),
    }
    const content = normalizePlanContent(blanks)
    expect(planDraftHashInput(content)).not.toContain('leadGroup')
    expect(planDraftHashInput(content)).not.toContain('fixes')
    expect(hashPlanDraft(content)).toBe(draft)
    expect(normalizePlanContent({ ...input, leadGroup: null }).leadGroup).toBeUndefined()
  })

  test('set fields round-trip, trimmed and in order, an empty entry kept for the check', () => {
    const content = normalizePlanContent(planInput({
      leadGroup: ' lead ',
      changes: [{ change: 'api', group: 'middle-devs', fixes: [` ${FIX} `, '  ', 7] }],
    }))
    expect(content.leadGroup).toBe('lead')
    expect(content.changes[0]!.fixes).toEqual([FIX, ''])
    expect(normalizePlanContent(JSON.parse(JSON.stringify(content)))).toEqual(content)
    expect(hashPlanDraft(content)).not.toBe(PINNED[0]![1])
  })
})

describe('planStructureErrors: Lead role and fixes', () => {
  const errors = (overrides: Record<string, unknown>) => planStructureErrors(normalizePlanContent(planInput(overrides)))

  test('a Lead role outside the roles is refused, naming it', () => {
    expect(errors({ leadGroup: 'lead' })).toEqual([
      'The plan Lead role names group "lead", which is missing from the roles; add it to the roles or pick a listed group.',
    ])
    expect(errors({ leadGroup: 'middle-devs' })).toEqual([])
  })

  test('malformed and duplicate fixes entries are refused, naming them', () => {
    expect(errors({ changes: [{ change: 'api', group: 'middle-devs', fixes: ['task-x', FIX, FIX, ' '] }] })).toEqual([
      'Change "api" fixes entry "task-x" is not a task id (task-<uuid>).',
      'Change "api" lists an empty fixes entry; name a fix or correction task id (task-<uuid>).',
      `Change "api" lists fixes entry "${FIX}" more than once.`,
    ])
  })

  test('one fix task named by two changes passes', () => {
    expect(errors({
      changes: [{ change: 'api', group: 'middle-devs', fixes: [FIX] }, { change: 'ui', group: 'middle-devs', dependsOn: ['api'], fixes: [FIX] }],
    })).toEqual([])
  })
})
