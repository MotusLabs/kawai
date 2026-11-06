// Group-mail aging properties (group-mail-task-affinity D4, task 5.2) over
// the production dispatcher and router composition (hazard M1).
//
// The generator replays the incident's ping-pong: two lead members, each
// finding a direct message from the other waiting at every idle moment, and
// one normal group message whose affinity task `a` owns, with clock steps of
// 1–5 minutes. Per case the group's `affinityWait` is 0, 10, or 30 minutes,
// and the owner either stays busy or idles at random.
//
// - P1, no starvation (seed 4242, 300 cases): the group message is claimed
//   no later than the earlier of the owner's first idle moment at or after
//   15 minutes and within the wait (and then by the owner), and the first
//   idle moment of any member at or after max(15 min, wait).
// - P2, at most one claim (seed 4243, 300 cases): the same generator with
//   replayed notifications, a restart (a fresh dispatcher over the same
//   store) between passes, and human turns that arrive while a delivery is
//   being prepared; no message is ever claimed by two sessions, or twice.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { MailDispatcher, type MailRecipient } from '../team/dispatcher'
import { parseGroupFile, type GroupDefinition } from '../team/groupFile'
import { MailboxStore } from '../team/mailboxStore'
import { ProfileRouter } from '../team/routing/router'
import { taskOwnerResolver } from '../team/taskOwnerResolver'
import { TaskStore } from '../team/taskStore'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { schemaCopy } from './schemaDb'

const MIN = 60_000
const T0 = Date.parse('2026-01-05T09:00:00.000Z')
const AGED = 15 * MIN

let root: string
let team: TeamIdentity
beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-aging-property-')))
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }
  git(['init', '-q'])
  clearTeamCache()
  team = await resolveTeam(root)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** A seeded generator (mulberry32). */
function rng(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6D2B79F5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function leadGroup(waitMin: number): GroupDefinition {
  const parsed = parseGroupFile('lead', `---\naffinity: task-owner\naffinityWait: ${waitMin}\n---\nLead.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

interface CaseResult {
  waitMs: number
  /** Pass times with the members idle at the pass's start. */
  moments: Array<{ at: number; idle: string[] }>
  /** Every claim: message, session, time. */
  claims: Array<{ id: string; sessionId: string; at: number }>
  groupId: string
}

/** One generated case; `chaos` adds P2's replays, restarts, and human turns. */
async function runCase(random: () => number, chaos: boolean): Promise<CaseResult> {
  const waitMin = [0, 10, 30][Math.floor(random() * 3)]!
  const ownerStaysBusy = random() < 0.4
  const db: Database = schemaCopy()
  const store = new MailboxStore(db)
  const tasks = new TaskStore(db, store)
  const records = new Map<string, ChatSessionRecord>(['a', 'b'].map(sessionId => [sessionId, {
    sessionId, name: sessionId, projectPath: root, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '', groupId: 'lead',
  }]))
  const recipients: MailRecipient[] = ['a', 'b'].map(sessionId => ({
    sessionId, teamId: team.teamId, groupId: 'lead', idle: false, pendingRequest: false, available: true, worktree: root,
  }))
  const group = leadGroup(waitMin)
  let clock = T0
  const claims: CaseResult['claims'] = []
  const moments: CaseResult['moments'] = []
  let humanTurns = false
  const build = () => new MailDispatcher(store, {
    recipients: () => recipients,
    prepare: async id => {
      // A human turn arriving while the delivery is prepared (P2): the member is busy at the claim.
      if (humanTurns && random() < 0.25) recipients.find(row => row.sessionId === id)!.idle = false
    },
    interrupt: async () => {},
    deliver: id => { recipients.find(row => row.sessionId === id)!.idle = false },
    watchReceipt: () => {},
    claimed: (message, sessionId) => { claims.push({ id: message.id, sessionId, at: clock }) },
    router: new ProfileRouter({
      groupOf: async () => group,
      members: () => ['a', 'b'].map(sessionId => ({ sessionId, profileId: 'default', cwd: root })),
      targetWorktree: () => null,
      staffing: { spawnContext: async () => null, spawnFor: async () => null },
      rules: { rule: () => undefined },
      limits: {
        forProfile: () => [], forProvider: () => [], providerCooldownUntil: () => null,
        cooldownFor: (_id, providerId) => ({ until: null, provider: false, providerId: providerId ?? null }),
      },
      usageOf: () => null, providerUsageOf: () => null, now: () => clock,
    }),
    taskOwner: taskOwnerResolver({ tasks, getRecord: id => records.get(id), teamOf: id => (records.has(id) ? team.teamId : undefined) }),
    now: () => clock,
  })
  let dispatcher = build()
  try {
    const task = tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'agent', sessionId: 'a' } }).id
    const groupMail = store.enqueue({
      teamId: team.teamId, toKind: 'group', toId: 'lead', fromSession: 'dev', fromGroup: 'devs', originPath: root, body: 'report', affinityTask: task,
    }, new Date(T0).toISOString())
    while (clock < T0 + 75 * MIN) {
      clock += (1 + Math.floor(random() * 5)) * MIN
      for (const row of recipients) {
        if (!row.idle && !(row.sessionId === 'a' && ownerStaysBusy) && random() < 0.5) row.idle = true
      }
      // Each idle member finds a direct message from the other waiting.
      for (const row of recipients.filter(entry => entry.idle)) {
        const waiting = store.nextEligible({ teamId: team.teamId, sessionId: row.sessionId, groupId: null }, undefined, message => message.toKind === 'session')
        if (!waiting) {
          store.enqueue({
            teamId: team.teamId, toKind: 'session', toId: row.sessionId, fromSession: row.sessionId === 'a' ? 'b' : 'a', fromGroup: 'lead', originPath: root, body: 'ping',
          }, new Date(clock).toISOString())
        }
      }
      moments.push({ at: clock, idle: recipients.filter(entry => entry.idle).map(entry => entry.sessionId) })
      if (chaos && random() < 0.3) {
        dispatcher.close()
        dispatcher = build()
        dispatcher.release()
      }
      humanTurns = chaos
      dispatcher.notify()
      if (chaos && random() < 0.5) dispatcher.notify()
      await dispatcher.settled()
      humanTurns = false
      if (claims.some(claim => claim.id === groupMail.id)) break
    }
    return { waitMs: waitMin * MIN, moments, claims, groupId: groupMail.id }
  } finally {
    dispatcher.close()
    db.close()
  }
}

describe('group-mail aging properties', () => {
  // @covers: agent-mailbox › Delivery order › Group mail is not starved by a steady direct stream
  test('P1: seed 4242, 300 cases — a steady direct stream never starves the group message', async () => {
    const random = rng(4242)
    let byOwner = 0
    let byAny = 0
    for (let index = 0; index < 300; index++) {
      const result = await runCase(random, false)
      const ownerMoment = result.moments.find(moment => moment.at - T0 >= AGED && moment.at - T0 < result.waitMs && moment.idle.includes('a'))
      const anyMoment = result.moments.find(moment => moment.at - T0 >= Math.max(AGED, result.waitMs) && moment.idle.length > 0)
      const bound = Math.min(ownerMoment?.at ?? Infinity, anyMoment?.at ?? Infinity)
      if (bound === Infinity) continue
      const claim = result.claims.find(entry => entry.id === result.groupId)
      expect({ index, claimedBy: bound }).toEqual({ index, claimedBy: claim && claim.at <= bound ? bound : -1 })
      if (ownerMoment && ownerMoment.at === bound) {
        byOwner++
        expect({ index, to: claim!.sessionId }).toEqual({ index, to: 'a' })
      } else byAny++
    }
    // Non-vacuity: both arms of the bound are reached.
    expect(byOwner).toBeGreaterThan(20)
    expect(byAny).toBeGreaterThan(20)
  }, 120_000)

  test('P2: seed 4243, 300 cases — with replays, restarts, and racing human turns, no message is claimed twice', async () => {
    const random = rng(4243)
    let claimsSeen = 0
    for (let index = 0; index < 300; index++) {
      const result = await runCase(random, true)
      const byMessage = new Map<string, string[]>()
      for (const claim of result.claims) byMessage.set(claim.id, [...(byMessage.get(claim.id) ?? []), claim.sessionId])
      for (const [id, sessions] of byMessage) expect({ index, id, sessions: sessions.length }).toEqual({ index, id, sessions: 1 })
      claimsSeen += result.claims.length
    }
    expect(claimsSeen).toBeGreaterThan(1000)
  }, 120_000)
})
