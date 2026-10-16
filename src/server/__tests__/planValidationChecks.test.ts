// The technical checks (plan-validation design D3): one test per outcome in
// the table — errors, warnings, and evidence — plus the rules that cut across
// checks: an unavailable adapter never yields success, unregistered changes
// are skipped by the CLI-reading checks, capacity never blocks, and claims
// ignore this plan and closed plans.
import { describe, expect, test } from 'bun:test'
import { computeClaims, runValidationChecks, VALIDATION_CHECKS, type ValidationCheckContext } from '../plans/validation/validationChecks'
import type { ResolvedChange } from '../plans/validation/validationChecks'
import type { ShowDeltasOutcome, ValidateOutcome, AdapterProbe } from '../plans/validation/openspecAdapter'
import { normalizePlanContent, type PlanContent, type PlanRevisionStatus } from '../../shared/plans'
import type { Finding } from '../../shared/planValidation'

const probe = (ok = true): AdapterProbe => ok
  ? { tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }
  : { tool: 'openspec', version: null, capabilities: [], ok: false, error: 'openspec executable not found' }

const valid = (): ValidateOutcome => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 })
const deltas = (touches: ShowDeltasOutcome['touches'] = []): ShowDeltasOutcome => ({ ok: true, error: null, touches })
const registered = (change: string): ResolvedChange => ({ change, status: 'registered', dir: `/repo/openspec/changes/${change}`, root: '/repo', head: 'aaaa' })

const gate = (state: 'current' | 'continue' | 'decision-required' | 'adapt' | 'reconsider' | 'withdrawn-direction') => ({
  state, pass: state === 'current' || state === 'continue', reviewId: null, decisionId: null, pin: null,
})

const content = (raw: Record<string, unknown>): PlanContent => normalizePlanContent(raw)

const ctx = (overrides: Partial<ValidationCheckContext> = {}): ValidationCheckContext => ({
  content: content({ goal: 'g', changes: [{ change: 'alpha', group: 'middle-devs' }, { change: 'beta' }], roles: [{ group: 'middle-devs', profiles: ['default'] }] }),
  pin: null,
  adapter: probe(),
  resolved: { alpha: registered('alpha'), beta: registered('beta') },
  cli: { alpha: { validate: valid(), deltas: deltas() }, beta: { validate: valid(), deltas: deltas() } },
  gate: gate('current'),
  claims: { branch: [], changes: {} },
  groups: new Map([['middle-devs', { profiles: ['default'] }]]),
  knownProfiles: new Set(['default', 'opus']),
  capacity: [],
  branch: null,
  ...overrides,
})

const run = (check: string, context: ValidationCheckContext): Finding[] => {
  const entry = VALIDATION_CHECKS.find(candidate => candidate.name === check)!
  return entry.run(context)
}

const names = (findings: readonly Finding[]): string[] => findings.map(finding => `${finding.severity}:${finding.key}`)

describe('adapter-available', () => {
  test('an available adapter is evidence; a missing one is an error', () => {
    expect(run('adapter-available', ctx())).toEqual([expect.objectContaining({ severity: 'evidence', key: 'adapter-available:openspec adapter', detail: { version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'] } })])
    const unavailable = run('adapter-available', ctx({ adapter: probe(false) }))
    expect(unavailable[0]!.severity).toBe('error')
    expect(unavailable[0]!.message).toContain('unavailable')
  })
})

describe('change-registered', () => {
  test('registered is evidence with the canonical location and HEAD', () => {
    const findings = run('change-registered', ctx())
    expect(names(findings)).toEqual(['evidence:change-registered:alpha', 'evidence:change-registered:beta'])
    expect(findings[0]!.detail).toEqual({ root: '/repo', head: 'aaaa' })
  })

  test.each([
    ['missing', 'missing'],
    ['archived', 'archived'],
    ['unregistered', 'worktree outside the registry'],
  ])('%s is an error naming where it was found', (status, phrase) => {
    const resolved: ResolvedChange = status === 'archived'
      ? { ...registered('alpha'), status: 'archived', dir: '/repo/openspec/changes/archive/2026-01-01-alpha' }
      : status === 'unregistered'
        ? { ...registered('alpha'), status: 'unregistered', root: '/repo/.worktrees/lone' }
        : { ...registered('alpha'), status: 'missing', dir: null, root: null }
    const findings = run('change-registered', ctx({ resolved: { alpha: resolved, beta: registered('beta') } }))
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.message).toContain(phrase)
    expect(findings[0]!.message).toContain('alpha')
  })
})

describe('openspec-valid', () => {
  test('a valid change is silent; an invalid one attaches the capped issues', () => {
    expect(run('openspec-valid', ctx())).toEqual([])
    const invalid: ValidateOutcome = { ok: true, error: null, valid: false, issues: [{ level: 'ERROR', message: 'No deltas' }], issueCount: 1 }
    const findings = run('openspec-valid', ctx({ cli: { alpha: { validate: invalid, deltas: deltas() }, beta: { validate: valid(), deltas: deltas() } } }))
    expect(findings).toEqual([expect.objectContaining({ severity: 'error', key: 'openspec-valid:alpha', detail: { issues: [{ level: 'ERROR', message: 'No deltas' }], issueCount: 1 } })])
  })

  test('a failed or timed-out call is an error for that change', () => {
    const failed: ValidateOutcome = { ok: false, error: 'validate alpha timed out after 15000ms', valid: false, issues: [], issueCount: 0 }
    const findings = run('openspec-valid', ctx({ cli: { alpha: { validate: failed, deltas: deltas() }, beta: { validate: valid(), deltas: deltas() } } }))
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.message).toContain('timed out')
  })

  test('an unavailable adapter is one not-checked error; unregistered changes are skipped', () => {
    const findings = run('openspec-valid', ctx({ adapter: probe(false) }))
    expect(findings).toEqual([expect.objectContaining({ severity: 'error', key: 'openspec-valid:openspec adapter', message: 'not checked: OpenSpec adapter unavailable' })])
    // alpha is unregistered (skipped even though its validate failed); beta
    // is registered and invalid, so only beta reports.
    const failedAlpha: ValidateOutcome = { ok: false, error: 'call failed', valid: false, issues: [], issueCount: 0 }
    const invalid: ValidateOutcome = { ok: true, error: null, valid: false, issues: [{ level: 'ERROR', message: 'No deltas' }], issueCount: 1 }
    const skipped = run('openspec-valid', ctx({
      resolved: { alpha: { ...registered('alpha'), status: 'unregistered' }, beta: registered('beta') },
      cli: { alpha: { validate: failedAlpha, deltas: deltas() }, beta: { validate: invalid, deltas: deltas() } },
    }))
    expect(skipped.map(finding => finding.subject)).toEqual(['beta'])
  })
})

describe('relations', () => {
  const touchAlpha = [{ capability: 'chat', operation: 'MODIFIED', requirement: 'Presence' }]
  const touchBeta = [{ capability: 'chat', operation: 'MODIFIED', requirement: 'Presence' }]

  test('a conflict is an error, an overlap a warning, and serialized pairs evidence', () => {
    const findings = run('relations', ctx({ cli: { alpha: { validate: valid(), deltas: deltas(touchAlpha) }, beta: { validate: valid(), deltas: deltas(touchBeta) } } }))
    expect(names(findings)).toEqual(['error:relations:conflict:alpha+beta:chat/Presence'])
  })

  test('an unavailable adapter is one not-checked error; unregistered changes are skipped', () => {
    expect(run('relations', ctx({ adapter: probe(false) }))).toEqual([expect.objectContaining({ severity: 'error', key: 'relations:openspec adapter', message: 'not checked: OpenSpec adapter unavailable' })])
    const skipped = run('relations', ctx({ resolved: { alpha: { ...registered('alpha'), status: 'archived' }, beta: registered('beta') }, cli: { beta: { validate: valid(), deltas: deltas(touchBeta) } } }))
    expect(skipped).toEqual([])
  })

  test('a failed delta read is an error for that change, which is excluded from pairing', () => {
    // alpha's deltas timed out; beta conflicts with alpha's requirement, but
    // alpha cannot be paired — the failure itself is the error.
    const failedDeltas: ShowDeltasOutcome = { ok: false, error: 'show alpha timed out after 15000ms', touches: [] }
    const findings = run('relations', ctx({ cli: { alpha: { validate: valid(), deltas: failedDeltas }, beta: { validate: valid(), deltas: deltas(touchBeta) } } }))
    expect(findings).toEqual([expect.objectContaining({ severity: 'error', key: 'relations:alpha', message: expect.stringContaining('timed out') })])
  })
})

describe('change-claimed-elsewhere', () => {
  test('another open plan naming a change is a warning', () => {
    const findings = run('change-claimed-elsewhere', ctx({ claims: { branch: [], changes: { alpha: ['plan-9'] } } }))
    expect(findings).toEqual([expect.objectContaining({ severity: 'warning', key: 'change-claimed-elsewhere:alpha:plan-9', detail: { plans: ['plan-9'] } })])
  })

  test('branch-free lists every claimant in one error; change-claimed-elsewhere keys the claimant set', () => {
    const landing = { mode: 'integration-branch' as const, branch: 'release/1' }
    const claimed = ctx({
      content: content({ changes: [], landing }),
      claims: { branch: ['plan-9', 'plan-8'], changes: {} },
    })
    const branchFindings = run('branch-free', claimed)
    expect(branchFindings.filter(finding => finding.severity === 'error')).toHaveLength(1)
    expect(branchFindings[0]!.message).toContain('plan-8, plan-9')
    // A new claimant is a new key, so an earlier acceptance covers only the
    // claimants it named.
    const oneClaimant = run('change-claimed-elsewhere', ctx({ claims: { branch: [], changes: { alpha: ['plan-9'] } } }))[0]!
    const twoClaimants = run('change-claimed-elsewhere', ctx({ claims: { branch: [], changes: { alpha: ['plan-9', 'plan-8'] } } }))[0]!
    expect(oneClaimant.key).toBe('change-claimed-elsewhere:alpha:plan-9')
    expect(twoClaimants.key).toBe('change-claimed-elsewhere:alpha:plan-8+plan-9')
    expect(oneClaimant.key).not.toBe(twoClaimants.key)
  })

  test('claims computation ignores this plan and closed plans, and only standing revisions claim', () => {
    const plan = (planId: string, lifecycle: 'open' | 'completed', status: PlanRevisionStatus, change: string, branch: string | null) => ({
      planId, lifecycle,
      revisions: [{ status, content: content({ changes: [{ change }], landing: branch ? { mode: 'integration-branch', branch } : {} }) }] as Array<{ status: PlanRevisionStatus; content: PlanContent }>,
    })
    const claims = computeClaims('plan-1', [
      plan('plan-1', 'open', 'approved', 'alpha', 'release/x'),       // this plan: ignored
      plan('plan-2', 'open', 'in_review', 'alpha', 'release/x'),      // claims both
      plan('plan-3', 'completed', 'approved', 'alpha', 'release/x'),  // closed: ignored
      plan('plan-4', 'open', 'superseded', 'alpha', 'release/x'),     // not standing: ignored
      plan('plan-5', 'open', 'approved', 'unrelated', null),          // another change and no branch claim
    ], 'release/x', ['alpha', 'beta'])
    expect(claims).toEqual({ branch: ['plan-2'], changes: { alpha: ['plan-2'] } })
  })
})

describe('strategy-impact', () => {
  test.each(['current', 'continue'])('a passing gate (%s) is evidence', (state) => {
    const findings = run('strategy-impact', ctx({ gate: gate(state as 'current') }))
    expect(findings).toEqual([expect.objectContaining({ severity: 'evidence', key: 'strategy-impact:gate', detail: { state } })])
  })

  test.each(['decision-required', 'adapt', 'reconsider', 'withdrawn-direction'])('a failing gate (%s) is an error naming the state', (state) => {
    const findings = run('strategy-impact', ctx({ gate: gate(state as 'decision-required') }))
    expect(findings).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining(state) })])
  })
})

describe('groups-known and profiles-known', () => {
  test('a missing group is an error naming it', () => {
    const findings = run('groups-known', ctx({ groups: new Map() }))
    expect(names(findings)).toEqual(['error:groups-known:middle-devs'])
    expect(findings[0]!.message).toContain('middle-devs')
  })

  test('per-change and review groups are named too', () => {
    const findings = run('groups-known', ctx({ content: content({ changes: [{ change: 'alpha', group: 'senior-devs', reviewGroup: 'reviewers' }, { change: 'beta', group: 'ghost-review' }], reviewGroup: 'lead' }) }))
    expect(names(findings).sort()).toEqual(['error:groups-known:ghost-review', 'error:groups-known:lead', 'error:groups-known:reviewers', 'error:groups-known:senior-devs'])
  })

  test('an unknown role profile is an error; an outside-profile warning only when the group declares profiles', () => {
    const withBoth = ctx({
      content: content({ changes: [], roles: [{ group: 'middle-devs', profiles: ['default', 'opus'] }] }),
      knownProfiles: new Set(['default']),
    })
    const unknown = run('profiles-known', withBoth)
    expect(names(unknown)).toEqual(['error:profiles-known:middle-devs/opus'])
    const declared = run('profiles-known', ctx({
      content: content({ changes: [], roles: [{ group: 'middle-devs', profiles: ['mimo'] }] }),
      groups: new Map([['middle-devs', { profiles: ['default', 'opus'] }]]),
      knownProfiles: new Set(['default', 'opus', 'mimo']),
    }))
    expect(names(declared)).toEqual(['warning:profiles-known:middle-devs/mimo'])
    const undeclaredGroup = run('profiles-known', ctx({
      content: content({ changes: [], roles: [{ group: 'middle-devs', profiles: ['mimo'] }] }),
      groups: new Map([['middle-devs', { profiles: [] }]]),
      knownProfiles: new Set(['default', 'opus', 'mimo']),
    }))
    expect(undeclaredGroup).toEqual([])
  })
})

describe('branch-free', () => {
  test('direct landing never checks the branch', () => {
    expect(run('branch-free', ctx({ claims: { branch: ['plan-9'], changes: {} } }))).toEqual([])
  })

  test('a claimed integration branch is an error naming the plan, with branch facts as evidence', () => {
    const findings = run('branch-free', ctx({
      content: content({ changes: [], landing: { mode: 'integration-branch', branch: 'release/1' } }),
      claims: { branch: ['plan-9'], changes: {} },
      branch: { exists: true, head: 'abc123', worktree: '/repo/.worktrees/release' },
    }))
    expect(names(findings)).toEqual(['error:branch-free:release/1', 'evidence:branch-free:release/1:state'])
    expect(findings[0]!.message).toContain('plan-9')
    expect(findings[1]!.detail).toEqual({ exists: true, head: 'abc123', worktree: '/repo/.worktrees/release' })
  })
})

describe('capacity', () => {
  test('is evidence only and never fails a report', () => {
    const busy = run('capacity', ctx({
      capacity: [{ group: 'middle-devs', max: 2, live: 2, profiles: [{ profile: 'default', cap: 2, live: 2 }], cooling: [{ profile: 'default', until: '2026-10-16T12:00:00Z' }] }],
    }))
    expect(busy).toEqual([expect.objectContaining({ severity: 'evidence', key: 'capacity:middle-devs' })])
    const all = runValidationChecks(ctx({
      capacity: [{ group: 'middle-devs', max: 2, live: 2, profiles: [{ profile: 'default', cap: 2, live: 2 }], cooling: [{ profile: 'default', until: '2026-10-16T12:00:00Z' }] }],
    }))
    expect(all.filter(finding => finding.severity === 'error')).toEqual([])
  })
})

test('the checks run in the D3 order', () => {
  expect(VALIDATION_CHECKS.map(check => check.name)).toEqual([
    'adapter-available', 'change-registered', 'openspec-valid', 'relations', 'change-claimed-elsewhere',
    'strategy-impact', 'groups-known', 'profiles-known', 'branch-free', 'capacity',
  ])
})
