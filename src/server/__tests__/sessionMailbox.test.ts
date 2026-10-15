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
    teams, records: () => records.values(), getRecord: id => records.get(id), available: record => !record.archivedAt,
    getDriver: id => ({ getPendingRequests: () => [], deliver: () => { records.get(id)!.status = 'working' } }) as unknown as ChatSessionDriver,
    prepare: async () => {}, restore: () => {}, watchReceipt: () => {}, archive: () => ({ ok: true }), hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false, transcriptFor: () => file, onError: error => { throw error },
  })
  // These tests drive dispatch directly, without start()'s recovery pass.
  runtime.dispatcher.release()
})
afterEach(() => { runtime.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
const mail = () => runtime.mailbox.store.enqueue({ teamId: dir, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: dir, body: 'Work' })

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
