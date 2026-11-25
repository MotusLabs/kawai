// The credentialed transport refusal of provider-credential-store (A1, r5,
// decision-a15a8e4e): a credential-bearing Claude launch pins every
// TRANSPORT_PIN_ENV key in the child env and the flag settings layer, so a
// non-empty value the credential store supplies refuses the launch by name;
// a blank store entry pins empty; process and seed pins keep their published
// behavior; the Default and named non-credentialed branches compose no pins
// and keep delivering store entries in the child env only. Every row runs
// through the production composition (createServerCredentials over a real
// database and a disposable HOME, one snapshot per resolution) and the real
// resolveClaudeProfileDetail. Mutant it kills: "refusal bypassed" (a store
// value pinned into the flag layer), and "the spawn ignores the snapshot"
// (claudeSpawnLaunch, the boundary every driver spawn and resume crosses).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServerCredentials, type ServerCredentials } from '../chat/credentialComposition'
import { resolveClaudeProfileDetail, TRANSPORT_PIN_ENV, type ClaudeLaunchConfiguration } from '../chat/ClaudeProfiles'
import { claudeSpawnLaunch } from '../chat/provider/claudeRuntimeLaunch'
import { StoreTransportRefusal, type RegistryContext } from '../chat/secretNameRegistry'
import type { SessionDatabase } from '../db'
import { freshTestDatabase } from './helpers/testDatabase'

const VALUE = 'http://zq-user:zq-pass@proxy.example.internal:3128'
const OTHER = 'http://zq-other.example.internal:8080'

let root: string
let home: string
let db: SessionDatabase
const saved = Object.fromEntries(TRANSPORT_PIN_ENV.map(name => [name, process.env[name]]))

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-pins-')))
  home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ plain: { label: 'Plain', model: 'sonnet' } }))
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
    relay: {
      label: 'Relay', authTokenEnv: 'PCS_PIN_TOKEN',
      env: { ANTHROPIC_BASE_URL: 'https://relay.example.internal/api' },
      models: { 'relay-opus': { label: 'Relay Opus', model: 'opus' } },
    },
  }))
  db = freshTestDatabase(path.join(root, 'test.db'))
  for (const name of TRANSPORT_PIN_ENV) delete process.env[name]
})

afterEach(() => {
  for (const name of TRANSPORT_PIN_ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function server(seed: Record<string, string> = {}): Promise<ServerCredentials> {
  const credentials = createServerCredentials({ db, seed, homeDir: home })
  expect((await credentials.store.set('PCS_PIN_TOKEN', 'zq-pin-token', 'secret-source')).durable).toBe(true)
  return credentials
}

/** One launch from one snapshot, as the manager's admission and each spawn resolve it. */
function resolve(credentials: ServerCredentials, profile: string): ClaudeLaunchConfiguration {
  const registry: RegistryContext = {
    getAppSetting: key => db.getAppSetting(key),
    setAppSetting: (key, value) => db.setAppSetting(key, value),
    secretSourceKeys: () => credentials.composition.secretSourceKeys(),
  }
  const snapshot = credentials.composition.snapshot()
  const launch = resolveClaudeProfileDetail(profile, snapshot.env, { homeDir: home }, undefined, registry, snapshot.storeSourced).launch
  if (launch.runtime !== 'claude') throw new Error('expected a Claude launch')
  return launch
}

function refusalOf(run: () => unknown): StoreTransportRefusal {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(StoreTransportRefusal)
    return error as StoreTransportRefusal
  }
  throw new Error('expected the credentialed transport refusal')
}

const flag = (launch: ClaudeLaunchConfiguration) => (launch.settings as { env?: Record<string, string> } | undefined)?.env

// Table C's C11 row, verbatim:
// | C11 | * | * | launch-env set, non-empty, for a `TRANSPORT_PIN_ENV` key | no | store value | Default, named, and wrapper launches: store value in the child env only. A credentialed launch refuses before SDK availability or spawn, naming the keys and no value (r5, decision-a15a8e4e), at creation and at every spawn or resume, from one snapshot. A blank entry pins empty (C4); process and seed values pin as before |
// Its expansion per pin key: | Row | process | seed | store | credentialed launch: child / flag |
const ROWS: { id: string; process?: string; seed?: string; store?: string; expected: 'refuse' | string }[] = [
  { id: 'T1 absent', expected: '' },
  { id: 'T2 process', process: VALUE, expected: VALUE },
  { id: 'T3 seed', seed: VALUE, expected: VALUE },
  { id: 'T4 seed over process', process: OTHER, seed: VALUE, expected: VALUE },
  { id: 'T5 store', store: VALUE, expected: 'refuse' },
  { id: 'T6 store over process', process: OTHER, store: VALUE, expected: 'refuse' },
  { id: 'T7 store over seed', seed: OTHER, store: VALUE, expected: 'refuse' },
  { id: 'T8 store blank', store: '', expected: '' },
  { id: 'T9 store blank over process', process: OTHER, store: '', expected: '' },
  { id: 'T10 store blank over seed', seed: OTHER, store: '', expected: '' },
]

describe('the credentialed transport refusal — every pin key, its winning source, and blank precedence', () => {
  for (const key of TRANSPORT_PIN_ENV) {
    for (const row of ROWS) {
      test(`${row.id}: ${key} on a credentialed launch ${row.expected === 'refuse' ? 'refuses by name' : 'pins the winning value in the child env and the flag layer'}`, async () => {
        if (row.process !== undefined) process.env[key] = row.process
        const credentials = await server(row.seed !== undefined ? { [key]: row.seed } : {})
        if (row.store !== undefined) expect((await credentials.store.set(key, row.store, 'launch-env')).durable).toBe(true)
        if (row.expected === 'refuse') {
          const refusal = refusalOf(() => resolve(credentials, 'relay-opus'))
          expect(refusal.names).toEqual([key])
          expect(refusal.message).toContain(`Credential store entry ${key} cannot be used by a credentialed launch`)
          expect(refusal.message).not.toContain('zq-')
          return
        }
        const launch = resolve(credentials, 'relay-opus')
        expect({ child: launch.env?.[key], flag: flag(launch)?.[key] }).toEqual({ child: row.expected, flag: row.expected })
        // The route stays pinned and the token rides its designed channel.
        expect(flag(launch)?.ANTHROPIC_BASE_URL).toBe('https://relay.example.internal/api')
        expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('zq-pin-token')
      })
    }
  }

  test('several store-backed pin keys are named together, sorted, with no value', async () => {
    const credentials = await server()
    await credentials.store.set('NO_PROXY', 'zq-no-proxy.example.internal', 'launch-env')
    await credentials.store.set('HTTPS_PROXY', VALUE, 'launch-env')
    await credentials.store.set('HTTP_PROXY', '', 'launch-env')
    const refusal = refusalOf(() => resolve(credentials, 'relay-opus'))
    expect(refusal.names).toEqual(['HTTPS_PROXY', 'NO_PROXY'])
    expect(refusal.message).toContain('Credential store entries HTTPS_PROXY, NO_PROXY cannot be used')
    expect(refusal.message).not.toContain('zq-')
  })

  for (const profile of ['default', 'plain'] as const) {
    test(`the ${profile} branch is unaffected: a store pin key still delivers in the child env and never enters the flag layer`, async () => {
      const credentials = await server()
      await credentials.store.set('HTTPS_PROXY', VALUE, 'launch-env')
      const launch = resolve(credentials, profile)
      expect(launch.env?.HTTPS_PROXY).toBe(VALUE)
      expect(flag(launch)?.HTTPS_PROXY).toBeUndefined()
      expect(JSON.stringify(launch.settings ?? {})).not.toContain('zq-')
    })
  }

  test('clearing the store entry lifts the refusal at the next resolution (fresh composition)', async () => {
    const credentials = await server()
    await credentials.store.set('HTTPS_PROXY', VALUE, 'launch-env')
    refusalOf(() => resolve(credentials, 'relay-opus'))
    await credentials.store.clear('HTTPS_PROXY')
    const launch = resolve(credentials, 'relay-opus')
    expect({ child: launch.env?.HTTPS_PROXY, flag: flag(launch)?.HTTPS_PROXY }).toEqual({ child: '', flag: '' })
  })

  // @covers: provider-credentials › Credential resolution composes per variable › A stored transport value refuses a credentialed launch
  test('every spawn and resume resolves its own snapshot: claudeSpawnLaunch refuses a store pin key and pins a blank empty', async () => {
    const credentials = await server()
    const spawn = () => claudeSpawnLaunch({
      claudeProfileId: 'relay-opus',
      getProviderEnvSnapshot: () => credentials.composition.snapshot(),
      profileCatalogHome: home,
      retainedNamesDb: db,
      projectPath: root,
      injected: true,
    })
    await credentials.store.set('NODE_EXTRA_CA_CERTS', '/zq-store/ca.pem', 'launch-env')
    expect(refusalOf(spawn).names).toEqual(['NODE_EXTRA_CA_CERTS'])
    await credentials.store.set('NODE_EXTRA_CA_CERTS', '', 'launch-env')
    const launched = spawn()
    expect({ child: launched.launch.childEnv.NODE_EXTRA_CA_CERTS, flag: launched.settingsEnv?.NODE_EXTRA_CA_CERTS }).toEqual({ child: '', flag: '' })
    expect(JSON.stringify(launched.settingsEnv)).not.toContain('zq-')
  })
})
