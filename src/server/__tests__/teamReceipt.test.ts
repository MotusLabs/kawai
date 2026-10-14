// Recovery decisions are proven by CLI transcript rows, never SDK display
// events. Held group claims retry only to their original recipient.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MailboxStore } from '../team/mailboxStore'
import { formatEnvelope, messageEnvelope } from '../team/envelope'
import { receiptMessageId, reconcileMailbox } from '../team/receipt'
import { watchTranscriptTitle } from '../chat/transcriptTitleWatcher'

let dir: string
let file: string
let db: Database
let store: MailboxStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-receipt-')); file = path.join(dir, 'transcript.jsonl')
  db = new Database(':memory:'); store = new MailboxStore(db)
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
const claim = (push = true) => {
  const message = store.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'Work' })
  store.claim(message.id, 'dev'); if (push) store.markPushed(message.id)
  return store.get(message.id)!
}
const row = (message: ReturnType<typeof claim>) => JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: formatEnvelope(messageEnvelope(message)) } })

test('live receipt waits for a complete transcript row and uses rearming watcher', async () => {
  const mail = claim(); fs.writeFileSync(file, '')
  const watcher = watchTranscriptTitle(file, () => {}, line => {
    const id = receiptMessageId(line); if (id) store.markDelivered(id)
  })
  try {
    expect(store.get(mail.id)?.deliveredAt).toBeNull()
    fs.appendFileSync(file, row(mail))
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(store.get(mail.id)?.state).toBe('claimed')
    fs.appendFileSync(file, '\n')
    for (let i = 0; i < 30 && !store.get(mail.id)?.deliveredAt; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(store.get(mail.id)?.state).toBe('delivered')
  } finally { watcher.close() }
})
test('crash after delivery marks receipt without redelivery', () => {
  const mail = claim(); fs.writeFileSync(file, row(mail) + '\n')
  reconcileMailbox(store, () => file)
  expect(store.get(mail.id)?.state).toBe('delivered')
  expect(store.nextEligible({ teamId: 'team', sessionId: 'dev', groupId: 'devs' })).toBeNull()
})
test('crash after claim before push requeues without reading transcript', () => {
  const mail = claim(false); reconcileMailbox(store, () => null)
  expect(store.get(mail.id)).toMatchObject({ state: 'queued', claimedBy: null, pushedAt: null })
})
test('clean transcript without the input refutes receipt and requeues', () => {
  const mail = claim(); fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'Other turn' } }) + '\n')
  reconcileMailbox(store, () => file)
  expect(store.get(mail.id)?.state).toBe('queued')
})
test('torn transcript holds uncertain without reassignment', () => {
  const mail = claim(); fs.writeFileSync(file, '{"type":')
  reconcileMailbox(store, () => file)
  expect(store.get(mail.id)).toMatchObject({ state: 'uncertain', claimedBy: 'dev' })
})
test('missing and unreadable transcript hold uncertain', () => {
  for (const transcript of [null, dir]) {
    const mail = claim(); reconcileMailbox(store, () => transcript)
    expect(store.get(mail.id)?.state).toBe('uncertain')
  }
})
test('human uncertain retry stays with recipient and carries duplicate notice; discard is explicit', () => {
  const mail = claim(); reconcileMailbox(store, () => null); store.retry(mail.id)
  expect(store.get(mail.id)).toMatchObject({ toKind: 'session', toId: 'dev', possibleDuplicate: true })
  expect(store.nextEligible({ teamId: 'team', sessionId: 'other', groupId: 'devs' })).toBeNull()
  expect(formatEnvelope(messageEnvelope(store.get(mail.id)!))).toContain('Possible duplicate')
  const held = claim(); reconcileMailbox(store, () => null)
  expect(store.discard(held.id, { kind: 'human' })).toBe(true)
  expect(store.get(held.id)?.state).toBe('discarded')
})
test('assistant and sidechain echoes never prove receipt', () => {
  const mail = claim()
  const user = JSON.parse(row(mail))
  expect(receiptMessageId(JSON.stringify({ ...user, type: 'assistant' }))).toBeNull()
  expect(receiptMessageId(JSON.stringify({ ...user, isSidechain: true }))).toBeNull()
})
