import { describe, expect, test } from 'bun:test'
import { builtinPick } from '../team/routing/builtin'
import { buildCandidates, type CandidateInput, type GroupMemberState } from '../team/routing/candidates'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { RouteCandidate } from '../../shared/routing'

function group(frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile('devs', `---\n${frontmatter}\n---\nBuild.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

const member = (sessionId: string, profileId: string, over: Partial<GroupMemberState> = {}): GroupMemberState =>
  ({ sessionId, profileId, cwd: '/repo/wt', eligible: true, ...over })

const CAPPED = 'profiles: { glm: 2, mimo: 1, claude: 1 }'

function build(over: Partial<CandidateInput>) {
  return buildCandidates({
    group: group(CAPPED), members: [], pendingSpawnProfiles: [], spawnAllowed: true, spawnCwd: '/repo/wt',
    ...over,
  })
}
const ids = (candidates: RouteCandidate[]) => candidates.map(candidate => candidate.id)

describe('buildCandidates', () => {
  test('a reached profile cap removes that spawn slot only', () => {
    const set = build({ members: [member('a', 'glm', { eligible: false }), member('b', 'glm', { eligible: false })] })
    expect(ids(set.candidates)).toEqual(['spawn:mimo', 'spawn:claude'])
    expect(set.group.profiles).toEqual([
      { profileId: 'glm', cap: 2, live: 2 }, { profileId: 'mimo', cap: 1, live: 0 }, { profileId: 'claude', cap: 1, live: 0 },
    ])
    expect(set.group).toMatchObject({ id: 'devs', max: 4, live: 2, strategy: 'first-available' })
  })

  test('parked members hold their slots and forwarded work skips the limited profile', () => {
    const parked = [member('a', 'glm', { eligible: false }), member('b', 'glm', { eligible: false })]
    expect(ids(build({ members: parked, excludeProfile: 'glm' }).candidates)).toEqual(['spawn:mimo', 'spawn:claude'])
  })

  test('pending reservations count toward caps', () => {
    expect(ids(build({ pendingSpawnProfiles: ['mimo'] }).candidates)).toEqual(['spawn:glm', 'spawn:claude'])
  })

  test('the overall max stops every spawn', () => {
    const set = build({
      group: group(`max: 3\n${CAPPED}`),
      members: [member('a', 'glm', { eligible: false }), member('b', 'mimo', { eligible: false }), member('c', 'claude', { eligible: false })],
    })
    expect(set.candidates).toEqual([])
  })

  test('the default max is the sum of caps', () => {
    const three = [member('a', 'glm', { eligible: false }), member('b', 'glm', { eligible: false }), member('c', 'mimo', { eligible: false })]
    expect(ids(build({ members: three }).candidates)).toEqual(['spawn:claude'])
    expect(build({ members: [...three, member('d', 'claude', { eligible: false })] }).candidates).toEqual([])
  })

  test('only members passed in count — other groups never do', () => {
    expect(ids(build({ group: group('profiles: { glm: 2 }') }).candidates)).toEqual(['spawn:glm'])
  })

  test('eligible members are candidates, cooling or not, unless their profile is excluded', () => {
    const set = build({
      members: [member('a', 'glm', { idleForMs: 5 }), member('b', 'claude'), member('c', 'mimo', { eligible: false })],
      excludeProfile: 'claude', spawnAllowed: false,
    })
    expect(set.candidates).toEqual([{ id: 'member:a', kind: 'member', profileId: 'glm', sessionId: 'a', cwd: '/repo/wt', idleForMs: 5 }])
  })

  test('no spawn slots when staffing would not spawn or no cwd is known', () => {
    expect(build({ spawnAllowed: false }).candidates).toEqual([])
    expect(build({ spawnCwd: null }).candidates).toEqual([])
  })

  test('a group without profiles offers the default profile under max', () => {
    const set = build({ group: group('max: 2') })
    expect(ids(set.candidates)).toEqual(['spawn:default'])
    expect(set.group.profiles).toEqual([{ profileId: 'default', live: 0 }])
  })
})

describe('builtinPick', () => {
  const c = (id: string, kind: 'member' | 'spawn', profileId: string, idleForMs?: number): RouteCandidate =>
    ({ id, kind, profileId, cwd: '/r', ...(kind === 'member' ? { sessionId: id } : {}), ...(idleForMs !== undefined ? { idleForMs } : {}) })

  test('first-available: the longest-idle member, else the first spawn slot', () => {
    const list = [c('s-claude', 'spawn', 'claude'), c('a', 'member', 'glm', 10), c('b', 'member', 'claude', 50)]
    expect(builtinPick('first-available', list, ['claude', 'glm'])?.id).toBe('b')
    expect(builtinPick('first-available', [c('s-glm', 'spawn', 'glm'), c('s-claude', 'spawn', 'claude')], ['claude', 'glm'])?.id).toBe('s-claude')
  })

  test('profile-order: earlier profiles first, members before spawns', () => {
    const list = [c('a', 'member', 'glm', 99), c('b', 'member', 'claude', 1), c('s', 'spawn', 'claude')]
    expect(builtinPick('profile-order', list, ['claude', 'glm'])?.id).toBe('b')
    expect(builtinPick('profile-order', [c('x', 'member', 'other', 99), c('a', 'member', 'glm', 1)], ['claude', 'glm'])?.id).toBe('a')
  })

  test('both strategies skip cooling profiles, members and spawns alike', () => {
    const list = [c('a', 'member', 'glm', 99), c('b', 'member', 'claude', 1), c('s', 'spawn', 'glm')]
    const cooling = (profileId: string) => profileId === 'glm'
    expect(builtinPick('first-available', list, ['glm', 'claude'], cooling)?.id).toBe('b')
    expect(builtinPick('profile-order', list, ['glm', 'claude'], cooling)?.id).toBe('b')
    expect(builtinPick('first-available', [list[0]!, list[2]!], ['glm'], cooling)).toBeNull()
  })

  test('no candidates, no pick', () => {
    expect(builtinPick('first-available', [], [])).toBeNull()
  })
})

describe('a plan role narrows the candidates (plan-execution D15)', () => {
  test('members outside the role are excluded; spawns come in the role\'s order over the group\'s', () => {
    const set = build({
      members: [member('a', 'mimo'), member('b', 'glm')],
      allowedProfiles: ['claude', 'glm'],
    })
    expect(ids(set.candidates)).toEqual(['member:b', 'spawn:claude', 'spawn:glm'])
  })

  test('spawn slots only for role profiles the group also allows; caps still apply', () => {
    const set = build({
      members: [member('a', 'glm', { eligible: false }), member('b', 'glm', { eligible: false })],
      allowedProfiles: ['sonnet', 'glm', 'mimo'],
    })
    // glm is capped out; sonnet is not a group profile; so mimo only.
    expect(ids(set.candidates)).toEqual(['spawn:mimo'])
  })

  test('no narrowing without a role', () => {
    // The mimo member stays a candidate and every group profile spawns;
    // mimo's own slot is out only because its cap of 1 is taken by the member.
    const set = build({ members: [member('a', 'mimo')], allowedProfiles: null })
    expect(ids(set.candidates)).toEqual(['member:a', 'spawn:glm', 'spawn:claude'])
  })

  test('builtin profile-order ranks by the role\'s order', () => {
    const glm = { id: 'member:g', kind: 'member' as const, profileId: 'glm', sessionId: 'g', cwd: '/w', idleForMs: 5 }
    const claude = { id: 'member:c', kind: 'member' as const, profileId: 'claude', sessionId: 'c', cwd: '/w', idleForMs: 99 }
    expect(builtinPick('profile-order', [glm, claude], ['glm', 'mimo', 'claude'])).toMatchObject({ id: 'member:g' })
    expect(builtinPick('profile-order', [glm, claude], ['claude', 'glm'])).toMatchObject({ id: 'member:c' })
  })
})
