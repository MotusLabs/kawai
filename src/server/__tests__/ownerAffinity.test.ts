// Owner affinity (group-mail-task-affinity D3): design.md's derivation table
// A1–A9 as pure rows over `ownerAffinity`, then the built-in path's rows of
// the routing table (B1–B4, B6, B7) over `evaluateEligibility` and
// `builtinPick` — the decision made without a rule. The rule rows (B8, B9),
// B5, B10, and the router composition are in routingAffinity.test.ts.
import { describe, expect, test } from 'bun:test'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import { builtinPick } from '../team/routing/builtin'
import {
  evaluateEligibility, ownerAffinity, type EligibilityMember, type EligibilityState, type MemberExclusionKind, type OwnerAffinityInput,
} from '../team/routing/workerEligibility'

function group(frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile('lead', `---\n${frontmatter}\n---\nLead.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

const MIN = 60_000
const CREATED = Date.parse('2026-11-06T10:00:00.000Z')
const WAIT = 30 * MIN
const LEAD = group('profiles: [opus, sonnet]\nmax: 4\naffinity: task-owner')

const idle = (sessionId: string, profileId: string, idleForMs: number): EligibilityMember =>
  ({ sessionId, profileId, cwd: '/repo', eligible: true, idleForMs })
const excluded = (sessionId: string, profileId: string, ...kinds: MemberExclusionKind[]): EligibilityMember =>
  ({ sessionId, profileId, cwd: '/repo', eligible: false, causes: kinds.map(kind => ({ sessionId, kind })) })

function state(members: EligibilityMember[], over: Partial<EligibilityState> = {}): EligibilityState {
  return {
    group: LEAD, members, pendingSpawnProfiles: [], spawnAllowed: false, spawnCwd: null, now: CREATED + 10 * MIN,
    taskOwner: { sessionId: 'a', dueAt: CREATED, waitMs: WAIT }, ...over,
  }
}

/** The built-in path's answer: `hold@<minutes>`, a candidate id, or `none`. */
function decide(input: EligibilityState, strategy: GroupDefinition['strategy'] = 'first-available'): string {
  const result = evaluateEligibility({ ...input, group: { ...input.group, strategy } })
  if (result.affinity.kind === 'hold') return `hold@${(result.affinity.until - CREATED) / MIN}`
  if (result.candidates.length === 0) return 'none'
  const order = result.group.profiles.map(entry => entry.profileId)
  const cooling = (profileId: string) => input.cooldowns?.[profileId] != null && Date.parse(input.cooldowns[profileId]!) > input.now!
  const pick = builtinPick(strategy, result.candidates, order, cooling, result.affinity.kind === 'prefer' ? result.affinity.sessionId : undefined)
  return pick?.id ?? 'none'
}

describe('built-in path rows (B1–B4, B6, B7)', () => {
  test('B1: no task owner — the strategy picks the longest-idle member', () => {
    expect(decide(state([idle('a', 'opus', 1), idle('b', 'opus', 10 * MIN)], { taskOwner: null }))).toBe('member:b')
  })

  // @covers: team-routing-rules › Groups may route by task owner › Owner preferred over the longest-idle member
  test('B2: an eligible owner receives it over a member idle longer', () => {
    expect(decide(state([idle('a', 'opus', 1), idle('b', 'opus', 10 * MIN)]))).toBe('member:a')
  })

  test('B4: a busy or card-waiting owner holds until due+wait, up to the last millisecond', () => {
    for (const kinds of [['busy'], ['pending-card'], ['pending-card', 'busy']] as MemberExclusionKind[][]) {
      expect(decide(state([excluded('a', 'opus', ...kinds), idle('b', 'opus', 5 * MIN)]))).toBe('hold@30')
      expect(decide(state([excluded('a', 'opus', ...kinds), idle('b', 'opus', 5 * MIN)], { now: CREATED + WAIT - 1 }))).toBe('hold@30')
    }
  })

  test('B7: at exactly due+wait and after, the strategy picks among the others', () => {
    for (const now of [CREATED + WAIT, CREATED + WAIT + MIN]) {
      expect(decide(state([excluded('a', 'opus', 'busy'), idle('b', 'opus', 5 * MIN)], { now }))).toBe('member:b')
    }
  })

  test('B6: the wait over and no other candidate — no candidates, no hold', () => {
    expect(decide(state([excluded('a', 'opus', 'busy'), excluded('b', 'opus', 'busy')], { now: CREATED + WAIT }))).toBe('none')
  })

  test('B7: an owner parked, context-exhausted, unavailable, startup-failed, or elsewhere never holds', () => {
    const others: MemberExclusionKind[][] = [['parked'], ['context-exhausted'], ['unavailable'], ['startup-failed'], ['other-worktree'], ['busy', 'parked'], ['busy', 'context-exhausted']]
    for (const kinds of others) {
      expect(decide(state([excluded('a', 'opus', ...kinds), idle('b', 'opus', 5 * MIN)]))).toBe('member:b')
    }
  })

  test('B7: a cooling owner, idle or busy, gives way to another candidate with no wait', () => {
    const cooldowns = { opus: new Date(CREATED + 2 * 60 * MIN).toISOString() }
    expect(decide(state([idle('a', 'opus', 1), idle('b', 'sonnet', 5 * MIN)], { cooldowns }))).toBe('member:b')
    expect(decide(state([excluded('a', 'opus', 'busy'), idle('b', 'sonnet', 5 * MIN)], { cooldowns }))).toBe('member:b')
    expect(decide(state([excluded('a', 'opus', 'busy', 'profile-cooling'), idle('b', 'sonnet', 5 * MIN)]))).toBe('member:b')
  })

  test('B7: an owner the message filters drop, idle or busy, never holds or gets preferred', () => {
    const filters: Array<Partial<EligibilityState>> = [
      { allowedProfiles: ['sonnet'] },
      { workerChoice: { selector: 'sonnet', profiles: ['sonnet'] } },
      { excludeProfile: 'opus' },
    ]
    for (const filter of filters) {
      expect(decide(state([idle('a', 'opus', 1), idle('b', 'sonnet', 5 * MIN)], filter))).toBe('member:b')
      expect(decide(state([excluded('a', 'opus', 'busy'), idle('b', 'sonnet', 5 * MIN)], filter))).toBe('member:b')
    }
  })

  test('B7: an owner that is not a live member of the group never holds', () => {
    expect(decide(state([idle('b', 'opus', 5 * MIN), idle('c', 'opus', 1)]))).toBe('member:b')
  })

  // @covers: team-routing-rules › Groups may route by task owner › Owner preferred under profile order
  test('B3: under profile-order the owner on the second profile beats a member on the first', () => {
    const members = [idle('b', 'opus', 10 * MIN), idle('a', 'sonnet', 1)]
    expect(decide(state(members), 'profile-order')).toBe('member:a')
    expect(decide(state(members, { taskOwner: null }), 'profile-order')).toBe('member:b')
  })
})

describe('evaluateEligibility with a task owner', () => {
  // @covers: team-routing-rules › Eligibility is one reusable pure check › Task owner ranked first
  test('an eligible owner comes first among the candidates; the rest keep their order', () => {
    const result = evaluateEligibility(state([idle('b', 'opus', 10 * MIN), idle('c', 'opus', 5 * MIN), idle('a', 'opus', 1)]))
    expect(result.candidates.map(candidate => candidate.id)).toEqual(['member:a', 'member:b', 'member:c'])
    expect(result.affinity).toEqual({ kind: 'prefer', sessionId: 'a' })
  })

  test('without an owner, or with one held, the order is unchanged', () => {
    const members = [idle('b', 'opus', 10 * MIN), idle('c', 'opus', 5 * MIN)]
    expect(evaluateEligibility(state(members, { taskOwner: null })).affinity).toEqual({ kind: 'none' })
    const held = evaluateEligibility(state([...members, excluded('a', 'opus', 'busy')]))
    expect(held.candidates.map(candidate => candidate.id)).toEqual(['member:b', 'member:c'])
    expect(held.affinity).toEqual({ kind: 'hold', sessionId: 'a', until: CREATED + WAIT })
  })

  test('an ineligible owner with no stated causes reads as busy, as its exclusion does', () => {
    const result = evaluateEligibility(state([{ sessionId: 'a', profileId: 'opus', cwd: '/repo', eligible: false }, idle('b', 'opus', 1)]))
    expect(result.affinity).toEqual({ kind: 'hold', sessionId: 'a', until: CREATED + WAIT })
  })

  test('without an evaluation time the wait counts as over', () => {
    const result = evaluateEligibility(state([excluded('a', 'opus', 'busy'), idle('b', 'opus', 1)], { now: undefined }))
    expect(result.affinity).toEqual({ kind: 'none' })
  })
})

describe('ownerAffinity', () => {
  const base: OwnerAffinityInput = {
    owner: 'a', member: { eligible: false, causes: ['busy'] }, filtered: false, cooling: false, dueAt: CREATED, waitMs: WAIT, now: CREATED,
  }

  test('affinityWait 0 never holds: within the wait is always false', () => {
    expect(ownerAffinity({ ...base, waitMs: 0 })).toEqual({ kind: 'none' })
    expect(ownerAffinity({ ...base, waitMs: 0, member: { eligible: true, causes: [] } })).toEqual({ kind: 'prefer', sessionId: 'a' })
  })

  test('a member with no causes is not waitable', () => {
    expect(ownerAffinity({ ...base, member: { eligible: false, causes: [] } })).toEqual({ kind: 'none' })
  })

  test('no owner, no member, filtered, or cooling gives none', () => {
    for (const over of [{ owner: null }, { member: null }, { filtered: true }, { cooling: true }] as Array<Partial<OwnerAffinityInput>>) {
      expect(ownerAffinity({ ...base, ...over })).toEqual({ kind: 'none' })
    }
  })
})

describe('builtinPick with a preferred session', () => {
  const candidates = [
    { id: 'member:b', kind: 'member' as const, profileId: 'opus', providerId: 'p', sessionId: 'b', cwd: '/r', idleForMs: 10 },
    { id: 'member:a', kind: 'member' as const, profileId: 'sonnet', providerId: 'p', sessionId: 'a', cwd: '/r', idleForMs: 1 },
  ]

  test('the preferred member is picked under either strategy unless it is cooling or absent', () => {
    for (const strategy of ['first-available', 'profile-order'] as const) {
      expect(builtinPick(strategy, candidates, ['opus', 'sonnet'], () => false, 'a')?.id).toBe('member:a')
      expect(builtinPick(strategy, candidates, ['opus', 'sonnet'], profileId => profileId === 'sonnet', 'a')?.id).toBe('member:b')
      expect(builtinPick(strategy, candidates, ['opus', 'sonnet'], () => false, 'z')?.id).toBe('member:b')
    }
  })
})

// design.md's derivation table, verbatim: affinity on or off (off reaches
// `ownerAffinity` as no owner — the router passes none without affinity),
// the resolved owner, its state, and `now < due + wait`. A3 and A4 each have a
// scheduled row: the wait counts from `deliver_at`, not `created_at`.
describe('ownerAffinity derivation table (A1–A9)', () => {
  const DUE = CREATED + 25 * MIN // a row created at CREATED, scheduled for 25 minutes later
  const row = (over: Partial<OwnerAffinityInput>): OwnerAffinityInput => ({
    owner: 'a', member: { eligible: false, causes: ['busy'] }, filtered: false, cooling: false, dueAt: CREATED, waitMs: WAIT, now: CREATED + 10 * MIN, ...over,
  })
  const cases: Array<[string, OwnerAffinityInput, ReturnType<typeof ownerAffinity>]> = [
    ['A1 on, no owner', row({ owner: null }), { kind: 'none' }],
    ['A2 on, eligible owner', row({ member: { eligible: true, causes: [] } }), { kind: 'prefer', sessionId: 'a' }],
    ['A3 on, busy, within the wait', row({}), { kind: 'hold', sessionId: 'a', until: CREATED + WAIT }],
    ['A3 on, awaiting a card, within the wait', row({ member: { eligible: false, causes: ['pending-card'] } }), { kind: 'hold', sessionId: 'a', until: CREATED + WAIT }],
    ['A3 scheduled: due 25 min after creation, 40 min after creation', row({ dueAt: DUE, now: CREATED + 40 * MIN }), { kind: 'hold', sessionId: 'a', until: DUE + WAIT }],
    ['A4 on, busy, now = due + wait', row({ now: CREATED + WAIT }), { kind: 'none' }],
    ['A4 scheduled: now = deliver_at + wait', row({ dueAt: DUE, now: DUE + WAIT }), { kind: 'none' }],
    ['A5 on, other cause', row({ member: { eligible: false, causes: ['parked'] } }), { kind: 'none' }],
    ['A6 on, cooling', row({ cooling: true }), { kind: 'none' }],
    ['A7 on, filtered', row({ filtered: true }), { kind: 'none' }],
    ['A8 on, not live', row({ member: null }), { kind: 'none' }],
  ]
  for (const [name, input, expected] of cases) {
    test(`${name} → ${expected.kind}`, () => expect(ownerAffinity(input)).toEqual(expected))
  }

  test('A9 off: a group without affinity gives the eligibility check no owner, so affinity is none', () => {
    const off = group('profiles: [opus, sonnet]\nmax: 4')
    expect(off.affinity).toBeUndefined()
    // The router passes taskOwner only while the group has affinity (router.ts), so off reads as no owner.
    expect(evaluateEligibility(state([excluded('a', 'opus', 'busy'), idle('b', 'opus', 1)], { group: off, taskOwner: null })).affinity).toEqual({ kind: 'none' })
  })
})
