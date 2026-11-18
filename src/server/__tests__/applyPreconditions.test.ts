// APPLY_PRECONDITIONS (plan-revision-apply design D3, oracle tables AP and
// DL, task 2.1). The AP rows run the real list over pure contexts: each row
// overrides exactly what its input names, and the expected outcome is the
// list of failing entries in list order (AP16) — empty for AP17. The DL rows
// run the real `revisionDelta` over two plan contents and then the real
// list over that delta, so a classification row also states whether Apply
// refuses it. One literal test per row keeps every row citable.
import { describe, expect, test } from 'bun:test'
import type { Plan, PlanChange, PlanContent, PlanRevision } from '../../shared/plans'
import type { ValidationStanding } from '../plans/validation/validationStanding'
import type { ExecutionRow } from '../plans/execution/executionRows'
import { revisionDelta } from '../plans/revisionControl/revisionDelta'
import {
  APPLY_PRECONDITIONS, baseComparedChanges, evaluateApplyPreconditions, neededChoices,
  type ApplyCheckContext,
} from '../plans/revisionControl/applyPreconditions'

/** A plan check, as plan-wide and per-change extra checks carry it. */
const BENCH = { name: 'bench', description: 'Runs the benchmark', command: null }

const change = (name: string, over: Partial<PlanChange> = {}): PlanChange => ({
  change: name, dependsOn: [], group: 'middle-devs', reviewGroup: null,
  acceptance: [`${name} works`], extraChecks: [], guidance: '', ...over,
})
const content = (changes: PlanChange[], over: Partial<PlanContent> = {}): PlanContent => ({
  goal: 'g', successCriteria: ['s'], nonGoals: [], approach: 'a', alignment: { statement: '', refs: [] },
  changes, acceptanceRules: [], extraChecks: [], landing: { mode: 'direct' }, roles: [], reviewGroup: 'reviewers', ...over,
})
const revisionRow = (revision: number, body: PlanContent, hash = `h${revision}`): PlanRevision => ({
  revision, status: 'approved', content: body, contentHash: hash, pin: null, author: { kind: 'human', sessionId: null }, createdAt: '',
})
const standing = (carried: Array<{ target: string; text: string; gate: 'start' | 'acceptance'; resolved: boolean }> = []): ValidationStanding =>
  ({ state: 'current', report: { readiness: { carriedConditions: carried } } }) as unknown as ValidationStanding

const plan: Plan = {
  id: 'plan-1', teamId: 'team', title: 'P', lifecycle: 'open', currentApprovedRevision: 2,
  creator: { kind: 'human', sessionId: null }, createdAt: '', updatedAt: '',
}
const execution = { id: 'exec-1', teamId: 'team', planId: 'plan-1', revision: 1, contentHash: 'h1', state: 'running', outcome: null } as ExecutionRow

/** The baseline: revision 1 runs api (landed) and ui (provisioned); revision 2 rewords ui's guidance and adds docs. */
const RUNNING = content([change('api'), change('ui')])
const TARGET = content([change('api'), change('ui', { guidance: 'say more' }), change('docs')])

/** A context over these contents; `landed` and `provisioned` feed the real delta. */
function ctxFor(running: PlanContent, target: PlanContent, over: Partial<ApplyCheckContext> = {},
  landed: string[] = ['api'], provisioned: string[] = ['api', 'ui']): ApplyCheckContext {
  const targetRow = revisionRow(2, target)
  const delta = revisionDelta(running, target, new Set(landed), new Set(provisioned))
  return {
    plan, execution, target: targetRow, running, delta,
    request: { executionId: 'exec-1', expectedRevision: 1, revision: 2, contentHash: 'h2', choices: Object.fromEntries(neededChoices(delta).map(name => [name, 'continue'])), rationale: 'why' },
    validation: standing(),
    impactGate: { state: 'current', pass: true, reviewId: null, decisionId: null, pin: null },
    liveMerges: [], claimedChanges: [], baseDiffs: [],
    roles: [{ change: 'ui', group: 'middle-devs', groupKnown: true, worktreeScoped: true, sharedProfiles: ['glm'] }],
    ...over,
  }
}
const ready = (over: Partial<ApplyCheckContext> = {}) => ctxFor(RUNNING, TARGET, over)
const failing = (ctx: ApplyCheckContext) => evaluateApplyPreconditions(ctx).map(failure => failure.name)
const messageOf = (ctx: ApplyCheckContext, name: string) => evaluateApplyPreconditions(ctx).find(failure => failure.name === name)?.message ?? null

describe('APPLY_PRECONDITIONS: the list', () => {
  test('the entries are the specified ones, in order', () => {
    expect(APPLY_PRECONDITIONS.map(entry => entry.name)).toEqual([
      'plan-open', 'execution-running', 'execution-revision-unchanged', 'revision-current', 'revision-newer',
      'validation-current', 'start-conditions-resolved', 'strategy-impact', 'landing-unchanged', 'landed-unchanged',
      'merge-quiet', 'choices-complete', 'changes-unclaimed', 'changes-on-base', 'roles-routable',
    ])
  })

  test('changes-on-base compares the added changes and the changed ones chosen adapt or restart', () => {
    const running = content([change('a'), change('b'), change('c'), change('d')])
    const target = content([change('a', { guidance: '1' }), change('b', { guidance: '2' }), change('c', { guidance: '3' }), change('d'), change('e')])
    const delta = revisionDelta(running, target, new Set(), new Set(['a', 'b', 'c']))
    expect(baseComparedChanges(delta, { a: 'continue', b: 'adapt', c: 'restart' })).toEqual(['e', 'b', 'c'])
  })
})

describe('APPLY_PRECONDITIONS: the AP table', () => {
  test('AP1 plan-open: the plan is closed', () => {
    const ctx = ready({ plan: { ...plan, lifecycle: 'completed' } })
    expect(failing(ctx)).toEqual(['plan-open'])
    expect(messageOf(ctx, 'plan-open')).toContain('completed')
  })

  test('AP2 execution-running: the execution stopped or completed', () => {
    expect(failing(ready({ execution: { ...execution, state: 'finished', outcome: 'stopped' } }))).toEqual(['execution-running'])
    expect(failing(ready({ execution: { ...execution, state: 'finished', outcome: 'completed' } }))).toEqual(['execution-running'])
  })

  test('AP3 execution-revision-unchanged: expectedRevision is not the execution\'s current revision', () => {
    const base = ready()
    const ctx = { ...base, request: { ...base.request, expectedRevision: 0 } }
    expect(failing(ctx)).toEqual(['execution-revision-unchanged'])
    expect(messageOf(ctx, 'execution-revision-unchanged')).toContain('now runs revision 1')
  })

  test('AP4 revision-current: the revision or content hash is not the plan\'s current approved revision', () => {
    const base = ready()
    expect(failing({ ...base, request: { ...base.request, contentHash: 'other' } })).toEqual(['revision-current'])
    expect(failing(ready({ plan: { ...plan, currentApprovedRevision: 3 } }))).toEqual(['revision-current'])
    expect(messageOf(ready({ target: null, delta: null }), 'revision-current')).toContain('does not exist')
  })

  test('AP5 revision-newer: the revision is not greater than the execution\'s', () => {
    const same = ctxFor(RUNNING, RUNNING, { plan: { ...plan, currentApprovedRevision: 1 } })
    const ctx = { ...same, target: revisionRow(1, RUNNING), request: { ...same.request, revision: 1, contentHash: 'h1' } }
    expect(failing(ctx)).toEqual(['revision-newer'])
  })

  // @covers: plan-revision-apply › Apply evaluates named preconditions › The target revision lacks standing
  test('AP6 validation-current: the target\'s report is out of date, with V5\'s message', () => {
    const stale = { state: 'stale', report: { seq: 3, readiness: { carriedConditions: [] } }, changedParts: ['content'] } as unknown as ValidationStanding
    const ctx = ready({ validation: stale })
    expect(failing(ctx)).toEqual(['validation-current'])
    expect(messageOf(ctx, 'validation-current')).toBe('inputs changed since report 3: content')
  })

  test('AP7 start-conditions-resolved: the target report carries an unresolved start condition', () => {
    const ctx = ready({ validation: standing([{ target: 'a#0', text: 'Confirm the order', gate: 'start', resolved: false }]) })
    expect(failing(ctx)).toEqual(['start-conditions-resolved'])
  })

  test('AP8 strategy-impact: the impact gate refuses the target', () => {
    expect(failing(ready({ impactGate: { state: 'adapt', pass: false, reviewId: 'r', decisionId: null, pin: null } }))).toEqual(['strategy-impact'])
  })

  test('AP9 landing-unchanged: the landing mode or integration branch differs, naming both landings and a forward fix', () => {
    const ctx = ctxFor(RUNNING, { ...TARGET, landing: { mode: 'integration-branch', branch: 'int/next' } })
    expect(failing(ctx)).toEqual(['landing-unchanged'])
    const message = messageOf(ctx, 'landing-unchanged')!
    expect(message).toContain('direct')
    expect(message).toContain('integration branch int/next')
    expect(message).toContain('corrects it forward')
  })

  // @covers: plan-revision-apply › Landed work is never redefined › A landed change was edited
  test('AP10 landed-unchanged: a landed change\'s acceptance differs, naming it and suggesting a forward fix', () => {
    const ctx = ctxFor(RUNNING, content([change('api', { acceptance: ['api works harder'] }), change('ui', { guidance: 'say more' }), change('docs')]))
    expect(failing(ctx)).toEqual(['landed-unchanged'])
    const message = messageOf(ctx, 'landed-unchanged')!
    expect(message).toContain('api')
    expect(message).toContain('add a change that corrects it')
  })

  test('AP11 merge-quiet: a changed or removed change has a merge or fast-forward running', () => {
    const ctx = ready({ liveMerges: ['ui'] })
    expect(failing(ctx)).toEqual(['merge-quiet'])
    expect(messageOf(ctx, 'merge-quiet')).toContain('ui')
  })

  // @covers: plan-revision-apply › Kawai classifies every change against the running revision › A missing choice is refused
  test('AP12 choices-complete: a missing choice or an empty Adapt text fails naming the change; an omitted text passes', () => {
    const base = ready()
    const missing = { ...base, request: { ...base.request, choices: {} } }
    expect(failing(missing)).toEqual(['choices-complete'])
    expect(messageOf(missing, 'choices-complete')).toContain('ui needs a choice')
    const empty = { ...base, request: { ...base.request, choices: { ui: 'adapt' }, adaptations: { ui: '  ' } } }
    expect(failing(empty)).toEqual(['choices-complete'])
    expect(messageOf(empty, 'choices-complete')).toContain('ui\'s Adapt text is empty')
    const omitted = { ...base, request: { ...base.request, choices: { ui: 'adapt' } } }
    expect(failing(omitted)).toEqual([])
    const unknown = { ...base, request: { ...base.request, choices: { ui: 'merge' } } }
    expect(messageOf(unknown, 'choices-complete')).toContain('"merge"')
    const extra = { ...base, request: { ...base.request, choices: { ui: 'continue', docs: 'continue' } } }
    expect(messageOf(extra, 'choices-complete')).toContain('docs takes no choice')
    const stray = { ...base, request: { ...base.request, choices: { ui: 'continue' }, adaptations: { ui: 'text' } } }
    expect(messageOf(stray, 'choices-complete')).toContain('not chosen adapt')
  })

  test('AP13 changes-unclaimed: an added change is owned by another running execution', () => {
    const ctx = ready({ claimedChanges: [{ change: 'docs', executionId: 'exec-9' }] })
    expect(failing(ctx)).toEqual(['changes-unclaimed'])
    expect(messageOf(ctx, 'changes-unclaimed')).toContain('docs (exec-9)')
  })

  test('AP14 changes-on-base: an added, adapted, or restarted change\'s artifacts are not on the base', () => {
    const ctx = ready({ baseDiffs: [{ change: 'docs', files: ['openspec/changes/docs/proposal.md'] }] })
    expect(failing(ctx)).toEqual(['changes-on-base'])
    expect(messageOf(ctx, 'changes-on-base')).toContain('docs: openspec/changes/docs/proposal.md')
  })

  test('AP15 roles-routable: an unlanded change\'s group under the target\'s roles has no routable worker', () => {
    const ctx = ready({ roles: [{ change: 'ui', group: 'middle-devs', groupKnown: true, worktreeScoped: true, sharedProfiles: [] }] })
    expect(failing(ctx)).toEqual(['roles-routable'])
    expect(messageOf(ctx, 'roles-routable')).toContain('ui\'s group "middle-devs" shares no profile')
  })

  test('AP16 several entries: refused naming every failing entry in list order', () => {
    const base = ctxFor(RUNNING, { ...TARGET, landing: { mode: 'integration-branch', branch: 'int' } }, {
      plan: { ...plan, lifecycle: 'cancelled' }, liveMerges: ['ui'],
      roles: [{ change: 'ui', group: 'gone', groupKnown: false, worktreeScoped: true, sharedProfiles: [] }],
    })
    const ctx = { ...base, request: { ...base.request, choices: {} } }
    expect(failing(ctx)).toEqual(['plan-open', 'landing-unchanged', 'merge-quiet', 'choices-complete', 'roles-routable'])
  })

  test('AP17 none: accepted', () => {
    expect(failing(ready())).toEqual([])
  })
})

/** The DL rows: the real delta, then the real list over it. */
function classify(running: PlanContent, target: PlanContent, landed: string[], provisioned: string[]) {
  const ctx = ctxFor(running, target, {}, landed, provisioned)
  return { delta: ctx.delta!, byName: Object.fromEntries(ctx.delta!.changes.map(entry => [entry.change, entry])), refused: failing(ctx), findings: ctx.delta!.findings.map(finding => finding.kind) }
}

describe('APPLY_PRECONDITIONS: the DL table, through revisionDelta', () => {
  test('DL1 only in the target: added', () => {
    const out = classify(content([change('a')]), content([change('a'), change('b')]), [], [])
    expect(out.byName.b).toEqual({ change: 'b', class: 'added', fields: [], choice: null })
    expect(out.refused).toEqual([])
  })

  test('DL2 only in the running revision, unlanded: removed', () => {
    const out = classify(content([change('a'), change('b')]), content([change('a')]), [], ['b'])
    expect(out.byName.b).toEqual({ change: 'b', class: 'removed', fields: [], choice: null })
    expect(out.findings).toEqual([])
    expect(out.refused).toEqual([])
  })

  test('DL3 only in the running revision, landed: removed, with finding landed-changed naming it (refusal)', () => {
    const out = classify(content([change('a'), change('b')]), content([change('a')]), ['b'], [])
    expect(out.byName.b.class).toBe('removed')
    expect(out.delta.findings.find(finding => finding.kind === 'landed-changed')?.changes).toEqual(['b'])
    expect(out.refused).toEqual(['landed-unchanged'])
  })

  test('DL4 in both, unlanded, a compared field differs, has a task: changed, needs a choice', () => {
    const out = classify(content([change('a')]), content([change('a', { extraChecks: [BENCH] })]), [], ['a'])
    expect(out.byName.a).toEqual({ change: 'a', class: 'changed', fields: ['extraChecks'], choice: 'needed' })
  })

  test('DL5 as DL4 but still waiting with no task: changed, choice none', () => {
    const out = classify(content([change('a')]), content([change('a', { extraChecks: [BENCH] })]), [], [])
    expect(out.byName.a).toEqual({ change: 'a', class: 'changed', fields: ['extraChecks'], choice: 'none' })
    expect(out.refused).toEqual([])
  })

  test('DL6 landed, differs only in dependsOn or fixes: metadata, no choice', () => {
    const out = classify(content([change('a'), change('b')]), content([change('a', { fixes: ['task-1'] }), change('b', { dependsOn: ['a'] })]), ['a', 'b'], ['a', 'b'])
    expect(out.byName.a).toEqual({ change: 'a', class: 'metadata', fields: ['fixes'], choice: null })
    expect(out.byName.b).toEqual({ change: 'b', class: 'metadata', fields: ['dependsOn'], choice: null })
    expect(out.refused).toEqual([])
  })

  test('DL7 landed, differs in any other compared field: changed, with finding landed-changed naming it (refusal)', () => {
    const out = classify(content([change('a')]), content([change('a', { guidance: 'more', fixes: ['task-1'] })]), ['a'], ['a'])
    expect(out.byName.a).toMatchObject({ class: 'changed', fields: ['fixes', 'guidance'] })
    expect(out.delta.findings.find(finding => finding.kind === 'landed-changed')?.changes).toEqual(['a'])
    expect(out.refused).toEqual(['landed-unchanged'])
  })

  test('DL8 landing mode or integration branch differs: finding landing-changed', () => {
    const intA = { landing: { mode: 'integration-branch' as const, branch: 'int/a' } }
    const out = classify(content([change('a')], intA), content([change('a')], { landing: { mode: 'integration-branch', branch: 'int/b' } }), [], [])
    expect(out.findings).toEqual(['landing-changed'])
    expect(out.refused).toEqual(['landing-unchanged'])
  })

  test('DL9 plan-wide rules or extra checks differ, something landed: finding plan-rules-changed', () => {
    const out = classify(content([change('a'), change('b')]), content([change('a'), change('b')], { extraChecks: [BENCH] }), ['a'], [])
    expect(out.findings).toEqual(['plan-rules-changed'])
    expect(out.refused).toEqual(['landed-unchanged'])
  })

  test('DL10 plan-wide rules differ, nothing landed: every unlanded change changed, fields planAcceptanceRules / planExtraChecks', () => {
    const out = classify(content([change('a'), change('b')]), content([change('a'), change('b')], { acceptanceRules: ['r'], extraChecks: [BENCH] }), [], ['a'])
    expect(out.byName.a).toEqual({ change: 'a', class: 'changed', fields: ['planAcceptanceRules', 'planExtraChecks'], choice: 'needed' })
    expect(out.byName.b).toEqual({ change: 'b', class: 'changed', fields: ['planAcceptanceRules', 'planExtraChecks'], choice: 'none' })
    expect(out.findings).toEqual([])
  })

  test('DL11 a role\'s profiles differ: unlanded changes of that implementing or effective review group changed with roles, never landed-changed', () => {
    const roles = (profiles: string[]) => ({ roles: [{ group: 'middle-devs', profiles }, { group: 'reviewers', profiles: ['x'] }] })
    const out = classify(
      content([change('a'), change('b'), change('c', { group: 'senior-devs' })], roles(['glm'])),
      content([change('a'), change('b'), change('c', { group: 'senior-devs' })], roles(['codex'])),
      ['a'], ['b'])
    expect(out.byName.a.class).toBe('unchanged')
    expect(out.byName.b).toEqual({ change: 'b', class: 'changed', fields: ['roles'], choice: 'needed' })
    expect(out.byName.c.class).toBe('unchanged')
    expect(out.findings).toEqual([])
    const review = classify(content([change('a')], { roles: [{ group: 'reviewers', profiles: ['x'] }] }), content([change('a')], { roles: [{ group: 'reviewers', profiles: ['y'] }] }), [], [])
    expect(review.byName.a).toMatchObject({ class: 'changed', fields: ['roles'] })
  })

  test('DL12 only leadGroup differs: every change unchanged, informational lead-changed', () => {
    const out = classify(content([change('a'), change('b')], { leadGroup: 'lead' }), content([change('a'), change('b')], { leadGroup: 'change-leads' }), ['a'], ['b'])
    expect(out.delta.changes.map(entry => entry.class)).toEqual(['unchanged', 'unchanged'])
    expect(out.findings).toEqual(['lead-changed'])
    expect(out.refused).toEqual([])
  })

  test('DL13 identical: unchanged', () => {
    const out = classify(content([change('a')]), content([change('a')]), ['a'], ['a'])
    expect(out.byName.a).toEqual({ change: 'a', class: 'unchanged', fields: [], choice: null })
    expect(out.findings).toEqual([])
  })
})
