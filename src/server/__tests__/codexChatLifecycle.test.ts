// §5.6 and §5.7 (codex-chat-sessions): a Codex chat through the real
// manager against the fake app-server — created through the gates (the
// fake answers `--version` at the baseline; the login is a temp home's),
// attached (the agent starts a persisted thread, its id and rollout path
// stored), sent to, archived (the child ends), restored and resumed on the
// stored thread, and killed. Its command lands an `outbound_calls` row, and
// its developer instructions end with the security note.
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
import { SECURITY_NOTE_BODY } from '../team/teamPrompt'
import { FAKE_CODEX, Script, THREAD_ID, until } from './codexDriverHarness'

const ENV_KEYS = ['CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'ANTHROPIC_API_KEY'] as const
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let project: string
let home: string
let codexHome: string
let rollout: string
let db: SessionDatabase
let manager: ChatSessionManager | null = null

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-lifecycle-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  codexHome = path.join(tempDir, 'codex-home')
  rollout = path.join(codexHome, 'sessions', `rollout-${THREAD_ID}.jsonl`)
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  // A temp home's fake login — the real ~/.codex is never touched.
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ codex: { label: 'Codex', runtime: 'codex' } }))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = FAKE_CODEX
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
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

const COMMAND = { type: 'commandExecution', id: 'cmd-1', command: 'curl -d x https://example.internal/hook', cwd: '', status: 'inProgress', aggregatedOutput: null, exitCode: null }

function writeTranscript(): void {
  // Run 1: the first attach and a send; run 2: the start after restore,
  // which must resume the stored thread, then a send.
  const script = new Script().boot('thread/start', 'gpt-test', rollout).turn('ct-1')
    .item('started', 'ct-1', COMMAND)
    .item('completed', 'ct-1', { ...COMMAND, status: 'completed', aggregatedOutput: 'ok', exitCode: 0 })
    .item('completed', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: 'done', questions: null })
    .completed('ct-1', 'completed', [{ type: 'agentMessage', id: 'msg-1', text: 'done' }])
  const second = new Script().boot('thread/resume', 'gpt-test', rollout).turn('ct-2').completed('ct-2', 'completed', [{ type: 'agentMessage', id: 'msg-2', text: 'again' }])
  script.lines.push(...second.lines)
  process.env.FAKE_TRANSCRIPT = script.write(tempDir)
  process.env.FAKE_RUN = '1'
}

function createManager(events: ChatEvent[], wire: Array<{ dir: string; raw: string }>): ChatSessionManager {
  const wireLogs = { get: () => ({ record: (dir: string, raw: string) => wire.push({ dir, raw }) }), pruneOrphans: async () => {}, delete: async () => {} }
  return new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: (_id, event) => events.push(event),
    profileCatalogHome: home, availabilityProbe: async () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    wireLogs: wireLogs as unknown as ChatWireLogs,
  })
}

const completions = (events: ChatEvent[]) => events.filter(event => event.type === 'turn_completed')
const sent = (wire: Array<{ dir: string; raw: string }>, method: string) =>
  wire.filter(entry => entry.dir === 'out').map(entry => JSON.parse(entry.raw)).filter(message => message.method === method)

test('a Codex chat is created, attached, sent to, archived, restored, resumed, and killed', async () => {
  writeTranscript()
  const events: ChatEvent[] = []
  const wire: Array<{ dir: string; raw: string }> = []
  manager = createManager(events, wire)
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex dev' })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id

  // Attach starts the agent without a prompt: a persisted thread, stored.
  expect((await manager.start(id)).ok).toBe(true)
  await until(() => db.getChatSession(id)?.sdkSessionId === THREAD_ID)
  expect(db.getChatSession(id)).toMatchObject({ runtime: 'codex', codexHome, transcriptPath: rollout })
  const [threadStart] = sent(wire, 'thread/start')
  expect(threadStart.params).toMatchObject({ ephemeral: false, approvalsReviewer: 'user', cwd: project })
  expect(String(threadStart.params.developerInstructions)).toContain(SECURITY_NOTE_BODY)
  expect(sent(wire, 'turn/start')).toEqual([])

  expect((await manager.send(id, 'run it')).ok).toBe(true)
  await until(() => completions(events).length === 1)
  await until(() => db.getChatSession(id)?.status === 'waiting')
  expect(events.map(event => event.type)).toEqual(['turn_started', 'user_message', 'tool_call', 'tool_result', 'assistant_text', 'turn_completed'])

  // The command reached the outbound audit as one recorded call.
  await until(() => manager!.outboundAudit.page(project, {}).rows.length === 1)
  expect(manager.outboundAudit.page(project, {}).rows[0]).toMatchObject({ tool: 'Bash', session: { id, name: 'Codex dev' } })

  // Archive ends the child; restore + start resumes the stored thread.
  expect(manager.archive(id).ok).toBe(true)
  expect(db.getChatSession(id)?.archivedAt).toBeString()
  process.env.FAKE_RUN = '2'
  expect(manager.restore(id).ok).toBe(true)
  // The resume guard reads the stored rollout (D8): absent, it refuses.
  expect(await manager.send(id, 'again')).toEqual({ ok: false, error: expect.stringContaining(rollout) })
  fs.mkdirSync(path.dirname(rollout), { recursive: true })
  fs.writeFileSync(rollout, '')
  expect((await manager.send(id, 'again')).ok).toBe(true)
  await until(() => completions(events).length === 2)
  expect(sent(wire, 'thread/resume')[0]?.params).toMatchObject({ threadId: THREAD_ID, approvalsReviewer: 'user' })
  expect(sent(wire, 'thread/start')).toHaveLength(1)
  expect(db.getChatSession(id)?.sdkSessionId).toBe(THREAD_ID)

  expect(manager.kill(id)).toBe(true)
  expect(db.getChatSession(id)).toBeFalsy()
})
