// Cross-model review eligibility (starter-team-setup D5/D6, Table E): a
// review handoff to a `crossModelReview: true` group excludes every member
// and spawn slot of an author's model family, before any routing rule, and
// an unknown author leaves none eligible. P1 checks the invariant over seeded
// author and member sets; P3 checks that the router and the pure check agree.
import { beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { familyOf, resolveProfileCatalog } from '../chat/profileCatalog'
import type { EligibleMember } from '../team/dispatcher'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import type { TeamMessage } from '../team/mailboxStore'
import { crossModelChoiceRefusal, crossModelConstraint, crossModelFilter, type CrossModelFilter } from '../team/routing/crossModel'
import { ProfileRouter, type GroupMemberRecord } from '../team/routing/router'
import { evaluateEligibility, type EligibilityMember } from '../team/routing/workerEligibility'
import type { ResultAuthorRow } from '../team/taskResultStore'
import type { RouteContext, RouteDecision } from '../../shared/routing'
import { propertyCases } from './helpers/propertyCases'

// The shipped catalog's families: opus/sonnet/openrouter-opus claude, codex-sol gpt, glm glm.
const SHIPPED = resolveProfileCatalog({ homeDir: path.join(fs.realpathSync(os.tmpdir()), 'kawai-cross-model-no-home') })
const family = (profileId: string) => familyOf(SHIPPED, profileId)

function group(frontmatter: string): GroupDefinition {
  const parsed = parseGroupFile('reviewers', `---\n${frontmatter}\n---\nReview.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

const FLAGGED = 'workers: { codex-sol: 1, opus: 1, openrouter-opus: 1, glm: 1 }\nmax: 4\ncrossModelReview: true'
const REVIEW = { handoffKind: 'review', resultId: 'result-1', taskId: 'task-1' }

/** The filter for one message: authors as (session, recorded profile) rows, records as session → profile. */
function filterFor(opts: {
  flag?: boolean
  handoff?: typeof REVIEW | null
  authors: Array<[string, string | null]>
  records?: Record<string, string>
}): CrossModelFilter | null {
  return crossModelFilter({
    groupFlag: opts.flag ?? true,
    handoff: opts.handoff === undefined ? REVIEW : opts.handoff,
    authors: () => opts.authors.map(([sessionId, profileId]): ResultAuthorRow => ({ sessionId, profileId })),
    profileOfSession: sessionId => opts.records?.[sessionId] ?? null,
    familyOf: family,
  })
}

const member = (sessionId: string, profileId: string, over: Partial<EligibilityMember> = {}): EligibilityMember =>
  ({ sessionId, profileId, cwd: '/wt', eligible: true, ...over })

function evaluate(def: GroupDefinition, members: EligibilityMember[], crossModel: CrossModelFilter | null, over: Record<string, unknown> = {}) {
  return evaluateEligibility({
    group: def, members, pendingSpawnProfiles: [], spawnAllowed: false, spawnCwd: null, crossModel, ...over,
  })
}

const memberReasons = (result: ReturnType<typeof evaluateEligibility>, sessionId: string) =>
  result.excluded.find(entry => entry.alternative.kind === 'member' && entry.alternative.sessionId === sessionId)?.reasons.map(reason => reason.kind) ?? []

describe('Table E — review eligibility', () => {
  test('E1: an unflagged group routes a review of an opus result to an opus member', () => {
    const filter = filterFor({ flag: false, authors: [['dev', 'opus']] })
    expect(filter).toBeNull()
    expect(evaluate(group('workers: { opus: 1 }'), [member('r', 'opus')], filter).candidates.map(c => c.sessionId)).toEqual(['r'])
  })

  // @covers: team-routing-rules › Groups may require cross-model review › Plain group mail is not filtered
  test('E2: plain mail to a flagged group is not filtered', () => {
    const filter = filterFor({ handoff: null, authors: [['dev', 'opus']] })
    expect(filter).toBeNull()
    const assignmentNotReview = filterFor({ handoff: { ...REVIEW, handoffKind: 'qa' }, authors: [['dev', 'opus']] })
    expect(assignmentNotReview).toBeNull()
    expect(evaluate(group(FLAGGED), [member('r', 'opus')], filter).candidates.map(c => c.sessionId)).toEqual(['r'])
  })

  // @covers: team-routing-rules › Cross-model review excludes the authors' model families › An Opus result goes to the Sol reviewer
  test('E3/E4: an opus result excludes the opus member and keeps the codex-sol member', () => {
    const result = evaluate(group(FLAGGED), [member('o', 'opus'), member('s', 'codex-sol')], filterFor({ authors: [['dev', 'opus']] }))
    expect(result.candidates.map(c => c.sessionId)).toEqual(['s'])
    expect(memberReasons(result, 'o')).toEqual(['cross-model'])
    expect(result.excluded.find(entry => entry.alternative.kind === 'member')?.reasons[0]).toEqual({ kind: 'cross-model', detail: 'family claude' })
  })

  // @covers: team-routing-rules › Cross-model review excludes the authors' model families › Every round's author counts
  test('E5: authors of every round count — opus then codex-sol leaves no candidate', () => {
    const filter = filterFor({ authors: [['dev-1', 'opus'], ['dev-2', 'codex-sol']] })
    expect(filter?.families).toEqual(['claude', 'gpt'])
    const result = evaluate(group('workers: { opus: 1, codex-sol: 1 }\nmax: 2\ncrossModelReview: true'), [member('o', 'opus'), member('s', 'codex-sol')], filter)
    expect(result.candidates).toEqual([])
    expect(memberReasons(result, 's')).toEqual(['cross-model'])
  })

  // @covers: team-routing-rules › Cross-model review excludes the authors' model families › Families, not profile ids, are compared
  test('E3b: families, not profile ids — openrouter-opus shares claude with opus', () => {
    const result = evaluate(group(FLAGGED), [member('or', 'openrouter-opus')], filterFor({ authors: [['dev', 'opus']] }))
    expect(result.candidates).toEqual([])
    expect(memberReasons(result, 'or')).toEqual(['cross-model'])
  })

  // @covers: team-routing-rules › Cross-model review excludes the authors' model families › Human-submitted results add no family
  test('E6: a task with no agent-submitted result excludes nothing', () => {
    const filter = filterFor({ authors: [] })
    expect(filter).toEqual({ families: [], unknownAuthors: [], familyOf: family })
    expect(evaluate(group(FLAGGED), [member('o', 'opus')], filter).candidates.map(c => c.sessionId)).toEqual(['o'])
  })

  // @covers: team-routing-rules › An unknown author's family holds the review › A result with no recoverable profile
  test('E7: an author with no recorded profile and no session record leaves no candidate', () => {
    const filter = filterFor({ authors: [['gone', null]] })
    expect(filter?.unknownAuthors).toEqual(['gone'])
    const result = evaluate(group(FLAGGED), [member('o', 'opus'), member('s', 'codex-sol')], filter)
    expect(result.candidates).toEqual([])
    expect(result.excluded.every(entry => entry.reasons.some(reason => reason.kind === 'cross-model' && reason.detail === 'unknown author gone'))).toBe(true)
  })

  test('E7b: an older row without a recorded profile resolves through the session record', () => {
    const filter = filterFor({ authors: [['dev', null]], records: { dev: 'codex-sol' } })
    expect(filter).toMatchObject({ families: ['gpt'], unknownAuthors: [] })
  })

  // @covers: team-routing-rules › A worker choice inside the authors' families is refused › Choosing the author's model is refused
  test("E8: a choice of only the authors' family is refused naming it", () => {
    const filter = filterFor({ authors: [['dev', 'opus']] })!
    expect(crossModelChoiceRefusal(filter, ['opus', 'openrouter-opus'])).toBe(
      "worker choice is within the authors' model family claude; a cross-model review needs a worker of another family")
    expect(crossModelChoiceRefusal(filter, null)).toBeNull()
  })

  // @covers: team-routing-rules › A worker choice inside the authors' families is refused › A provider choice with another family is accepted
  test('E9: a choice keeping another family is accepted and filtered', () => {
    const filter = filterFor({ authors: [['dev', 'opus']] })!
    expect(crossModelChoiceRefusal(filter, ['openrouter-opus', 'openrouter-deepseek-flash'])).toBeNull()
    const def = group('workers: { openrouter-opus: 1, openrouter-deepseek-flash: 1 }\nmax: 2\ncrossModelReview: true')
    const result = evaluate(def, [member('or', 'openrouter-opus'), member('ds', 'openrouter-deepseek-flash')], filter,
      { workerChoice: { selector: 'openrouter', profiles: ['openrouter-opus', 'openrouter-deepseek-flash'] } })
    expect(result.candidates.map(c => c.sessionId)).toEqual(['ds'])
  })

  // @covers: team-routing-rules › Cross-model review excludes the authors' model families › The task owner yields to the filter
  test('E10: an owner on the authors family is not preferred; the other-family member takes it', () => {
    const def = group(`${FLAGGED}\naffinity: task-owner`)
    const result = evaluate(def, [member('owner', 'opus'), member('s', 'codex-sol')], filterFor({ authors: [['dev', 'opus']] }),
      { taskOwner: { sessionId: 'owner', dueAt: 0, waitMs: 60_000 }, now: 1 })
    expect(result.affinity).toEqual({ kind: 'none' })
    expect(result.candidates.map(c => c.sessionId)).toEqual(['s'])
  })

  test('spawn slots of the authors family are excluded too', () => {
    const def = group('workers: { opus: 1, codex-sol: 1 }\nmax: 2\ncrossModelReview: true')
    const result = evaluateEligibility({
      group: def, members: [], pendingSpawnProfiles: [], spawnAllowed: true, spawnCwd: '/wt',
      staffing: { teamSpawned: 0, teamCap: 5, worktreeOccupants: [], worktreePending: 0, backoffRetryAt: null },
      crossModel: filterFor({ authors: [['dev', 'opus']] }),
    })
    expect(result.candidates.map(c => c.id)).toEqual(['spawn:codex-sol'])
    expect(result.excluded).toEqual([{ alternative: { kind: 'spawn', profileId: 'opus' }, reasons: [{ kind: 'cross-model', detail: 'family claude' }] }])
  })
})

// The router composition: the flagged filter applied before a rule, and the waiting reasons of a held review.
const message = (over: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'm1', teamId: 'team', toKind: 'group', toId: 'reviewers', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
  priority: 'normal', tags: [], threadId: 'm1', inReplyTo: null, hop: 1, body: 'review', state: 'queued',
  claimedBy: null, claimedAt: null, deliverAt: null, createdAt: '', pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: 'task-1', taskRevision: null,
  claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null, ...over,
})
const eligible = (sessionId: string, idleForMs: number): EligibleMember => ({
  sessionId, teamId: 'team', groupId: 'reviewers', idle: true, pendingRequest: false, available: true, worktree: '/wt', idleForMs,
})

let def: GroupDefinition
let members: GroupMemberRecord[]
let rule: ((ctx: RouteContext) => Promise<RouteDecision>) | null
let filter: CrossModelFilter | null
let spawnAllowed: boolean

function makeRouter() {
  return new ProfileRouter({
    groupOf: async () => def,
    members: () => members,
    targetWorktree: () => '/wt',
    staffing: {
      spawnContext: async () => ({ worktree: '/wt', allowed: spawnAllowed, pendingProfiles: [],
        facts: { teamSpawned: 0, teamCap: 5, worktreeOccupants: [], worktreePending: 0, backoffRetryAt: null } }),
      spawnFor: async (m, _wt, _g, profileId) => ({ message: m, sessionId: `spawned-${profileId}` }),
    },
    rules: { rule: () => (rule ? { route: rule } as never : undefined) },
    limits: { forProfile: () => [], forProvider: () => [], cooldownFor: () => ({ until: null, provider: false, providerId: null }), providerCooldownUntil: () => null },
    usageOf: () => null,
    providerUsageOf: () => null,
    crossModel: (_message, group) => (group.crossModelReview ? filter : null),
    now: () => Date.parse('2026-11-18T08:00:00.000Z'),
  })
}

beforeEach(() => {
  def = group('workers: { opus: 1, codex-sol: 1 }\nmax: 2\ncrossModelReview: true')
  members = [{ sessionId: 'o', profileId: 'opus', cwd: '/wt' }, { sessionId: 's', profileId: 'codex-sol', cwd: '/wt' }]
  rule = null
  filter = filterFor({ authors: [['dev', 'opus']] })
  spawnAllowed = false
})

describe('Table E — through the router', () => {
  // @covers: team-routing-rules › Cross-model review excludes the authors' model families › A rule cannot pick an excluded candidate
  test('E11: a rule naming the opus member reads as unknown; the built-in picks the codex-sol member', async () => {
    const seen: RouteContext[] = []
    rule = async ctx => { seen.push(ctx); return { type: 'pick', candidateId: 'member:o' } }
    const router = makeRouter()
    expect(await router.route(message(), { eligible: [eligible('o', 500), eligible('s', 5)], attempt: 0 }))
      .toEqual({ kind: 'member', sessionId: 's' })
    expect(seen[0]!.candidates.map(candidate => candidate.id)).toEqual(['member:s'])
    expect(router.decisions('team')[1]).toMatchObject({ source: 'fallback', reason: 'rule picked unknown candidate member:o' })
  })

  // @covers: team-waiting-reasons › Waiting reasons name the cross-model requirement › No other-family worker is configured
  test('a group with only the authors family waits naming it and the missing worker', async () => {
    def = group('workers: { opus: 1 }\nmax: 1\ncrossModelReview: true')
    members = [{ sessionId: 'o', profileId: 'opus', cwd: '/wt' }]
    const routed = await makeRouter().route(message(), { eligible: [eligible('o', 5)], attempt: 0 })
    expect(routed.kind).toBe('none')
    const diagnosis = routed.kind === 'none' ? routed.diagnosis ?? [] : []
    expect(diagnosis).toContainEqual({ kind: 'cross-model', detail: "authors' families: claude; no worker of another family is configured" })
    expect(diagnosis.find(entry => entry.kind === 'no-eligible-member')?.members).toEqual([
      { sessionId: 'o', cause: "on a review author's model family" },
    ])
  })

  // @covers: team-waiting-reasons › Waiting reasons name the cross-model requirement › The other-family worker is at its cap
  test("the other-family worker's cap is the capacity the review waits on, never the authors' worker's", async () => {
    // Both slots are taken — opus by the author's family, codex-sol by a busy
    // member: only the codex-sol cap is what the review waits on.
    def = group('workers: { opus: 1, codex-sol: 1 }\nmax: 4\ncrossModelReview: true')
    members = [{ sessionId: 'o', profileId: 'opus', cwd: '/wt' }, { sessionId: 's', profileId: 'codex-sol', cwd: '/wt' }]
    spawnAllowed = true
    const routed = await makeRouter().route(message(), { eligible: [eligible('o', 5)], attempt: 0 })
    expect(routed.kind).toBe('none')
    const diagnosis = routed.kind === 'none' ? routed.diagnosis ?? [] : []
    expect(diagnosis).toContainEqual({ kind: 'cross-model', detail: "authors' families: claude" })
    expect(diagnosis).toContainEqual({ kind: 'profile-cap', counts: { live: 1, cap: 1 }, detail: 'codex-sol' })
    expect(diagnosis.some(entry => entry.kind === 'profile-cap' && entry.detail === 'opus')).toBe(false)
  })

  // @covers: team-waiting-reasons › Waiting reasons name the cross-model requirement › The reason clears when a worker frees up
  test('the review routes once the codex-sol reviewer is idle', async () => {
    const router = makeRouter()
    expect((await router.route(message(), { eligible: [eligible('o', 5)], attempt: 0 })).kind).toBe('none')
    expect(await router.route(message(), { eligible: [eligible('o', 5), eligible('s', 1)], attempt: 1 })).toEqual({ kind: 'member', sessionId: 's' })
  })

  test('the unknown-author constraint names the session', () => {
    expect(crossModelConstraint(filterFor({ authors: [['gone', null]] })!, ['codex-sol'])).toEqual({
      kind: 'cross-model', detail: "authors' families: none; unknown author gone", sessionIds: ['gone'],
    })
  })
})

/** A seeded linear congruential stream (no dependency): values in [0, 1). */
function stream(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
const pick = <T>(next: () => number, values: readonly T[]): T => values[Math.floor(next() * values.length)]!

const PROFILES = ['opus', 'sonnet', 'openrouter-opus', 'codex-sol', 'codex-luna', 'glm', 'glm-flash', 'mimo', 'lan-a', 'lan-b'] as const

function seededCase(next: () => number) {
  const authors: Array<[string, string | null]> = []
  const records: Record<string, string> = {}
  const authorCount = Math.floor(next() * 5)
  for (let i = 0; i < authorCount; i++) {
    const session = `dev-${i}`
    const roll = next()
    if (roll < 0.15) authors.push([session, null])
    else if (roll < 0.35) { authors.push([session, null]); records[session] = pick(next, PROFILES) }
    else authors.push([session, pick(next, PROFILES)])
  }
  const workers = [...new Set(Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(next, PROFILES)))]
  const def = group(`workers: { ${workers.map(id => `${id}: 2`).join(', ')} }\nmax: 8\ncrossModelReview: true`)
  const roster = Array.from({ length: Math.floor(next() * 5) }, (_, i) => member(`m${i}`, pick(next, workers), { eligible: next() < 0.8 }))
  return { authors, records, def, roster }
}

describe('properties', () => {
  // P1 (I1): no eligible candidate shares an author's family; an unknown author leaves none.
  test('P1: cross-model eligibility never admits an author family (seed 0x5eed01, 400 cases)', () => {
    const next = stream(0x5eed01)
    for (let i = 0; i < propertyCases(400); i++) {
      const { authors, records, def, roster } = seededCase(next)
      const crossModel = filterFor({ authors, records })!
      const result = evaluateEligibility({
        group: def, members: roster, pendingSpawnProfiles: [], spawnAllowed: true, spawnCwd: '/wt',
        staffing: { teamSpawned: 0, teamCap: 9, worktreeOccupants: [], worktreePending: 0, backoffRetryAt: null }, crossModel,
      })
      const unknown = authors.some(([session, profile]) => profile === null && records[session] === undefined)
      const families = new Set(authors.flatMap(([session, profile]) => {
        const resolved = profile ?? records[session]
        return resolved === undefined ? [] : [family(resolved)]
      }))
      if (unknown) expect(result.candidates).toEqual([])
      for (const candidate of result.candidates) expect(families.has(family(candidate.profileId))).toBe(false)
    }
  })

  // P3 (I3): the router routes only to a candidate the pure check admits, and names none when it admits none.
  test('P3: the router and the pure check agree (seed 0x5eed03, 200 cases)', async () => {
    const next = stream(0x5eed03)
    for (let i = 0; i < propertyCases(200); i++) {
      const { authors, records, def: seededDef, roster } = seededCase(next)
      def = seededDef
      members = roster.map(entry => ({ sessionId: entry.sessionId, profileId: entry.profileId, cwd: '/wt' }))
      filter = filterFor({ authors, records })
      spawnAllowed = false
      const pure = evaluateEligibility({ group: def, members: roster, pendingSpawnProfiles: [], spawnAllowed: false, spawnCwd: '/wt',
        staffing: { teamSpawned: 0, teamCap: 9, worktreeOccupants: [], worktreePending: 0, backoffRetryAt: null }, crossModel: filter })
      const routed = await makeRouter().route(message({ id: `m-${i}` }), {
        eligible: roster.filter(entry => entry.eligible).map((entry, index) => eligible(entry.sessionId, index)), attempt: 0,
      })
      const admitted = pure.candidates.filter(candidate => candidate.kind === 'member').map(candidate => candidate.sessionId)
      if (routed.kind === 'member') expect(admitted).toContain(routed.sessionId)
      else expect(admitted).toEqual([])
    }
  })
})

describe('the crossModelReview flag (3.1)', () => {
  // @covers: team-routing-rules › Groups may require cross-model review › The flag is read
  test('true is read; absent and false read as off', () => {
    expect(group('crossModelReview: true').crossModelReview).toBe(true)
    expect(group('crossModelReview: false').crossModelReview).toBe(false)
    expect(group('max: 1').crossModelReview ?? false).toBe(false)
  })

  // @covers: team-routing-rules › Groups may require cross-model review › A non-boolean rejects the file
  test('a non-boolean rejects the file naming the key', () => {
    const parsed = parseGroupFile('reviewers', '---\ncrossModelReview: yes\n---\nReview.')
    expect(parsed).toEqual({ ok: false, error: 'crossModelReview must be true or false, got "yes"' })
  })
})
