// codex-chat-sessions 6.4 (D8, lead ruling R5): a Codex chat's rollout never
// becomes a terminal session. Log discovery excludes it when its
// session_meta id or the thread id in its `rollout-<time>-<uuid>.jsonl` name
// is a chat's thread id — either suffices, since their equality is
// unverified — while an unrelated rollout stays discoverable.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectLogEntriesForPaths, collectLogEntryBatch } from '../logPollData'

const CHAT_THREAD = '01a14f43-2ff1-7ef2-bb8b-873486618448'
const OTHER_THREAD = '01a14f4d-4f0a-7ba2-8bd0-02e0dc283eeb'
const originalCodex = process.env.CODEX_HOME
const originalClaude = process.env.CLAUDE_CONFIG_DIR
let root: string
let day: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-exclusion-'))
  process.env.CODEX_HOME = path.join(root, 'codex')
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  day = path.join(root, 'codex', 'sessions', '2026', '10', '20')
  fs.mkdirSync(day, { recursive: true })
})

afterEach(() => {
  if (originalCodex === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodex
  if (originalClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaude
  fs.rmSync(root, { recursive: true, force: true })
})

/** A rollout whose name carries `nameThread` and whose session_meta id is `metaId`. */
function rollout(nameThread: string, metaId: string, stamp = '2026-10-20T00-00-00'): string {
  const file = path.join(day, `rollout-${stamp}-${nameThread}.jsonl`)
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: '2026-10-20T00:00:00Z', type: 'session_meta', payload: { id: metaId, cwd: '/repo', originator: 'codex_cli_rs' } }),
    JSON.stringify({ timestamp: '2026-10-20T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }),
  ].join('\n') + '\n')
  return file
}

const exclude = new Set([CHAT_THREAD])

test('a chat rollout is excluded by its session_meta id and by its file name, an unrelated one is kept', () => {
  const both = rollout(CHAT_THREAD, CHAT_THREAD, '2026-10-20T00-00-01')
  // The name names the chat's thread, the session_meta another id.
  const byName = rollout(CHAT_THREAD, OTHER_THREAD, '2026-10-20T00-00-02')
  // The session_meta names the chat's thread, the name another id.
  const byMeta = rollout(OTHER_THREAD, CHAT_THREAD, '2026-10-20T00-00-03')
  const unrelated = rollout(OTHER_THREAD, OTHER_THREAD, '2026-10-20T00-00-04')

  const kept = collectLogEntriesForPaths([both, byName, byMeta, unrelated], [], exclude).map(entry => entry.logPath)
  expect(kept).toEqual([unrelated])
  // Without the exclusion set every rollout is a discoverable Codex log.
  expect(collectLogEntriesForPaths([both, byName, byMeta, unrelated]).map(entry => entry.agentType)).toEqual(['codex', 'codex', 'codex', 'codex'])
})

test('the scanning poll path excludes a chat rollout too', () => {
  rollout(CHAT_THREAD, OTHER_THREAD, '2026-10-20T00-00-01')
  const unrelated = rollout(OTHER_THREAD, OTHER_THREAD, '2026-10-20T00-00-02')
  const { entries } = collectLogEntryBatch(50, { excludeSessionIds: exclude })
  expect(entries.map(entry => entry.logPath)).toEqual([unrelated])
})
