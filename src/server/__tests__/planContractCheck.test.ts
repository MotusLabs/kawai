// The `implementation-contract` validation check (implementation-contract
// D5, table V1–V5): a registered change's well-formed section is evidence
// with its hash; a missing design.md or section, or a malformed one, is one
// error naming the change with every problem and its line; an unregistered
// or archived change is skipped; and the checks version is 2, so a report
// from version 1 reads Out of date naming the checks version.
import { expect, test } from 'bun:test'
import { VALIDATION_CHECKS, type ResolvedChange, type ValidationCheckContext } from '../plans/validation/validationChecks'
import { changedInputParts } from '../plans/validation/validationStanding'
import { contractHash } from '../team/contractHash'
import { normalizePlanContent } from '../../shared/plans'
import { VALIDATION_CHECKS_VERSION, type Finding } from '../../shared/planValidation'
import { parseContract } from '../../shared/implementationContract'

const SECTION = ['## Implementation contract', '### Acceptance', '- A1: Works', '### Invariants', '### Scope', '- `src/**`',
  '### Verification', '- V1: check passes', '### Excluded'].join('\n')
const DESIGN = `# Design\n\nContext.\n\n${SECTION}\n`
const resolvedAs = (change: string, status: ResolvedChange['status']): ResolvedChange =>
  ({ change, status, dir: `/repo/openspec/changes/${change}`, root: '/repo', head: 'aaaa' })

const run = (designs: Record<string, string | null>, resolved: Record<string, ResolvedChange['status']> = {}): Finding[] => {
  const changes = Object.keys(designs)
  const ctx = {
    content: normalizePlanContent({ goal: 'g', changes: changes.map(change => ({ change })) }),
    resolved: Object.fromEntries(changes.map(change => [change, resolvedAs(change, resolved[change] ?? 'registered')])),
    designs,
  } as unknown as ValidationCheckContext
  return VALIDATION_CHECKS.find(check => check.name === 'implementation-contract')!.run(ctx)
}

// @covers: plan-validation › Every named change carries an implementation contract › Well-formed section
test('V1: a well-formed section in every change is evidence carrying each contract hash, under intent', () => {
  const findings = run({ alpha: DESIGN, beta: DESIGN.replace('A1: Works', 'A1: Also works') })
  expect(findings.map(finding => [finding.severity, finding.key, finding.row])).toEqual([
    ['evidence', 'implementation-contract:alpha', 'intent'], ['evidence', 'implementation-contract:beta', 'intent'],
  ])
  expect(findings[0]!.detail).toEqual({ hash: contractHash(parseContract(DESIGN).contract!) })
  expect(findings[0]!.detail).not.toEqual(findings[1]!.detail)
})

// @covers: plan-validation › Every named change carries an implementation contract › Missing section
test('V2: a design.md without the section, or no design.md, is an error naming the change', () => {
  const findings = run({ alpha: '# Design\n\nNo contract.\n', beta: null })
  expect(findings.map(finding => [finding.severity, finding.subject])).toEqual([['error', 'alpha'], ['error', 'beta']])
  expect(findings[0]!.message).toContain('line 1: No Implementation contract section')
  expect(findings[1]!.message).toBe('beta has no design.md, so no Implementation contract section.')
})

// @covers: plan-validation › Every named change carries an implementation contract › Malformed section
test('V3: a scope glob /etc/** and no Verification heading are one error naming the change and both problems with their lines', () => {
  const malformed = SECTION.replace('- `src/**`', '- `/etc/**`').replace('### Verification\n- V1: check passes\n', '')
  const findings = run({ alpha: malformed })
  expect(findings).toHaveLength(1)
  const [finding] = findings
  expect(finding).toMatchObject({ severity: 'error', subject: 'alpha', row: 'intent' })
  const problems = (finding!.detail as { problems: Array<{ line: number; message: string }> }).problems
  // Every problem is carried, with its line (an emptied Scope also reports itself empty, as row G12 pins).
  expect(problems).toEqual(expect.arrayContaining([
    { line: 1, message: 'Missing `### Verification` heading' },
    { line: 6, message: 'Scope glob `/etc/**` is an absolute path' },
  ]))
  for (const problem of problems) expect(finding!.message).toContain(`line ${problem.line}: ${problem.message}`)
})

// @covers: plan-validation › Every named change carries an implementation contract › Unregistered change is skipped
test('V4: an unregistered, archived, or missing change reports nothing here (change-registered blocks it)', () => {
  expect(run({ alpha: null, beta: null, gamma: null }, { alpha: 'unregistered', beta: 'archived', gamma: 'missing' })).toEqual([])
})

// @covers: plan-validation › Reports from earlier checks are out of date › Earlier report after the upgrade
test('V5: the checks version is 2, and a report from version 1 is out of date naming the checks version', () => {
  expect(VALIDATION_CHECKS_VERSION).toBe(2)
  const inputs: Parameters<typeof changedInputParts>[0] = {
    checksVersion: 1,
    plan: { planId: 'p', revision: 1, contentHash: 'h' },
    impactStateKey: 'impact-1',
    adapter: { tool: 'openspec', version: '1.14.2', capabilities: ['show-deltas-json', 'validate-strict-json'] },
    changes: [{ change: 'alpha', status: 'registered', artifacts: { 'design.md': 'd' }, baseSpecs: {}, config: 'c' }],
    catalog: { groups: {}, profiles: 'p1' },
    claims: { branch: [], changes: {} },
    records: { assessments: [], decisions: [] },
  }
  expect(changedInputParts(inputs, { ...inputs, checksVersion: VALIDATION_CHECKS_VERSION })).toEqual(['the checks version'])
})
