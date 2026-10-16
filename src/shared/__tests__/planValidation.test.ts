// plan-validation design D2, D4, and D7: the input identity, typed relations,
// and readiness as pure functions.
import { describe, expect, test } from 'bun:test'
import {
  conflictKey,
  deriveRelations,
  findingKey,
  findingWarningKey,
  overlapKey,
  relationFindings,
  validationInputsHashInput,
  validationReadiness,
  VALIDATION_CHECKS_VERSION,
  type AlignmentAssessment,
  type AssessmentRow,
  type DecisionRecord,
  type Finding,
  type SpecTouch,
  type ValidationInputs,
} from '../planValidation'

const PIN = { strategyId: 'strategy-1', revision: 2, hash: 'abc' }

const touch = (capability: string, requirement: string, operation = 'MODIFIED'): SpecTouch => ({ capability, requirement, operation })

const finding = (key: string, severity: Finding['severity'], row: Finding['row'] = 'scope'): Finding => ({
  check: key.split(':')[0]!, key, severity, row, subject: key, message: `${key} ${severity}`,
})

const alignment = (id: string, createdAt: string, payload: Partial<AlignmentAssessment> = {}): AssessmentRow => ({
  id, revision: 1, kind: 'alignment', createdAt, author: { kind: 'agent', sessionId: 'chat-1' },
  payload: {
    assessment: 'aligned', outcomes: [], conditions: [], experiment: null, conflicts: [], rationale: 'r',
    ...payload,
  },
})

const question = (id: string, mandatory: boolean): AssessmentRow => ({
  id, revision: 1, kind: 'question', createdAt: '2026-01-01T00:00:00Z', author: { kind: 'agent', sessionId: 'chat-1' },
  payload: { text: 'q', mandatory, subject: null },
})

const warning = (id: string): AssessmentRow => ({
  id, revision: 1, kind: 'finding', createdAt: '2026-01-01T00:00:00Z', author: { kind: 'agent', sessionId: 'chat-1' },
  payload: { text: 'w', subject: null },
})

const decision = (kind: DecisionRecord['kind'], target: string): DecisionRecord => ({
  id: `d-${kind}-${target}`, kind, target, text: 'ok', scope: null, createdAt: '2026-01-02T00:00:00Z',
})

const baseInputs = (): ValidationInputs => ({
  checksVersion: VALIDATION_CHECKS_VERSION,
  plan: { planId: 'plan-1', revision: 3, contentHash: 'hash-3' },
  impactStateKey: 'impact-key',
  adapter: { tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'] },
  changes: [
    { change: 'alpha', status: 'registered', artifacts: { 'proposal.md': 'a1' }, baseSpecs: { chat: 'b1' }, config: 'c1' },
    { change: 'beta', status: 'registered', artifacts: { 'proposal.md': 'a2' }, baseSpecs: { chat: 'b1' }, config: 'c1' },
  ],
  catalog: { groups: { 'middle-devs': 'g1' }, profiles: 'p1' },
  claims: { branch: ['plan-9'], changes: { beta: ['plan-8'] } },
  records: { assessments: ['pas-2', 'pas-1'], decisions: ['pvd-1'] },
})

describe('validationInputsHashInput (D2)', () => {
  test('is stable under object key order', () => {
    const inputs = baseInputs()
    const reordered = {
      records: inputs.records,
      claims: inputs.claims,
      catalog: inputs.catalog,
      changes: inputs.changes,
      adapter: inputs.adapter,
      impactStateKey: inputs.impactStateKey,
      plan: inputs.plan,
      checksVersion: inputs.checksVersion,
    } satisfies ValidationInputs
    expect(validationInputsHashInput(reordered)).toBe(validationInputsHashInput(inputs))
  })

  test('is stable under the order of every sorted array', () => {
    const inputs = baseInputs()
    const shuffled: ValidationInputs = {
      ...inputs,
      adapter: { ...inputs.adapter, capabilities: [...inputs.adapter.capabilities].reverse() },
      claims: {
        branch: [...inputs.claims.branch].reverse(),
        changes: { beta: [...inputs.claims.changes.beta!] },
      },
      records: { assessments: [...inputs.records.assessments].reverse(), decisions: inputs.records.decisions },
    }
    expect(validationInputsHashInput(shuffled)).toBe(validationInputsHashInput(inputs))
  })

  test('keeps plan order for changes', () => {
    const inputs = baseInputs()
    const reordered: ValidationInputs = { ...inputs, changes: [...inputs.changes].reverse() }
    expect(validationInputsHashInput(reordered)).not.toBe(validationInputsHashInput(inputs))
  })

  test.each([
    ['checksVersion', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, checksVersion: inputs.checksVersion + 1 })],
    ['plan revision', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, plan: { ...inputs.plan, revision: 4 } })],
    ['plan content hash', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, plan: { ...inputs.plan, contentHash: 'other' } })],
    ['impact state key', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, impactStateKey: 'other' })],
    ['adapter version', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, adapter: { ...inputs.adapter, version: '1.15.0' } })],
    ['adapter capabilities', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, adapter: { ...inputs.adapter, capabilities: ['validate-strict-json'] } })],
    ['a change status', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, changes: [{ ...inputs.changes[0]!, status: 'missing' }, inputs.changes[1]!] })],
    ['a change artifacts', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, changes: [{ ...inputs.changes[0]!, artifacts: { 'proposal.md': 'edited' } }, inputs.changes[1]!] })],
    ['a base spec', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, changes: [{ ...inputs.changes[0]!, baseSpecs: { chat: 'edited' } }, inputs.changes[1]!] })],
    ['a config', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, changes: [{ ...inputs.changes[0]!, config: 'edited' }, inputs.changes[1]!] })],
    ['a group', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, catalog: { ...inputs.catalog, groups: { 'middle-devs': 'g2' } } })],
    ['an unknown group digest', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, catalog: { ...inputs.catalog, groups: { 'middle-devs': null } } })],
    ['profiles', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, catalog: { ...inputs.catalog, profiles: 'p2' } })],
    ['branch claims', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, claims: { ...inputs.claims, branch: ['plan-7'] } })],
    ['change claims', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, claims: { ...inputs.claims, changes: { beta: ['plan-7'] } } })],
    ['assessment records', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, records: { ...inputs.records, assessments: [...inputs.records.assessments, 'pas-3'] } })],
    ['decision records', (inputs: ValidationInputs): ValidationInputs => ({ ...inputs, records: { ...inputs.records, decisions: [...inputs.records.decisions, 'pvd-2'] } })],
  ])('changes with %s', (_name, mutate) => {
    const inputs = baseInputs()
    expect(validationInputsHashInput(mutate(inputs))).not.toBe(validationInputsHashInput(inputs))
  })

  test('never contains location or baseline evidence', () => {
    const canonical = validationInputsHashInput(baseInputs())
    expect(canonical).not.toContain('/home/')
    expect(canonical).not.toContain('HEAD')
    expect(canonical).not.toContain('worktree')
  })
})

describe('deriveRelations (D4)', () => {
  test('a conflict on one requirement, unordered, is an error', () => {
    const relations = deriveRelations(
      ['alpha', 'beta'],
      { alpha: [touch('chat', 'Presence')], beta: [touch('chat', 'Presence')] },
      {},
    )
    expect(relations).toEqual([{ kind: 'conflict', changes: ['alpha', 'beta'], capability: 'chat', requirements: ['Presence'], order: null }])
    const findings = relationFindings(relations)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.key).toBe(conflictKey(['alpha', 'beta'], 'chat', 'Presence'))
    expect(findings[0]!.key).toBe('relations:conflict:alpha+beta:chat/Presence')
  })

  test('the same pair ordered directly and transitively is serialized with its order', () => {
    const deltas = { alpha: [touch('chat', 'Presence')], beta: [touch('chat', 'Presence')], gamma: [touch('chat', 'Presence')] }
    const direct = deriveRelations(['alpha', 'beta'], deltas, { beta: ['alpha'] })
    expect(direct).toEqual([{ kind: 'serialized', changes: ['alpha', 'beta'], capability: 'chat', requirements: ['Presence'], order: ['alpha', 'beta'] }])
    const transitive = deriveRelations(['alpha', 'beta', 'gamma'], deltas, { gamma: ['beta'], beta: ['alpha'] })
    const pair = transitive.filter(relation => relation.changes.join() === 'alpha,beta')
    expect(pair).toEqual([{ kind: 'serialized', changes: ['alpha', 'beta'], capability: 'chat', requirements: ['Presence'], order: ['alpha', 'beta'] }])
    expect(relationFindings(transitive).every(finding => finding.severity !== 'error')).toBe(true)
  })

  test('an overlap on one capability with different requirements is a warning', () => {
    const relations = deriveRelations(
      ['alpha', 'beta'],
      { alpha: [touch('chat', 'A')], beta: [touch('chat', 'B')] },
      {},
    )
    expect(relations).toEqual([{ kind: 'overlap', changes: ['alpha', 'beta'], capability: 'chat', requirements: [], order: null }])
    const findings = relationFindings(relations)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.key).toBe(overlapKey(['alpha', 'beta'], 'chat'))
    expect(findings[0]!.key).toBe('relations:overlap:alpha+beta:chat')
  })

  test('several unordered overlaps on one capability raise one warning listing the pairs', () => {
    const relations = deriveRelations(
      ['a', 'b', 'c'],
      { a: [touch('chat', 'A')], b: [touch('chat', 'B')], c: [touch('chat', 'C')] },
      {},
    )
    expect(relations).toHaveLength(3)
    expect(relations.every(relation => relation.kind === 'overlap')).toBe(true)
    const findings = relationFindings(relations)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.key).toBe('relations:overlap:a+b+c:chat')
    expect(findings[0]!.detail).toEqual({ changes: ['a', 'b', 'c'], pairs: [['a', 'b'], ['a', 'c'], ['b', 'c']] })
  })

  test('a grown or shrunk overlap set is a new key', () => {
    const two = relationFindings(deriveRelations(['a', 'b'], { a: [touch('chat', 'A')], b: [touch('chat', 'B')] }, {}))
    const three = relationFindings(deriveRelations(
      ['a', 'b', 'c'],
      { a: [touch('chat', 'A')], b: [touch('chat', 'B')], c: [touch('chat', 'C')] },
      {},
    ))
    expect(two[0]!.key).toBe('relations:overlap:a+b:chat')
    expect(three[0]!.key).toBe('relations:overlap:a+b+c:chat')
    expect(two[0]!.key).not.toBe(three[0]!.key)
  })

  test('an ordered change is not in the unordered overlap set', () => {
    const relations = deriveRelations(
      ['a', 'b', 'c'],
      { a: [touch('chat', 'A')], b: [touch('chat', 'B')], c: [touch('chat', 'C')] },
      { b: ['a'], c: ['a'] },
    )
    const findings = relationFindings(relations)
    expect(findings.filter(finding => finding.severity === 'warning')).toHaveLength(1)
    expect(findings.find(finding => finding.severity === 'warning')!.key).toBe('relations:overlap:b+c:chat')
  })

  test('a rename, given as its two touches, conflicts with a change touching either name', () => {
    const rename = [touch('chat', 'Presence', 'RENAMED'), touch('chat', 'Online Status', 'RENAMED')]
    const fromSide = deriveRelations(['alpha', 'beta'], { alpha: rename, beta: [touch('chat', 'Presence')] }, {})
    expect(fromSide[0]!.kind).toBe('conflict')
    expect(fromSide[0]!.requirements).toEqual(['Presence'])
    const toSide = deriveRelations(['alpha', 'beta'], { alpha: rename, beta: [touch('chat', 'Online Status')] }, {})
    expect(toSide[0]!.kind).toBe('conflict')
    expect(toSide[0]!.requirements).toEqual(['Online Status'])
  })

  test('three changes on distinct capabilities yield one relation per pair', () => {
    const relations = deriveRelations(
      ['a', 'b', 'c'],
      { a: [touch('chat', 'A')], b: [touch('chat', 'B'), touch('mail', 'M')], c: [touch('mail', 'N')] },
      {},
    )
    expect(relations.map(relation => [relation.changes.join('+'), relation.capability, relation.kind])).toEqual([
      ['a+b', 'chat', 'overlap'],
      ['b+c', 'mail', 'overlap'],
    ])
  })

  test('no shared capability means no relation', () => {
    expect(deriveRelations(['a', 'b'], { a: [touch('chat', 'A')], b: [touch('mail', 'M')] }, {})).toEqual([])
    expect(deriveRelations(['a', 'b'], {}, {})).toEqual([])
  })

  test('keys are sorted and stable', () => {
    const deltas = {
      zeta: [touch('chat', 'Z1'), touch('mail', 'M1')],
      alpha: [touch('chat', 'A1'), touch('mail', 'M2')],
      mid: [touch('chat', 'C1')],
    }
    const first = deriveRelations(['zeta', 'alpha', 'mid'], deltas, {})
    const second = deriveRelations(['mid', 'zeta', 'alpha'], deltas, {})
    expect(first.map(relation => relation.changes.join('+'))).toEqual(first.map(relation => relation.changes.join('+')).sort())
    expect(relationFindings(first).map(finding => finding.key)).toEqual(relationFindings(first).map(finding => finding.key).sort())
    expect(second).toEqual(first)
  })

  test('findings use the findingKey shape and findingWarningKey', () => {
    expect(findingKey('openspec-valid', 'alpha')).toBe('openspec-valid:alpha')
    expect(findingWarningKey('pas-9')).toBe('finding:pas-9')
    const evidence = relationFindings(deriveRelations(['a', 'b'], { a: [touch('c', 'R')], b: [touch('c', 'R')] }, { b: ['a'] }))
    expect(evidence[0]!.key).toBe('relations:serialized:a+b:c')
  })
})

describe('validationReadiness (D7)', () => {
  test('an empty pin is unassessed and passes', () => {
    const readiness = validationReadiness([finding('capacity:x', 'evidence', 'readiness')], null, [], [])
    expect(readiness.alignment).toEqual({ state: 'unassessed', reason: null, effective: null })
    expect(readiness.ready).toBe(true)
  })

  test('a conflict blocks until the owner records an exception', () => {
    const conflict = alignment('pas-c', '2026-01-01T00:00:00Z', { assessment: 'conflicting', conflicts: ['violates non-goal'] })
    const blocked = validationReadiness([], PIN, [conflict], [])
    expect(blocked.alignment.state).toBe('blocked')
    expect(blocked.alignment.reason).toBe('conflict unresolved')
    expect(blocked.ready).toBe(false)
    const excepted = validationReadiness([], PIN, [conflict], [decision('alignment-exception', 'pas-c')])
    expect(excepted.alignment.state).toBe('passes')
    expect(excepted.ready).toBe(true)
  })

  test('a later aligned assessment does not lift the conflict', () => {
    const conflict = alignment('pas-c', '2026-01-01T00:00:00Z', { assessment: 'conflicting', conflicts: ['x'] })
    const later = alignment('pas-ok', '2026-01-02T00:00:00Z')
    const readiness = validationReadiness([], PIN, [conflict, later], [])
    expect(readiness.alignment.state).toBe('blocked')
    expect(readiness.alignment.reason).toBe('conflict unresolved')
    expect(readiness.ready).toBe(false)
  })

  test('no assessment with a pin blocks as not assessed', () => {
    const readiness = validationReadiness([], PIN, [], [])
    expect(readiness.alignment).toEqual({ state: 'blocked', reason: 'not assessed', effective: null })
    expect(readiness.ready).toBe(false)
  })

  test('aligned passes', () => {
    const readiness = validationReadiness([], PIN, [alignment('pas-1', '2026-01-01T00:00:00Z')], [])
    expect(readiness.alignment.state).toBe('passes')
    expect(readiness.ready).toBe(true)
  })

  test('a ready-gated condition blocks until resolved; start and acceptance are carried', () => {
    const assessed = alignment('pas-1', '2026-01-01T00:00:00Z', {
      assessment: 'aligned-with-conditions',
      conditions: [
        { text: 'ship the schema first', gate: 'ready' },
        { text: 'announce before start', gate: 'start' },
        { text: 'demo at acceptance', gate: 'acceptance' },
      ],
    })
    const open = validationReadiness([], PIN, [assessed], [])
    expect(open.alignment.state).toBe('blocked')
    expect(open.alignment.reason).toBe('unresolved condition: ship the schema first')
    expect(open.carriedConditions).toEqual([
      { target: 'pas-1#1', text: 'announce before start', gate: 'start', resolved: false },
      { target: 'pas-1#2', text: 'demo at acceptance', gate: 'acceptance', resolved: false },
    ])
    const resolved = validationReadiness([], PIN, [assessed], [decision('resolve-condition', 'pas-1#0')])
    expect(resolved.alignment.state).toBe('passes')
    expect(resolved.ready).toBe(true)
    expect(resolved.carriedConditions[1]).toEqual({ target: 'pas-1#2', text: 'demo at acceptance', gate: 'acceptance', resolved: false })
  })

  test('a start-only condition can be ready and is carried unresolved', () => {
    const assessed = alignment('pas-1', '2026-01-01T00:00:00Z', {
      assessment: 'aligned-with-conditions',
      conditions: [{ text: 'announce before start', gate: 'start' }],
    })
    const readiness = validationReadiness([], PIN, [assessed], [])
    expect(readiness.alignment.state).toBe('passes')
    expect(readiness.ready).toBe(true)
    expect(readiness.carriedConditions).toEqual([{ target: 'pas-1#0', text: 'announce before start', gate: 'start', resolved: false }])
  })

  test('exploratory and insufficient-information need the owner authorization', () => {
    const exploratory = alignment('pas-e', '2026-01-01T00:00:00Z', {
      assessment: 'exploratory', experiment: { criteria: 'measure latency', scope: 'one week' },
    })
    const unauthorized = validationReadiness([], PIN, [exploratory], [])
    expect(unauthorized.alignment).toEqual({ state: 'blocked', reason: 'exploration not authorized', effective: 'pas-e' })
    const authorized = validationReadiness([], PIN, [exploratory], [decision('authorize-exploration', 'pas-e')])
    expect(authorized.alignment.state).toBe('passes')
    const insufficient = alignment('pas-i', '2026-01-01T00:00:00Z', { assessment: 'insufficient-information' })
    expect(validationReadiness([], PIN, [insufficient], []).alignment.state).toBe('blocked')
    expect(validationReadiness([], PIN, [insufficient], [decision('authorize-exploration', 'pas-i')]).alignment.state).toBe('passes')
  })

  test('mandatory questions block; optional ones never do', () => {
    const readiness = validationReadiness([], PIN, [question('pas-q1', true), question('pas-q2', false)], [])
    expect(readiness.unansweredQuestions).toEqual(['pas-q1'])
    expect(readiness.ready).toBe(false)
    const answered = validationReadiness([], PIN, [question('pas-q1', true)], [decision('answer', 'pas-q1')])
    expect(answered.unansweredQuestions).toEqual([])
  })

  test('unaccepted check warnings and finding warnings block', () => {
    const overlap = finding('relations:overlap:a+b:chat', 'warning')
    const blocked = validationReadiness([overlap], PIN, [alignment('pas-1', '2026-01-01T00:00:00Z'), warning('pas-w1')], [])
    expect(blocked.unacceptedWarnings).toEqual(['relations:overlap:a+b:chat', 'finding:pas-w1'])
    expect(blocked.ready).toBe(false)
    const accepted = validationReadiness([overlap], PIN, [alignment('pas-1', '2026-01-01T00:00:00Z'), warning('pas-w1')], [
      decision('accept-warning', 'relations:overlap:a+b:chat'),
      decision('accept-warning', 'finding:pas-w1'),
    ])
    expect(accepted.unacceptedWarnings).toEqual([])
    expect(accepted.ready).toBe(true)
  })

  test('errors block readiness', () => {
    const readiness = validationReadiness([finding('openspec-valid:alpha', 'error', 'intent')], null, [], [])
    expect(readiness.errors).toEqual(['openspec-valid:alpha'])
    expect(readiness.ready).toBe(false)
  })
})

