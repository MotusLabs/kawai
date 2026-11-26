// Property P3, landed work stays (plan-revision-apply design "Properties",
// invariant I3): no accepted Apply changes a landed change other than its
// `dependsOn` and `fixes`, removes it, or changes the plan-wide rules after a
// landing. Generator: random plans of two to five changes with a random
// landed set, edited at random — per change a guidance, acceptance, group,
// dependsOn, or fixes edit, or a removal; an added change; a plan-wide
// acceptance-rule or extra-check edit. Seam: the real `revisionDelta` and
// the real precondition list over a context that passes every other entry
// (choices complete, roles routable), so acceptance is decided by the delta.
// Seed 0x4A9A, 500 declared cases through `propertyCases`; the run must see
// both accepted and refused edits.
import { describe, expect, test } from 'bun:test'
import type { Plan, PlanChange, PlanContent, PlanRevision } from '../../shared/plans'
import type { ValidationStanding } from '../plans/validation/validationStanding'
import type { ExecutionRow } from '../plans/execution/executionRows'
import { revisionDelta } from '../plans/revisionControl/revisionDelta'
import { evaluateApplyPreconditions, neededChoices, type ApplyCheckContext } from '../plans/revisionControl/applyPreconditions'
import { propertyCases } from './helpers/propertyCases'

const SEED = 0x4A9A
const CASES = 500

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NAMES = ['api', 'ui', 'docs', 'cli', 'db']
const change = (name: string): PlanChange => ({ change: name, dependsOn: [], group: 'middle-devs', reviewGroup: null, acceptance: [`${name} works`], extraChecks: [], guidance: '' })
const content = (changes: PlanChange[]): PlanContent => ({
  goal: 'g', successCriteria: ['s'], nonGoals: [], approach: 'a', alignment: { statement: '', refs: [] },
  changes, acceptanceRules: ['rule'], extraChecks: [], landing: { mode: 'direct' }, roles: [], reviewGroup: 'reviewers',
})
const plan: Plan = { id: 'plan-1', teamId: 'team', title: 'P', lifecycle: 'open', currentApprovedRevision: 2, creator: { kind: 'human', sessionId: null }, createdAt: '', updatedAt: '' }
const execution = { id: 'exec-1', teamId: 'team', planId: 'plan-1', revision: 1, contentHash: 'h1', state: 'running', outcome: null } as ExecutionRow
const standing = { state: 'current', report: { readiness: { carriedConditions: [] } } } as unknown as ValidationStanding

/** One case: a running content, a landed set, and a random edit of it. */
function generate(next: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const size = 2 + Math.floor(next() * 4)
  const running = content(NAMES.slice(0, size).map(change))
  const landed = running.changes.filter(() => next() < 0.4).map(entry => entry.change)
  let changes: PlanChange[] = []
  for (const entry of running.changes) {
    const roll = next()
    if (roll < 0.1) continue // removed
    const edited = structuredClone(entry)
    if (roll < 0.6) {
      const field = pick(['guidance', 'acceptance', 'group', 'dependsOn', 'fixes'] as const)
      if (field === 'guidance') edited.guidance = 'reworded'
      if (field === 'acceptance') edited.acceptance = [...edited.acceptance, 'and more']
      if (field === 'group') edited.group = 'senior-devs'
      if (field === 'dependsOn') edited.dependsOn = running.changes.filter(other => other.change !== entry.change && next() < 0.5).map(other => other.change)
      if (field === 'fixes') edited.fixes = ['task-fix']
    }
    changes.push(edited)
  }
  if (next() < 0.3) changes = [...changes, change('extra')]
  const target = content(changes)
  if (next() < 0.15) target.acceptanceRules = ['rule', 'another rule']
  if (next() < 0.1) target.extraChecks = [{ name: 'bench', description: 'Runs the benchmark', command: null }]
  return { running, target, landed }
}

function accepted(running: PlanContent, target: PlanContent, landed: string[]): boolean {
  const provisioned = new Set(running.changes.map(entry => entry.change))
  const delta = revisionDelta(running, target, new Set(landed), provisioned)
  const targetRow: PlanRevision = { revision: 2, status: 'approved', content: target, contentHash: 'h2', pin: null, author: { kind: 'human', sessionId: null }, createdAt: '' }
  const ctx: ApplyCheckContext = {
    plan, execution, target: targetRow, running, delta,
    request: { executionId: 'exec-1', expectedRevision: 1, revision: 2, contentHash: 'h2', choices: Object.fromEntries(neededChoices(delta).map(name => [name, 'continue'])), rationale: 'why' },
    validation: standing,
    impactGate: { state: 'current', pass: true, reviewId: null, decisionId: null, pin: null },
    liveMerges: [], claimedChanges: [], baseDiffs: [],
    roles: target.changes.filter(entry => !landed.includes(entry.change))
      .map(entry => ({ change: entry.change, group: entry.group!, groupKnown: true, worktreeScoped: true, sharedProfiles: ['glm'] })),
  }
  return evaluateApplyPreconditions(ctx).length === 0
}

/** What I3 forbids an accepted Apply: a landed change removed or redefined beyond dependsOn/fixes, or plan-wide rules changed after a landing. */
function violation(running: PlanContent, target: PlanContent, landed: string[]): string | null {
  for (const name of landed) {
    const before = running.changes.find(entry => entry.change === name)!
    const after = target.changes.find(entry => entry.change === name)
    if (after === undefined) return `${name} removed`
    const strip = (entry: PlanChange) => ({ ...entry, dependsOn: [], fixes: undefined })
    if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after))) return `${name} redefined`
  }
  if (landed.length > 0 && (JSON.stringify(running.acceptanceRules) !== JSON.stringify(target.acceptanceRules) || JSON.stringify(running.extraChecks) !== JSON.stringify(target.extraChecks))) {
    return 'plan-wide rules changed after a landing'
  }
  return null
}

describe('Apply properties: landed work stays (P3)', () => {
  test('P3 no accepted Apply redefines or removes a landed change, or changes plan-wide rules after a landing (seed 0x4A9A, 500 cases)', () => {
    const next = mulberry32(SEED)
    let accepts = 0
    let refusals = 0
    for (let index = 0; index < propertyCases(CASES); index++) {
      const { running, target, landed } = generate(next)
      if (!accepted(running, target, landed)) {
        refusals += 1
        continue
      }
      accepts += 1
      expect({ index, violation: violation(running, target, landed) }).toEqual({ index, violation: null })
    }
    // Non-vacuous: the generator reaches both outcomes.
    expect(accepts).toBeGreaterThan(0)
    expect(refusals).toBeGreaterThan(0)
  })
})
