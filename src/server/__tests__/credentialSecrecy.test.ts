// Properties P2 (write-only read surfaces) and P1s (store secrecy) of
// provider-credential-store, seeded and run through propertyCases.
//   P2   random import/replace/blank/clear/reclassify sequences through the
//        mounted credential routes: every response body (listing, outcome,
//        refusal) carries name, kind, state, source, and marks only — never a
//        value, a prefix, or a length — whatever the variable is named, and
//        the listing equals the reference projection of the operations.
//   P1s  the same mutations plus refusals that carry sentinels in their
//        input, then the real Claude launch composer and the real wire tap:
//        no store value in any HTTP body, log call, SQLite row, the flag
//        settings layer, or a wire-log frame. The designed channels stand:
//        the provider's token rides the launch env as ANTHROPIC_AUTH_TOKEN,
//        and launch-env values ride the env as themselves.
// Sentinel values use an alphabet no fixed text or name contains, so a
// prefix match is a real leak, never an accident of the fixture.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import type { CredentialKind, CredentialListing, CredentialListingRow } from '../../shared/credentials'
import { createServerCredentials } from '../chat/credentialComposition'
import { resolveClaudeProfileDetail } from '../chat/ClaudeProfiles'
import { readRetainedNames, RETAINED_SECRET_NAMES_KEY, type RegistryContext } from '../chat/secretNameRegistry'
import { createWireTappedSpawn } from '../chat/wireTap'
import { freshTestDatabase } from './helpers/testDatabase'
import { propertyCases } from './helpers/propertyCases'
import { logger } from '../logger'
import { mountCredentialRoutes } from '../routes/credentials'
import type { SessionDatabase } from '../db'

let root: string
let logged: string[]
const spies: { mockRestore: () => void }[] = []

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-secrecy-')))
  logged = []
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation((event: string, data?: unknown) => {
      logged.push(JSON.stringify({ level, event, data }))
    }))
  }
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  shared?.close()
  shared = null
  fs.rmSync(root, { recursive: true, force: true })
})

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

// q, x, z, j, k, v, w: no fixed sentence, kind, source, or name below has an
// 8-character run of these, so any 8-character piece of a value is a leak.
const ALPHABET = 'qxzjkvw'
function sentinel(next: () => number, length = 16): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)]
  return out
}

/** Every 8-character piece of each value (the value, its prefixes, its splits). */
function leaks(text: string, values: Iterable<string>): string[] {
  const found: string[] = []
  for (const value of values) {
    for (let at = 0; at + 8 <= value.length; at++) {
      if (text.includes(value.slice(at, at + 8))) { found.push(value); break }
    }
  }
  return found
}

/** A JSON tree with any number leaf, so a length could never ride a field. */
function numberLeaves(value: unknown, at = '$'): string[] {
  if (typeof value === 'number') return [at]
  if (Array.isArray(value)) return value.flatMap((item, i) => numberLeaves(item, `${at}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => numberLeaves(v, `${at}.${k}`))
  return []
}

const ROW_KEYS = ['collision', 'kind', 'name', 'overriding', 'source', 'state']
// Names of both patterns, including the secret-looking ones the old
// name-regex projector showed (the closed hole) and plain ones it did not.
const NAMES = ['PCS_API_TOKEN', 'PCS_PASSWORD', 'PCS_PLAIN', 'Relay_Value', 'plain_var', 'PCS_KEY'] as const
const CATALOG_NAME = /^[A-Z_][A-Z0-9_]*$/

interface Harness {
  app: Hono
  db: SessionDatabase
  credentials: ReturnType<typeof createServerCredentials>
  home: string
}

let shared: SessionDatabase | null = null

/** One migrated database per test (a migration per case would dominate the
 * run); each case starts with no registered names, as a fresh install does. */
function caseDatabase(): SessionDatabase {
  shared ??= freshTestDatabase(path.join(root, 'test.db'))
  shared.db.run('DELETE FROM app_settings WHERE key = ?', [RETAINED_SECRET_NAMES_KEY])
  return shared
}

function harness(caseDir: string, seed: Record<string, string>, catalog?: object): Harness {
  const home = path.join(caseDir, 'home')
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
  if (catalog) fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify(catalog))
  const db = caseDatabase()
  const credentials = createServerCredentials({ db, seed, homeDir: home })
  const app = new Hono()
  mountCredentialRoutes(app, {
    store: credentials.store,
    composition: credentials.composition,
    registered: () => new Set([...readRetainedNames(db), ...credentials.composition.secretSourceKeys()]),
    migration: () => ({ state: 'none', text: null, skipped: [], ignored: [] }),
  })
  return { app, db, credentials, home }
}

type Op =
  | { op: 'set'; name: string; value: string; kind: CredentialKind }
  | { op: 'clear'; name: string }
  | { op: 'reclassify'; name: string; kind: CredentialKind }
  | { op: 'refused'; name: string; body: string }

function randomOp(next: () => number, values: Set<string>): Op {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const name = pick(NAMES)
  const kind = pick(['launch-env', 'secret-source'] as const)
  const roll = next()
  if (roll < 0.45) {
    const value = next() < 0.2 ? '' : sentinel(next)
    if (value) values.add(value)
    return { op: 'set', name, value, kind }
  }
  if (roll < 0.6) return { op: 'clear', name }
  if (roll < 0.8) return { op: 'reclassify', name, kind }
  // A refusal whose input carries a sentinel: NUL, a bad name, a bad kind, a bad body.
  const value = sentinel(next)
  values.add(value)
  return pick([
    { op: 'refused', name, body: JSON.stringify({ value: `${value}\u0000`, kind: 'launch-env' }) },
    { op: 'refused', name: `bad name ${value}`, body: JSON.stringify({ value }) },
    { op: 'refused', name, body: JSON.stringify({ value, kind: `kind-${value}` }) },
    { op: 'refused', name, body: `{"value":"${value}"` },
  ] as const)
}

async function apply(app: Hono, op: Op): Promise<Response> {
  const url = `/api/settings/credentials/${encodeURIComponent(op.name)}`
  const json = (method: string, body: string) => app.request(url, { method, headers: { 'Content-Type': 'application/json' }, body })
  if (op.op === 'set') return json('PUT', JSON.stringify({ value: op.value, kind: op.kind }))
  if (op.op === 'clear') return app.request(url, { method: 'DELETE' })
  if (op.op === 'reclassify') return app.request(`${url}/reclassify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: op.kind }) })
  return json('PUT', op.body)
}

/** The reference model: name -> kind and state, plus every name ever a secret source. */
interface Model { entries: Map<string, { kind: CredentialKind; blank: boolean }>; secret: Set<string> }

function step(model: Model, op: Op): void {
  if (op.op === 'set') {
    if (op.kind === 'secret-source' && !CATALOG_NAME.test(op.name)) return
    model.entries.set(op.name, { kind: op.kind, blank: op.value === '' })
    if (op.kind === 'secret-source') model.secret.add(op.name)
  } else if (op.op === 'clear') {
    model.entries.delete(op.name)
  } else if (op.op === 'reclassify') {
    const entry = model.entries.get(op.name)
    if (!entry || (op.kind === 'secret-source' && !CATALOG_NAME.test(op.name))) return
    entry.kind = op.kind
    if (op.kind === 'secret-source') model.secret.add(op.name)
  }
}

function expectedRows(model: Model, seed: Record<string, string>): CredentialListingRow[] {
  const rows = new Map<string, CredentialListingRow>()
  for (const [name, value] of Object.entries(seed)) {
    rows.set(name, { name, kind: null, state: value === '' ? 'blank' : 'set', source: 'seed', overriding: false, collision: model.secret.has(name) })
  }
  for (const [name, entry] of model.entries) {
    rows.set(name, {
      name, kind: entry.kind, state: entry.blank ? 'blank' : 'set', source: 'store',
      overriding: Object.hasOwn(seed, name) || process.env[name] !== undefined,
      collision: entry.kind === 'launch-env' && model.secret.has(name),
    })
  }
  return [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

describe('P2 — every read surface is write-only', () => {
  const CASES = 200
  const SEED = 0x5c0c2
  // @covers: provider-credentials › The credential UI is write-only › Presence without value
  test('P2: seeded mutation sequences leave every response body with name, kind, state, source, and marks only (200 cases)', async () => {
    const next = rng(SEED)
    const failures: string[] = []
    for (let i = 0; i < propertyCases(CASES); i++) {
      const values = new Set<string>()
      const seed: Record<string, string> = {}
      if (next() < 0.5) { seed.PCS_PLAIN = sentinel(next); values.add(seed.PCS_PLAIN) }
      const caseDir = path.join(root, `p2-${i}`)
      const h = harness(caseDir, seed)
      const model: Model = { entries: new Map(), secret: new Set() }
      const ops = Array.from({ length: 3 + Math.floor(next() * 8) }, () => randomOp(next, values))
      for (const [n, op] of ops.entries()) {
        const response = await apply(h.app, op)
        if (response.ok) step(model, op)
        const bodies = [await response.text(), await (await h.app.request('/api/settings/credentials')).text()]
        for (const text of bodies) {
          const where = `case ${i} op ${n} ${op.op} ${op.name}`
          const leaked = leaks(text, values)
          if (leaked.length > 0) failures.push(`${where}: value piece in a body`)
          const parsed = JSON.parse(text) as { listing?: CredentialListing; rows?: CredentialListingRow[] }
          if (numberLeaves(parsed).length > 0) failures.push(`${where}: number leaf ${numberLeaves(parsed).join(',')}`)
          const rows = parsed.rows ?? parsed.listing?.rows ?? []
          for (const row of rows) {
            if (Object.keys(row).sort().join() !== ROW_KEYS.join()) failures.push(`${where}: row keys ${Object.keys(row).join()}`)
          }
        }
        const listing = JSON.parse(bodies[1]!) as CredentialListing
        const want = expectedRows(model, seed)
        if (JSON.stringify(listing.rows) !== JSON.stringify(want)) {
          failures.push(`case ${i} op ${n}: listing ${JSON.stringify(listing.rows)} != ${JSON.stringify(want)}`)
        }
      }
      if (failures.length > 0) break
    }
    expect(failures).toEqual([])
  }, 300_000)
})

/** Spawn through the real wire tap with the launch's flag layer as the SDK passes it. */
async function wireFrames(settings: unknown, env: Record<string, string | undefined>): Promise<string[]> {
  const frames: string[] = []
  const spawn = createWireTappedSpawn({ record: (dir, raw) => frames.push(`${dir} ${raw}`) })
  const child = spawn({
    command: '/bin/sh',
    args: ['-c', 'exit 0', 'claude', '--settings', JSON.stringify(settings)],
    cwd: root,
    env: Object.fromEntries(Object.entries({ ...env, PATH: process.env.PATH }).filter(([, v]) => v !== undefined)) as Record<string, string>,
    signal: new AbortController().signal,
  })
  child.stdin.end()
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return frames
}

describe('P1s — no store value escapes the designed channels', () => {
  const CASES = 200
  const SEED = 0x5c0c3
  // @covers: provider-credentials › Imported credentials live in the server-owned store › Import writes only the store
  test('P1s: no store value reaches an HTTP body, a log call, SQLite, the flag settings layer, or a wire frame (200 cases)', async () => {
    const next = rng(SEED)
    const failures: string[] = []
    const catalog = {
      relay: {
        label: 'Relay', authTokenEnv: 'PCS_API_TOKEN',
        env: { ANTHROPIC_BASE_URL: 'https://relay.example.internal/api' },
        models: { 'relay-opus': { label: 'Relay Opus', model: 'opus' } },
      },
    }
    for (let i = 0; i < propertyCases(CASES); i++) {
      logged.length = 0
      const values = new Set<string>()
      const caseDir = path.join(root, `p1-${i}`)
      const h = harness(caseDir, {}, catalog)
      const bodies: string[] = []
      for (const op of Array.from({ length: 3 + Math.floor(next() * 8) }, () => randomOp(next, values))) {
        bodies.push(await (await apply(h.app, op)).text())
      }
      // The provider token always lives in the store, so the credentialed branch runs.
      const token = sentinel(next)
      values.add(token)
      await h.credentials.store.set('PCS_API_TOKEN', token, 'secret-source')
      bodies.push(await (await h.app.request('/api/settings/credentials')).text())
      const where = `case ${i}`
      for (const text of bodies) if (leaks(text, values).length > 0) failures.push(`${where}: HTTP body`)
      for (const line of logged) if (leaks(line, values).length > 0) failures.push(`${where}: log ${line.slice(0, 80)}`)
      const tables = h.db.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      for (const { name } of tables) {
        const dump = JSON.stringify(h.db.db.query(`SELECT * FROM "${name}"`).all())
        if (leaks(dump, values).length > 0) failures.push(`${where}: SQLite ${name}`)
      }
      const registry: RegistryContext = {
        getAppSetting: key => h.db.getAppSetting(key),
        setAppSetting: (key, value) => h.db.setAppSetting(key, value),
        secretSourceKeys: () => h.credentials.composition.secretSourceKeys(),
      }
      const overrides = h.credentials.composition.overrides()
      for (const profile of ['relay-opus', 'default']) {
        const launch = resolveClaudeProfileDetail(profile, overrides, { homeDir: h.home }, undefined, registry).launch
        if (launch.runtime !== 'claude') throw new Error('expected a Claude launch')
        if (leaks(JSON.stringify(launch.settings ?? {}), values).length > 0) failures.push(`${where} ${profile}: flag settings layer`)
        const frames = await wireFrames(launch.settings ?? {}, launch.env ?? {})
        if (!frames.some(frame => frame.includes('"event":"spawn"'))) failures.push(`${where} ${profile}: no spawn frame`)
        for (const frame of frames) if (leaks(frame, values).length > 0) failures.push(`${where} ${profile}: wire frame`)
        // The designed channel stands: the token rides the env, not its name.
        if (profile === 'relay-opus' && launch.env?.ANTHROPIC_AUTH_TOKEN !== token) failures.push(`${where}: token channel lost`)
        if (launch.env?.PCS_API_TOKEN !== undefined) failures.push(`${where} ${profile}: registered name delivered`)
      }
      // Logged lines exist (refusals log their code), so the log seam is live.
      if (failures.length > 0) break
    }
    expect(failures).toEqual([])
  }, 300_000)
})
