// Table C of provider-credential-store through the REAL ChatSessionManager
// (A1, findings F4): each row composes the server's credentials exactly as
// bootstrap does — createServerCredentials over a real database and a
// disposable HOME, spread into the manager with credentialManagerOptions —
// and observes the row's synthetic VALUE (never only a name) where a launch
// receives it: the Claude Default launch's child env, the gate's resolution
// through a provider binding for the registered rows (C5-C7: the bound
// ANTHROPIC_AUTH_TOKEN carries the resolved value), and the Codex child's env,
// recorded by a wrapper around the fake app-server. Codex follows D5's
// filtered process env: an unregistered process value passes through (C1),
// registered names are withheld (C5-C7), and neither a seed nor a store entry
// supplies or overrides a Codex variable (C2-C4, C9). Also F1 at the manager:
// stored prototype-shaped names reach the Claude launch as own keys.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import { createServerCredentials, credentialManagerOptions } from '../chat/credentialComposition'
import { claudeSpawnLaunch } from '../chat/provider/claudeRuntimeLaunch'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { anyDirectory, closeDispatchers, type FakeHandle, fakeQueryFactory, flush, initMessage, installManagerCleanup, managedManager, spawned } from './helpers/chatSessionManagerHarness'
import { FAKE_CODEX, Script, THREAD_ID, until } from './codexDriverHarness'

installManagerCleanup()

const VAR = 'PCS_TC_VAR'
const OTHER = 'PCS_TC_OTHER'
const ENV_KEYS = [
  VAR, OTHER, 'CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'FAKE_EXIT_AFTER_REPLAY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let project: string
let home: string
let codexHome: string
let db: SessionDatabase
const cleanups: (() => void)[] = []

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-tablec-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  codexHome = path.join(tempDir, 'codex-home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ codex: { label: 'Codex', runtime: 'codex' } }))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  // The Codex child's values, recorded before it becomes the fake app-server.
  const wrapper = path.join(tempDir, 'codex-wrapper.sh')
  const record = (name: string, label: string) =>
    `if [ -n "\${${name}+x}" ]; then printf '${label}=set:%s\\n' "$${name}"; else printf '${label}=absent\\n'; fi`
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    'if [ "$1" != "--version" ]; then',
    `  { ${record(VAR, 'VAR')}; ${record(OTHER, 'OTHER')}; } > "${codexValuesFile()}.tmp"`,
    `  mv "${codexValuesFile()}.tmp" "${codexValuesFile()}"`,
    'fi',
    `exec "${FAKE_CODEX}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = wrapper
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
  delete process.env[VAR]
  delete process.env[OTHER]
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  resetCodexExecutableCache()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    try { cleanup() } catch { /* already gone */ }
  }
  await Bun.sleep(50)
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  resetCodexExecutableCache()
  closeDispatchers()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function codexValuesFile(): string {
  return path.join(tempDir, 'codex-values.txt')
}

type Entry = { kind: 'launch-env' | 'secret-source'; value: string }

function writeStore(entries: Record<string, Entry>): void {
  fs.writeFileSync(path.join(home, '.kawai', 'credentials.json'), JSON.stringify({ version: 1, entries }), { mode: 0o600 })
}

/** A provider binding VAR — registering it as a catalog credential name. */
function bindVar(): void {
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
    bound: {
      label: 'Bound', authTokenEnv: VAR,
      env: { ANTHROPIC_BASE_URL: 'https://bound.example.internal/api' },
      models: { 'bound-m': { label: 'Bound M', model: 'opus' } },
    },
  }))
}

type Seen = string | undefined

/** One composed server: the Claude manager and its credentials for `seed`. */
async function claudeServer(handles: FakeHandle[], seed: Record<string, string>) {
  const credentials = createServerCredentials({ db, seed, homeDir: home })
  return managedManager({
    isDirectory: anyDirectory,
    db, registry: new SessionRegistry(), onEvent: () => {},
    queryFactory: fakeQueryFactory(handles),
    executableCheck: async () => ({ path: '/opt/claude', identity: 'id-1' }),
    availabilityProbe: async () => {},
    profileCatalogHome: home,
    ...credentialManagerOptions(credentials.composition),
  })
}

/** The child env of a created and started Claude session, or the creation refusal. */
async function claudeLaunch(seed: Record<string, string>, profile: string): Promise<{ env: Record<string, string | undefined> } | { refused: string }> {
  const handles: FakeHandle[] = []
  const manager = await claudeServer(handles, seed)
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: profile })
  if (!created.ok) return { refused: created.error }
  expect((await manager.send(created.session.id, 'hello')).ok).toBe(true)
  await spawned(handles, 0)
  handles[0]!.push(initMessage(`sdk-${profile}`))
  await flush()
  return { env: handles[0]!.options.env ?? {} }
}

/** The VAR and OTHER values the Codex child received (or absent). */
async function codexLaunch(seed: Record<string, string>): Promise<{ VAR: Seen; OTHER: Seen }> {
  fs.rmSync(codexValuesFile(), { force: true })
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
  const events: ChatEvent[] = []
  const credentials = createServerCredentials({ db, seed, homeDir: home })
  const wireLogs = { get: () => ({ record: () => {} }), pruneOrphans: async () => {}, delete: async () => {} }
  const manager = await managedManager({
    db, registry: new SessionRegistry(), onEvent: (_id, event) => events.push(event),
    profileCatalogHome: home, availabilityProbe: async () => {},
    wireLogs: wireLogs as unknown as ChatWireLogs,
    ...credentialManagerOptions(credentials.composition),
  })
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id
  cleanups.push(() => manager.kill(id))
  await manager.start(id)
  await until(() => fs.existsSync(codexValuesFile()))
  await until(() => events.some(event => event.type === 'error' && event.message.startsWith('The Codex app-server exited')))
  const lines = Object.fromEntries(fs.readFileSync(codexValuesFile(), 'utf8').trim().split('\n').map(line => line.split('=', 2) as [string, string]))
  const read = (raw: string | undefined): Seen => (raw === undefined || raw === 'absent' ? undefined : raw.slice('set:'.length))
  return { VAR: read(lines.VAR), OTHER: read(lines.OTHER) }
}

const value = (launch: Awaited<ReturnType<typeof claudeLaunch>>, name: string): Seen | 'refused' =>
  'refused' in launch ? 'refused' : launch.env[name]

interface Row {
  id: string
  row: string
  process: string | null
  seed: string | null
  store: Entry | null
  /** Registered through a provider binding of VAR (C6, C7, registered C8). */
  bound: boolean
  claude: Seen
  /** The gate's resolved value, seen through the binding (registered rows). */
  gate?: Seen | 'refused'
  codex: Seen
}

// Table C rows, verbatim from design.md ("Composition table C"), each with
// its observable reading through the manager.
const ROWS: Row[] = [
  { id: 'C1', row: '| C1 | set | absent | absent | no | process value | process value |', process: 'zq-p', seed: null, store: null, bound: false, claude: 'zq-p', codex: 'zq-p' },
  { id: 'C2', row: '| C2 | * | set | absent | no | seed value | seed value |', process: 'zq-p', seed: 'zq-s', store: null, bound: false, claude: 'zq-s', codex: 'zq-p' },
  { id: 'C2', row: '| C2 | * | set | absent | no | seed value | seed value |', process: null, seed: 'zq-s', store: null, bound: false, claude: 'zq-s', codex: undefined },
  { id: 'C3', row: '| C3 | * | * | launch-env set | no | store value | store value (W6), except C11 |', process: 'zq-p', seed: 'zq-s', store: { kind: 'launch-env', value: 'zq-v' }, bound: false, claude: 'zq-v', codex: 'zq-p' },
  { id: 'C3', row: '| C3 | * | * | launch-env set | no | store value | store value (W6), except C11 |', process: null, seed: null, store: { kind: 'launch-env', value: 'zq-v' }, bound: false, claude: 'zq-v', codex: undefined },
  { id: 'C4', row: '| C4 | * | * | launch-env blank | no | empty string | empty string |', process: 'zq-p', seed: 'zq-s', store: { kind: 'launch-env', value: '' }, bound: false, claude: '', codex: 'zq-p' },
  { id: 'C5', row: '| C5 | * | * | secret-source set | yes (by construction) | store value | absent under its own name; reaches a launch only through a binding (W3) |', process: 'zq-p', seed: 'zq-s', store: { kind: 'secret-source', value: 'zq-v' }, bound: false, claude: undefined, gate: 'zq-v', codex: undefined },
  { id: 'C6', row: '| C6 | * | * | launch-env set | yes | store value | absent (W7, inert) — the credential listing marks the collision |', process: 'zq-p', seed: 'zq-s', store: { kind: 'launch-env', value: 'zq-v' }, bound: true, claude: undefined, gate: 'zq-v', codex: undefined },
  { id: 'C7', row: '| C7 | set | absent | absent | yes | process value | absent (W2/W5) |', process: 'zq-p', seed: null, store: null, bound: true, claude: undefined, gate: 'zq-p', codex: undefined },
  { id: 'C8', row: '| C8 | absent | absent | absent | * | absent | absent |', process: null, seed: null, store: null, bound: false, claude: undefined, codex: undefined },
  { id: 'C8', row: '| C8 | absent | absent | absent | * | absent | absent |', process: null, seed: null, store: null, bound: true, claude: undefined, gate: 'refused', codex: undefined },
]

describe('table C through the real ChatSessionManager', () => {
  for (const row of ROWS) {
    const label = `process ${row.process ?? 'absent'}, seed ${row.seed ?? 'absent'}, store ${row.store ? `${row.store.kind} "${row.store.value}"` : 'absent'}${row.bound ? ', bound' : ''}`
    test(`${row.id} (${label}): the Claude launch, the gate, and the Codex launch observe the row's value`, async () => {
      if (row.process !== null) process.env[VAR] = row.process
      if (row.store) writeStore({ [VAR]: row.store })
      const seed: Record<string, string> = row.seed === null ? {} : { [VAR]: row.seed }
      // C5 is registered by its store kind alone: observe its launches before any binding.
      if (row.bound) bindVar()
      const seen: Record<string, Seen | 'refused'> = { claude: value(await claudeLaunch(seed, 'default'), VAR) }
      if (row.gate !== undefined) {
        bindVar()
        const bound = await claudeLaunch(seed, 'bound-m')
        seen.gate = value(bound, 'ANTHROPIC_AUTH_TOKEN')
        seen.boundOwn = value(bound, VAR)
      }
      seen.codex = (await codexLaunch(seed)).VAR
      const want: Record<string, Seen | 'refused'> = { claude: row.claude, codex: row.codex }
      if (row.gate !== undefined) Object.assign(want, { gate: row.gate, boundOwn: row.gate === 'refused' ? 'refused' : undefined })
      expect({ row: row.row, ...seen }).toEqual({ row: row.row, ...want })
    }, 30_000)
  }

  // @covers: provider-credentials › Credential resolution composes per variable › A seed-only sibling key survives
  test('C9: the seed holds two variables, the store one — Claude composes per variable; Codex takes neither', async () => {
    // | C9 | * | set (two variables) | launch-env for one of them | no | per variable | per variable: store for one, seed for the other ("A seed-only sibling key survives") |
    writeStore({ [VAR]: { kind: 'launch-env', value: 'zq-from-store' } })
    const seed = { [VAR]: 'zq-seed-a', [OTHER]: 'zq-seed-b' }
    const claude = await claudeLaunch(seed, 'default')
    expect({ VAR: value(claude, VAR), OTHER: value(claude, OTHER) }).toEqual({ VAR: 'zq-from-store', OTHER: 'zq-seed-b' })
    expect(await codexLaunch(seed)).toEqual({ VAR: undefined, OTHER: undefined })
    process.env[VAR] = 'zq-ambient-a'
    expect(await codexLaunch(seed)).toEqual({ VAR: 'zq-ambient-a', OTHER: undefined })
  }, 30_000)

  test('C10: a malformed store composes process and seed at the Claude launch; Codex keeps the process value', async () => {
    // | C10 | * | * | store unreadable / unsafe / malformed | * | composes process env < seed, as if the store were absent; listing reports the fixed reason | same, minus registered names |
    fs.writeFileSync(path.join(home, '.kawai', 'credentials.json'), '{"version":1,"entries":', { mode: 0o600 })
    process.env[OTHER] = 'zq-ambient-other'
    const claude = await claudeLaunch({ [VAR]: 'zq-seed' }, 'default')
    expect({ VAR: value(claude, VAR), OTHER: value(claude, OTHER) }).toEqual({ VAR: 'zq-seed', OTHER: 'zq-ambient-other' })
    expect(await codexLaunch({ [VAR]: 'zq-seed' })).toEqual({ VAR: undefined, OTHER: 'zq-ambient-other' })
  }, 30_000)

  test('F1: the env Kawai hands the runtime (LaunchConfiguration.childEnv) carries __proto__, constructor, and prototype as own entries', () => {
    // decision-145e46be: the runtime's launch normalization and node:child_process
    // then drop __proto__ (recorded limit); this is Kawai's side of the boundary.
    writeStore(Object.fromEntries(['__proto__', 'constructor', 'prototype', VAR].map(name => [name, { kind: 'launch-env' as const, value: `zq-${name}` }])))
    const credentials = createServerCredentials({ db, seed: {}, homeDir: home })
    const spawn = claudeSpawnLaunch({
      claudeProfileId: 'default', projectPath: project, profileCatalogHome: home, retainedNamesDb: db, injected: true,
      ...credentialManagerOptions(credentials.composition),
    })
    const env = spawn.launch.childEnv
    const own = (name: string) => (Object.hasOwn(env, name) ? Object.getOwnPropertyDescriptor(env, name)?.value : 'missing')
    expect(['__proto__', 'constructor', 'prototype', VAR].map(own)).toEqual(['zq-__proto__', 'zq-constructor', 'zq-prototype', `zq-${VAR}`])
  })

  test('F1: stored prototype-shaped names (constructor, prototype) reach the Claude launch as own keys beside a sibling', async () => {
    // `__proto__` stays an own key through Kawai's composition (credentialComposition.test.ts);
    // the runtime package's launch normalization and the OS spawn drop that one name (limitation).
    const entries: Record<string, Entry> = Object.fromEntries([['constructor', 'zq-ctor'], ['prototype', 'zq-proto-name'], [VAR, 'zq-sibling']].map(([name, value]) => [name, { kind: 'launch-env', value }]))
    writeStore(entries)
    const claude = await claudeLaunch({}, 'default')
    if ('refused' in claude) throw new Error(claude.refused)
    const own = (name: string) => (Object.hasOwn(claude.env, name) ? claude.env[name] : 'missing')
    expect({ constructor: own('constructor'), prototype: own('prototype'), sibling: own(VAR) }).toEqual({ constructor: 'zq-ctor', prototype: 'zq-proto-name', sibling: 'zq-sibling' })
  }, 30_000)
})
