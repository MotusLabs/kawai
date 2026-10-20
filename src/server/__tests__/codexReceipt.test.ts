// codex-chat-sessions 6.2 (D8): a Codex recipient's receipt is a rollout
// `response_item` user message carrying the envelope — never a row that
// merely quotes it (assistant, developer, tool output, event_msg), never an
// AGENTS.md user row — and a torn or missing rollout reads uncertain.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schemaDb } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { formatEnvelope, messageEnvelope } from '../team/envelope'
import { codexReceiptMessageId, reconcileMailbox, transcriptReceipt } from '../team/receipt'

let dir: string
let file: string
let db: Database
let store: MailboxStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-receipt-')); file = path.join(dir, 'rollout.jsonl')
  db = schemaDb(':memory:'); store = new MailboxStore(db)
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const claim = () => {
  const message = store.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'Work' })
  store.claim(message.id, 'dev'); store.markPushed(message.id)
  return store.get(message.id)!
}
const envelopeOf = (mail: ReturnType<typeof claim>) => formatEnvelope(messageEnvelope(mail))
const message = (role: string, type: string, text: string) =>
  JSON.stringify({ timestamp: '2026-10-20T00:00:00Z', type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } })
const userRow = (text: string) => message('user', 'input_text', text)
const write = (...rows: string[]) => fs.writeFileSync(file, rows.map(row => `${row}\n`).join(''))

test('a rollout user message carrying the envelope is the receipt', () => {
  const mail = claim()
  expect(codexReceiptMessageId(userRow(envelopeOf(mail)))).toBe(mail.id)
  write(JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }), userRow(envelopeOf(mail)))
  expect(transcriptReceipt(file, mail.id, codexReceiptMessageId)).toBe('found')
})

test('rows that only quote the envelope, and AGENTS.md user rows, never match', () => {
  const mail = claim()
  const envelope = envelopeOf(mail)
  const quoting = [
    userRow('# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nBun 1.x\n</INSTRUCTIONS>'),
    message('assistant', 'output_text', envelope),
    message('developer', 'input_text', envelope),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: envelope } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: envelope } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: envelope } }),
    // A message-shaped payload outside a response_item (a compaction's
    // replacement history, any other row kind) is not the delivered input.
    JSON.stringify({ type: 'compacted', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: envelope }] } }),
    // A user-role response_item that is not a message (a hypothetical item
    // kind carrying input text) is not the delivered input either.
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', role: 'user', content: [{ type: 'input_text', text: envelope }] } }),
    // A Claude-shaped user row is not a Codex receipt either.
    JSON.stringify({ type: 'user', message: { role: 'user', content: envelope } }),
  ]
  for (const row of quoting) expect(codexReceiptMessageId(row)).toBeNull()
  write(...quoting)
  expect(transcriptReceipt(file, mail.id, codexReceiptMessageId)).toBe('absent')
})

test('a torn or missing rollout holds pushed mail as uncertain at reconciliation', () => {
  const torn = claim()
  write(userRow('hello'), '{"type":"response_item","payload":{"type":"mess')
  reconcileMailbox(store, () => file, () => codexReceiptMessageId)
  expect(store.get(torn.id)?.state).toBe('uncertain')

  const missing = claim()
  reconcileMailbox(store, () => path.join(dir, 'absent.jsonl'), () => codexReceiptMessageId)
  expect(store.get(missing.id)?.state).toBe('uncertain')
})

test('reconciliation with the Codex parser delivers found mail and requeues a complete rollout without it', () => {
  const found = claim()
  const absent = claim()
  write(userRow(envelopeOf(found)))
  reconcileMailbox(store, () => file, () => codexReceiptMessageId)
  expect(store.get(found.id)?.state).toBe('delivered')
  expect(store.get(absent.id)?.state).toBe('queued')
})
