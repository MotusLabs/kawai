// Plan content checks (durable-plans 1.2): one test per structural rule,
// completeness gaps listed together, and incomplete drafts passing structure.
import { describe, expect, test } from 'bun:test'
import { normalizePlanContent } from '../plans'
import { normalizeStrategyContent } from '../productStrategy'
import { planStructureErrors, planSubmitErrors, strategyAlignmentRefs } from '../planChecks'
import { planInput } from './planFixtures'

const errors = (overrides: Record<string, unknown>) => planStructureErrors(normalizePlanContent(planInput(overrides)))
const change = (name: string, extra: Record<string, unknown> = {}) => ({ change: name, group: 'middle-devs', ...extra })

describe('planStructureErrors', () => {
  test('a complete plan has no violations', () => {
    expect(errors({})).toEqual([])
  })

  test('malformed and duplicate change names are both listed', () => {
    const found = errors({ changes: [change('api'), change('api'), change('Bad_Name')] })
    expect(found).toHaveLength(2)
    expect(found.some(error => error.includes('"Bad_Name" is not a kebab-case'))).toBe(true)
    expect(found.some(error => error.includes('"api" is listed more than once'))).toBe(true)
  })

  test('dependencies: on itself, outside the plan, and listed twice', () => {
    const found = errors({ changes: [change('api', { dependsOn: ['api'] }), change('ui', { dependsOn: ['missing', 'api', 'api'] })] })
    expect(found).toEqual([
      'Change "api" depends on itself.',
      'Change "ui" depends on "missing", which is unknown: the plan lists no change "missing".',
      'Change "ui" lists dependency "api" more than once.',
    ])
  })

  test('a cycle is reported once, as its path', () => {
    expect(errors({ changes: [change('a', { dependsOn: ['b'] }), change('b', { dependsOn: ['a'] })] }))
      .toEqual(['Dependency cycle: a → b → a.'])
    expect(errors({ changes: [change('x'), change('c', { dependsOn: ['a'] }), change('a', { dependsOn: ['b'] }), change('b', { dependsOn: ['c'] })] }))
      .toEqual(['Dependency cycle: c → a → b → c.'])
  })

  test('check names: malformed, floor names reserved, duplicate in scope, change repeating plan-wide', () => {
    const found = errors({
      extraChecks: [{ name: 'lint', description: '' }, { name: 'browser-walkthrough', description: '' }, { name: 'browser-walkthrough', description: '' }],
      changes: [change('api', { extraChecks: [{ name: 'Bad Check', description: '' }, { name: 'browser-walkthrough', description: '' }, { name: 'migration-dry-run', description: '' }] })],
    })
    expect(found).toHaveLength(4)
    expect(found[0]).toContain('"lint" reuses a reserved floor check name')
    expect(found[1]).toContain('"browser-walkthrough" is listed more than once')
    expect(found[2]).toContain('"Bad Check" has a malformed name')
    expect(found[3]).toContain('Change "api" check "browser-walkthrough" repeats a plan-wide check name')
  })

  test('integration branch format', () => {
    for (const branch of ['bad..name', '-lead', '/root', 'trail/', 'x.lock', 'sp ace', '']) {
      expect(errors({ landing: { mode: 'integration-branch', branch } })).toHaveLength(1)
    }
    expect(errors({ landing: { mode: 'integration-branch', branch: 'wave-c/integration' } })).toEqual([])
    expect(errors({ landing: { mode: 'integration-branch', branch: 'bad..name' } })[0]).toContain('"bad..name"')
  })

  test('roles: duplicate group and duplicate profile', () => {
    const found = errors({ roles: [{ group: 'middle-devs', profiles: ['a', 'a'] }, { group: 'middle-devs' }, { group: 'reviewers' }] })
    expect(found).toEqual(['Role "middle-devs" lists profile "a" more than once.', 'Role "middle-devs" is listed more than once.'])
  })

  test('groups outside the roles: implementing, change review, plan review', () => {
    const found = errors({
      roles: [{ group: 'middle-devs' }, { group: 'reviewers' }],
      reviewGroup: 'qa',
      changes: [change('api', { group: 'senior-devs', reviewGroup: 'staff' })],
    })
    expect(found).toHaveLength(3)
    expect(found[0]).toContain('"qa", which is missing from the roles')
    expect(found[1]).toContain('"senior-devs", which is missing from the roles')
    expect(found[2]).toContain('"staff", which is missing from the roles')
  })

  test('duplicate alignment references', () => {
    expect(errors({ alignment: { statement: 's', refs: ['UC1', 'UC1'] } })).toEqual(['Alignment reference "UC1" is listed more than once.'])
  })

  test('an incomplete draft passes the structure checks', () => {
    expect(planStructureErrors(normalizePlanContent({ goal: 'Only a goal' }))).toEqual([])
  })
})

describe('planSubmitErrors', () => {
  test('a complete plan has no gaps', () => {
    expect(planSubmitErrors(normalizePlanContent(planInput()))).toEqual([])
  })

  test('every completeness gap is listed together', () => {
    expect(planSubmitErrors(normalizePlanContent({}))).toEqual([
      'The plan needs a goal.', 'The plan needs at least one success criterion.', 'The plan needs at least one change.',
    ])
    expect(planSubmitErrors(normalizePlanContent({ goal: 'g', changes: [{ change: 'api' }] }))).toEqual([
      'The plan needs at least one success criterion.',
      'Change "api" needs an implementing group.',
      'Change "api" needs a review group (its own, or the plan\'s).',
    ])
  })

  test('a change review group satisfies the gap without a plan review group', () => {
    const content = normalizePlanContent(planInput({ reviewGroup: null, changes: [change('api', { reviewGroup: 'reviewers' })] }))
    expect(planSubmitErrors(content)).toEqual([])
  })
})

describe('strategyAlignmentRefs', () => {
  test('use cases, principles, measures, and decisions — never claims', () => {
    const refs = strategyAlignmentRefs(normalizeStrategyContent({
      useCases: [{ ref: 'UC1' }], principles: [{ ref: 'P4' }], successMeasures: [{ ref: 'S1' }],
      decisions: [{ ref: 'D1' }], claims: [{ ref: 'C1', text: 'x', kind: 'hypothesis' }],
    }))
    expect([...refs].sort()).toEqual(['D1', 'P4', 'S1', 'UC1'])
  })
})
