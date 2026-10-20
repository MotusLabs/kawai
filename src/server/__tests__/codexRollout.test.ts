// codex-chat-sessions 6.3 (D8, amended by PR D decision 2, M3): a Codex
// chat replays from its rollout file alone. Every turn emits the boundaries
// a live turn does — turn_started … turn_completed, or turn_interrupted for
// an abort — and row ids carry the line's hash, so a rewrite under the same
// path never reuses an id for a different row.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schemaDb } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { formatEnvelope, messageEnvelope } from '../team/envelope'
import { parseCodexRollout, replayCodexRollout } from '../chat/codex/codexRollout'

let dir: string
let db: Database
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-rollout-')))
  db = schemaDb(':memory:')
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const store = () => new MailboxStore(db)
const at = '2026-10-20T10:00:00.000Z'
const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at, type, payload })
const message = (role: string, block: string, text: string) => line('response_item', { type: 'message', role, content: [{ type: block, text }] })
const event = (type: string, extra: Record<string, unknown> = {}) => line('event_msg', { type, ...extra })

/** A pushed, claimed mail — the envelope a delivery turn's rollout row carries. */
const peerEnvelope = () => {
  const s = store()
  const mail = s.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'chat-lead', fromGroup: 'lead', originPath: '/repo', body: 'Please review' })
  s.claim(mail.id, 'dev')
  return formatEnvelope(messageEnvelope(s.get(mail.id)!))
}

/** A recorded-shape rollout: a completed user turn with a tool call, an aborted turn, and a peer turn. */
const ROLLOUT = (envelope: string) => [
  line('session_meta', { id: 'thread-1', cwd: '/repo' }),
  event('task_started', { turn_id: 't1' }),
  line('turn_context', { cwd: '/repo', model: 'gpt-test' }),
  message('user', 'input_text', '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nBun\n</INSTRUCTIONS>'),
  message('user', 'input_text', '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'),
  message('user', 'input_text', 'list the files'),
  line('response_item', { type: 'reasoning', summary: [] }),
  line('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call-1' }),
  line('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'a.ts\nb.ts' }),
  message('assistant', 'output_text', 'Two files.'),
  event('token_count', { info: null }),
  event('task_complete', { turn_id: 't1', last_agent_message: 'Two files.' }),
  event('task_started', { turn_id: 't2' }),
  message('user', 'input_text', 'stop that'),
  event('turn_aborted', { reason: 'interrupted' }),
  event('task_started', { turn_id: 't3' }),
  message('user', 'input_text', envelope),
  line('response_item', { type: 'custom_tool_call', name: 'send_message', input: '{"to_kind":"group","to_id":"lead","body":"ok"}', call_id: 'call-2' }),
  line('response_item', { type: 'custom_tool_call_output', call_id: 'call-2', output: '{"id":"msg-2"}' }),
  event('task_complete', { turn_id: 't3', last_agent_message: null }),
]

test('replay from a recorded rollout emits each turn\'s boundaries, turn_completed included', () => {
  const events = parseCodexRollout(ROLLOUT(peerEnvelope()).join('\n') + '\n')
  expect(events.map(e => e.type)).toEqual([
    'turn_started', 'user_message', 'tool_call', 'tool_result', 'assistant_text', 'turn_completed',
    'turn_started', 'user_message', 'turn_interrupted',
    'turn_started', 'peer_message', 'tool_call', 'tool_result', 'turn_completed',
  ])
  const [first, user, call, result, text, done] = events
  const turnId = (first as { turnId: string }).turnId
  expect(events.slice(0, 6).every(e => (e as { turnId?: string }).turnId === turnId)).toBe(true)
  expect(user).toMatchObject({ type: 'user_message', text: 'list the files', at })
  expect(call).toMatchObject({ toolCallId: 'call-1', tool: 'shell', input: { command: ['ls'] } })
  expect(result).toMatchObject({ toolCallId: 'call-1', output: 'a.ts\nb.ts' })
  expect(text).toMatchObject({ text: 'Two files.' })
  expect(done).toMatchObject({ type: 'turn_completed', subtype: 'success', finalText: 'Two files.' })
  expect(events[10]).toMatchObject({ type: 'peer_message', body: 'Please review' })
  // Three distinct turns, ids unique across the replay.
  expect(new Set(events.filter(e => e.type === 'turn_started').map(e => (e as { turnId: string }).turnId)).size).toBe(3)
  expect(new Set(events.map(e => e.id)).size).toBe(events.length)
})

test('an error marks its turn failed; a user row before any task_started opens a turn; a torn tail is skipped', () => {
  const events = parseCodexRollout([
    message('user', 'text', 'hello'),
    event('error', { message: 'stream disconnected' }),
    event('task_complete', { turn_id: 't1', last_agent_message: null }),
    '{"timestamp":"x","type":"response_item","payload":{"type":"mess',
  ].join('\n'))
  expect(events.map(e => e.type)).toEqual(['turn_started', 'user_message', 'error', 'turn_completed'])
  expect(events[3]).toMatchObject({ subtype: 'error_during_execution', isError: true })
  expect(events[0]!.id).not.toBe(events[1]!.id)
})

test('ids are stable while the file grows and change for a row rewritten under the same path', () => {
  const first = parseCodexRollout(ROLLOUT(peerEnvelope()).slice(0, 6).join('\n'))
  const grown = parseCodexRollout(ROLLOUT(peerEnvelope()).join('\n'))
  expect(grown.slice(0, first.length).map(e => e.id)).toEqual(first.map(e => e.id))
  const rewritten = ROLLOUT(peerEnvelope())
  rewritten[5] = message('user', 'input_text', 'list the folders')
  const after = parseCodexRollout(rewritten.join('\n'))
  expect(after[1]!.id).not.toBe(grown[1]!.id)
  expect(after[0]!.id).toBe(grown[0]!.id)
})

test('a missing rollout replays as the history-unavailable notice; a readable one reports no cwd', () => {
  expect(replayCodexRollout(path.join(dir, 'gone.jsonl'))).toMatchObject({ status: 'missing', events: [{ type: 'notice' }], cwd: null })
  expect(replayCodexRollout(null).status).toBe('missing')
  const file = path.join(dir, 'rollout.jsonl')
  fs.writeFileSync(file, ROLLOUT(peerEnvelope()).join('\n') + '\n')
  const replay = replayCodexRollout(file)
  expect(replay.status).toBe('ok')
  expect(replay.cwd).toBeNull()
  expect(replay.events.filter(e => e.type === 'turn_completed')).toHaveLength(2)
})
