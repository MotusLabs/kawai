// Lifecycle reconciliation keeps unconfirmed pushes visible, while recipient
// snapshots share a team's catalog across startup and atomic claim rechecks.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { SessionMailbox } from '../team/sessionMailbox'
import { SessionTeams } from '../team/sessionTeams'
import { messageEnvelope, formatEnvelope } from '../team/envelope'
import { mailboxHandlers } from '../team/mailboxTools'
import { NULL_OWNERSHIP } from '../plans/execution/executionOwnership'
import { profileCatalogLevels, providerOf } from '../chat/profileCatalog'
import { catalogCtx } from '../team/cooldowns'
import type { MailRecipient } from '../team/dispatcher'

let dir: string
let db: Database
let records: Map<string, ChatSessionRecord>
let teams: SessionTeams
let runtime: SessionMailbox
let file: string
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mail-lifecycle-'))
  fs.mkdirSync(path.join(dir, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.kawai/groups/devs.md'), 'Build features')
  file = path.join(dir, 'transcript.jsonl'); fs.writeFileSync(file, '')
  db = schemaDb(':memory:'); records = new Map(); teams = new SessionTeams({ homeDir: dir })
  for (let i = 0; i < 8; i++) {
    const id = `dev-${i}`
    records.set(id, { sessionId: id, groupId: 'devs', projectPath: dir, status: 'waiting' } as ChatSessionRecord)
    await teams.track(id, dir)
  }
  runtime = new SessionMailbox(db, {
    ownership: NULL_OWNERSHIP, onTaskResultWrite: () => {},
    teams, records: () => records.values(), getRecord: id => records.get(id), available: record => !record.archivedAt,
    getDriver: id => ({ getPendingRequests: () => [], deliver: () => { records.get(id)!.status = 'working' } }) as unknown as ChatSessionDriver,
    prepare: async () => {}, restore: () => {}, watchReceipt: () => {}, archive: () => ({ ok: true }), hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false, transcriptFor: () => file, homeDir: dir, onError: error => { throw error },
  })
  // These tests drive dispatch directly, without start()'s recovery pass.
  runtime.dispatcher.release()
})
afterEach(() => { runtime.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
const mail = () => runtime.mailbox.store.enqueue({ teamId: dir, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: dir, body: 'Work' })

// B1(a) (providers-and-workers 4.4/4.6, findings-7f4df8a6): through the real
// wiring — the store, providerOf over the shipped catalog, and the wired
// refusal — glm's provider-scoped limit cools the glm-flash recipient row
// (cooldownProvider 'zai') and urgent direct mail names profile and provider.
test("a sibling's provider limit cools the recipient row and the urgent refusal names it", async () => {
  records.set('lead', { sessionId: 'lead', groupId: 'leads', projectPath: dir, status: 'waiting' } as ChatSessionRecord)
  records.set('flash', { sessionId: 'flash', groupId: 'devs', projectPath: dir, claudeProfileId: 'glm-flash', status: 'waiting' } as ChatSessionRecord)
  await teams.track('lead', dir)
  await teams.track('flash', dir)
  const untilMs = Date.now() + 3_600_000
  const until = new Date(untilMs).toISOString()
  runtime.limits.record({
    profileId: 'glm', sessionId: 'flash', groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
    message: 'quota', resetsAt: until, providerId: 'zai', window: null,
  })
  // Urgent direct mail to the glm-flash session is refused with the full string.
  const error = await mailboxHandlers(runtime.mailbox, 'lead').send_message({ to_kind: 'session', to_id: 'flash', body: 'Now!', urgent: true })
    .then(() => null, e => e as Error)
  const time = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  expect(error?.message).toBe(`Session flash runs on profile glm-flash of provider zai, which is cooling down after a provider limit until ${time} (${until}). ` +
    'Send it without urgent to queue it, or send it to another agent.')
  expect(runtime.mailbox.store.teamsWithQueuedMail()).toEqual([])
  // The recipient row cools with the deciding provider: a queued direct
  // message's waiting reason carries retryAt, the provider detail, and its
  // catalog label resolved from the shipped providers (O1).
  const direct = runtime.mailbox.store.enqueue({ teamId: dir, toKind: 'session', toId: 'flash', fromSession: 'lead', fromGroup: 'leads', originPath: dir, body: 'Later' })
  runtime.dispatcher.notify()
  await runtime.dispatcher.settled()
  const waiting = runtime.waitingFor(dir)
  expect(waiting[direct.id]!.blocker).toEqual({ kind: 'profile-cooling', retryAt: until, detail: 'zai', providerLabel: 'Z.AI' })
})

// openrouter-provider D8 through the same wiring: a credit limit on
// openrouter-opus cools its openrouter-sonnet sibling, the urgent refusal says
// out of credit, and the queued direct mail's reason carries the credit mark.
test('a sibling out of credit: the urgent refusal and the waiting reason say out of credit', async () => {
  records.set('lead', { sessionId: 'lead', groupId: 'leads', projectPath: dir, status: 'waiting' } as ChatSessionRecord)
  records.set('or', { sessionId: 'or', groupId: 'devs', projectPath: dir, claudeProfileId: 'openrouter-sonnet', status: 'waiting' } as ChatSessionRecord)
  await teams.track('lead', dir)
  await teams.track('or', dir)
  const at = Date.now()
  const until = new Date(at + 3_600_000).toISOString()
  runtime.limits.record({
    profileId: 'openrouter-opus', sessionId: 'or', groupId: 'devs', kind: 'unknown', final: true, status: 402,
    message: 'API Error: 402', resetsAt: null, providerId: 'openrouter', window: 'credit', at: new Date(at).toISOString(),
  })
  const error = await mailboxHandlers(runtime.mailbox, 'lead').send_message({ to_kind: 'session', to_id: 'or', body: 'Now!', urgent: true })
    .then(() => null, e => e as Error)
  const time = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  expect(error?.message).toBe(`Session or runs on profile openrouter-sonnet of provider openrouter, which is out of credit; its cooldown ends by ${time} (${until}) at the latest. ` +
    'Send it without urgent to queue it, or send it to another agent.')
  const direct = runtime.mailbox.store.enqueue({ teamId: dir, toKind: 'session', toId: 'or', fromSession: 'lead', fromGroup: 'leads', originPath: dir, body: 'Later' })
  runtime.dispatcher.notify()
  await runtime.dispatcher.settled()
  // The merged constraint carries the catalog label (providers-and-workers O1)
  // beside the credit mark (openrouter-provider D8) and the raw provider id.
  expect(runtime.waitingFor(dir)[direct.id]!.blocker).toEqual({ kind: 'profile-cooling', providerLabel: 'OpenRouter', retryAt: until, detail: 'openrouter', credit: true })
  // A pull showing credit grew ends it early, everywhere the cooldown is read.
  runtime.limits.reportRemainingCredit('openrouter', 0.01)
  await Bun.sleep(2)
  runtime.limits.reportRemainingCredit('openrouter', 10)
  expect(await mailboxHandlers(runtime.mailbox, 'lead').send_message({ to_kind: 'session', to_id: 'or', body: 'Now!', urgent: true }))
    .toMatchObject({ state: 'queued' })
})

test('one catalog read per team per dispatch cycle despite eight recipients and claim rechecks', async () => {
  const read = spyOn(fs, 'readFileSync')
  try {
    mail(); mail(); mail(); mail()
    runtime.dispatcher.notify(); await runtime.dispatcher.settled()
    const groupReads = read.mock.calls.filter(call => String(call[0]).endsWith('/devs.md'))
    expect(groupReads).toHaveLength(1)
    expect(runtime.mailbox.store.unacknowledgedClaims()).toHaveLength(4)
  } finally { read.mockRestore() }
})
test('live release confirms a recorded receipt before the watcher is removed', () => {
  const store = runtime.mailbox.store; const row = mail()
  store.claim(row.id, 'dev-0'); store.markPushed(row.id)
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: formatEnvelope(messageEnvelope(row)) } }) + '\n')
  runtime.settleRecipient('dev-0')
  expect(store.get(row.id)?.state).toBe('delivered')
})
test('clean but still-live or unavailable transcript holds pushed mail instead of unsafe redelivery', () => {
  const store = runtime.mailbox.store
  for (const missing of [false, true]) {
    if (missing) fs.rmSync(file)
    const row = mail(); store.claim(row.id, 'dev-0'); store.markPushed(row.id)
    runtime.settleRecipient('dev-0')
    expect(store.get(row.id)).toMatchObject({ state: 'uncertain', claimedBy: 'dev-0' })
  }
})
test('killed recipient cannot be revived by uncertain retry; an unpushed claim requeues', () => {
  const store = runtime.mailbox.store; const row = mail()
  store.claim(row.id, 'dev-0'); store.markPushed(row.id); runtime.settleRecipient('dev-0')
  records.delete('dev-0')
  expect(store.retry(row.id)).toBe(false)
  expect(store.get(row.id)).toMatchObject({ state: 'dead', toKind: 'session', toId: 'dev-0', reason: 'killed-recipient' })
  const unpushed = mail(); store.claim(unpushed.id, 'dev-1'); runtime.settleRecipient('dev-1')
  expect(store.get(unpushed.id)?.state).toBe('queued')
})
test('a late durable receipt confirms held mail without another push', () => {
  const store = runtime.mailbox.store; const row = mail()
  store.claim(row.id, 'dev-0'); store.markPushed(row.id); runtime.settleRecipient('dev-0')
  expect(store.get(row.id)?.state).toBe('uncertain')
  expect(store.markDelivered(row.id)).toBe(true)
  expect(store.get(row.id)?.state).toBe('delivered')
})

// W1 (catalog-resolution-cache Table W, findings-f4b1ebad B1): the sweep the
// mailbox hands its dispatcher (sessionMailbox.ts `recipients`) holds one
// catalog snapshot, so each distinct context computes its input key once per
// sweep — and a second sweep computes it again. The expected counts come from
// one lookup per context outside any snapshot, anchored to the level count.
// The records carry no group: the group catalog stats the same level files
// for its own stamp (groupCatalog.ts), a separate cache once per sweep.
test("W1: the mailbox recipient sweep computes each catalog context's key once per sweep (kills R10)", () => {
  const sub = path.join(dir, 'sub')
  fs.mkdirSync(path.join(sub, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(sub, '.kawai/profiles.json'), JSON.stringify({ sub: { label: 'Sub' } }))
  for (const record of records.values()) record.groupId = null
  for (let i = 4; i < 8; i++) records.get(`dev-${i}`)!.projectPath = sub
  const contexts = [catalogCtx(dir, dir), catalogCtx(dir, sub)]
  const files = new Set(contexts.flatMap(ctx => profileCatalogLevels(ctx).map(level => level.file)))
  const stats = (read: () => unknown): number => {
    const spy = spyOn(fs, 'statSync')
    try {
      read()
      return spy.mock.calls.filter(call => files.has(String(call[0]))).length
    } finally { spy.mockRestore() }
  }
  const [kDir, kSub] = contexts.map(ctx => stats(() => providerOf('default', ctx)))
  expect([kDir, kSub]).toEqual(contexts.map(ctx => profileCatalogLevels(ctx).length))
  expect(kSub).toBeGreaterThan(kDir!)
  const { recipients } = (runtime.dispatcher as unknown as { options: { recipients(): MailRecipient[] } }).options
  let rows: MailRecipient[] = []
  expect(stats(() => { rows = recipients() })).toBe(kDir! + kSub!)
  expect(rows.map(row => row.sessionId).sort()).toEqual([...records.keys()].sort())
  expect(stats(() => recipients())).toBe(kDir! + kSub!)
})
