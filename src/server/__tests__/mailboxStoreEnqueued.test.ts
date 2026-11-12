// `MailboxStore.subscribeEnqueued` (manual-task-stall-alerts D2, task 3.1):
// it fires once per enqueue with the inserted row, and never for a claim,
// push, delivery, or any other transition of an existing message; the
// general `subscribe` keeps firing for both.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schemaDb } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'

const TEAM = '/repo/.git'
let dir: string
let db: Database
let store: MailboxStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mailbox-enqueued-'))
  db = schemaDb(path.join(dir, 'mail.db'))
  store = new MailboxStore(db)
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const send = (body: string) => store.enqueue({
  teamId: TEAM, toKind: 'session', toId: 'chat-dev', fromSession: 'chat-lead', fromGroup: 'leads', originPath: '/repo', body,
})

test('subscribeEnqueued fires once per enqueue and never for claim, push, or delivery', () => {
  const enqueued: string[] = []
  const general: string[] = []
  const stop = store.subscribeEnqueued(message => enqueued.push(`${message.id}:${message.state}:${message.body}`))
  store.subscribe((_teamId, message) => { if (message) general.push(message.id) })

  const first = send('one')
  expect(enqueued).toEqual([`${first.id}:queued:one`])
  expect(store.claim(first.id, 'chat-dev')).toBe(true)
  expect(store.markPushed(first.id)).toBe(true)
  expect(store.markDelivered(first.id)).toBe(true)
  expect(enqueued).toEqual([`${first.id}:queued:one`])
  // The general listener saw the enqueue and every transition.
  expect(general.filter(id => id === first.id).length).toBeGreaterThanOrEqual(4)

  const second = send('two')
  expect(enqueued).toEqual([`${first.id}:queued:one`, `${second.id}:queued:two`])
  stop()
  send('three')
  expect(enqueued).toHaveLength(2)
})
