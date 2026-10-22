// The no-eligible-member breakdown for members the message's filters drop
// (dispatch-worker-choice D2/D10, PR A review finding 3): a member that
// passes the dispatcher's member-state predicates gets its entry from the
// one eligibility check — excluded profile or provider, the plan role, or
// the worker choice — never from a hand-rolled copy beside it.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { EligibleMember, MemberExclusion, RouteView } from '../team/dispatcher'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { TeamMessage } from '../team/mailboxStore'
import { ProfileRouter, type GroupMemberRecord } from '../team/routing/router'
import type { WaitingConstraint } from '../../shared/team'

const PROVIDERS: Record<string, string> = { sonnet: 'anthropic', glm: 'zai', 'glm-flash': 'zai' }
const providerOf = (profileId: string) => PROVIDERS[profileId] ?? profileId

function group(frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile('devs', `---\n${frontmatter}\n---\nBuild.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

const message = (over: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'm1', teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
  priority: 'normal', tags: [], threadId: 'm1', inReplyTo: null, hop: 1, body: 'work', state: 'queued',
  claimedBy: null, claimedAt: null, deliverAt: null, createdAt: '', pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: 'task-1', taskRevision: null,
  claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null, ...over,
})

const eligible = (sessionId: string): EligibleMember => ({
  sessionId, teamId: 'team', groupId: 'devs', idle: true, pendingRequest: false, available: true, worktree: '/wt', idleForMs: 10,
})

let def: GroupDefinition
let members: GroupMemberRecord[]
let allowed: string[] | null
let coolingProvider: string | null

function makeRouter() {
  return new ProfileRouter({
    groupOf: async () => def,
    members: () => members,
    targetWorktree: () => '/wt',
    staffing: {
      spawnContext: async () => ({ worktree: '/wt', allowed: false, pendingProfiles: [],
        facts: { teamSpawned: 5, teamCap: 5, worktreeOccupants: [], worktreePending: 0, backoffRetryAt: null } }),
      spawnFor: async () => null,
    },
    rules: { rule: () => undefined },
    limits: {
      forProfile: () => [], forProvider: () => [], cooldownFor: () => ({ until: null, provider: false, providerId: null }),
      providerCooldownUntil: provider => (provider === coolingProvider ? '2026-10-21T09:00:00.000Z' : null),
    },
    providerOf,
    usageOf: () => null,
    providerUsageOf: () => null,
    excludedProfile: m => m.excludedProfile ?? undefined,
    allowedProfiles: () => allowed,
    now: () => Date.parse('2026-10-21T08:00:00.000Z'),
  })
}

/** The breakdown line of a `none`: each member and its readable cause. */
async function breakdown(m: TeamMessage, view: RouteView) {
  const result = await makeRouter().route(m, view)
  if (result.kind !== 'none') throw new Error(`expected none, got ${result.kind}`)
  const line = (result.diagnosis ?? []).find((entry: WaitingConstraint) => entry.kind === 'no-eligible-member')
  return line?.members ?? null
}

beforeEach(() => {
  def = group('profiles: [sonnet, glm, glm-flash]\nmax: 6')
  members = [{ sessionId: 'flash', profileId: 'glm-flash', cwd: '/wt' }]
  allowed = null
  coolingProvider = null
})

describe('dispatcher-eligible members dropped by a filter (finding 3)', () => {
  test('a member on the excluded profile reads "on the excluded profile"', async () => {
    members = [{ sessionId: 'g', profileId: 'glm', cwd: '/wt' }]
    expect(await breakdown(message({ excludedProfile: 'glm' }), { eligible: [eligible('g')], attempt: 0, exclusions: [] }))
      .toEqual([{ sessionId: 'g', cause: 'on the excluded profile' }])
  })

  test('a member on another model of the cooling excluded provider is listed as excluded-profile', async () => {
    coolingProvider = 'zai'
    expect(await breakdown(message({ excludedProfile: 'glm' }), { eligible: [eligible('flash')], attempt: 0, exclusions: [] }))
      .toEqual([{ sessionId: 'flash', cause: 'on the excluded profile' }])
  })

  test('a member outside the plan role reads outside-role once, even on the excluded profile too', async () => {
    allowed = ['sonnet']
    members = [{ sessionId: 'g', profileId: 'glm', cwd: '/wt' }]
    expect(await breakdown(message({ excludedProfile: 'glm' }), { eligible: [eligible('g')], attempt: 0, exclusions: [] }))
      .toEqual([{ sessionId: 'g', cause: 'outside the plan role\'s profiles' }])
  })

  test('a member off the worker choice reads "not on the chosen worker"', async () => {
    expect(await breakdown(message({ workerChoice: 'anthropic' }), { eligible: [eligible('flash')], attempt: 0, exclusions: [] }))
      .toEqual([{ sessionId: 'flash', cause: 'not on the chosen worker' }])
  })

  test('member-state causes from the dispatcher stay beside the filter entries, one entry per member', async () => {
    members = [{ sessionId: 'busy', profileId: 'sonnet', cwd: '/wt' }, { sessionId: 'flash', profileId: 'glm-flash', cwd: '/wt' }]
    const exclusions: MemberExclusion[] = [{ sessionId: 'busy', kind: 'busy' }]
    expect(await breakdown(message({ workerChoice: 'anthropic' }), { eligible: [eligible('flash')], attempt: 0, exclusions }))
      .toEqual([{ sessionId: 'busy', cause: 'working' }, { sessionId: 'flash', cause: 'not on the chosen worker' }])
  })
})
