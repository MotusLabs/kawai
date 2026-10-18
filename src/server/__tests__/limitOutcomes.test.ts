// Limit outcomes on claimed work: park / release / forward, resume, manual
// hand off, recovery notes, and the claim commit.
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { LimitEventStore } from '../team/routing/limitEvents'
import { LimitOutcomes } from '../team/routing/limitOutcomes'
import type { LimitOutcome, LimitOutcomeContext } from '../../shared/routing'

const T0 = Date.parse('2026-10-12T12:00:00.000Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

let now: number
let db: Database
let store: MailboxStore
let limits: LimitEventStore
let outcomes: LimitOutcomes
let records: Map<string, ChatSessionRecord>
let groups: Map<string, GroupDefinition>
let ruleOnLimit: ((ctx: LimitOutcomeContext) => Promise<LimitOutcome>) | null
let errors: unknown[]
let home: string

const group = (id: string, frontmatter = '') => {
  const parsed = parseGroupFile(id, `---\n${frontmatter}\n---\nWork.`)
  if (!parsed.ok) throw new Error(parsed.error)
  groups.set(id, parsed.group)
}
const record = (sessionId: string, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, name: `name-${sessionId}`, projectPath: '/repo', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', claudeProfileId: 'glm', ...extra,
})

function makeOutcomes() {
  return new LimitOutcomes(db, {
    store, limits,
    rules: { rule: () => (ruleOnLimit ? { hasOnLimit: true, onLimit: ruleOnLimit } as never : undefined) },
    getRecord: id => records.get(id),
    teamOf: id => (records.has(id) ? 'team' : undefined),
    groupOf: (_sessionId, groupId) => groups.get(groupId),
    taskTitle: id => (id === 'task-1' ? 'Export CSV' : null),
    targetWorktree: message => message.taskId === 'task-1' ? '/repo/worktree' : null,
    restoreSession: id => { records.get(id)!.archivedAt = null },
    onError: error => errors.push(error),
    now: () => now,
    homeDir: home,
  })
}

beforeEach(() => {
  now = T0
  // providerOf reads the catalog home the options pass, never the operator's.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-limit-home-'))
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  limits = new LimitEventStore(db, () => now)
  records = new Map([['dev', record('dev')], ['dev2', record('dev2', { claudeProfileId: 'claude' })], ['lead', record('lead', { groupId: 'leads' })]])
  groups = new Map()
  group('devs')
  group('architects')
  ruleOnLimit = null
  errors = []
  outcomes = makeOutcomes()
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

/** Group mail claimed and delivered to `sessionId` as its current turn. */
function deliver(sessionId = 'dev', extra: Partial<Parameters<MailboxStore['enqueue']>[0]> = {}): TeamMessage {
  const message = store.enqueue({
    teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo',
    body: 'Build the export', taskId: 'task-1', ...extra,
  })
  store.claim(message.id, sessionId); store.markPushed(message.id); store.markDelivered(message.id)
  outcomes.delivered(sessionId, store.get(message.id)!)
  return store.get(message.id)!
}

/** A final limit event during the session's turn, then the turn's end. */
async function hitLimit(resetInMs: number | null, sessionId = 'dev', profileId = 'glm') {
  limits.record({
    profileId, sessionId, groupId: 'devs', kind: 'rate_limit', final: true, status: 429, message: 'API Error: 429 quota',
    resetsAt: resetInMs === null ? null : iso(now + resetInMs), providerId: null, window: null,
  })
  await outcomes.turnEnded(sessionId, true)
}

const work = (sessionId = 'dev', calls = 2) => {
  for (let i = 0; i < calls; i++) outcomes.toolCall(sessionId, i % 2 ? 'Edit' : 'Read', { file_path: `src/f${i}.ts` })
}

describe('resolution', () => {
  test('close reset with progress parks on the same agent with a resume at the reset', async () => {
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    const parked = store.get(m.id)!
    expect(parked).toMatchObject({ state: 'parked', claimedBy: 'dev', parkedUntil: iso(T0 + 40 * MIN), parkCount: 1 })
    const resume = store.get(parked.resumeMessageId!)!
    expect(resume).toMatchObject({ state: 'queued', toKind: 'session', toId: 'dev', deliverAt: iso(T0 + 40 * MIN), taskId: 'task-1' })
    expect(resume.body).toContain(m.id)
    expect(store.parkedBy('dev')).toHaveLength(1)
  })

  test('an unknown reset uses the built-in one-hour cooldown', async () => {
    const m = deliver()
    work()
    await hitLimit(null)
    expect(store.get(m.id)?.parkedUntil).toBe(iso(T0 + 60 * MIN))
  })

  test('far reset with progress forwards to the group with a handoff package excluding the profile', async () => {
    const m = deliver()
    store.setClaimCommit(m.id, 'abc1234')
    work()
    await hitLimit(5 * 60 * MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'forwarded' })
    const forwardedId = store.get(m.id)!.reason!.replace('forwarded: ', '')
    expect(store.get(forwardedId)).toMatchObject({
      state: 'queued', toKind: 'group', toId: 'devs', fromSession: 'lead', body: 'Build the export', taskId: 'task-1',
      threadId: m.threadId, attachThread: true, excludedProfile: 'glm',
      handoff: {
        fromSession: 'dev', fromProfile: 'glm', claimCommit: 'abc1234', lastError: 'API Error: 429 quota',
        progress: { toolCalls: 2, tools: ['Read', 'Edit'], filesTouched: ['src/f0.ts', 'src/f1.ts'] },
      },
    })
  })

  test('no progress releases the message to its group queue', async () => {
    const m = deliver()
    await hitLimit(10 * MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'queued', claimedBy: null, deliveredAt: null, toKind: 'group', toId: 'devs' })
  })

  test('released direct mail goes to the agent’s group', async () => {
    const m = deliver('dev', { toKind: 'session', toId: 'dev' })
    await hitLimit(10 * MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'queued', toKind: 'group', toId: 'devs' })
  })

  test('frontmatter otherwise: release returns progressed work without a package', async () => {
    group('devs', 'onLimit: { parkIfResetWithin: 1h, otherwise: release }')
    const m = deliver()
    work()
    await hitLimit(2 * 60 * MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'queued', handoff: null })
  })

  test('frontmatter forwardTo sends far-reset work to another group; unknown targets fall back', async () => {
    group('devs', 'onLimit: { forwardTo: architects }')
    const m = deliver()
    work()
    await hitLimit(5 * 60 * MIN)
    const forwardedId = store.get(m.id)!.reason!.replace('forwarded: ', '')
    expect(store.get(forwardedId)).toMatchObject({ toKind: 'group', toId: 'architects' })

    group('devs', 'onLimit: { forwardTo: nowhere }')
    const second = deliver()
    work()
    await hitLimit(5 * 60 * MIN)
    const secondForward = store.get(store.get(second.id)!.reason!.replace('forwarded: ', ''))
    expect(secondForward).toMatchObject({ toKind: 'group', toId: 'devs' })
    expect(String(errors.at(-1))).toContain('nowhere')
  })

  test('forwardTo may name a session of the team', async () => {
    group('devs', 'onLimit: { forwardTo: dev2 }')
    const m = deliver()
    work()
    await hitLimit(5 * 60 * MIN)
    expect(store.get(store.get(m.id)!.reason!.replace('forwarded: ', ''))).toMatchObject({ toKind: 'session', toId: 'dev2' })
  })

  test('a rule’s onLimit decides; its failure falls back to the group policy', async () => {
    ruleOnLimit = async ctx => {
      expect(ctx).toMatchObject({ profileId: 'glm', sessionId: 'dev', parkCount: 0, progress: { toolCalls: 0 }, status: 429 })
      return { type: 'forward', to: { kind: 'group', id: 'architects' } }
    }
    const m = deliver()
    await hitLimit(10 * MIN)
    expect(store.get(store.get(m.id)!.reason!.replace('forwarded: ', ''))).toMatchObject({ toId: 'architects' })

    ruleOnLimit = async () => { throw new Error('boom') }
    const second = deliver()
    await hitLimit(10 * MIN)
    expect(store.get(second.id)?.state).toBe('queued')
  })

  test('a limit outside any mail turn, or a non-limit failure, changes nothing', async () => {
    await hitLimit(10 * MIN)
    const m = deliver()
    await outcomes.turnEnded('dev', false)
    expect(store.get(m.id)?.state).toBe('delivered')
  })
})

describe('parking', () => {
  test('the resume turn continues the parked work; success unparks it', async () => {
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    const resumeId = store.get(m.id)!.resumeMessageId!
    store.claim(resumeId, 'dev'); store.markPushed(resumeId); store.markDelivered(resumeId)
    outcomes.delivered('dev', store.get(resumeId)!)
    work('dev', 1)
    await outcomes.turnEnded('dev', true)
    expect(store.get(m.id)).toMatchObject({ state: 'delivered', parkedUntil: null, resumeMessageId: null })
    expect(store.parkedBy('dev')).toEqual([])
  })

  test('a resume that hits the limit again parks again; after three parks the work is released', async () => {
    const m = deliver()
    work()
    for (let round = 1; round <= 3; round++) {
      await hitLimit(10 * MIN)
      expect(store.get(m.id)).toMatchObject({ state: 'parked', parkCount: round })
      const resumeId = store.get(m.id)!.resumeMessageId!
      store.claim(resumeId, 'dev'); store.markPushed(resumeId); store.markDelivered(resumeId)
      outcomes.delivered('dev', store.get(resumeId)!)
    }
    await hitLimit(10 * MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'queued', claimedBy: null })
  })

  test('a successful human turn cancels the scheduled resume and unparks', async () => {
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    const resumeId = store.get(m.id)!.resumeMessageId!
    await outcomes.turnEnded('dev', true)
    expect(store.get(resumeId)?.state).toBe('cancelled')
    expect(store.get(m.id)?.state).toBe('delivered')
  })

  test('manual hand off forwards parked work with a package and cancels the resume', async () => {
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    const resumeId = store.get(m.id)!.resumeMessageId!
    const forwarded = outcomes.handOff(m.id, { kind: 'group', id: 'architects' })
    expect(forwarded).toMatchObject({ toId: 'architects', handoff: { fromSession: 'dev', fromProfile: 'glm', lastError: 'API Error: 429 quota' } })
    expect(store.get(resumeId)?.state).toBe('cancelled')
    expect(store.get(m.id)?.state).toBe('forwarded')
    expect(() => outcomes.handOff(m.id, { kind: 'group', id: 'devs' })).toThrow('Only parked work')
  })

  test('a Hand off to a session of the cooling provider refuses; another provider takes it', async () => {
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    records.set('flash', record('flash', { claudeProfileId: 'glm-flash' }))
    // The limit named its provider zai, so the provider stands while glm-flash cools.
    limits.record({
      profileId: 'glm', sessionId: 'dev', groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
      message: 'quota', resetsAt: iso(T0 + 40 * MIN), providerId: 'zai', window: null,
    })
    expect(() => outcomes.handOff(m.id, { kind: 'session', id: 'flash' }))
      .toThrow('its provider zai is cooling after the limit on glm')
    records.set('clauder', record('clauder', { claudeProfileId: 'claude' }))
    expect(outcomes.handOff(m.id, { kind: 'session', id: 'clauder' })).toMatchObject({ toId: 'clauder', excludedProfile: 'glm' })
  })
})

describe('recovery notes', () => {
  test('the forwarding agent is told who took the task once its profile recovers, once', async () => {
    const m = deliver()
    work()
    await hitLimit(5 * 60 * MIN)
    const forwardedId = store.get(m.id)!.reason!.replace('forwarded: ', '')
    expect(outcomes.nextNoteAt()).toBe(T0 + 5 * 60 * MIN)
    store.claim(forwardedId, 'dev2')
    outcomes.processNotes()
    const notes = () => store.listForTeam('team').filter(row => row.tags.includes('handoff-note'))
    expect(notes()).toEqual([])
    now = T0 + 5 * 60 * MIN + 1
    outcomes.processNotes()
    outcomes.processNotes()
    expect(notes()).toHaveLength(1)
    expect(notes()[0]).toMatchObject({ toKind: 'session', toId: 'dev', state: 'queued' })
    expect(notes()[0]!.body).toContain('Export CSV')
    expect(notes()[0]!.body).toContain('name-dev2')
    // The note names the profile's provider (providers-and-workers D15).
    expect(notes()[0]!.body).toContain('Your provider zai limit has recovered')
  })

  test('a recovered profile waits for the forwarded work to be taken', async () => {
    const m = deliver()
    work()
    await hitLimit(10 * MIN)
    // Parked at first; hand it off by hand.
    const forwarded = outcomes.handOff(m.id, { kind: 'group', id: 'devs' })
    now = T0 + 61 * MIN
    outcomes.processNotes()
    expect(store.listForTeam('team').some(row => row.tags.includes('handoff-note'))).toBe(false)
    store.claim(forwarded.id, 'dev2')
    outcomes.processNotes()
    expect(store.listForTeam('team').some(row => row.tags.includes('handoff-note'))).toBe(true)
  })

  test('a model-scoped limit keeps the provider out of the note (D15 same case)', async () => {
    const m = deliver()
    work()
    // opus's own seven_day_opus window: the cooldown is the profile's alone,
    // so the note does not name claude.
    limits.record({
      profileId: 'opus', sessionId: 'dev', groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
      message: 'quota', resetsAt: iso(T0 + 5 * 60 * MIN), providerId: 'claude', window: 'seven_day_opus',
    })
    await outcomes.turnEnded('dev', true)
    const forwardedId = store.get(m.id)!.reason!.replace('forwarded: ', '')
    store.claim(forwardedId, 'dev2')
    now = T0 + 5 * 60 * MIN + 1
    outcomes.processNotes()
    const notes = store.listForTeam('team').filter(row => row.tags.includes('handoff-note'))
    expect(notes).toHaveLength(1)
    expect(notes[0]!.body).toContain('Your provider limit has recovered')
    expect(notes[0]!.body).not.toContain('claude')
  })

  test("a sibling's provider-scoped event holds the note past the original reset", async () => {
    const m = deliver()
    work()
    await hitLimit(5 * 60 * MIN)
    // glm-flash shares glm's shipped provider zai: its later provider reset
    // holds glm's note past glm's own.
    limits.record({
      profileId: 'glm-flash', sessionId: 'dev2', groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
      message: 'quota', at: iso(T0 + MIN), resetsAt: iso(T0 + 6 * 60 * MIN), providerId: 'zai', window: null,
    })
    const forwardedId = store.get(m.id)!.reason!.replace('forwarded: ', '')
    store.claim(forwardedId, 'dev2')
    expect(outcomes.nextNoteAt()).toBe(T0 + 6 * 60 * MIN)
    now = T0 + 5 * 60 * MIN + 1
    outcomes.processNotes()
    expect(store.listForTeam('team').some(row => row.tags.includes('handoff-note'))).toBe(false)
    now = T0 + 6 * 60 * MIN + 1
    outcomes.processNotes()
    expect(store.listForTeam('team').filter(row => row.tags.includes('handoff-note'))).toHaveLength(1)
  })
})

describe('claim commit', () => {
  test('the claimant’s HEAD is recorded once after the claim', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-claim-'))
    try {
      const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() })
      git('init', '-q')
      git('-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init')
      const head = git('rev-parse', 'HEAD').stdout.trim()
      records.set('dev', record('dev', { projectPath: repo }))
      const m = deliver()
      outcomes.claimed(m, 'dev')
      for (let i = 0; i < 50 && !store.get(m.id)?.claimCommit; i++) await Bun.sleep(10)
      expect(store.get(m.id)?.claimCommit).toBe(head)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a claim-commit write that throws is reported, never left unhandled', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-claim-throw-'))
    try {
      const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() })
      git('init', '-q')
      git('-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init')
      records.set('dev', record('dev', { projectPath: repo }))
      const m = deliver()
      // A store torn down before the git call resolves: the write throws, and
      // must reach onError rather than an unhandled rejection (a `.then`
      // rejection handler never sees a throw from its own fulfillment one).
      ;(store as unknown as { setClaimCommit: () => void }).setClaimCommit = () => {
        throw new RangeError('Cannot use a closed database')
      }
      outcomes.claimed(m, 'dev')
      for (let i = 0; i < 50 && errors.length === 0; i++) await Bun.sleep(10)
      expect(errors).toHaveLength(1)
      expect(String(errors[0])).toContain('closed database')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('review regressions', () => {
  test('unrelated direct mail leaves parked work and its scheduled resume intact', async () => {
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    const resumeId = store.get(m.id)!.resumeMessageId!
    deliver('dev', { toKind: 'session', toId: 'dev', body: 'What is your name?' })
    await outcomes.turnEnded('dev', true)
    expect(store.get(m.id)?.state).toBe('parked')
    expect(store.get(resumeId)?.state).toBe('queued')
  })

  test.each([20, 25])('forwarding accepted work at hop %i preserves its hop and thread', async hop => {
    const m = deliver()
    db.prepare('UPDATE team_messages SET hop = ? WHERE id = ?').run(hop, m.id)
    work()
    await hitLimit(5 * 60 * MIN)
    const forwarded = store.get(store.get(m.id)!.reason!.replace('forwarded: ', ''))!
    expect(forwarded).toMatchObject({ hop, threadId: m.threadId, inReplyTo: m.id, state: 'queued' })
  })

  test('manual handoff at the hop limit carries work without consuming another hop', async () => {
    const m = deliver()
    db.prepare('UPDATE team_messages SET hop = 20 WHERE id = ?').run(m.id)
    work()
    await hitLimit(40 * MIN)
    expect(outcomes.handOff(m.id, { kind: 'group', id: 'devs' })).toMatchObject({ hop: 20, state: 'queued' })
  })

  test('manual handoff restores an archived recipient on a different profile', async () => {
    records.set('dev2', record('dev2', { claudeProfileId: 'claude', archivedAt: iso(T0) }))
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    expect(outcomes.handOff(m.id, { kind: 'session', id: 'dev2' })).toMatchObject({ state: 'queued', toId: 'dev2' })
    expect(records.get('dev2')?.archivedAt).toBeNull()
  })

  test('automatic forwardTo restores an archived recipient', async () => {
    group('devs', 'onLimit: { forwardTo: dev2 }')
    records.set('dev2', record('dev2', { claudeProfileId: 'claude', archivedAt: iso(T0) }))
    const m = deliver()
    work()
    await hitLimit(5 * 60 * MIN)
    expect(store.get(m.id)?.state).toBe('forwarded')
    expect(records.get('dev2')?.archivedAt).toBeNull()
  })

  test('handoff to the limited profile refuses without cancelling the existing resume', async () => {
    records.set('dev2', record('dev2', { archivedAt: iso(T0) }))
    const m = deliver()
    work()
    await hitLimit(40 * MIN)
    const resumeId = store.get(m.id)!.resumeMessageId!
    expect(() => outcomes.handOff(m.id, { kind: 'session', id: 'dev2' })).toThrow('limited profile glm')
    expect(store.get(m.id)?.state).toBe('parked')
    expect(store.get(resumeId)?.state).toBe('queued')
    expect(records.get('dev2')?.archivedAt).toBe(iso(T0))
  })

  test('an invalid automatic target forwards to the same group with its handoff', async () => {
    group('devs', 'onLimit: { forwardTo: dev }')
    const m = deliver()
    work()
    await hitLimit(5 * 60 * MIN)
    expect(store.get(m.id)?.state).toBe('forwarded')
    const forwarded = store.get(store.get(m.id)!.reason!.replace('forwarded: ', ''))
    expect(forwarded).toMatchObject({ state: 'queued', toKind: 'group', toId: 'devs', handoff: { fromProfile: 'glm' } })
    expect(String(errors.at(-1))).toContain('limited profile glm')
  })

  test('onLimit receives the task worktree and the previous handoff profile', async () => {
    ruleOnLimit = async ctx => {
      expect(ctx.message).toMatchObject({ worktree: '/repo/worktree', forwardedFromProfile: 'mimo' })
      return { type: 'release' }
    }
    deliver('dev', { handoff: { fromSession: 'previous', fromProfile: 'mimo', claimCommit: null, lastError: null,
      progress: { toolCalls: 1, tools: ['Edit'], filesTouched: ['x'] } } })
    await hitLimit(40 * MIN)
    expect(errors).toEqual([])
  })

  test.each([false, true])('no-group direct work with progress=%p is scheduled back to its original recipient', async progress => {
    records.set('dev', record('dev', { groupId: null }))
    const m = deliver('dev', { toKind: 'session', toId: 'dev' })
    if (progress) work()
    await hitLimit(5 * 60 * MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'queued', toKind: 'session', toId: 'dev', claimedBy: null,
      deliverAt: iso(T0 + 5 * 60 * MIN) })
    expect(store.listForTeam('team').map(row => row.id)).toContain(m.id)
    expect(errors).toEqual([])
  })

  test('an expired reset retries progressed work without parking or incrementing parkCount', async () => {
    const m = deliver()
    work()
    await hitLimit(-MIN)
    expect(store.get(m.id)).toMatchObject({ state: 'queued', parkCount: 0, resumeMessageId: null })
    expect(store.parkedBy('dev')).toEqual([])
  })
})

test('manual handoff wins while a resume limit rule is still running', async () => {
  const m = deliver()
  work()
  await hitLimit(40 * MIN)
  const resumeId = store.get(m.id)!.resumeMessageId!
  store.claim(resumeId, 'dev'); store.markPushed(resumeId); store.markDelivered(resumeId)
  outcomes.delivered('dev', store.get(resumeId)!)
  let finishRule!: (value: LimitOutcome) => void
  ruleOnLimit = () => new Promise(resolve => { finishRule = resolve })
  const pending = hitLimit(40 * MIN)
  const forwarded = outcomes.handOff(m.id, { kind: 'group', id: 'architects' })
  finishRule({ type: 'park' })
  await pending
  expect(store.get(m.id)?.state).toBe('forwarded')
  expect(store.listForTeam('team').map(row => row.id)).toEqual([forwarded.id])
})
