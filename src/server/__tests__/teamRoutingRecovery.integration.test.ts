// Real mailbox, rule Workers, team catalogs, and dispatcher exercise recovery
// across a rule reload and a handoff to an archived recipient.
import { expect, test } from 'bun:test'
import { schemaDb } from './schemaDb'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionMailbox } from '../team/sessionMailbox'
import { SessionTeams } from '../team/sessionTeams'
import type { ChatSessionRecord } from '../db'
import type { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { NULL_OWNERSHIP } from '../plans/execution/executionOwnership'

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-routing-recovery-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.mkdirSync(path.join(root, '.kawai/routing'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), 'Build features')
  const records = new Map<string, ChatSessionRecord>()
  for (const id of ['dev', 'other']) records.set(id, {
    sessionId: id, name: id, projectPath: repo, sdkSessionId: null, status: 'waiting',
    groupId: 'devs', claudeProfileId: id === 'dev' ? 'glm' : 'default', createdAt: '', lastActivityAt: '',
  })
  const teams = new SessionTeams({ homeDir: root })
  await Promise.all([...records.keys()].map(id => teams.track(id, repo)))
  const db = schemaDb(':memory:')
  const pushed: Array<{ session: string; message: string }> = []
  const errors: unknown[] = []
  const mailbox = new SessionMailbox(db, {
    ownership: NULL_OWNERSHIP, onTaskResultWrite: () => {},
    teams, records: () => records.values(), getRecord: id => records.get(id),
    getDriver: id => ({ getPendingRequests: () => [], deliver: (peer: { messageId: string }) => {
      pushed.push({ session: id, message: peer.messageId })
      records.get(id)!.status = 'working'
    } }) as unknown as ChatSessionDriver,
    available: record => record.archivedAt == null, prepare: async () => {},
    restore: id => { records.get(id)!.archivedAt = null },
    watchReceipt: () => {}, archive: id => { const row = records.get(id); if (row) row.archivedAt = new Date().toISOString(); return { ok: true } }, hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false, transcriptFor: () => null, homeDir: root,
    onError: error => errors.push(error),
  })
  // This fixture drives recovery and rule loading explicitly.
  mailbox.dispatcher.release()
  const store = mailbox.mailbox.store
  const send = () => store.enqueue({ teamId: teams.teamOf('dev')!.teamId, toKind: 'group', toId: 'devs',
    fromSession: 'dev', fromGroup: 'devs', originPath: repo, body: 'Build export' })
  return { root, records, mailbox, store, send, pushed, errors,
    close: () => { mailbox.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('reloading a real rule releases its indefinite hold without a candidate change', async () => {
  const f = await fixture()
  try {
    const file = path.join(f.root, '.kawai/routing/devs.ts')
    fs.writeFileSync(file, "export default { route: () => ({ type: 'hold', reason: 'operator hold' }) }")
    await f.mailbox.rules.reload()
    const message = f.send()
    f.mailbox.dispatcher.notify()
    await f.mailbox.dispatcher.settled()
    expect(f.store.get(message.id)?.state).toBe('queued')
    expect(f.pushed).toEqual([])
    fs.writeFileSync(file, "export default { route: () => ({ type: 'pick', candidateId: 'member:dev' }) }")
    await f.mailbox.rules.reload()
    await f.mailbox.dispatcher.settled()
    expect(f.pushed).toEqual([{ session: 'dev', message: message.id }])
    expect(f.errors).toEqual([])
  } finally { f.close() }
})

test('a handoff restores an archived recipient and is pushed as its first turn', async () => {
  const f = await fixture()
  try {
    f.records.get('other')!.archivedAt = new Date().toISOString()
    const message = f.send()
    f.store.claim(message.id, 'dev'); f.store.markPushed(message.id); f.store.markDelivered(message.id)
    const resume = f.store.enqueue({ teamId: message.teamId, toKind: 'session', toId: 'dev', fromSession: 'dev',
      fromGroup: 'devs', originPath: message.originPath, body: 'Resume', deliverAt: '2099-01-01T00:00:00Z' })
    f.store.park(message.id, resume.deliverAt!, resume.id)
    const forwarded = f.mailbox.handOff(message.id, { kind: 'session', id: 'other' })
    await f.mailbox.dispatcher.settled()
    expect(f.records.get('other')!.archivedAt).toBeNull()
    expect(f.store.get(message.id)?.state).toBe('forwarded')
    expect(f.store.get(resume.id)?.state).toBe('cancelled')
    expect(f.store.get(forwarded.id)).toMatchObject({ state: 'claimed', claimedBy: 'other' })
    expect(f.pushed).toEqual([{ session: 'other', message: forwarded.id }])
    expect(f.errors).toEqual([])
  } finally { f.close() }
})

test('no-group direct work is retried automatically after the provider reset', async () => {
  const f = await fixture()
  try {
    f.records.get('dev')!.groupId = null
    const seed = f.send()
    f.store.cancel(seed.id, { kind: 'human' })
    const message = f.store.enqueue({ teamId: seed.teamId, toKind: 'session', toId: 'dev', fromSession: 'other',
      fromGroup: 'devs', originPath: seed.originPath, body: 'Build export' })
    f.store.claim(message.id, 'dev'); f.store.markPushed(message.id); f.store.markDelivered(message.id)
    f.mailbox.outcomes.delivered('dev', message)
    const reset = new Date(Date.now() + 100).toISOString()
    f.mailbox.limits.record({ profileId: 'glm', sessionId: 'dev', groupId: null, kind: 'rate_limit',
      final: true, status: 429, message: 'quota', resetsAt: reset })
    await f.mailbox.outcomes.turnEnded('dev', false)
    f.mailbox.dispatcher.notify()
    await f.mailbox.dispatcher.settled()
    expect(f.store.get(message.id)).toMatchObject({ state: 'queued', toId: 'dev', deliverAt: reset })
    expect(f.pushed).toEqual([])
    const deadline = Date.now() + 1000
    while (f.pushed.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(f.pushed).toEqual([{ session: 'dev', message: message.id }])
    expect(f.errors).toEqual([])
  } finally { f.close() }
})
