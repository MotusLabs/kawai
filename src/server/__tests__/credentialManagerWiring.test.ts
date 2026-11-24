// The credential composition through the REAL ChatSessionManager
// (provider-credential-store PW2, PW3, PW5, A4, and "Store changes apply at
// the next launch"): each test builds the server's credentials exactly as
// bootstrap does — createServerCredentials over a real database and a
// disposable HOME, spread into the manager with credentialManagerOptions —
// and kills one wiring mutant:
//   PW2  the gate reads the seed instead of the composition, so a token that
//        resolves only through the store fails creation;
//   PW3  the registry is built without the store's secret-source keys, so a
//        stored secret source reaches the Claude and Codex launches;
//   A4   reclassify skips the retain step, so a reclassified key is delivered;
//   PW5  the usage pull reads the raw seed, so a store-only balance key is lost;
//   4.5  the composition is cached for the process lifetime, so an import
//        does not reach the next creation without a restart;
//   I3   a registered ANTHROPIC_AUTH_TOKEN is not refused on the credentialed
//        branch, so the launch carries a registered name under its own name;
//   S6   the startup gate is not awaited, so restore or the first creation
//        runs before the startup migration's store write settles.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import { createServerCredentials, credentialManagerOptions } from '../chat/credentialComposition'
import { readRetainedNames, retainSecretName } from '../chat/secretNameRegistry'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { anyDirectory, closeDispatchers, type FakeHandle, fakeQueryFactory, flush, initMessage, installManagerCleanup, managedManager, spawned } from './helpers/chatSessionManagerHarness'
import { FAKE_CODEX, Script, THREAD_ID, until } from './codexDriverHarness'

installManagerCleanup()

const ENV_KEYS = [
  'CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'FAKE_ENV_NAMES', 'FAKE_EXIT_AFTER_REPLAY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'PCS_RELAY_TOKEN', 'PCS_SECRET_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let project: string
let home: string
let codexHome: string
let db: SessionDatabase
let liveCodexSession: { manager: ReturnType<typeof Object>; kill: () => void } | null = null
const codexEvents: ChatEvent[] = []

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-wiring-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  codexHome = path.join(tempDir, 'codex-home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
    codex: { label: 'Codex', runtime: 'codex' },
    plain: { label: 'Plain', model: 'sonnet' },
  }))
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
    'relay-provider': {
      label: 'Relay', authTokenEnv: 'PCS_RELAY_TOKEN',
      env: { ANTHROPIC_BASE_URL: 'https://relay.example.internal/api' },
      models: { 'relay-opus': { label: 'Relay Opus', model: 'opus' } },
    },
  }))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = FAKE_CODEX
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  // The host login the Default gate accepts; the credentialed gate never does.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
  delete process.env.PCS_RELAY_TOKEN
  delete process.env.PCS_SECRET_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  resetCodexExecutableCache()
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  resetCodexExecutableCache()
  if (liveCodexSession) {
    const live = liveCodexSession
    liveCodexSession = null
    try { live.kill() } catch { /* already gone */ }
    await Bun.sleep(50)
  }
  closeDispatchers()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const storeFile = () => path.join(home, '.kawai', 'credentials.json')

/** A store document written as an earlier install left it (no retain step ran). */
function writeStoreFile(entries: Record<string, { kind: 'launch-env' | 'secret-source'; value: string }>): void {
  fs.writeFileSync(storeFile(), JSON.stringify({ version: 1, entries }), { mode: 0o600 })
}

/** The server's credentials and the Claude manager, composed as bootstrap does. */
async function claudeServer(handles: FakeHandle[], seed: Record<string, string> = {}) {
  const credentials = createServerCredentials({ db, seed, homeDir: home })
  const manager = await managedManager({
    isDirectory: anyDirectory,
    db, registry: new SessionRegistry(), onEvent: () => {},
    queryFactory: fakeQueryFactory(handles),
    executableCheck: async () => ({ path: '/opt/claude', identity: 'id-1' }),
    availabilityProbe: async () => {},
    profileCatalogHome: home,
    ...credentialManagerOptions(credentials.composition),
  })
  return { credentials, manager }
}

async function firstLaunchEnv(manager: Awaited<ReturnType<typeof claudeServer>>['manager'], handles: FakeHandle[], profile: string) {
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: profile })
  if (!created.ok) throw new Error(created.error)
  expect((await manager.send(created.session.id, 'hello')).ok).toBe(true)
  await spawned(handles, handles.length)
  handles[handles.length - 1]!.push(initMessage(`sdk-${profile}-${handles.length}`))
  await flush()
  return handles[handles.length - 1]!.options.env ?? {}
}

describe('PW2 — gate and spawn agree through the store', () => {
  // @covers: provider-credentials › Credential resolution composes per variable › Gate and spawn agree through the store
  test('PW2: a token resolving only through the store passes creation and rides the launch inside ANTHROPIC_AUTH_TOKEN', async () => {
    const handles: FakeHandle[] = []
    const { credentials, manager } = await claudeServer(handles, { UNRELATED_SEED: 'seed' })
    // The production store with the real SQLite retain collaborator.
    expect(await credentials.store.set('PCS_RELAY_TOKEN', 'store-only-token', 'secret-source')).toEqual({ applied: true, durable: true })
    expect([...readRetainedNames(db)]).toContain('PCS_RELAY_TOKEN')
    const env = await firstLaunchEnv(manager, handles, 'relay-opus')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('store-only-token')
    expect(env.PCS_RELAY_TOKEN).toBeUndefined()
    expect(fs.statSync(storeFile()).mode & 0o777).toBe(0o600)
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Corrupt store degrades visibly
  test('C10 at the gate: a malformed store composes the lower sources, so a store-only token refuses creation with the fixed message', async () => {
    const handles: FakeHandle[] = []
    const { manager } = await claudeServer(handles)
    fs.writeFileSync(storeFile(), '{"version":1,"entries":{"PCS_RELAY_TOKEN":', { mode: 0o600 })
    const refused = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'relay-opus' })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected a refusal')
    expect(refused.error).toBe('Provider Relay needs PCS_RELAY_TOKEN in the server environment.')
    // The process env still applies beneath the unreadable store.
    process.env.PCS_RELAY_TOKEN = 'ambient-token'
    const env = await firstLaunchEnv(manager, handles, 'relay-opus')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ambient-token')
    expect(handles).toHaveLength(1)
  })
})

describe('Store changes apply at the next launch', () => {
  // @covers: provider-credentials › Store changes apply at the next launch › Import then create
  test('import then create: a token imported after startup passes the very next creation without a restart', async () => {
    const handles: FakeHandle[] = []
    const { credentials, manager } = await claudeServer(handles)
    const before = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'relay-opus' })
    expect(before.ok).toBe(false)
    await credentials.store.set('PCS_RELAY_TOKEN', 'imported-token', 'secret-source')
    const env = await firstLaunchEnv(manager, handles, 'relay-opus')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('imported-token')
  })

  // @covers: provider-credentials › Store changes apply at the next launch › Running session keeps its environment
  test('a running session keeps the environment it launched with; only its next launch sees the change', async () => {
    const handles: FakeHandle[] = []
    const { credentials, manager } = await claudeServer(handles)
    await credentials.store.set('PCS_LAUNCH_VAR', 'first', 'launch-env')
    const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'plain' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    expect((await manager.send(id, 'one')).ok).toBe(true)
    await spawned(handles)
    handles[0]!.push(initMessage('sdk-run-1'))
    await flush()
    const launched = handles[0]!.options.env ?? {}
    expect(launched.PCS_LAUNCH_VAR).toBe('first')
    await credentials.store.set('PCS_LAUNCH_VAR', 'second', 'launch-env')
    // A second turn into the live process spawns nothing and changes nothing.
    expect((await manager.send(id, 'two')).ok).toBe(true)
    await flush()
    expect(handles).toHaveLength(1)
    expect(handles[0]!.options.env?.PCS_LAUNCH_VAR).toBe('first')
    // The next launch (after the process ends) reads the store afresh.
    handles[0]!.query.close()
    await flush()
    expect((await manager.send(id, 'three')).ok).toBe(true)
    await spawned(handles, 1)
    handles[1]!.push(initMessage('sdk-run-2'))
    await flush()
    expect(handles[1]!.options.env?.PCS_LAUNCH_VAR).toBe('second')
  })
})

describe('PW3 and A4 — store secret sources stay withheld at every launch', () => {
  test('PW3: a stored secret-source key never reaches a Claude launch under its own name, though it resolves', async () => {
    // Written as an earlier install left it: no retain step has run, so
    // only the registry's store-key source withholds it.
    writeStoreFile({ PCS_SECRET_KEY: { kind: 'secret-source', value: 'stored-secret' } })
    process.env.PCS_SECRET_KEY = 'ambient-secret'
    const handles: FakeHandle[] = []
    const { credentials, manager } = await claudeServer(handles)
    expect(credentials.composition.overrides().PCS_SECRET_KEY).toBe('stored-secret')
    const env = await firstLaunchEnv(manager, handles, 'default')
    expect(env.PCS_SECRET_KEY).toBeUndefined()
    const named = await firstLaunchEnv(manager, handles, 'plain')
    expect(named.PCS_SECRET_KEY).toBeUndefined()
  })

  // @covers: provider-credentials › Registered secret names stay withheld › Reclassification does not end withholding
  test('A4: a secret source reclassified as a launch-env entry stays withheld through the real registry collaborator', async () => {
    writeStoreFile({ PCS_SECRET_KEY: { kind: 'secret-source', value: 'stored-secret' } })
    const handles: FakeHandle[] = []
    const { credentials, manager } = await claudeServer(handles)
    expect([...readRetainedNames(db)]).not.toContain('PCS_SECRET_KEY')
    expect(await credentials.store.reclassify('PCS_SECRET_KEY', 'launch-env')).toEqual({ applied: true, durable: true })
    // The core retained the name (current kind secret source) before the file changed.
    expect([...readRetainedNames(db)]).toContain('PCS_SECRET_KEY')
    expect(credentials.composition.secretSourceKeys()).toEqual([])
    const env = await firstLaunchEnv(manager, handles, 'default')
    expect(env.PCS_SECRET_KEY).toBeUndefined()
    // The listing marks the inert collision (W8).
    const row = credentials.composition.listing(readRetainedNames(db), { state: 'none', text: null, skipped: [], ignored: [] })
      .rows.find(r => r.name === 'PCS_SECRET_KEY')
    expect(row).toMatchObject({ kind: 'launch-env', collision: true })
  })

  test('PW3 at Codex: a stored secret-source key is absent from the Codex launch even when the process env carries it', async () => {
    writeStoreFile({ PCS_SECRET_KEY: { kind: 'secret-source', value: 'stored-secret' } })
    process.env.PCS_SECRET_KEY = 'ambient-secret'
    const rolloutPath = path.join(codexHome, 'sessions', `rollout-${THREAD_ID}.jsonl`)
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true })
    fs.writeFileSync(rolloutPath, '')
    const FILL = {
      limitId: 'codex', limitName: null, normalModelSlug: null,
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1792337450 },
      secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1792879251 },
      credits: null, individualLimit: null, spendControlReached: null,
      planType: 'plus', rateLimitReachedType: null,
    }
    const script = new Script().boot('thread/start', 'gpt-test', rolloutPath).request('account/rateLimits/read', { rateLimits: FILL })
    process.env.FAKE_TRANSCRIPT = script.write(tempDir)
    process.env.FAKE_EXIT_AFTER_REPLAY = '1'
    process.env.FAKE_RUN = '1'
    const namesFile = path.join(tempDir, 'env-names.txt')
    process.env.FAKE_ENV_NAMES = namesFile
    const credentials = createServerCredentials({ db, seed: {}, homeDir: home })
    const wireLogs = { get: () => ({ record: () => {} }), pruneOrphans: async () => {}, delete: async () => {} }
    const manager = await managedManager({
      db, registry: new SessionRegistry(), onEvent: (_id, event) => codexEvents.push(event),
      profileCatalogHome: home, availabilityProbe: async () => {},
      wireLogs: wireLogs as unknown as ChatWireLogs,
      ...credentialManagerOptions(credentials.composition),
    })
    const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    liveCodexSession = { manager, kill: () => manager.kill(id) }
    const exits = () => codexEvents.filter(event => event.type === 'error' && event.message.startsWith('The Codex app-server exited')).length
    await manager.start(id)
    await until(() => exits() >= 1)
    const names = fs.readFileSync(namesFile, 'utf8').split('\n')
    expect(names).toContain('CODEX_HOME')
    expect(names).not.toContain('PCS_SECRET_KEY')
  })
})

describe('S6 — the startup gate orders the migration before restore and creation', () => {
  test('restore and the first creation wait for the startup gate, so a credential the gated step stored passes the first gate', async () => {
    const handles: FakeHandle[] = []
    const credentials = createServerCredentials({ db, seed: {}, homeDir: home })
    let release!: () => void
    const startupGate = new Promise<void>(resolve => { release = resolve })
    const manager = new ChatSessionManager({
      isDirectory: anyDirectory,
      db, registry: new SessionRegistry(), onEvent: () => {},
      queryFactory: fakeQueryFactory(handles),
      executableCheck: async () => ({ path: '/opt/claude', identity: 'id-1' }),
      availabilityProbe: async () => {},
      providerUsageFetch: (async () => { throw new Error('not expected') }) as unknown as typeof fetch,
      profileCatalogHome: home,
      startupGate,
      ...credentialManagerOptions(credentials.composition),
    })
    try {
      let restored = false
      void manager.whenRestored().then(() => { restored = true })
      let settled = false
      const creation = manager.createAvailableSession({ projectPath: project, claudeProfileId: 'relay-opus' })
        .finally(() => { settled = true })
      await flush()
      await Bun.sleep(50)
      expect({ restored, settled }).toEqual({ restored: false, settled: false })
      // The gated step (the migration in bootstrap) writes the store, then settles.
      expect((await credentials.store.set('PCS_RELAY_TOKEN', 'gated-token', 'secret-source')).durable).toBe(true)
      release()
      const created = await creation
      expect(created.ok).toBe(true)
      await manager.whenRestored()
      expect(restored).toBe(true)
    } finally {
      manager.dispatcher.close()
      manager.observations.stop()
    }
  })
})

describe('I3/M7 — a registered output name refuses the credentialed launch', () => {
  for (const source of ['a stored secret-source', 'a retained name only'] as const) {
    test(`a registered ANTHROPIC_AUTH_TOKEN (${source}) refuses the relay creation by name before any spawn, though authTokenEnv names another variable`, async () => {
      const handles: FakeHandle[] = []
      const { credentials, manager } = await claudeServer(handles)
      expect((await credentials.store.set('PCS_RELAY_TOKEN', 'zq-relay-token', 'secret-source')).durable).toBe(true)
      if (source === 'a stored secret-source') {
        expect((await credentials.store.set('ANTHROPIC_AUTH_TOKEN', 'zq-registered-output', 'secret-source')).durable).toBe(true)
      } else {
        retainSecretName(db, 'ANTHROPIC_AUTH_TOKEN')
      }
      expect(readRetainedNames(db).has('ANTHROPIC_AUTH_TOKEN')).toBe(true)
      // The creation gate composes the launch and refuses there, before a session or a child exists.
      const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'relay-opus' })
      expect(created.ok).toBe(false)
      const error = created.ok ? '' : created.error
      expect(error).toContain('Registered secret name(s) ANTHROPIC_AUTH_TOKEN cannot be launched on the credentialed branch')
      expect(error).not.toContain('zq-')
      await flush()
      expect(handles).toHaveLength(0)
    })
  }
})
