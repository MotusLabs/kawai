// F8 of provider-credential-store: the Default (non-credentialed) auth gate
// evaluates only the explicit launch env the spawn receives — no process.env
// merge — so a key the launch withholds (a secret-source or registered name)
// or blanks (a blank store entry, C4) never admits a chat. Each row is the
// only authentication in a disposable HOME and an empty CLAUDE_CONFIG_DIR (no
// OAuth token, no login file), so the admission depends on the exercised key
// alone; admitted rows also start the agent and observe the delivered value.
// Composed as bootstrap does: createServerCredentials over a real database,
// spread into the real ChatSessionManager with credentialManagerOptions.
// Direct hasClaudeAuth callers keep the merge.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasClaudeAuth, hasClaudeAuthIn } from '../chat/chatAuth'
import { createServerCredentials, credentialManagerOptions } from '../chat/credentialComposition'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { closeDispatchers, type FakeHandle, fakeQueryFactory, flush, initMessage, installManagerCleanup, managedManager, spawned } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

const KEY = 'ANTHROPIC_API_KEY'
const ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let home: string
let db: SessionDatabase

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-gate-')))
  home = path.join(tempDir, 'home')
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(tempDir, 'claude-config'), { recursive: true })
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const) delete process.env[key]
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
})

afterEach(() => {
  closeDispatchers()
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

interface GateRow {
  name: string
  process?: string
  seed?: string
  store?: { kind: 'launch-env' | 'secret-source'; value: string }
  /** Registers KEY through a provider binding (C7's registered process value). */
  bound?: boolean
  /** The admission and, when admitted, the KEY value the Default child receives. */
  want: { admitted: false } | { admitted: true; delivered: string }
}

const ROWS: GateRow[] = [
  // The reviewer's reproduction: the store's secret-source entry registers the
  // name, so the process value is withheld from Default and cannot admit it.
  { name: 'C5: a secret-source store entry withholds the process value', process: 'zq-proc', store: { kind: 'secret-source', value: 'zq-secret' }, want: { admitted: false } },
  { name: 'C7: a provider-registered process value is withheld', process: 'zq-proc', bound: true, want: { admitted: false } },
  { name: 'C4: a blank launch-env store entry pins empty over the process value', process: 'zq-proc', store: { kind: 'launch-env', value: '' }, want: { admitted: false } },
  { name: 'C1: an unregistered process value admits', process: 'zq-proc', want: { admitted: true, delivered: 'zq-proc' } },
  { name: 'C2: a seed value admits', seed: 'zq-seed', want: { admitted: true, delivered: 'zq-seed' } },
  { name: 'C3: a launch-env store value admits', store: { kind: 'launch-env', value: 'zq-store' }, want: { admitted: true, delivered: 'zq-store' } },
  { name: 'C8: no source refuses', want: { admitted: false } },
]

async function gate(row: GateRow): Promise<{ admitted: false } | { admitted: true; delivered: string | undefined }> {
  if (row.process === undefined) delete process.env[KEY]
  else process.env[KEY] = row.process
  if (row.store) {
    fs.writeFileSync(path.join(home, '.kawai', 'credentials.json'), JSON.stringify({ version: 1, entries: { [KEY]: row.store } }), { mode: 0o600 })
  }
  if (row.bound) {
    fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
      bound: { label: 'Bound', authTokenEnv: KEY, env: { ANTHROPIC_BASE_URL: 'https://bound.example.internal/api' }, models: { 'bound-m': { model: 'opus' } } },
    }))
  }
  const credentials = createServerCredentials({ db, seed: row.seed === undefined ? {} : { [KEY]: row.seed }, homeDir: home })
  const handles: FakeHandle[] = []
  let probed = 0
  const manager = await managedManager({
    isDirectory: () => true, db, registry: new SessionRegistry(), onEvent: () => {},
    queryFactory: fakeQueryFactory(handles),
    executableCheck: async () => ({ path: '/opt/claude', identity: 'id-1' }),
    availabilityProbe: async () => { probed++ },
    profileCatalogHome: home,
    ...credentialManagerOptions(credentials.composition),
  })
  const created = await manager.createAvailableSession({ projectPath: '/tmp/proj', claudeProfileId: 'default' })
  if (!created.ok) {
    // A refusal is the gate's, before the availability probe.
    expect({ probed, error: created.error.startsWith('Chat sessions need Claude authentication') }).toEqual({ probed: 0, error: true })
    return { admitted: false }
  }
  expect((await manager.send(created.session.id, 'hello')).ok).toBe(true)
  await spawned(handles, 0)
  handles[0]!.push(initMessage('sdk-gate'))
  await flush()
  return { admitted: true, delivered: handles[0]!.options.env?.[KEY] }
}

describe('F8 — the Default gate reads only the explicit launch env', () => {
  test.each(ROWS.map(row => [row.name, row] as const))('Default gate row %s', async (_name, row) => {
    expect(await gate(row)).toEqual(row.want)
  }, 30_000)

  test('hasClaudeAuth keeps merging the process environment for direct callers; hasClaudeAuthIn reads only its argument', () => {
    process.env[KEY] = 'zq-proc'
    expect(hasClaudeAuth({})).toBe(true)
    expect(hasClaudeAuthIn({ HOME: home, CLAUDE_CONFIG_DIR: path.join(tempDir, 'claude-config') })).toBe(false)
    expect(hasClaudeAuthIn({ [KEY]: 'zq-explicit' })).toBe(true)
    expect(hasClaudeAuthIn({ [KEY]: '  ' , CLAUDE_CONFIG_DIR: path.join(tempDir, 'claude-config') })).toBe(false)
  })
})
