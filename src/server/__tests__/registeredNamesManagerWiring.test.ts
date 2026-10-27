// Manager wiring for the registered-name set (provider-relay-setup
// correction A, from advisories note-da7f0861 + note-0f4155a0): each test
// drives the real ChatSessionManager — or the real CodexSessionDriver —
// against a real database and kills one wiring mutant:
//   M1a  the manager's Codex withheldCredentials provider drops the db, so
//        a retained name reaches the respawned child;
//   M1b  the Claude retainedNamesDb option drops the db;
//   M1c  launchFor's resolution drops the db, so nothing observes or
//        persists at the resolve sites;
//   M-freeze  the manager freezes the Codex set at driver creation, so a
//        name registered after creation reaches the respawn;
//   M2   the Codex driver caches the set instead of evaluating it per spawn.
// The helper-level suites cover their own seams; none of them closes a
// manager one — only a real composition can.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppServerClientOptions } from '../chat/codex/appServerClient'
import { CodexSessionDriver } from '../chat/codex/CodexSessionDriver'
import type { CodexClient } from '../chat/codex/codexThread'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import type { ChatEvent } from '../../shared/chat'
import { readRetainedNames } from '../chat/secretNameRegistry'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { anyDirectory, closeDispatchers, FakeHandle, fakeQueryFactory, flush, initMessage, installManagerCleanup, managedManager } from './helpers/chatSessionManagerHarness'
import { FAKE_CODEX, Script, startHarness, THREAD_ID, until } from './codexDriverHarness'

installManagerCleanup()

const ENV_KEYS = [
  'CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'FAKE_ENV_NAMES', 'FAKE_EXIT_AFTER_REPLAY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'RELAY_TOKEN_ENV', 'RELAY_BALANCE_ENV', 'RELAY2_TOKEN_ENV',
] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let project: string
let home: string
let codexHome: string
let db: SessionDatabase
// The fake Codex child emits its exit event asynchronously: a test failing
// before its own kill must not leave that event firing into the next test's
// closed database, so afterEach ends the live session first (advisor
// A-checkpoint nit) and every mutant kill reads as its own assertion.
let liveCodexSession: { manager: ChatSessionManager; id: string } | null = null
// The Codex seam's driver events, for synchronizing a respawn on the
// previous child's settled exit (the driver announces it as an error event).
const codexEvents: ChatEvent[] = []

// A trusted-catalog provider whose credential names must never reach a
// launch, in any entry state; hosts and names are examples throughout.
const relayProvider = (authTokenEnv: string, modelKey = 'm') => ({
  label: 'Relay',
  authTokenEnv,
  balanceKeyEnv: 'RELAY_BALANCE_ENV',
  env: { ANTHROPIC_BASE_URL: 'https://relay.example.internal/api' },
  models: { [modelKey]: { label: 'Relay M', model: 'opus' } },
})

function writeProviders(providers: Record<string, unknown>): void {
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify(providers))
}

describe('registered names through the real manager wiring', () => {
  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-relay-wiring-')))
    project = path.join(tempDir, 'project')
    home = path.join(tempDir, 'home')
    codexHome = path.join(tempDir, 'codex-home')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    // The Codex profile and a plain (non-credentialed) Claude profile: both
    // resolve, neither names a credential itself — registration comes from
    // the providers' authTokenEnv/balanceKeyEnv alone.
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
      codex: { label: 'Codex', runtime: 'codex' },
      relay: { label: 'Relay', model: 'sonnet', env: { ANTHROPIC_BASE_URL: 'https://relay.example.internal/api' } },
    }))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.CODEX_HOME = codexHome
    process.env.KAWAI_CODEX_PATH = FAKE_CODEX
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    // Ambient credential values: present in the server environment, so only
    // a correct withholding keeps them out of a launch.
    process.env.RELAY_TOKEN_ENV = 'relay-token-value'
    process.env.RELAY_BALANCE_ENV = 'relay-balance-value'
    // Ambient from the start: a later catalog registration must still
    // withhold it (the frozen-launch mutant delivers this value).
    process.env.RELAY2_TOKEN_ENV = 'relay2-token-value'
    resetCodexExecutableCache()
  })

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    resetCodexExecutableCache()
    if (liveCodexSession) {
      const { manager, id } = liveCodexSession
      liveCodexSession = null
      try {
        manager.kill(id)
      } catch {
        // Already gone is exactly what the net is for.
      }
      await Bun.sleep(50)
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('manager Codex seam', () => {
    /** Three boot runs (start, resume, resume), each with a completed turn:
     * the fake exits after replaying its run, so every send respawns. */
    /** The rate-limit payload the recorded boot fill answers with. */
    const FILL = {
      limitId: 'codex', limitName: null, normalModelSlug: null,
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1792337450 },
      secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1792879251 },
      credits: null, individualLimit: null, spendControlReached: null,
      planType: 'plus', rateLimitReachedType: null,
    }

    /** Three boot runs (start, resume, resume): the fake exits after
     * replaying its run, so every send respawns. Run 1 serves only the start
     * boot — the first spawn sends no prompt — plus the boot's fill read
     * (PR E 7.1): the manager claims it once per home, so runs 2 and 3,
     * whose store already holds the report, never read, and an un-expected
     * read would fail the fake's replay check. */
    function writeCodexTranscript(): void {
      const rolloutPath = path.join(codexHome, 'sessions', `rollout-${THREAD_ID}.jsonl`)
      fs.mkdirSync(path.dirname(rolloutPath), { recursive: true })
      fs.writeFileSync(rolloutPath, '')
      const run = (boot: 'thread/start' | 'thread/resume', turn: string, text: string) =>
        new Script().boot(boot, 'gpt-test', rolloutPath)
          .turn(turn)
          .item('completed', turn, { type: 'agentMessage', id: `msg-${turn}`, text, questions: null })
          .completed(turn, 'completed', [{ type: 'agentMessage', id: `msg-${turn}`, text }])
      const script = new Script().boot('thread/start', 'gpt-test', rolloutPath)
        .request('account/rateLimits/read', { rateLimits: FILL })
      script.lines.push(...run('thread/resume', 'ct-2', 'two').lines)
      script.lines.push(...run('thread/resume', 'ct-3', 'three').lines)
      process.env.FAKE_TRANSCRIPT = script.write(tempDir)
      process.env.FAKE_EXIT_AFTER_REPLAY = '1'
    }

    function codexManager(): Promise<ChatSessionManager> {
      const wireLogs = { get: () => ({ record: () => {} }), pruneOrphans: async () => {}, delete: async () => {} }
      return managedManager({
        db, registry: new SessionRegistry(), onEvent: (_sessionId, event) => codexEvents.push(event),
        profileCatalogHome: home, availabilityProbe: async () => {},
        wireLogs: wireLogs as unknown as ChatWireLogs,
      })
    }

    /** One child per call: the fake exits after its replay, so a send
     * respawns the same driver — never a fresh creation. A send into a child
     * whose exit has not settled yet would be eaten by the dead process, so
     * each spawn after the first waits for the previous child's settled
     * exit (the driver announces it as an error event) before triggering.
     * The names are read only once this child's own exit has settled: the
     * fake writes them synchronously before its replay, and the write's
     * open makes an empty file visible first, so the file existing is no
     * sign the names are complete. */
    async function spawnChild(manager: ChatSessionManager, id: string, namesFile: string, run: number, trigger: () => Promise<unknown>): Promise<string[]> {
      const settledExits = () => codexEvents.filter(event => event.type === 'error' && event.message.includes('exited with code 0')).length
      const anyExits = () => codexEvents.filter(event => event.type === 'error' && event.message.startsWith('The Codex app-server exited')).length
      await until(() => settledExits() >= run - 1, 10_000)
      fs.rmSync(namesFile, { force: true })
      process.env.FAKE_RUN = String(run)
      await trigger()
      await until(() => anyExits() >= run, 10_000)
      return fs.readFileSync(namesFile, 'utf8').split('\n')
    }

    test('a respawn re-derives the set and keeps removed entries withheld (M-freeze, M1a)', async () => {
      // Kill M-freeze: the catalog gains a name after the driver's creation,
      // and only a per-spawn derivation keeps it from the respawned child —
      // the respawns here reuse the driver (child exit, then a send), never
      // a fresh creation. Kill M1a: the entry is then removed, and only the
      // retained set (the db the manager threads into the provider) keeps
      // its name withheld.
      writeCodexTranscript()
      const namesFile = path.join(tempDir, 'env-names.txt')
      process.env.FAKE_ENV_NAMES = namesFile
      writeProviders({ 'relay-provider': relayProvider('RELAY_TOKEN_ENV') })
      const manager = await codexManager()
      const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
      if (!created.ok) throw new Error(created.error)
      const id = created.session.id
      liveCodexSession = { manager, id }

      const first = await spawnChild(manager, id, namesFile, 1, () => manager.start(id))
      expect(first).toContain('CODEX_HOME')
      expect(first).not.toContain('RELAY_TOKEN_ENV')
      expect(first).not.toContain('RELAY_BALANCE_ENV')
      // The observation persisted: a later spawn reads it from the db.
      expect([...readRetainedNames(db)]).toContain('RELAY_TOKEN_ENV')

      // A name that registers only after the driver exists.
      writeProviders({
        'relay-provider': relayProvider('RELAY_TOKEN_ENV'),
        'relay-2': relayProvider('RELAY2_TOKEN_ENV', 'm2'),
      })
      const second = await spawnChild(manager, id, namesFile, 2, async () => {
        expect((await manager.send(id, 'second')).ok).toBe(true)
      })
      expect(second).not.toContain('RELAY2_TOKEN_ENV')

      // Every entry removed: the retained set keeps all three withheld.
      writeProviders({})
      const third = await spawnChild(manager, id, namesFile, 3, async () => {
        expect((await manager.send(id, 'third')).ok).toBe(true)
      })
      expect(third).not.toContain('RELAY_TOKEN_ENV')
      expect(third).not.toContain('RELAY_BALANCE_ENV')
      expect(third).not.toContain('RELAY2_TOKEN_ENV')
      // The live child ends in afterEach, so a mid-test failure can no
      // longer fire its exit event into the next test's closed database.
    })
  })

  describe('manager Claude seams', () => {
    function claudeManager(handles: FakeHandle[]): Promise<ChatSessionManager> {
      return managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        queryFactory: fakeQueryFactory(handles),
        // The respawn path re-verifies the executable even with an injected
        // query factory; pin it so the check never reads the host PATH.
        executableCheck: async () => ({ path: '/opt/claude', identity: 'id-1' }),
        profileCatalogHome: home,
      })
    }

    test('a respawn and a restart keep removed entries withheld (M1b)', async () => {
      writeProviders({ 'relay-provider': relayProvider('RELAY_TOKEN_ENV') })
      const handles: FakeHandle[] = []
      const manager = await claudeManager(handles)
      const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'relay' })
      if (!created.ok) throw new Error(created.error)
      const id = created.session.id
      expect((await manager.send(id, 'first')).ok).toBe(true)
      handles[0]!.push(initMessage('sdk-session-1'))
      await flush()

      // The child got the profile's own env (W1) and neither credential.
      const firstEnv = handles[0]!.options.env ?? {}
      expect(firstEnv['ANTHROPIC_BASE_URL']).toBe('https://relay.example.internal/api')
      expect(firstEnv['RELAY_TOKEN_ENV']).toBeUndefined()
      expect(firstEnv['RELAY_BALANCE_ENV']).toBeUndefined()
      // The driver seam observed and persisted the names (retained growth).
      expect([...readRetainedNames(db)]).toContain('RELAY_TOKEN_ENV')

      // A name that registers only after the driver exists withholds at
      // the respawn — spawnQuery re-resolves per spawn (freshness); the
      // catalog keeps both entries here.
      writeProviders({
        'relay-provider': relayProvider('RELAY_TOKEN_ENV'),
        'relay-2': relayProvider('RELAY2_TOKEN_ENV', 'm2'),
      })
      handles[0]!.query.close()
      await flush()
      expect((await manager.send(id, 'second')).ok).toBe(true)
      handles[1]!.push(initMessage('sdk-session-2'))
      await flush()
      const secondEnv = handles[1]!.options.env ?? {}
      expect(secondEnv['RELAY_TOKEN_ENV']).toBeUndefined()
      expect(secondEnv['RELAY_BALANCE_ENV']).toBeUndefined()
      expect(secondEnv['RELAY2_TOKEN_ENV']).toBeUndefined()

      // Every entry then disappears: the retained set (the db the manager
      // threads into the driver) keeps the names withheld — the db-less
      // mutant delivers them after a restart.
      writeProviders({})

      // A fresh manager on the same db (a restart) withholds too.
      const restarted: FakeHandle[] = []
      const manager2 = await claudeManager(restarted)
      const created2 = await manager2.createAvailableSession({ projectPath: project, claudeProfileId: 'relay' })
      if (!created2.ok) throw new Error(created2.error)
      expect((await manager2.send(created2.session.id, 'third')).ok).toBe(true)
      restarted[0]!.push(initMessage('sdk-session-3'))
      await flush()
      const restartEnv = restarted[0]!.options.env ?? {}
      expect(restartEnv['RELAY_TOKEN_ENV']).toBeUndefined()
      expect(restartEnv['RELAY_BALANCE_ENV']).toBeUndefined()
    })

    test('creation alone observes and persists the catalog names (M1c)', async () => {
      // launchFor runs at every resolve site — creation included — so the
      // names are registered before any spawn; the db-less mutant writes
      // nothing and the persisted set stays empty.
      writeProviders({ 'relay-provider': relayProvider('RELAY_TOKEN_ENV') })
      const manager = await managedManager({
        isDirectory: anyDirectory,
        db, registry: new SessionRegistry(), onEvent: () => {},
        profileCatalogHome: home,
        executableCheck: async () => ({ path: '/opt/claude', identity: 'id-1' }),
        availabilityProbe: async () => {},
      })
      const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'relay' })
      if (!created.ok) throw new Error(created.error)
      const retained = [...readRetainedNames(db)]
      expect(retained).toContain('RELAY_TOKEN_ENV')
      expect(retained).toContain('RELAY_BALANCE_ENV')
    })
  })
})

interface FakeCodexClient extends CodexClient {
  /** Simulates the app-server process dying. */
  die(): void
  startedThread: boolean
}

function makeFakeClient(options: AppServerClientOptions): FakeCodexClient {
  const client: FakeCodexClient = {
    startedThread: false,
    start() {},
    end() {},
    async initialize() {
      return {}
    },
    async request(method: string) {
      if (method === 'thread/start' || method === 'thread/resume') {
        client.startedThread = true
        return { thread: { id: `th-fresh-${Math.random()}` } }
      }
      return {}
    },
    die() {
      options.onExit({ code: 0, signal: null })
    },
  }
  return client
}

describe('CodexSessionDriver spawn freshness', () => {
  test('the withheld set is evaluated at every spawn, not cached at creation (M2)', async () => {
    let registered = new Set(['FIRST_WITHHELD_KEY'])
    let evaluations = 0
    const clients: FakeCodexClient[] = []
    const spawnEnvNames: string[][] = []
    const harness = startHarness(new Script().boot(), {
      withheldCredentials: () => {
        evaluations += 1
        return new Set(registered)
      },
      createClient: options => {
        const client = makeFakeClient(options)
        clients.push(client)
        spawnEnvNames.push(Object.keys(options.env))
        return client
      },
    })
    try {
      harness.driver.send('first')
      await until(() => clients.length === 1 && clients[0]!.startedThread)
      expect(spawnEnvNames[0]).not.toContain('FIRST_WITHHELD_KEY')

      // A name registered after the driver's creation must vanish from the
      // respawned child's environment — the caching mutant delivers it.
      registered = new Set([...registered, 'SECOND_WITHHELD_KEY'])
      clients[0]!.die()
      // The next send respawns the ended app-server (ensureClient).
      harness.driver.send('second')
      await until(() => clients.length === 2 && clients[1]!.startedThread)
      expect(evaluations).toBeGreaterThanOrEqual(2)
      expect(spawnEnvNames[1]).not.toContain('FIRST_WITHHELD_KEY')
      expect(spawnEnvNames[1]).not.toContain('SECOND_WITHHELD_KEY')
    } finally {
      harness.cleanup()
    }
  })
})
