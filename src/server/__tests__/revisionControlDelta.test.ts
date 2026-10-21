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

  test('after a landing, a plan reviewGroup change lands-changes a landed change without its own review group', () => {
    // D10/D11: the effective review group is a compared field, so a landed
    // change reading the plan-wide reviewGroup cannot silently re-route its
    // reviews — the landed-changed refusal names reviewGroup. A landed change
    // with its own reviewGroup is untouched.
    const from = content([change('plan-grouped'), change('own-grouped', { reviewGroup: 'reviewers-mimo' })], { reviewGroup: 'reviewers-claude' })
    const to = content([change('plan-grouped'), change('own-grouped', { reviewGroup: 'reviewers-mimo' })], { reviewGroup: 'reviewers-claude-2' })
    const delta = revisionDelta(from, to, new Set(['plan-grouped', 'own-grouped']), new Set())
    expect(classes(delta)['plan-grouped']).toMatchObject({ class: 'changed', fields: ['reviewGroup'] })
    expect(finding(delta, 'landed-changed')?.changes).toEqual(['plan-grouped'])
    expect(classes(delta)['own-grouped'].class).toBe('unchanged')
    expect(finding(delta, 'landed-changed')?.changes).not.toContain('own-grouped')
  })

  test('a role profiles change of the implementing group marks the change changed with roles', () => {
    // D10, roles as effective fields: the implementing group's profiles are
    // compared in preference order, looked up by group name.
    const from = content([change('a')], { roles: [{ group: 'middle-devs', profiles: ['glm'] }] })
    const to = content([change('a')], { roles: [{ group: 'middle-devs', profiles: ['sonnet'] }] })
    expect(classes(revisionDelta(from, to, new Set(), new Set())).a).toMatchObject({ class: 'changed', fields: ['roles'] })
  })

  test('a role profiles change of the review group marks the change changed with roles', () => {
    const from = content([change('a')], { roles: [{ group: 'reviewers', profiles: ['mimo'] }] })
    const to = content([change('a')], { roles: [{ group: 'reviewers', profiles: ['claude'] }] })
    expect(classes(revisionDelta(from, to, new Set(), new Set())).a).toMatchObject({ class: 'changed', fields: ['roles'] })
  })

  test('an unrelated group\'s role change leaves the change unchanged', () => {
    const from = content([change('a')], { roles: [{ group: 'junior-devs', profiles: ['haiku'] }] })
    const to = content([change('a')], { roles: [{ group: 'junior-devs', profiles: ['flash'] }] })
    expect(classes(revisionDelta(from, to, new Set(), new Set())).a.class).toBe('unchanged')
  })

  test('reordering the roles array changes nothing', () => {
    const roles = [{ group: 'middle-devs', profiles: ['glm'] }, { group: 'reviewers', profiles: ['mimo'] }]
    const from = content([change('a')], { roles })
    const to = content([change('a')], { roles: [roles[1], roles[0]] })
    const delta = revisionDelta(from, to, new Set(), new Set())
    expect(classes(delta).a.class).toBe('unchanged')
    expect(delta.findings).toEqual([])
  })

  test('reordering a role\'s profiles marks the change changed (order is preference)', () => {
    const from = content([change('a')], { roles: [{ group: 'middle-devs', profiles: ['glm', 'sonnet'] }] })
    const to = content([change('a')], { roles: [{ group: 'middle-devs', profiles: ['sonnet', 'glm'] }] })
    expect(classes(revisionDelta(from, to, new Set(), new Set())).a).toMatchObject({ class: 'changed', fields: ['roles'] })
  })

  test('after a landing, a role change never lands-changes: the landed change reads unchanged, the unlanded one is marked', () => {
    const from = content([change('landed'), change('waiting')], { roles: [{ group: 'middle-devs', profiles: ['glm'] }] })
    const to = content([change('landed'), change('waiting')], { roles: [{ group: 'middle-devs', profiles: ['sonnet'] }] })
    const delta = revisionDelta(from, to, new Set(['landed']), new Set())
    expect(classes(delta).landed).toMatchObject({ class: 'unchanged', fields: [] })
    expect(classes(delta).waiting).toMatchObject({ class: 'changed', fields: ['roles'] })
    expect(finding(delta, 'landed-changed')).toBeNull()
  })

  test('a roles change needs a choice when provisioned, none when waiting', () => {
    const from = content([change('tasked'), change('waiting')], { roles: [{ group: 'middle-devs', profiles: ['glm'] }] })
    const to = content([change('tasked'), change('waiting')], { roles: [{ group: 'middle-devs', profiles: ['sonnet'] }] })
    const delta = revisionDelta(from, to, new Set(), new Set(['tasked']))
    expect(classes(delta).tasked).toMatchObject({ class: 'changed', fields: ['roles'], choice: 'needed' })
    expect(classes(delta).waiting).toMatchObject({ class: 'changed', fields: ['roles'], choice: 'none' })
  })

  test('plan-wide rules with nothing landed mark every unlanded change changed (D10)', () => {
    const from = content([change('tasked'), change('waiting')])
    const to = content([change('tasked'), change('waiting')], {
      acceptanceRules: ['new rule'],
      extraChecks: [{ name: 'ci', description: 'd', command: 'bun ci' }],
    })
    const delta = revisionDelta(from, to, new Set(), new Set(['tasked']))
    expect(finding(delta, 'plan-rules-changed')).toBeNull()
    expect(classes(delta).tasked).toMatchObject({ class: 'changed', fields: ['planAcceptanceRules', 'planExtraChecks'], choice: 'needed' })
    expect(classes(delta).waiting).toMatchObject({ class: 'changed', fields: ['planAcceptanceRules', 'planExtraChecks'], choice: 'none' })
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
    expect(classes(waiting).a).toMatchObject({ class: 'changed', fields: ['planExtraChecks'], choice: 'none' })
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
