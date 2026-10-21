// codex-chat-sessions 6.3 (D8, amended by PR D decision 2, M3): the manager
// replays a Codex chat's history from its rollout alone — getHistory,
// loadHistory, and searchableEvents never ask the app-server (no thread/read,
// R2's one id scheme), an archived chat replays with no process spawned, a
// rollout rewritten under the same path makes an older beforeId stale, and an
// unreadable rollout shows the history-unavailable notice without ever being
// memoized permanently: the retry waits for a load where no live turn could
// be duplicated (the memo is taken before a driver start, so live events must
// stay ahead of the replay).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { FAKE_CODEX, Script, THREAD_ID, until } from './codexDriverHarness'

const ENV_KEYS = [
  'CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY',
] as const
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let project: string
let home: string
let codexHome: string
let rollout: string
let db: SessionDatabase
let manager: ChatSessionManager | null = null

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-replay-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  codexHome = path.join(tempDir, 'codex-home')
  rollout = path.join(codexHome, 'sessions', '2026', '10', '20', `rollout-2026-10-20T00-00-00-${THREAD_ID}.jsonl`)
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.dirname(rollout), { recursive: true })
  // A temp home's fake login — the real ~/.codex is never touched.
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ codex: { label: 'Codex', runtime: 'codex' } }))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = FAKE_CODEX
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  process.env.FAKE_RUN = '1'
  resetCodexExecutableCache()
})

afterEach(() => {
  manager?.shutdown()
  manager = null
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  resetCodexExecutableCache()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

type Wire = Array<{ dir: string; raw: string }>

function createManager(events: ChatEvent[], wire: Wire): ChatSessionManager {
  const wireLogs = { get: () => ({ record: (dir: string, raw: string) => wire.push({ dir, raw }) }), pruneOrphans: async () => {}, delete: async () => {} }
  return new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: (_id, event) => events.push(event),
    profileCatalogHome: home, availabilityProbe: async () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    wireLogs: wireLogs as unknown as ChatWireLogs,
  })
}

const OLD = '2026-10-18T10:00:00.000Z'
const NOW = '2026-10-20T10:00:00.000Z'
const line = (ts: string, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: ts, type, payload })
const message = (ts: string, text: string) => line(ts, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const turn = (ts: string, id: string, text: string, answer: string) => [
  line(ts, 'event_msg', { type: 'task_started', turn_id: id }),
  message(ts, text),
  line(ts, 'event_msg', { type: 'task_complete', turn_id: id, last_agent_message: answer }),
]
/** Two turns two days apart: the recent one windows, the older one pages. */
const HISTORY = [...turn(OLD, 't1', 'older question', 'older answer'), ...turn(NOW, 't2', 'recent question', 'recent answer')]

const userTexts = (events: ChatEvent[]) => events.filter(e => e.type === 'user_message').map(e => (e as { text: string }).text)

async function startedSession(wire: Wire, script: Script): Promise<string> {
  manager = createManager([], wire)
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex dev' })
  if (!created.ok) throw new Error(created.error)
  process.env.FAKE_TRANSCRIPT = script.write(tempDir)
  expect((await manager.start(created.session.id)).ok).toBe(true)
  await until(() => db.getChatSession(created.session.id)?.transcriptPath === rollout)
  return created.session.id
}

test('a Codex chat reconnects, pages, and restarts from its rollout alone — no thread/read, no spawn', async () => {
  const wire: Wire = []
  const id = await startedSession(wire, new Script().boot('thread/start', 'gpt-test', rollout))
  fs.writeFileSync(rollout, `${HISTORY.join('\n')}\n`)
  manager!.shutdown()

  // The reconnect: the memo is rebuilt from the rollout alone.
  const wire2: Wire = []
  manager = createManager([], wire2)
  await manager.whenRestored()
  await manager.loadHistory(id)
  const snapshot = manager!.getSnapshot(id)!
  // The window holds the recent turn; the older one pages.
  expect(userTexts(snapshot.events)).toEqual(['recent question'])
  expect(snapshot.historyHasOlder).toBe(true)
  expect(snapshot.historyStartId).toBeTruthy()
  const page = manager!.getHistoryPage(id, snapshot.historyStartId!)!
  expect(page.stale).toBe(false)
  expect(userTexts(page.events)).toEqual(['older question'])
  expect(page.hasOlder).toBe(false)
  // One replay source (R2): the app-server was never asked for history.
  expect(wire2.some(entry => entry.raw.includes('thread/read'))).toBe(false)
  const search = await manager!.searchableEvents(id)
  expect(search.readable).toBe(true)
  expect(userTexts(search.events)).toEqual(['older question', 'recent question'])

  const firstIds = [...snapshot.events, ...page.events].map(e => e.id)
  manager!.shutdown()
  const restartWire: Wire = []
  manager = createManager([], restartWire)
  await manager.whenRestored()
  await manager.loadHistory(id)
  const restored = manager!.getSnapshot(id)!
  const restoredPage = manager!.getHistoryPage(id, restored.historyStartId!)!
  // The restart replays the same rows with the same ids, spawning nothing.
  expect([...restored.events, ...restoredPage.events].map(e => e.id)).toEqual(firstIds)
  expect(restartWire).toEqual([])
})

test('a rollout rewritten under the same path makes an older beforeId read stale', async () => {
  const wire: Wire = []
  const id = await startedSession(wire, new Script().boot('thread/start', 'gpt-test', rollout))
  fs.writeFileSync(rollout, `${HISTORY.join('\n')}\n`)
  manager!.shutdown()

  manager = createManager([], [])
  await manager.whenRestored()
  await manager.loadHistory(id)
  const page = manager!.getHistoryPage(id, manager!.getSnapshot(id)!.historyStartId!)!
  // The user row is the one the rewrite changes; its id must go stale.
  const oldBeforeId = page.events[1]!.id
  manager!.shutdown()

  // The same path, one row changed: its id changes with its content.
  const rewritten = [...HISTORY]
  rewritten[1] = message(OLD, 'older question, edited')
  fs.writeFileSync(rollout, `${rewritten.join('\n')}\n`)
  manager = createManager([], [])
  await manager.whenRestored()
  await manager.loadHistory(id)
  expect(manager!.getHistoryPage(id, oldBeforeId)).toEqual({ events: [], hasOlder: false, stale: true })
  // Unchanged rows keep their ids, so a current beforeId still pages.
  const fresh = manager!.getSnapshot(id)!
  expect(manager!.getHistoryPage(id, fresh.historyStartId!)!.stale).toBe(false)
})

test('an archived Codex chat replays its rollout with no process spawned', async () => {
  const wire: Wire = []
  const id = await startedSession(wire, new Script().boot('thread/start', 'gpt-test', rollout))
  fs.writeFileSync(rollout, `${turn(NOW, 't2', 'recent question', 'recent answer').join('\n')}\n`)
  manager!.archive(id)
  manager!.shutdown()

  const restartWire: Wire = []
  manager = createManager([], restartWire)
  await manager.whenRestored()
  await manager.loadHistory(id)
  const snapshot = manager!.getSnapshot(id)!
  expect(userTexts(snapshot.events)).toEqual(['recent question'])
  expect(snapshot.status).toBe('waiting')
  // Reading history never starts the agent.
  expect(restartWire).toEqual([])
})

test('an unreadable rollout shows the notice, then reads once without duplicating turns', async () => {
  const wire: Wire = []
  const id = await startedSession(wire, new Script().boot('thread/start', 'gpt-test', rollout))
  fs.writeFileSync(rollout, `${turn(NOW, 't2', 'recent question', 'recent answer').join('\n')}\n`)
  manager!.shutdown()

  // Restart with the rollout gone: the notice shows, memoized as retryable.
  fs.rmSync(rollout)
  manager = createManager([], [])
  await manager.whenRestored()
  await manager.loadHistory(id)
  expect(manager!.getSnapshot(id)!.events.map(e => e.type)).toEqual(['notice'])

  // The rollout comes back: the next load retries the memo (no live turn
  // could be duplicated here) and the notice is gone.
  fs.writeFileSync(rollout, `${turn(NOW, 't2', 'recent question', 'recent answer').join('\n')}\n`)
  await manager.loadHistory(id)
  const snapshot = manager!.getSnapshot(id)!
  expect(snapshot.events.some(e => e.type === 'notice')).toBe(false)
  expect(userTexts(snapshot.events)).toEqual(['recent question'])
  expect(snapshot.events.filter(e => e.type === 'turn_started')).toHaveLength(1)
})

// Pins the post-await guard in loadHistory's Codex branch (ChatSessionManager
// ~:1006, the `!snapshotHistory.has` check after replayCodexRolloutAsync): a
// send's synchronous captureHistory that lands while the read is still
// awaiting keeps its memo; the load discards its own older replay. The
// Claude branch's copy is pinned by chatAsyncRestore's race test.
test('a synchronous capture that wins the race keeps its memo — the async Codex replay discards its own result', async () => {
  const wire: Wire = []
  const id = await startedSession(wire, new Script().boot('thread/start', 'gpt-test', rollout))
  fs.writeFileSync(rollout, `${turn(NOW, 't2', 'recent question', 'recent answer').join('\n')}\n`)
  manager!.shutdown()

  manager = createManager([], [])
  await manager.whenRestored()
  const loading = manager.loadHistory(id)
  // The synchronous capture runs while the async read is still awaiting.
  manager.getSnapshot(id)
  const memo = (manager as unknown as { snapshotHistory: Map<string, ChatEvent[]> }).snapshotHistory.get(id)
  expect(memo).toBeTruthy()
  await loading
  expect((manager as unknown as { snapshotHistory: Map<string, ChatEvent[]> }).snapshotHistory.get(id)).toBe(memo)
  expect(userTexts(manager.getSnapshot(id)!.events)).toEqual(['recent question'])
})

test('a load while a live turn runs keeps the memo — the replay never duplicates live events', async () => {
  const gate = path.join(tempDir, 'gate')
  // Run 2 is the respawn after the restart: a resume whose rollout row (the
  // append) lands while Kawai's turn is still live.
  const script = new Script().boot('thread/start', 'gpt-test', rollout)
  const second = new Script().boot('thread/resume', 'gpt-test', rollout)
    .turn('ct-2')
    .append(rollout)
    .gate(gate)
    .completed('ct-2')
  script.lines.push(...second.lines)
  const wire: Wire = []
  const id = await startedSession(wire, script)
  fs.writeFileSync(rollout, `${turn(NOW, 't2', 'recent question', 'recent answer').join('\n')}\n`)
  manager!.shutdown()
  fs.rmSync(rollout)

  // Restart with the rollout gone: the notice shows, memoized as retryable.
  manager = createManager([], [])
  await manager.whenRestored()
  await manager.loadHistory(id)
  expect(manager!.getSnapshot(id)!.events.map(e => e.type)).toEqual(['notice'])

  // The rollout returns and a real turn runs. The send's history capture
  // retries the notice memo first (no live turn yet — the safe moment), so
  // the memo is the pre-turn replay, and the turn streams as live events.
  fs.writeFileSync(rollout, `${turn(NOW, 't2', 'recent question', 'recent answer').join('\n')}\n`)
  process.env.FAKE_RUN = '2'
  expect((await manager.send(id, 'go again')).ok).toBe(true)
  await until(() => fs.existsSync(rollout) && fs.readFileSync(rollout, 'utf8').includes('go again'))

  // A load mid-turn must not re-read: the rollout now holds the row the live
  // turn is also streaming, and a re-read would replay it twice. (The memo
  // here is NOT retryable — the send's capture consumed the notice memo at
  // live=0 and replaced it with the successful pre-turn replay; the
  // retryable-memo-plus-live-events window is pinned by the EISDIR test
  // above.)
  await manager.loadHistory(id)
  const snapshot = manager.getSnapshot(id)!
  expect(snapshot.events.some(e => e.type === 'notice')).toBe(false)
  expect(userTexts(snapshot.events)).toEqual(['recent question', 'go again'])
  expect(snapshot.events.filter(e => e.type === 'user_message')).toHaveLength(2)

  // After the turn and a restart, the replay shows every turn exactly once.
  fs.writeFileSync(gate, '')
  await until(() => db.getChatSession(id)?.status === 'waiting')
  manager.shutdown()
  manager = createManager([], [])
  await manager.whenRestored()
  await manager.loadHistory(id)
  const restored = manager.getSnapshot(id)!
  expect(userTexts(restored.events)).toEqual(['recent question', 'go again'])
  expect(restored.events.filter(e => e.type === 'user_message')).toHaveLength(2)
  expect(restored.events.some(e => e.type === 'notice')).toBe(false)
})
