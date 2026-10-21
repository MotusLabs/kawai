// PR D decision 2, M1–M2: a Codex chat's receipt reads every rollout file
// of its thread — the stored transcript_path plus a bounded walk of
// <codex_home>/sessions — and fails closed: absence requeues only when the
// reader is proven (some file holds a recognized envelope row) and the
// stored path carries the thread id; otherwise the mail is held.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schemaDb } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { formatEnvelope, messageEnvelope } from '../team/envelope'
import { reconcileMailbox } from '../team/receipt'
import { codexRolloutReceipt, threadRolloutFiles, type CodexReceiptSource } from '../team/codexReceipt'

const THREAD = '019a0000-0000-7000-8000-000000000001'
let home: string
let db: Database
let store: MailboxStore
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-rollouts-'))
  db = schemaDb(':memory:'); store = new MailboxStore(db)
})
afterEach(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }) })

const claim = (session = 'dev') => {
  const message = store.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'Work' })
  store.claim(message.id, session); store.markPushed(message.id)
  return store.get(message.id)!
}
const envelopeOf = (mail: ReturnType<typeof claim>) => formatEnvelope(messageEnvelope(mail))
/** The documented RolloutLine shape: {timestamp, type, payload: ResponseItem}. */
const userRow = (text: string, block = 'input_text') => JSON.stringify({
  timestamp: '2026-10-20T00:00:00.000Z', type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: block, text }] },
})
const meta = (thread = THREAD) => JSON.stringify({ timestamp: '2026-10-20T00:00:00.000Z', type: 'session_meta', payload: { id: thread } })
/** A rollout file at `sessions/<dirs…>/rollout-<ts>-<thread>.jsonl`. */
const rollout = (dirs: string[], rows: string[], thread = THREAD, ts = '2026-10-20T00-00-00') => {
  const file = path.join(home, 'sessions', ...dirs, `rollout-${ts}-${thread}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map(row => `${row}\n`).join(''))
  return file
}
const NESTED = ['2026', '10', '20']
const source = (transcriptPath: string | null, threadId = THREAD): CodexReceiptSource => ({ transcriptPath, codexHome: home, threadId })
const reconcile = (src: CodexReceiptSource) => reconcileMailbox(store, () => null, (_session, id) => codexRolloutReceipt(src, id))

test('the nested layout: an envelope row is found; a proven reader turns absence into a requeue', () => {
  const delivered = claim()
  const missing = claim()
  const file = rollout(NESTED, [meta(), userRow(envelopeOf(delivered))])
  expect(codexRolloutReceipt(source(file), delivered.id)).toBe('found')
  expect(codexRolloutReceipt(source(file), missing.id)).toBe('absent')
  reconcile(source(file))
  expect(store.get(delivered.id)?.state).toBe('delivered')
  expect(store.get(missing.id)?.state).toBe('queued')
})

test('an envelope in a `text` block is found, as is one in `input_text`', () => {
  const mail = claim()
  const file = rollout(NESTED, [meta(), userRow(envelopeOf(mail), 'text')])
  expect(codexRolloutReceipt(source(file), mail.id)).toBe('found')
  fs.writeFileSync(file, `${meta()}\n${userRow(envelopeOf(mail), 'input_text')}\n`)
  expect(codexRolloutReceipt(source(file), mail.id)).toBe('found')
})

test('an unproven reader holds absent mail at the startup reconcile instead of requeueing it', () => {
  const mail = claim()
  // A complete rollout whose user rows are no envelope: the parser may be
  // missing the real row shape, so absence proves nothing.
  const file = rollout(NESTED, [meta(), userRow('# AGENTS.md instructions for /repo'), userRow('hello')])
  expect(codexRolloutReceipt(source(file), mail.id)).toBe('uncertain')
  reconcile(source(file))
  expect(store.get(mail.id)?.state).toBe('uncertain')
})

test('a receipt in an older rollout of the thread is found after a resume moved transcript_path', () => {
  const old = claim()
  const fresh = claim()
  rollout(['2026', '10', '19'], [meta(), userRow(envelopeOf(old))], THREAD, '2026-10-19T09-00-00')
  const current = rollout(NESTED, [meta(), userRow('resumed')])
  expect(codexRolloutReceipt(source(current), old.id)).toBe('found')
  // Proven by the older file, so the fresh mail's absence everywhere requeues.
  expect(codexRolloutReceipt(source(current), fresh.id)).toBe('absent')
  reconcile(source(current))
  expect(store.get(old.id)?.state).toBe('delivered')
  expect(store.get(fresh.id)?.state).toBe('queued')
})

test('a flat file under sessions is found by the walk; deeper than four levels is not walked', () => {
  const flat = claim()
  const deep = claim()
  const current = rollout(NESTED, [meta()])
  rollout([], [meta(), userRow(envelopeOf(flat))], THREAD, 'flat')
  const tooDeep = rollout(['a', 'b', 'c', 'd', 'e'], [meta(), userRow(envelopeOf(deep))], THREAD, 'deep')
  expect(threadRolloutFiles(home, THREAD).files.sort()).not.toContain(tooDeep)
  expect(threadRolloutFiles(home, THREAD).files).toHaveLength(2)
  expect(codexRolloutReceipt(source(current), flat.id)).toBe('found')
  expect(codexRolloutReceipt(source(current), deep.id)).not.toBe('found')
})

test('a symlinked directory is never followed', () => {
  const mail = claim()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-outside-'))
  try {
    fs.writeFileSync(path.join(outside, `rollout-x-${THREAD}.jsonl`), `${userRow(envelopeOf(mail))}\n`)
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
    fs.symlinkSync(outside, path.join(home, 'sessions', 'link'))
    expect(threadRolloutFiles(home, THREAD).files).toEqual([])
  } finally { fs.rmSync(outside, { recursive: true, force: true }) }
})

test('a thread id that differs from the rollout file name holds absent mail, in both directions', () => {
  const proving = claim()
  const absent = claim()
  // (a) The column's file is named for another id (say Thread.sessionId):
  // the name guard trips, so absence is a hold even though the file proves.
  const otherNamed = rollout(NESTED, [meta(), userRow(envelopeOf(proving))], 'other-id')
  expect(codexRolloutReceipt(source(otherNamed), proving.id)).toBe('found')
  expect(codexRolloutReceipt(source(otherNamed), absent.id)).toBe('uncertain')
  reconcile(source(otherNamed))
  expect(store.get(proving.id)?.state).toBe('delivered')
  expect(store.get(absent.id)?.state).toBe('uncertain')

  // (b) The file is named for the thread but the stored id is another: the
  // name guard trips the other way and nothing is walked for it.
  const held = claim()
  const named = rollout(NESTED, [meta(), userRow('hello')], THREAD, '2026-10-20T01-00-00')
  expect(codexRolloutReceipt(source(named, 'other-id'), held.id)).toBe('uncertain')
  reconcile(source(named, 'other-id'))
  expect(store.get(held.id)?.state).toBe('uncertain')
})

test('two Codex chats on one home read only their own thread\'s rollouts', () => {
  const OTHER = '019a0000-0000-7000-8000-000000000002'
  const mine = claim('dev')
  const theirs = claim('dev2')
  const myFile = rollout(NESTED, [meta(), userRow(envelopeOf(mine))])
  const theirFile = rollout(NESTED, [meta(OTHER), userRow(envelopeOf(theirs))], OTHER)
  // A receipt in the other chat's file never settles this chat's mail.
  expect(codexRolloutReceipt(source(myFile), theirs.id)).toBe('absent')
  expect(codexRolloutReceipt(source(theirFile, OTHER), theirs.id)).toBe('found')
  reconcileMailbox(store, () => null, (session, id) => codexRolloutReceipt(session === 'dev' ? source(myFile) : source(theirFile, OTHER), id))
  expect(store.get(mine.id)?.state).toBe('delivered')
  expect(store.get(theirs.id)?.state).toBe('delivered')
})

test('a torn or unreadable rollout, a missing column file, or no thread id holds absent mail', () => {
  const proving = claim()
  const absent = claim()
  const current = rollout(NESTED, [meta(), userRow(envelopeOf(proving))])
  rollout(['2026', '10', '19'], [meta(), '{"type":"response_item","payload":{"type":"mess'], THREAD, '2026-10-19T00-00-00')
  expect(codexRolloutReceipt(source(current), proving.id)).toBe('found')
  expect(codexRolloutReceipt(source(current), absent.id)).toBe('uncertain')
  expect(codexRolloutReceipt(source(path.join(home, 'sessions', 'gone', `rollout-x-${THREAD}.jsonl`)), absent.id)).toBe('uncertain')
  expect(codexRolloutReceipt({ transcriptPath: current, codexHome: home, threadId: null }, proving.id)).toBe('uncertain')
  expect(codexRolloutReceipt(source(null), absent.id)).toBe('uncertain')
})

// F1 (codexReceipt.readRollout): a torn line only clears `intact` — a found
// envelope beside it is still a delivery, as transcriptReceipt reads a
// Claude transcript (found before the integrity loop).
test('a found envelope beside a torn tail in the same file reads found; absence beside it stays uncertain', () => {
  const delivered = claim()
  const absent = claim()
  const torn = '{"timestamp":"2026-10-20T00:00:01.000Z","type":"response_item","payload":{"type":"mess'
  const file = rollout(NESTED, [meta(), userRow(envelopeOf(delivered)), torn], THREAD, '2026-10-20T02-00-00')
  expect(codexRolloutReceipt(source(file), delivered.id)).toBe('found')
  expect(codexRolloutReceipt(source(file), absent.id)).toBe('uncertain')
  // The settle path delivers on the same evidence (a hold here would invite
  // a Retry that duplicates the mail); the absent mail holds.
  reconcile(source(file))
  expect(store.get(delivered.id)?.state).toBe('delivered')
  expect(store.get(absent.id)?.state).toBe('uncertain')
})

test('an unreadable sessions directory holds absent mail: a receipt may hide there', () => {
  const proving = claim()
  const absent = claim()
  const current = rollout(NESTED, [meta(), userRow(envelopeOf(proving))])
  const locked = path.join(home, 'sessions', '2026', '09')
  fs.mkdirSync(locked, { recursive: true })
  fs.chmodSync(locked, 0o000)
  try {
    expect(threadRolloutFiles(home, THREAD).complete).toBe(false)
    expect(codexRolloutReceipt(source(current), proving.id)).toBe('found')
    expect(codexRolloutReceipt(source(current), absent.id)).toBe('uncertain')
  } finally { fs.chmodSync(locked, 0o755) }
})
