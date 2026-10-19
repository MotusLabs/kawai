// START_PRECONDITIONS (plan-execution D4, X5): one test per entry passing
// and failing, and every failing entry reported at once. The context is
// pure data, so each test overrides exactly what its entry reads.
import { describe, expect, test } from 'bun:test'
import type { Plan, PlanRevision } from '../../shared/plans'
import type { ValidationStanding } from '../plans/validation/validationStanding'
import { START_PRECONDITIONS, evaluateStartPreconditions, type StartCheckContext } from '../plans/execution/startPreconditions'
import { REGISTERED_LANDING_MODES } from '../plans/landing/landingMechanisms'

const plan: Plan = {
  id: 'plan-1', teamId: 'team', title: 'P', lifecycle: 'open', currentApprovedRevision: 2,
  creator: { kind: 'human', sessionId: null }, createdAt: '', updatedAt: '',
}
const revision: PlanRevision = {
  revision: 2, status: 'approved', content: {} as PlanRevision['content'], contentHash: 'h2',
  pin: null, author: { kind: 'human', sessionId: null }, createdAt: '',
}
const standing = (carried: Array<{ target: string; text: string; gate: 'start' | 'acceptance'; resolved: boolean }> = []): ValidationStanding =>
  ({ state: 'current', report: { readiness: { carriedConditions: carried } } }) as unknown as ValidationStanding

const ready = (): StartCheckContext => ({
  plan, revision, request: { planId: 'plan-1', revision: 2, contentHash: 'h2', commandId: 'c' },
  validation: standing(),
  impactGate: { state: 'current', pass: true, reviewId: null, decisionId: null, pin: null },
  runningExecution: null,
  claimedChanges: [],
  baseDiffs: [],
  roles: [{ change: 'api', group: 'middle-devs', groupKnown: true, worktreeScoped: true, sharedProfiles: ['glm'] }],
  probeFindings: [],
  landingMode: 'direct',
  supportedLandingModes: new Set(['direct']),
  runningPromotion: null,
  offBaseLandings: [],
  baseBranch: 'master',
})

const check = (name: string, overrides: Partial<StartCheckContext>): string | null => {
  const entry = START_PRECONDITIONS.find(precondition => precondition.name === name)!
  return entry.check({ ...ready(), ...overrides })
}
const names = (overrides: Partial<StartCheckContext>): string[] =>
  evaluateStartPreconditions({ ...ready(), ...overrides }).map(failure => failure.name)

describe('START_PRECONDITIONS', () => {
  test('a ready context passes every entry', () => {
    expect(evaluateStartPreconditions(ready())).toEqual([])
  })

  test('plan-open', () => {
    expect(check('plan-open', { plan: { ...plan, lifecycle: 'completed' } })).toContain('completed')
  })

  test('revision-current: missing, stale hash, and not the approved revision', () => {
    expect(check('revision-current', { revision: null })).toContain('does not exist')
    expect(check('revision-current', { request: { planId: 'plan-1', revision: 2, contentHash: 'other', commandId: 'c' } })).toContain('content hash')
    expect(check('revision-current', { plan: { ...plan, currentApprovedRevision: 3 } })).toContain('not the plan\'s approved revision')
  })

  test('validation-current reuses V5\'s message', () => {
    expect(check('validation-current', { validation: { state: 'not-validated' } })).toContain('run Validate')
    expect(check('validation-current', { validation: null })).toBeNull()
  })

  test('start-conditions-resolved: an unresolved start condition; an acceptance one or a resolved one passes', () => {
    const unresolved = [{ target: 'a#0', text: 'Confirm the rollout order with the owner', gate: 'start' as const, resolved: false }]
    expect(check('start-conditions-resolved', { validation: standing(unresolved) })).toContain('rollout order')
    expect(check('start-conditions-resolved', {
      validation: standing([
        { target: 'a#1', text: 'Acceptance-gated', gate: 'acceptance', resolved: false },
        { target: 'a#0', text: 'Resolved start condition', gate: 'start', resolved: true },
      ]),
    })).toBeNull()
  })

  test('strategy-impact: no strategy passes; a non-passing gate fails naming its state', () => {
    expect(check('strategy-impact', { impactGate: null })).toBeNull()
    expect(check('strategy-impact', { impactGate: { state: 'adapt', pass: false, reviewId: 'r', decisionId: null, pin: null } })).toContain('adapt')
  })

  test('one-execution: a running execution is named', () => {
    expect(check('one-execution', { runningExecution: { id: 'exec-9' } })).toContain('exec-9')
  })

  test('changes-unclaimed: every claimed change and its execution are named', () => {
    const message = check('changes-unclaimed', { claimedChanges: [{ change: 'api', executionId: 'exec-1' }, { change: 'ui', executionId: 'exec-2' }] })
    expect(message).toContain('api (exec-1)')
    expect(message).toContain('ui (exec-2)')
  })

  test('changes-on-base: each change and its differing files are named', () => {
    expect(check('changes-on-base', { baseDiffs: [{ change: 'api', files: ['design.md', 'specs/x/spec.md'] }] })).toContain('api: design.md, specs/x/spec.md')
  })

  test('roles-routable: no group, unknown group, unscoped group, and empty profile intersection', () => {
    expect(check('roles-routable', { roles: [{ change: 'api', group: null, groupKnown: false, worktreeScoped: true, sharedProfiles: [] }] })).toContain('no implementing group')
    expect(check('roles-routable', { roles: [{ change: 'api', group: 'ghosts', groupKnown: false, worktreeScoped: true, sharedProfiles: ['glm'] }] })).toContain('not defined')
    expect(check('roles-routable', { roles: [{ change: 'api', group: 'middle-devs', groupKnown: true, worktreeScoped: false, sharedProfiles: ['glm'] }] })).toContain('worktree-scoped')
    expect(check('roles-routable', { roles: [{ change: 'api', group: 'middle-devs', groupKnown: true, worktreeScoped: true, sharedProfiles: [] }] })).toContain('shares no profile')
  })

  test('landing-ready: every probe finding is named', () => {
    const message = check('landing-ready', { probeFindings: [{ code: 'floor-map', message: 'No floor map is configured.' }, { code: 'name-taken', message: 'A local branch already carries the name "api".' }] })
    expect(message).toContain('floor map')
    expect(message).toContain('api')
  })

  test('landing-mode-supported: an unregistered mode is refused; direct is shipped (14.5)', () => {
    expect(REGISTERED_LANDING_MODES).toEqual(['direct'])
    expect(check('landing-mode-supported', { landingMode: 'integration-branch' })).toContain('integration-branch')
    expect(check('landing-mode-supported', { landingMode: 'direct' })).toBeNull()
  })

  test('every failing entry is reported at once, in order', () => {
    const failures = names({
      plan: { ...plan, lifecycle: 'cancelled' },
      revision: null,
      validation: { state: 'not-validated' },
      impactGate: null,
      runningExecution: { id: 'exec-1' },
      claimedChanges: [{ change: 'api', executionId: 'exec-0' }],
      baseDiffs: [{ change: 'api', files: ['design.md'] }],
      roles: [{ change: 'api', group: null, groupKnown: false, worktreeScoped: true, sharedProfiles: [] }],
      probeFindings: [{ code: 'gh-auth', message: 'gh is not authenticated.' }],
      landingMode: 'integration-branch',
      runningPromotion: { id: 'promo-1', number: 1, branch: 'wave/int', step: 'ci' },
      offBaseLandings: [{ change: 'api', branch: 'wave/int' }],
    })
    expect(failures).toEqual([
      'plan-open', 'revision-current', 'validation-current', 'one-execution', 'changes-unclaimed',
      'changes-on-base', 'roles-routable', 'landing-ready', 'landing-mode-supported',
      'promotion-idle', 'landings-on-base',
    ])
  })

  test('promotion-idle: a running promotion is named with its number, branch, and step', () => {
    const message = check('promotion-idle', { runningPromotion: { id: 'promo-7', number: 2, branch: 'wave/int', step: 'ci' } })
    expect(message).toContain('Promotion 2 (promo-7) of wave/int is running at step ci')
    expect(check('promotion-idle', { runningPromotion: null })).toBeNull()
  })

  test('landings-on-base: each off-base landing is named with the branch it landed on; none passes', () => {
    const message = check('landings-on-base', { baseBranch: 'master', offBaseLandings: [{ change: 'api', branch: 'wave/int' }, { change: 'ui', branch: 'wave/int' }] })
    expect(message).toContain("The base master's head on origin lacks landed work: api (landed on wave/int), ui (landed on wave/int)")
    expect(message).toContain('Promote that branch first')
    expect(check('landings-on-base', { offBaseLandings: [] })).toBeNull()
  })

  test('the shipped list is append-only in order (X5): the names D4 pins', () => {
    expect(START_PRECONDITIONS.map(entry => entry.name)).toEqual([
      'plan-open', 'revision-current', 'validation-current', 'start-conditions-resolved', 'strategy-impact',
      'one-execution', 'changes-unclaimed', 'changes-on-base', 'roles-routable', 'landing-ready', 'landing-mode-supported',
      // integration-candidates D8, appended.
      'promotion-idle', 'landings-on-base',
    ])
  })
})
