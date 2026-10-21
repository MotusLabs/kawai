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

const ENV_KEYS = [
  'CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'FAKE_ENV_NAMES', 'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY', 'KAWAI_TEST_PASSTHROUGH',
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
  // Two profiles on one (default) home: the provider — and its usage — is
  // keyed by the home, so both share one report (PR E 7.1).
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
    codex: { label: 'Codex', runtime: 'codex' },
    'codex-fast': { label: 'Codex Fast', runtime: 'codex' },
  }))
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
  // which must resume the stored thread, then a send. Run 1 also carries
  // the boot's fill read (PR E 7.1): the manager claims it once per home,
  // so run 2 — whose store already holds the report — never reads.
  const script = new Script().boot('thread/start', 'gpt-test', rollout)
    .request('account/rateLimits/read', { rateLimits: MILD })
    .turn('ct-1')
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

const MILD = {
  limitId: 'codex',
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1792337450 },
  secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1792879251 },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: 'plus',
  rateLimitReachedType: null,
}

test('usage is kept per home: the fill read lands before a message and both profiles share the report', async () => {
  // Run 1 (codex): the boot's fill read answers the windows, the turn then
  // pushes an update. Run 2 (codex-fast): a quiet boot — its report can
  // only come from the shared store.
  const script = new Script().boot('thread/start', 'gpt-test', rollout)
    .request('account/rateLimits/read', { rateLimits: MILD })
    .turn('ct-1')
    .notify('account/rateLimits/updated', { rateLimits: { ...MILD, primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1792337451 } } })
    .completed('ct-1', 'completed', [{ type: 'agentMessage', id: 'msg-1', text: 'done' }])
  script.lines.push(...new Script().boot('thread/start', 'gpt-test', rollout).lines)
  process.env.FAKE_TRANSCRIPT = script.write(tempDir)
  process.env.FAKE_RUN = '1'
  const events: ChatEvent[] = []
  const wire: Array<{ dir: string; raw: string }> = []
  manager = createManager(events, wire)
  await manager.whenRestored()
  const first = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex A' })
  if (!first.ok) throw new Error(first.error)
  const started = manager
  expect((await started.start(first.session.id)).ok).toBe(true)
  // Windows before the first message: the fill read, not a turn.
  await until(() => started.getSnapshot(first.session.id)!.usage !== null)
  expect(started.getSnapshot(first.session.id)!.usage?.windows.map(window => window.key)).toEqual(['codex:primary', 'codex:secondary'])

  expect((await started.send(first.session.id, 'run it')).ok).toBe(true)
  await until(() => events.some(event => event.type === 'turn_completed'))
  // The push updated the home's report.
  expect(started.getSnapshot(first.session.id)!.usage?.windows[0]).toMatchObject({ percentUsed: 25 })

  // The sibling profile shares the home's report without its own push or read.
  process.env.FAKE_RUN = '2'
  const second = await started.createAvailableSession({ projectPath: project, claudeProfileId: 'codex-fast', name: 'Codex B' })
  if (!second.ok) throw new Error(second.error)
  expect((await started.start(second.session.id)).ok).toBe(true)
  await until(() => db.getChatSession(second.session.id)?.status === 'waiting')
  expect(started.getSnapshot(second.session.id)!.usage?.windows[0]).toMatchObject({ percentUsed: 25 })

  // Claude reports are separate: a Claude profile's provider key differs
  // from the home's, so its sessions never see the Codex windows.
  const claude = await started.createAvailableSession({ projectPath: project, claudeProfileId: 'default', name: 'Claude' })
  if (!claude.ok) throw new Error(claude.error)
  expect(started.providerIdOf(claude.session.id)).not.toBe(started.providerIdOf(first.session.id))
  expect(started.getSnapshot(claude.session.id)!.usage).toBeNull()
})

test('a Codex launch withholds the catalog-named credentials (openrouter-provider 1.8)', async () => {
  writeTranscript()
  // The user catalog carries the shipped OpenRouter provider, which names
  // both variables as its credentials; their values here are fakes.
  const shipped = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../../../config/providers.default.json'), 'utf8'))
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({ openrouter: shipped.openrouter }))
  process.env.OPENROUTER_API_KEY = 'fake-or-key'
  process.env.OPENROUTER_MANAGEMENT_KEY = 'fake-or-mgmt'
  process.env.KAWAI_TEST_PASSTHROUGH = '1'
  const names = path.join(tempDir, 'env-names.txt')
  process.env.FAKE_ENV_NAMES = names
  manager = createManager([], [])
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
  if (!created.ok) throw new Error(created.error)
  expect((await manager.start(created.session.id)).ok).toBe(true)
  await until(() => db.getChatSession(created.session.id)?.sdkSessionId === THREAD_ID)
  const received = fs.readFileSync(names, 'utf8').split('\n')
  // The child got the server env (non-vacuity) and its own home …
  expect(received).toContain('KAWAI_TEST_PASSTHROUGH')
  expect(received).toContain('CODEX_HOME')
  // … but neither credential the catalog names.
  expect(received).not.toContain('OPENROUTER_API_KEY')
  expect(received).not.toContain('OPENROUTER_MANAGEMENT_KEY')
})
