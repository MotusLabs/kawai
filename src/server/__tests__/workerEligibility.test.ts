// The one pure eligibility check (dispatch-worker-choice D10): every
// exclusion reason per alternative, an evaluation at a past cutoff, the same
// answer as the candidate builder, and the module's purity.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import { buildCandidates } from '../team/routing/candidates'
import {
  evaluateEligibility, memberStateCauses, type EligibilityMember, type EligibilityState, type MemberFacts,
} from '../team/routing/workerEligibility'

function group(frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile('devs', `---\n${frontmatter}\n---\nBuild.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

const member = (sessionId: string, profileId: string, over: Partial<EligibilityMember> = {}): EligibilityMember =>
  ({ sessionId, profileId, cwd: '/repo/wt', eligible: true, ...over })

const STAFFING = { teamSpawned: 0, teamCap: 5, worktreeOccupants: [], worktreePending: 0, backoffRetryAt: null }

type State = EligibilityState & { group: GroupDefinition }

function state(over: Partial<State>): State {
  return {
    group: group('profiles: { glm: 1, sonnet: 2 }\nmax: 4'), members: [], pendingSpawnProfiles: [],
    spawnAllowed: true, spawnCwd: '/repo/wt', staffing: STAFFING, ...over,
  }
}

const excludedOf = (result: ReturnType<typeof evaluateEligibility>) =>
  result.excluded.map(entry => [entry.alternative.kind === 'member' ? `member:${entry.alternative.sessionId}` : `spawn:${entry.alternative.profileId}`,
    entry.reasons.map(reason => reason.kind)])

describe('evaluateEligibility exclusion reasons', () => {
  test('a member that failed the member-state predicates carries its own causes', () => {
    const result = evaluateEligibility(state({
      members: [member('a', 'sonnet', { eligible: false, causes: [{ sessionId: 'a', kind: 'pending-card' }, { sessionId: 'a', kind: 'other-worktree', detail: '/repo/other' }] })],
    }))
    expect(result.excluded[0]).toEqual({
      alternative: { kind: 'member', sessionId: 'a', profileId: 'sonnet' },
      reasons: [{ kind: 'pending-card' }, { kind: 'other-worktree', detail: '/repo/other' }],
    })
  })

  test('an ineligible member stated without causes is still excluded with a reason', () => {
    const result = evaluateEligibility(state({ members: [member('a', 'sonnet', { eligible: false })] }))
    expect(excludedOf(result)).toEqual([['member:a', ['busy']]])
  })

  test('the role excludes members and slots as outside-role; the forward exclusion as excluded-profile', () => {
    const result = evaluateEligibility(state({
      members: [member('a', 'glm'), member('b', 'sonnet')], allowedProfiles: ['sonnet'], excludeProfile: 'sonnet',
    }))
    expect(result.candidates).toEqual([])
    expect(excludedOf(result)).toEqual([
      ['member:a', ['outside-role']], ['member:b', ['excluded-profile']],
      ['spawn:sonnet', ['excluded-profile']], ['spawn:glm', ['outside-role', 'profile-cap']],
    ])
  })

  test('a cooling excluded provider removes its other models', () => {
    const result = evaluateEligibility(state({
      group: group('profiles: [glm, glm-flash, haiku]\nmax: 5'),
      members: [member('f', 'glm-flash')], excludeProfile: 'glm', excludeProvider: 'zai',
      providerOf: id => (id.startsWith('glm') ? 'zai' : 'claude'),
    }))
    expect(result.candidates.map(candidate => candidate.id)).toEqual(['spawn:haiku'])
    expect(result.excluded.find(entry => entry.alternative.kind === 'member')!.reasons).toEqual([{ kind: 'excluded-profile', detail: 'provider zai' }])
  })

  test('caps exclude slots with their counts: profile cap, group max, team spawn cap, worktree writer, backoff', () => {
    const result = evaluateEligibility(state({
      members: [member('a', 'glm', { eligible: false }), member('b', 'sonnet', { eligible: false }), member('c', 'sonnet', { eligible: false })],
      pendingSpawnProfiles: ['sonnet'], spawnAllowed: false,
      staffing: { teamSpawned: 5, teamCap: 5, worktreeOccupants: ['w'], worktreePending: 0, backoffRetryAt: Date.parse('2026-10-21T10:00:30.000Z') },
    }))
    const glm = result.excluded.find(entry => entry.alternative.kind === 'spawn' && entry.alternative.profileId === 'glm')!
    expect(glm.reasons).toEqual([
      { kind: 'profile-cap', counts: { live: 1, cap: 1 }, detail: 'glm' },
      { kind: 'group-cap', counts: { live: 4, cap: 4 } },
      { kind: 'team-spawn-cap', counts: { live: 5, cap: 5 } },
      { kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, sessionIds: ['w'], detail: '/repo/wt' },
      { kind: 'spawn-backoff', retryAt: '2026-10-21T10:00:30.000Z' },
    ])
  })

  test('a state that disallows spawning without staffing counts still offers no slot', () => {
    const result = evaluateEligibility(state({ spawnAllowed: false, staffing: undefined }))
    expect(result.candidates).toEqual([])
    expect(excludedOf(result)).toEqual([['spawn:glm', ['spawn-not-allowed']], ['spawn:sonnet', ['spawn-not-allowed']]])
  })

  test('mail that cannot spawn (no spawn worktree) lists no slots at all', () => {
    const result = evaluateEligibility(state({ spawnCwd: null, members: [member('a', 'sonnet')] }))
    expect(result.candidates.map(candidate => candidate.id)).toEqual(['member:a'])
    expect(result.excluded).toEqual([])
  })
})

describe('evaluateEligibility at a stated time', () => {
  const at = (iso: string) => Date.parse(iso)
  const cooldowns = { glm: '2026-10-18T18:00:00.000Z' }

  test('an incident cutoff uses the cooldowns then in force and reads no current state', () => {
    // At 17:00 the cooldown was in force; the same state at 19:00 has it over.
    const before = evaluateEligibility(state({ cooldowns, now: at('2026-10-18T17:00:00.000Z') }))
    const after = evaluateEligibility(state({ cooldowns, now: at('2026-10-18T19:00:00.000Z') }))
    expect(before.cooling).toEqual({ 'spawn:glm': '2026-10-18T18:00:00.000Z' })
    expect(after.cooling).toEqual({})
    // Cooling never excludes: the candidates are the same either way.
    expect(before.candidates).toEqual(after.candidates)
  })

  test('member-state causes judge cooling at the stated time', () => {
    const facts: MemberFacts = { sessionId: 'a', idle: true, pendingRequest: false, available: true, profileId: 'glm', cooldownUntil: '2026-10-18T18:00:00.000Z', cooldownProvider: 'zai' }
    const mail = { toKind: 'session' }
    expect(memberStateCauses(facts, mail, { targetWorktree: null, now: at('2026-10-18T17:00:00.000Z'), startupFailed: false }))
      .toEqual([{ sessionId: 'a', kind: 'profile-cooling', detail: 'zai' }])
    expect(memberStateCauses(facts, mail, { targetWorktree: null, now: at('2026-10-18T19:00:00.000Z'), startupFailed: false })).toEqual([])
  })
})

describe('evaluateEligibility is the candidate builder', () => {
  test('buildCandidates returns exactly the check\'s candidates and counts', () => {
    const input = state({
      members: [member('a', 'sonnet', { idleForMs: 900 }), member('b', 'glm', { eligible: false })],
      pendingSpawnProfiles: [], allowedProfiles: ['sonnet', 'glm'],
    })
    const { candidates, group: counts } = evaluateEligibility(input)
    expect(buildCandidates(input)).toEqual({ candidates, group: counts })
    expect(candidates.map(candidate => candidate.id)).toEqual(['member:a', 'spawn:sonnet'])
  })
})

/**
 * Every module a source file reaches, in every form the compiler accepts:
 * static and side-effect imports (single- or multi-line, type-only or not),
 * `export … from`, `import x = require()`, dynamic `import()`, `require()`,
 * and `import('…')` types. A non-literal dynamic specifier reads as
 * `<dynamic>`. `value` marks a module whose values (not only types) load.
 */
function moduleReferences(source: string): Array<{ spec: string; value: boolean }> {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true)
  const out: Array<{ spec: string; value: boolean }> = []
  const literal = (node: ts.Node | undefined) => (node && ts.isStringLiteralLike(node) ? node.text : '<dynamic>')
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!bindings && ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)))
      out.push({ spec: literal(node.moduleSpecifier), value: !typeOnly })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      out.push({ spec: literal(node.moduleSpecifier), value: !node.isTypeOnly })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      out.push({ spec: literal(node.moduleReference.expression), value: !node.isTypeOnly })
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      out.push({ spec: literal(node.arguments[0]), value: true })
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      out.push({ spec: ts.isLiteralTypeNode(argument) ? literal(argument.literal) : '<dynamic>', value: false })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/** The modules a pure module may not reach: anything outside shared, and any value load. */
const impure = (source: string) => moduleReferences(source)
  .filter(entry => !entry.spec.startsWith('../../../shared/') || entry.value)
  .map(entry => entry.spec)

describe('workerEligibility purity', () => {
  test('the module imports no store, filesystem, or clock', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, '../team/routing/workerEligibility.ts'), 'utf8')
    // Only shared types: no store, database, filesystem, process, or catalog module.
    expect(moduleReferences(source).length).toBeGreaterThan(0)
    expect(impure(source)).toEqual([])
    expect(source).not.toMatch(/Date\.now|performance\.now|new Date\(\)|process\.|Bun\./)
  })

  test('the module check catches every import form (negative fixtures)', () => {
    const fixtures: Array<[string, string]> = [
      ["import { a } from '../mailboxStore'", '../mailboxStore'],
      ["import type {\n  A,\n  B,\n} from '../mailboxStore'", '../mailboxStore'],
      ["import type { A } from\n  'node:fs'", 'node:fs'],
      ["import '../sideEffect'", '../sideEffect'],
      ["import * as fs from 'node:fs'", 'node:fs'],
      ["export { a } from '../mailboxStore'", '../mailboxStore'],
      ["export {\n  type A,\n} from '../mailboxStore'", '../mailboxStore'],
      ["export * from 'node:fs'", 'node:fs'],
      ["export type * as T from '../db'", '../db'],
      ["const m = await import('node:fs')", 'node:fs'],
      ["const m = import(\n  '../db'\n)", '../db'],
      ['const m = import(name)', '<dynamic>'],
      ["const m = require('node:fs')", 'node:fs'],
      ["import fs = require('node:fs')", 'node:fs'],
      ["type T = import('../db').Db", '../db'],
      // Shared, but a value load rather than types only.
      ["import { a } from '../../../shared/routing'", '../../../shared/routing'],
      ["export { a } from '../../../shared/routing'", '../../../shared/routing'],
    ]
    for (const [source, spec] of fixtures) expect({ source, found: impure(source) }).toEqual({ source, found: [spec] })
    // The allowed forms stay allowed.
    expect(impure("import type { A } from '../../../shared/routing'\nimport { type B } from '../../../shared/team'")).toEqual([])
  })
})
