// Table C of provider-credential-store (per-variable composition) and its
// property PC1, through the real projections: the store core, the
// CredentialComposition owner, effectiveChatEnv (the gate's and injection's
// resolution), resolveClaudeProfileDetail (Default and named Claude
// launches), and codexSpawnEnv with withheldCredentialNamesAt (the Codex
// launch). Codex keeps design D5's Codex row — the process env minus the
// registry, never the seed or store launch-env entries — so a Codex launch
// observes table C's withholding (C5-C7) and C1 (Lead decision pending;
// recorded in the task journal). Also S2/A5: the store and the catalogs
// resolve under the same HOME.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CredentialComposition, credentialStorePath, deliveryEnv, resolutionEnv } from '../chat/credentialComposition'
import { createCredentialStore } from '../chat/credentialStore'
import { effectiveChatEnv, type ChatProviderEnv } from '../chat/chatProviderEnv'
import { resolveClaudeProfileDetail, withheldCredentialNamesAt } from '../chat/ClaudeProfiles'
import { codexSpawnEnv } from '../chat/codexProfiles'
import { profileCatalogLevels } from '../chat/profileCatalog'
import { RETAINED_SECRET_NAMES_KEY, type RegistryContext } from '../chat/secretNameRegistry'
import { propertyCases } from './helpers/propertyCases'

const VAR = 'PCS_C_VAR'
const OTHER = 'PCS_C_OTHER'
const ENV_KEYS = [VAR, OTHER, 'HOME'] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let root: string
let home: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-compose-')))
  home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
  // A named, non-credentialed profile: the named branch keeps unrelated variables.
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
    relay: { label: 'Relay', model: 'sonnet', env: { ANTHROPIC_BASE_URL: 'https://relay.example.internal/api' } },
  }))
  delete process.env[VAR]
  delete process.env[OTHER]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

type StoreSpec = Record<string, { kind: 'launch-env' | 'secret-source'; value: string }>

function writeStore(entries: StoreSpec, mode = 0o600): string {
  const file = path.join(home, '.kawai', 'credentials.json')
  fs.rmSync(file, { force: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries }), { mode })
  fs.chmodSync(file, mode)
  return file
}

/** Register a name through a catalog binding (any parsed layer registers). */
function registerByCatalog(name: string): void {
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
    bound: {
      label: 'Bound', authTokenEnv: name,
      env: { ANTHROPIC_BASE_URL: 'https://bound.example.internal/api' },
      models: { 'bound-m': { label: 'Bound M', model: 'opus' } },
    },
  }))
}

function memoryRegistry(composition: CredentialComposition): RegistryContext & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    getAppSetting: key => rows.get(key) ?? null,
    setAppSetting: (key, value) => { rows.set(key, value) },
    secretSourceKeys: () => composition.secretSourceKeys(),
  }
}

interface Observed {
  gate: string | undefined
  claudeDefault: string | undefined
  claudeNamed: string | undefined
  codex: string | undefined
}

/** One composed server's observables for `name`, through the real projections. */
function observe(seed: ChatProviderEnv, name: string): { observed: Observed; composition: CredentialComposition; registry: RegistryContext } {
  const store = createCredentialStore(path.join(home, '.kawai', 'credentials.json'))
  const composition = new CredentialComposition({ store, seed })
  const registry = memoryRegistry(composition)
  const overrides = composition.overrides()
  const ctx = { homeDir: home }
  const claudeDefault = resolveClaudeProfileDetail('default', overrides, ctx, undefined, registry).launch
  const claudeNamed = resolveClaudeProfileDetail('relay', overrides, ctx, undefined, registry).launch
  if (claudeDefault.runtime !== 'claude' || claudeNamed.runtime !== 'claude') throw new Error('expected Claude launches')
  const codex = codexSpawnEnv(process.env, path.join(root, 'codex'), withheldCredentialNamesAt(ctx, registry))
  return {
    composition, registry,
    observed: {
      gate: effectiveChatEnv(overrides)[name],
      claudeDefault: claudeDefault.env?.[name],
      claudeNamed: claudeNamed.env?.[name],
      codex: codex[name],
    },
  }
}

// Table C, verbatim from design.md ("Composition table C"); the executable
// columns below each row are its observable reading at the gate and the
// launches. "Codex" is D5's Codex row: process env minus the registry.
const TABLE_C = [
  { id: 'C1', row: '| C1 | set | absent | absent | no | process value | process value |', process: 'p', seed: null, store: null, registered: false, expect: { gate: 'p', launch: 'p', codex: 'p' } },
  { id: 'C2', row: '| C2 | * | set | absent | no | seed value | seed value |', process: 'p', seed: 's', store: null, registered: false, expect: { gate: 's', launch: 's', codex: 'p' } },
  { id: 'C2', row: '| C2 | * | set | absent | no | seed value | seed value |', process: null, seed: 's', store: null, registered: false, expect: { gate: 's', launch: 's', codex: undefined } },
  { id: 'C3', row: '| C3 | * | * | launch-env set | no | store value | store value (W6) |', process: 'p', seed: 's', store: { kind: 'launch-env', value: 'v' }, registered: false, expect: { gate: 'v', launch: 'v', codex: 'p' } },
  { id: 'C3', row: '| C3 | * | * | launch-env set | no | store value | store value (W6) |', process: null, seed: null, store: { kind: 'launch-env', value: 'v' }, registered: false, expect: { gate: 'v', launch: 'v', codex: undefined } },
  { id: 'C4', row: '| C4 | * | * | launch-env blank | no | empty string | empty string |', process: 'p', seed: 's', store: { kind: 'launch-env', value: '' }, registered: false, expect: { gate: '', launch: '', codex: 'p' } },
  { id: 'C5', row: '| C5 | * | * | secret-source set | yes (by construction) | store value | absent under its own name; reaches a launch only through a binding (W3) |', process: 'p', seed: 's', store: { kind: 'secret-source', value: 'v' }, registered: false, expect: { gate: 'v', launch: undefined, codex: undefined } },
  { id: 'C6', row: '| C6 | * | * | launch-env set | yes | store value | absent (W7, inert) — the credential listing marks the collision |', process: 'p', seed: 's', store: { kind: 'launch-env', value: 'v' }, registered: true, expect: { gate: 'v', launch: undefined, codex: undefined } },
  { id: 'C7', row: '| C7 | set | absent | absent | yes | process value | absent (W2/W5) |', process: 'p', seed: null, store: null, registered: true, expect: { gate: 'p', launch: undefined, codex: undefined } },
  { id: 'C8', row: '| C8 | absent | absent | absent | * | absent | absent |', process: null, seed: null, store: null, registered: false, expect: { gate: undefined, launch: undefined, codex: undefined } },
  { id: 'C8', row: '| C8 | absent | absent | absent | * | absent | absent |', process: null, seed: null, store: null, registered: true, expect: { gate: undefined, launch: undefined, codex: undefined } },
] as const

describe('table C — per-variable composition', () => {
  test('table C rows C1-C8 hold at the gate, the Claude launches, and the Codex launch', () => {
    const mismatches: string[] = []
    for (const row of TABLE_C) {
      fs.rmSync(path.join(home, '.kawai', 'providers.json'), { force: true })
      fs.rmSync(path.join(home, '.kawai', 'credentials.json'), { force: true })
      if (row.process === null) delete process.env[VAR]
      else process.env[VAR] = row.process
      if (row.store) writeStore({ [VAR]: row.store })
      if (row.registered) registerByCatalog(VAR)
      const seed: ChatProviderEnv = row.seed === null ? {} : { [VAR]: row.seed }
      const { observed, composition, registry } = observe(seed, VAR)
      const want = { gate: row.expect.gate, claudeDefault: row.expect.launch, claudeNamed: row.expect.launch, codex: row.expect.codex }
      for (const key of Object.keys(want) as (keyof Observed)[]) {
        if (observed[key] !== want[key]) mismatches.push(`${row.id} ${key}: got ${String(observed[key])}, want ${String(want[key])}`)
      }
      if (row.id === 'C6') {
        const listing = composition.listing(withheldCredentialNamesAt({ homeDir: home }, registry), { state: 'none', text: null, skipped: [], ignored: [] })
        const listed = listing.rows.find(r => r.name === VAR)
        if (!listed?.collision) mismatches.push('C6 listing: collision not marked')
      }
    }
    expect(mismatches).toEqual([])
  })

  // @covers: provider-credentials › Credential resolution composes per variable › A seed-only sibling key survives
  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › A seed-only sibling key survives
  test('C9: the seed holds two variables, the store one — delivery composes per variable', () => {
    // | C9 | * | set (two variables) | launch-env for one of them | no | per variable | per variable: store for one, seed for the other ("A seed-only sibling key survives") |
    writeStore({ [VAR]: { kind: 'launch-env', value: 'from-store' } })
    const { observed } = observe({ [VAR]: 'seed-a', [OTHER]: 'seed-b' }, VAR)
    const other = observe({ [VAR]: 'seed-a', [OTHER]: 'seed-b' }, OTHER).observed
    expect(observed.gate).toBe('from-store')
    expect(observed.claudeDefault).toBe('from-store')
    expect(observed.claudeNamed).toBe('from-store')
    expect(other.gate).toBe('seed-b')
    expect(other.claudeDefault).toBe('seed-b')
    expect(other.claudeNamed).toBe('seed-b')
    // Codex (D5): neither the seed nor the store supplies or overrides its variables.
    expect(observed.codex).toBeUndefined()
    expect(other.codex).toBeUndefined()
    process.env[VAR] = 'ambient-a'
    expect(observe({ [VAR]: 'seed-a' }, VAR).observed.codex).toBe('ambient-a')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Corrupt store degrades visibly
  // @covers: provider-credentials › Imported credentials live in the server-owned store › Invalid store is never salvaged
  test('C10: an unreadable, unsafe, or malformed store composes the lower sources and the listing reports why', () => {
    // | C10 | * | * | store unreadable / unsafe / malformed | * | composes process env < seed, as if the store were absent; listing reports the fixed reason | same, minus registered names |
    process.env[OTHER] = 'ambient-other'
    const variants: { name: string; reason: string; write: () => void }[] = [
      { name: 'malformed JSON', reason: 'malformed', write: () => { const f = writeStore({}); fs.writeFileSync(f, '{"version":1,"entries":') } },
      { name: 'unknown kind', reason: 'malformed', write: () => writeStore({ [VAR]: { kind: 'bogus' as 'launch-env', value: 'stored' } }) },
      { name: 'unsupported version', reason: 'malformed', write: () => { const f = writeStore({}); fs.writeFileSync(f, JSON.stringify({ version: 2, entries: {} })) } },
      { name: 'group-readable 0644', reason: 'unsafe-permissions', write: () => writeStore({ [VAR]: { kind: 'launch-env', value: 'stored' } }, 0o644) },
    ]
    for (const variant of variants) {
      variant.write()
      const bytes = fs.readFileSync(path.join(home, '.kawai', 'credentials.json'))
      const { observed, composition, registry } = observe({ [VAR]: 'seed-value' }, VAR)
      expect({ variant: variant.name, ...observed }).toEqual({ variant: variant.name, gate: 'seed-value', claudeDefault: 'seed-value', claudeNamed: 'seed-value', codex: undefined })
      expect(observe({}, OTHER).observed.claudeDefault).toBe('ambient-other')
      const listing = composition.listing(withheldCredentialNamesAt({ homeDir: home }, registry), { state: 'none', text: null, skipped: [], ignored: [] })
      expect(listing.store).toMatchObject({ ok: false, reason: variant.reason })
      expect(JSON.stringify(listing)).not.toContain('stored')
      // Never salvaged: the prior bytes stand.
      expect(fs.readFileSync(path.join(home, '.kawai', 'credentials.json'))).toEqual(bytes)
    }
  })

  // @covers: provider-credentials › Credential resolution composes per variable › Store overrides the ambient environment
  test('a store entry overrides the ambient environment and the listing marks it overriding', () => {
    process.env[VAR] = 'ambient'
    writeStore({ [VAR]: { kind: 'secret-source', value: 'stored' } })
    const { observed, composition, registry } = observe({}, VAR)
    expect(observed.gate).toBe('stored')
    const listing = composition.listing(withheldCredentialNamesAt({ homeDir: home }, registry), { state: 'none', text: null, skipped: [], ignored: [] })
    expect(listing.rows).toEqual([{ name: VAR, kind: 'secret-source', state: 'set', source: 'store', overriding: true, collision: false }])
  })

  // @covers: provider-credentials › Credential resolution composes per variable › A launch-env entry is delivered unchanged
  test('an unregistered launch-env entry reaches both Claude launches byte-for-byte under its own mixed-case name', () => {
    const name = 'http_proxy_pcs'
    const value = 'http://proxy.example.internal:3128/?a=b;c= d'
    writeStore({ [name]: { kind: 'launch-env', value } })
    const { observed, composition, registry } = observe({}, name)
    expect(observed.claudeDefault).toBe(value)
    expect(observed.claudeNamed).toBe(value)
    const listing = composition.listing(withheldCredentialNamesAt({ homeDir: home }, registry), { state: 'none', text: null, skipped: [], ignored: [] })
    expect(listing.rows.find(row => row.name === name)).toMatchObject({ kind: 'launch-env', source: 'store', collision: false })
  })

  // @covers: provider-credentials › Credential resolution composes per variable › A secret source never rides the launch environment
  test('a secret source no binding uses never reaches a Claude or Codex launch under its own name', () => {
    process.env[VAR] = 'ambient'
    writeStore({ [VAR]: { kind: 'secret-source', value: 'secret-value' } })
    const { observed } = observe({ [VAR]: 'seed' }, VAR)
    expect(observed.claudeDefault).toBeUndefined()
    expect(observed.claudeNamed).toBeUndefined()
    expect(observed.codex).toBeUndefined()
    expect(observed.gate).toBe('secret-value')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Blank is a stored state for both kinds
  test('a blank of either kind exports empty over the lower sources at resolution', () => {
    process.env[VAR] = 'ambient'
    for (const kind of ['launch-env', 'secret-source'] as const) {
      writeStore({ [VAR]: { kind, value: '' } })
      const { observed } = observe({ [VAR]: 'seed' }, VAR)
      expect({ kind, gate: observed.gate }).toEqual({ kind, gate: '' })
      expect({ kind, launch: observed.claudeDefault }).toEqual({ kind, launch: kind === 'launch-env' ? '' : undefined })
    }
  })
})

/** mulberry32: a tiny seeded PRNG — no new dependency. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('PC1 — composition equals the table', () => {
  const CASES = 200
  const SEED = 0x5c0c1
  test('PC1: seeded (process, seed, store, registry) tuples project exactly table C at the gate and every launch (200 cases)', () => {
    const next = rng(SEED)
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
    const names = ['PCS_P_A', 'PCS_P_B', 'PCS_P_C', 'pcs_p_mixed']
    const failures: string[] = []
    for (let i = 0; i < propertyCases(CASES); i++) {
      const caseHome = path.join(root, `case-${i}`)
      fs.mkdirSync(path.join(caseHome, '.kawai'), { recursive: true, mode: 0o700 })
      const health = next() < 0.1 ? 'malformed' : 'ok'
      const seed: ChatProviderEnv = {}
      const entries: StoreSpec = {}
      const retained: string[] = []
      const processEnv: Record<string, string | undefined> = {}
      for (const name of names) {
        const proc = pick([undefined, `p-${i}-${name}`])
        processEnv[name] = proc
        const seedValue = pick([undefined, `s-${i}-${name}`, ''])
        if (seedValue !== undefined) seed[name] = seedValue
        const store = pick([null, 'launch-env', 'launch-blank', 'secret-source'] as const)
        if (store === 'launch-env') entries[name] = { kind: 'launch-env', value: `v-${i}-${name}` }
        if (store === 'launch-blank') entries[name] = { kind: 'launch-env', value: '' }
        if (store === 'secret-source' && /^[A-Z_][A-Z0-9_]*$/.test(name)) entries[name] = { kind: 'secret-source', value: `x-${i}-${name}` }
        if (next() < 0.3) retained.push(name)
      }
      const file = path.join(caseHome, '.kawai', 'credentials.json')
      fs.writeFileSync(file, health === 'ok' ? JSON.stringify({ version: 1, entries }) : '{', { mode: 0o600 })
      for (const name of names) {
        if (processEnv[name] === undefined) delete process.env[name]
        else process.env[name] = processEnv[name]
      }
      const store = createCredentialStore(file)
      const composition = new CredentialComposition({ store, seed })
      const rows = new Map<string, string>([[RETAINED_SECRET_NAMES_KEY, JSON.stringify(retained)]])
      const registry: RegistryContext = { getAppSetting: k => rows.get(k) ?? null, setAppSetting: (k, v) => { rows.set(k, v) }, secretSourceKeys: () => composition.secretSourceKeys() }
      const overrides = composition.overrides()
      const ctx = { homeDir: caseHome }
      const claude = resolveClaudeProfileDetail('default', overrides, ctx, undefined, registry).launch
      const codex = codexSpawnEnv(process.env, path.join(root, 'codex'), withheldCredentialNamesAt(ctx, registry))
      if (claude.runtime !== 'claude') throw new Error('expected a Claude launch')
      for (const name of names) {
        // The reference model: table C's columns, row by row.
        const entry = health === 'ok' ? entries[name] : undefined
        const registered = retained.includes(name) || entry?.kind === 'secret-source'
        const resolution = entry !== undefined ? entry.value : seed[name] !== undefined ? seed[name] : processEnv[name]
        const delivery = registered ? undefined : resolution
        const codexWant = registered ? undefined : processEnv[name]
        const gate = effectiveChatEnv(overrides)[name]
        if (gate !== resolution) failures.push(`case ${i} ${name} gate ${String(gate)} != ${String(resolution)}`)
        if (claude.env?.[name] !== delivery) failures.push(`case ${i} ${name} claude ${String(claude.env?.[name])} != ${String(delivery)}`)
        if (codex[name] !== codexWant) failures.push(`case ${i} ${name} codex ${String(codex[name])} != ${String(codexWant)}`)
      }
      if (failures.length > 0) break
    }
    for (const name of names) delete process.env[name]
    expect(failures).toEqual([])
  })
})

describe('S2 — one HOME rule', () => {
  test('A5: with HOME overridden, the store path and the catalogs\' user directory resolve under the same home', () => {
    const overridden = path.join(root, 'overridden-home')
    // The user level is listed once a user catalog file exists there.
    fs.mkdirSync(path.join(overridden, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(overridden, '.kawai', 'profiles.json'), '{}')
    process.env.HOME = overridden
    const storeDir = path.dirname(credentialStorePath())
    const userLevel = profileCatalogLevels({}).map(level => path.dirname(level.file)).find(dir => dir.startsWith(overridden))
    expect(storeDir).toBe(path.join(overridden, '.kawai'))
    expect(userLevel).toBe(storeDir)
    // Bun fixes os.homedir() at startup, so an os.homedir() path rule would
    // resolve under the original home here and split from the catalogs.
    expect(os.homedir()).not.toBe(overridden)
  })

  test('resolution and delivery are the composition owner\'s two projections', () => {
    const resolution = resolutionEnv({ A: 'store' }, { A: 'process', B: 'process' })
    expect(resolution).toEqual({ A: 'store', B: 'process' })
    expect(deliveryEnv(resolution, new Set(['A']))).toEqual({ B: 'process' })
  })
})
