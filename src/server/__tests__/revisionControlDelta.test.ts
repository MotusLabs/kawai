// The pure revision delta (revision-control 1.3, design D10): every delta
// class with its changed fields, `metadata` for a landed change differing
// only in `dependsOn` or `fixes`, the execution-wide findings (`landing-changed`,
// `plan-rules-changed` only once something landed, `landed-changed` ignoring
// `dependsOn`, `lead-changed` informational), and the choice reading for a
// waiting changed change.
import { describe, expect, test } from 'bun:test'
import type { PlanChange, PlanContent } from '../../shared/plans'
import { revisionDelta } from '../plans/revisionControl/revisionDelta'

const change = (name: string, over: Partial<PlanChange> = {}): PlanChange => ({
  change: name,
  dependsOn: [],
  group: 'middle-devs',
  reviewGroup: null,
  acceptance: [`${name} works`],
  extraChecks: [],
  guidance: '',
  ...over,
})

const content = (changes: PlanChange[], over: Partial<PlanContent> = {}): PlanContent => ({
  goal: 'g',
  successCriteria: ['s'],
  nonGoals: [],
  approach: 'a',
  alignment: { statement: '', refs: [] },
  changes,
  acceptanceRules: [],
  extraChecks: [],
  landing: { mode: 'direct' },
  roles: [],
  reviewGroup: 'reviewers',
  ...over,
})

const classes = (delta: ReturnType<typeof revisionDelta>) =>
  Object.fromEntries(delta.changes.map(entry => [entry.change, entry]))
const finding = (delta: ReturnType<typeof revisionDelta>, kind: string) =>
  delta.findings.find(entry => entry.kind === kind) ?? null

describe('revisionDelta', () => {
  test('each delta class and its changed fields', () => {
    const from = content([
      change('same'),
      change('reworded'),
      change('regrouped'),
      change('gone'),
    ])
    const to = content([
      change('same'),
      change('reworded', { guidance: 'say more' }),
      change('regrouped', { group: 'senior-devs' }),
      change('new'),
    ])
    const delta = revisionDelta(from, to, new Set(), new Set(['reworded']))
    const byName = classes(delta)
    expect(byName.same.class).toBe('unchanged')
    expect(byName.reworded).toMatchObject({ class: 'changed', fields: ['guidance'], choice: 'needed' })
    expect(byName.regrouped).toMatchObject({ class: 'changed', fields: ['group'], choice: 'none' })
    expect(byName.new.class).toBe('added')
    expect(byName.gone.class).toBe('removed')
    // Target content order, removed last.
    expect(delta.changes.map(entry => entry.change)).toEqual(['same', 'reworded', 'regrouped', 'new', 'gone'])
  })

  test('metadata: a landed change differing only in dependsOn or fixes, with the fields named', () => {
    const from = content([
      change('landed-deps', { dependsOn: ['a'] }),
      change('landed-fixes', { fixes: ['task-1'] }),
    ])
    const to = content([
      change('landed-deps', { dependsOn: ['a', 'b'] }),
      change('landed-fixes', { fixes: ['task-1', 'task-2'] }),
    ])
    const delta = revisionDelta(from, to, new Set(['landed-deps', 'landed-fixes']), new Set())
    expect(classes(delta)['landed-deps']).toMatchObject({ class: 'metadata', fields: ['dependsOn'], choice: null })
    expect(classes(delta)['landed-fixes']).toMatchObject({ class: 'metadata', fields: ['fixes'], choice: null })
    expect(finding(delta, 'landed-changed')).toBeNull()
  })

  test('fixes is a compared field: an unlanded fix addition reads changed', () => {
    const delta = revisionDelta(
      content([change('fixable')]),
      content([change('fixable', { fixes: ['task-9'] })]),
      new Set(),
      new Set(['fixable']),
    )
    expect(classes(delta).fixable).toMatchObject({ class: 'changed', fields: ['fixes'], choice: 'needed' })
  })

  test('the effective review group: a plan reviewGroup change marks changes without their own', () => {
    // D10, roles with nothing landed: every unlanded change whose effective
    // review group changed reads `changed`, provisioned ones needing a choice.
    const from = content([change('a'), change('waiting'), change('b', { reviewGroup: 'reviewers-mimo' })])
    const to = content([change('a'), change('waiting'), change('b', { reviewGroup: 'reviewers-mimo' })], { reviewGroup: 'reviewers-claude' })
    const delta = revisionDelta(from, to, new Set(), new Set(['a']))
    expect(classes(delta).a).toMatchObject({ class: 'changed', fields: ['reviewGroup'], choice: 'needed' })
    expect(classes(delta).waiting).toMatchObject({ class: 'changed', fields: ['reviewGroup'], choice: 'none' })
    expect(classes(delta).b.class).toBe('unchanged')
  })

  test('plan-wide rules with nothing landed mark every unlanded change changed (D10)', () => {
    const from = content([change('tasked'), change('waiting')])
    const to = content([change('tasked'), change('waiting')], {
      acceptanceRules: ['new rule'],
      extraChecks: [{ name: 'ci', description: 'd', command: 'bun ci' }],
    })
    const delta = revisionDelta(from, to, new Set(), new Set(['tasked']))
    expect(finding(delta, 'plan-rules-changed')).toBeNull()
    expect(classes(delta).tasked).toMatchObject({ class: 'changed', fields: ['acceptanceRules', 'extraChecks'], choice: 'needed' })
    expect(classes(delta).waiting).toMatchObject({ class: 'changed', fields: ['acceptanceRules', 'extraChecks'], choice: 'none' })
    // An added change stays `added`: its provisioned definition is the new one.
    expect(revisionDelta(from, content([change('tasked'), change('waiting'), change('new')], { acceptanceRules: ['new rule'] }), new Set(), new Set(['tasked'])).changes
      .find(entry => entry.change === 'new')!.class).toBe('added')
  })

  test('landing-changed, plan-rules-changed only once something landed', () => {
    const rules = (extra: PlanContent['extraChecks']) => content([change('a')], { acceptanceRules: ['rule'], extraChecks: extra })
    const mode = revisionDelta(content([change('a')]), content([change('a')], { landing: { mode: 'integration-branch', branch: 'int' } }), new Set(), new Set())
    expect(finding(mode, 'landing-changed')).not.toBeNull()
    const branch = revisionDelta(
      content([change('a')], { landing: { mode: 'integration-branch', branch: 'int' } }),
      content([change('a')], { landing: { mode: 'integration-branch', branch: 'int-2' } }),
      new Set(), new Set(),
    )
    expect(finding(branch, 'landing-changed')).not.toBeNull()
    // Direct to direct, same plan rules: no findings at all.
    expect(revisionDelta(content([change('a')]), content([change('a')]), new Set(), new Set()).findings).toEqual([])
    // Rules differ with nothing landed: no refusal, but the class reads
    // changed through the plan-wide effective fields (D10); once landed the
    // class reads unchanged again and the refusal is the finding.
    const edited = rules([{ name: 'ci-extra', description: 'd', command: 'bun ci:extra' }])
    const waiting = revisionDelta(rules([]), edited, new Set(), new Set())
    expect(finding(waiting, 'plan-rules-changed')).toBeNull()
    expect(classes(waiting).a).toMatchObject({ class: 'changed', fields: ['extraChecks'], choice: 'none' })
    const landed = revisionDelta(rules([]), edited, new Set(['a']), new Set())
    expect(finding(landed, 'plan-rules-changed')).not.toBeNull()
    expect(classes(landed).a.class).toBe('unchanged')
  })

  test('landed-changed ignores dependsOn, names a landed content change, and a landed removal', () => {
    const delta = revisionDelta(
      content([change('landed-ok', { dependsOn: ['x'] }), change('landed-edited'), change('landed-removed')]),
      content([change('landed-ok', { dependsOn: ['y'] }), change('landed-edited', { acceptance: ['new bar'] })]),
      new Set(['landed-ok', 'landed-edited', 'landed-removed']),
      new Set(),
    )
    expect(classes(delta)['landed-ok'].class).toBe('metadata')
    expect(classes(delta)['landed-edited'].class).toBe('changed')
    const landed = finding(delta, 'landed-changed')
    expect(landed?.changes).toEqual(['landed-edited', 'landed-removed'])
  })

  test('lead-changed is informational: listed beside the findings, no refusal kind', () => {
    const delta = revisionDelta(content([change('a')], { leadGroup: 'lead' }), content([change('a')], { leadGroup: 'senior-lead' }), new Set(), new Set())
    expect(delta.changes.map(entry => entry.class)).toEqual(['unchanged'])
    expect(finding(delta, 'lead-changed')).not.toBeNull()
  })

  test('a waiting changed change gets choice none, a provisioned one needs a choice', () => {
    const delta = revisionDelta(
      content([change('waiting'), change('tasked')]),
      content([change('waiting', { guidance: 'new' }), change('tasked', { guidance: 'new' })]),
      new Set(),
      new Set(['tasked']),
    )
    expect(classes(delta).waiting).toMatchObject({ class: 'changed', choice: 'none' })
    expect(classes(delta).tasked).toMatchObject({ class: 'changed', choice: 'needed' })
  })
})
