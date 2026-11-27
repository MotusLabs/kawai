// The MODIFIED "Named profiles configure independent provider sessions"
// requirement of provider-credential-store: the effective global provider
// overrides are now the store's launch-env entries over the
// AGENTBOARD_CHAT_ENV seed, per variable. Each scenario resolves the shipped
// catalog's real profiles (resolveClaudeProfileDetail) over the composition
// bootstrap builds (createServerCredentials over a real database and a
// disposable HOME), so the profile rules are shown on the store's output.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServerCredentials } from '../chat/credentialComposition'
import { PROFILE_CONTROLLED_ENV, resolveClaudeProfileDetail, type ClaudeLaunchConfiguration } from '../chat/ClaudeProfiles'
import type { RegistryContext } from '../chat/secretNameRegistry'
import { freshTestDatabase } from './helpers/testDatabase'
import type { SessionDatabase } from '../db'

const KEYS = ['PCS_N_STORE', 'PCS_N_SEED', 'PCS_N_PROC', 'PCS_N_UNRELATED'] as const
const original = Object.fromEntries(KEYS.map(key => [key, process.env[key]]))

let root: string
let home: string
let db: SessionDatabase

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-profiles-')))
  home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
  db = freshTestDatabase(path.join(root, 'test.db'))
  for (const key of KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

/** The server's credentials with store launch-env entries, as bootstrap composes them. */
async function server(seed: Record<string, string>, store: Record<string, string>) {
  const credentials = createServerCredentials({ db, seed, homeDir: home })
  for (const [name, value] of Object.entries(store)) {
    expect(await credentials.store.set(name, value, 'launch-env')).toEqual({ applied: true, durable: true })
  }
  const registry: RegistryContext = {
    getAppSetting: key => db.getAppSetting(key),
    setAppSetting: (key, value) => db.setAppSetting(key, value),
    secretSourceKeys: () => credentials.composition.secretSourceKeys(),
  }
  return (profile: string): ClaudeLaunchConfiguration => {
    const launch = resolveClaudeProfileDetail(profile, credentials.composition.overrides(), { homeDir: home }, undefined, registry).launch
    if (launch.runtime !== 'claude') throw new Error(`expected a Claude launch for ${profile}`)
    return launch
  }
}

const GLOBAL = {
  ANTHROPIC_BASE_URL: 'https://gateway.example.internal/api',
  ANTHROPIC_MODEL: 'gateway-model',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet',
}

describe('named profiles over the store composition', () => {
  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › Effective global provider overrides
  test('each variable takes the store launch-env entry, else the seed, else the backend environment', async () => {
    process.env.PCS_N_PROC = 'process'
    process.env.PCS_N_STORE = 'process-store'
    const launch = await server({ PCS_N_STORE: 'seed-store', PCS_N_SEED: 'seed' }, { PCS_N_STORE: 'store' })
    const env = launch('default').env ?? {}
    expect({ store: env.PCS_N_STORE, seed: env.PCS_N_SEED, proc: env.PCS_N_PROC }).toEqual({ store: 'store', seed: 'seed', proc: 'process' })
    // The backend environment itself is never changed.
    expect(process.env.PCS_N_STORE).toBe('process-store')
  })

  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › Default and named profiles over the merged environment
  test('Default keeps the merged configuration; a named profile keeps credentials and unrelated variables and replaces controlled ones', async () => {
    const launch = await server({ ANTHROPIC_AUTH_TOKEN: 'seed-token' }, { ...GLOBAL, PCS_N_UNRELATED: 'kept' })
    const defaults = launch('default')
    expect(defaults.env).toMatchObject({ ...GLOBAL, ANTHROPIC_AUTH_TOKEN: 'seed-token', PCS_N_UNRELATED: 'kept' })
    const glm = launch('glm')
    expect(glm.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'seed-token', PCS_N_UNRELATED: 'kept', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]' })
    expect(glm.env?.ANTHROPIC_MODEL).toBeUndefined()
  })

  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › GLM configuration
  test('GLM over store-composed gateway overrides: its own URL, Opus start, tier map, and 1000000-token window', async () => {
    const glm = (await server({}, GLOBAL))('glm')
    expect(glm.model).toBe('opus')
    expect({ ...glm.env }).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    })
  })

  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › Kimi configuration
  test('Kimi over store-composed gateway overrides: its own URL, kimi-k3[1m] on every tier, and 1000000-token window', async () => {
    const kimi = (await server({}, GLOBAL))('kimi')
    expect(kimi.model).toBe('kimi-k3[1m]')
    expect({ ...kimi.env }).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3[1m]', ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    })
  })

  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › Conflicting Claude settings
  test('the flag settings layer pins only controlled variables to the profile, so other settings stay available', async () => {
    const glm = (await server({}, GLOBAL))('glm')
    if (typeof glm.settings !== 'object' || glm.settings === null) throw new Error('expected an inline flag settings layer')
    const flag: Record<string, string | undefined> = { ...glm.settings.env }
    // The flag layer outranks user, project, and local settings: the profile's
    // routing wins there, absent controlled fields are blanked, and nothing
    // else is written, so unrelated project settings still load.
    expect(flag.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    expect(flag.ANTHROPIC_MODEL).toBe('')
    expect(Object.keys(flag).every(name => (PROFILE_CONTROLLED_ENV as readonly string[]).includes(name))).toBe(true)
    expect(glm.model).toBe('opus')
  })

  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › Global provider settings coexist with profiles
  test('Default uses the stored gateway token, URL, and models; GLM keeps its routing and the token, and the listing shows no value', async () => {
    const credentials = createServerCredentials({ db, seed: {}, homeDir: home })
    await credentials.store.set('ANTHROPIC_AUTH_TOKEN', 'pcs-gateway-token', 'launch-env')
    for (const [name, value] of Object.entries(GLOBAL)) await credentials.store.set(name, value, 'launch-env')
    const registry: RegistryContext = { getAppSetting: k => db.getAppSetting(k), setAppSetting: (k, v) => db.setAppSetting(k, v), secretSourceKeys: () => [] }
    const resolve = (profile: string) => resolveClaudeProfileDetail(profile, credentials.composition.overrides(), { homeDir: home }, undefined, registry).launch as ClaudeLaunchConfiguration
    expect(resolve('default').env).toMatchObject({ ...GLOBAL, ANTHROPIC_AUTH_TOKEN: 'pcs-gateway-token' })
    const glm = resolve('glm')
    expect(glm.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'pcs-gateway-token', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })
    expect(JSON.stringify(glm.settings ?? {})).not.toContain('pcs-gateway-token')
    const listing = credentials.composition.listing(new Set(), { state: 'none', text: null, skipped: [], ignored: [] })
    expect(JSON.stringify(listing)).not.toContain('pcs-gateway-token')
    expect(listing.rows.find(row => row.name === 'ANTHROPIC_AUTH_TOKEN')).toMatchObject({ kind: 'launch-env', state: 'set', source: 'store' })
  })
})
