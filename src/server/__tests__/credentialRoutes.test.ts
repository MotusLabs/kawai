// Table U of provider-credential-store (the write-only read surface) and PW1,
// through a Hono app mounted exactly as bootstrap mounts the credential
// routes (mountCredentialRoutes), over the production store factory, a real
// database, and a disposable HOME. Each row asserts its observable response.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import type { CredentialListing, CredentialMutationOutcome, CredentialRefusal } from '../../shared/credentials'
import { createServerCredentials, type ServerCredentials } from '../chat/credentialComposition'
import { readRetainedNames } from '../chat/secretNameRegistry'
import { mountCredentialRoutes, OUTCOME_TEXT } from '../routes/credentials'
import { initDatabase, type SessionDatabase } from '../db'

let root: string
let home: string
let db: SessionDatabase
let credentials: ServerCredentials
let app: Hono

const storeFile = () => path.join(home, '.kawai', 'credentials.json')
const SENTINEL = 'zq7-unshaped-sentinel'

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-routes-')))
  home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  db = initDatabase({ path: path.join(root, 'test.db') })
  credentials = createServerCredentials({ db, seed: { SEED_ONLY: 'seed-value' }, homeDir: home })
  app = new Hono()
  mountCredentialRoutes(app, {
    store: credentials.store,
    composition: credentials.composition,
    registered: () => readRetainedNames(db),
    migration: () => ({ state: 'none', text: null, skipped: [], ignored: [] }),
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const put = (name: string, body: unknown) => app.request(`/api/settings/credentials/${encodeURIComponent(name)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
})
const del = (name: string) => app.request(`/api/settings/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' })
const reclassify = (name: string, kind: string) => app.request(`/api/settings/credentials/${encodeURIComponent(name)}/reclassify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }),
})
const list = async (): Promise<CredentialListing> => (await app.request('/api/settings/credentials')).json() as Promise<CredentialListing>

describe('table U — the write-only credential surface', () => {
  // @covers: provider-credentials › The credential UI is write-only › Presence without value
  test('U1: the listing carries kind, state, source, and marks for every variable — never a value, prefix, or length', async () => {
    // | U1 | GET listing, any store contents | per name: kind, state (set/blank), source, overriding/collision marks; no value, prefix, or length |
    await put('RELAY_KEY', { value: `${SENTINEL}-a`, kind: 'secret-source' })
    await put('relay_value', { value: `${SENTINEL}-b` })
    await put('BLANKED', { value: '' })
    await put('SEED_ONLY', { value: `${SENTINEL}-c` })
    const response = await app.request('/api/settings/credentials')
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toContain('zq7')
    const listing = JSON.parse(text) as CredentialListing
    expect(listing.rows).toEqual([
      { name: 'BLANKED', kind: 'launch-env', state: 'blank', source: 'store', overriding: false, collision: false },
      { name: 'RELAY_KEY', kind: 'secret-source', state: 'set', source: 'store', overriding: false, collision: false },
      { name: 'SEED_ONLY', kind: 'launch-env', state: 'set', source: 'store', overriding: true, collision: false },
      { name: 'relay_value', kind: 'launch-env', state: 'set', source: 'store', overriding: false, collision: false },
    ])
    for (const row of listing.rows) expect(Object.keys(row).sort()).toEqual(['collision', 'kind', 'name', 'overriding', 'source', 'state'])
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Import writes only the store
  test('U2 and PW1: a PUT through the mounted app writes a 0600 store file and returns the typed outcome without the value', async () => {
    // | U2 | PUT set with value | typed outcome; the value never appears in the response or any log |
    const response = await put('PCS_TOKEN', { value: SENTINEL, kind: 'secret-source' })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).not.toContain(SENTINEL)
    const outcome = JSON.parse(text) as CredentialMutationOutcome
    expect(outcome).toMatchObject({ applied: true, durable: true, message: OUTCOME_TEXT.durable })
    expect(fs.statSync(storeFile()).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(storeFile(), 'utf8')).toContain(SENTINEL)
    // The name only reached SQLite (the retain collaborator), never the value.
    const dump = db.db.query('SELECT key, value FROM app_settings').all()
    expect(JSON.stringify(dump)).not.toContain(SENTINEL)
    expect([...readRetainedNames(db)]).toContain('PCS_TOKEN')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › NUL never enters or persists in the store
  // @covers: provider-credentials › Imported credentials live in the server-owned store › Secret sources require catalog-compatible names
  // @covers: provider-credentials › The credential UI is write-only › Errors carry fixed safe text only
  test('U3: a NUL value, an invalid name, or a lower-case secret source refuses with fixed text, prior bytes standing, no registry call', async () => {
    // | U3 | PUT with NUL in value, invalid name, or secret-source name outside the catalog pattern | fixed reason, prior bytes stand, no registry call for an invalid name |
    await put('KEPT', { value: 'kept' })
    const before = fs.readFileSync(storeFile())
    const registryBefore = db.getAppSetting('registered_secret_names')
    const cases: [string, unknown, string][] = [
      ['NUL_VALUE', { value: `a\u0000${SENTINEL}` }, 'value-nul'],
      ['9bad-name', { value: SENTINEL }, 'invalid-name'],
      [`bad name ${SENTINEL}`, { value: 'x', kind: 'secret-source' }, 'invalid-name'],
      ['lower_secret', { value: SENTINEL, kind: 'secret-source' }, 'name-not-catalog'],
      ['ANY', { value: SENTINEL, kind: 'bogus' }, 'invalid-kind'],
      ['ANY', '{not json', 'invalid-body'],
    ]
    for (const [name, body, code] of cases) {
      const response = await put(name, body)
      const text = await response.text()
      expect({ name, status: response.status }).toEqual({ name, status: 400 })
      const refusal = JSON.parse(text) as CredentialRefusal
      expect({ name, code: refusal.code }).toEqual({ name, code })
      expect(text).not.toContain(SENTINEL)
      expect(text).not.toContain('bad name')
      expect(fs.readFileSync(storeFile())).toEqual(before)
    }
    expect(db.getAppSetting('registered_secret_names')).toBe(registryBefore)
  })

  test('U4: clearing an absent name reports neither applied nor durable and creates nothing', async () => {
    // | U4 | DELETE absent name | `{applied:false, durable:false}`, nothing created |
    const response = await del('NEVER_SET')
    expect(await response.json()).toMatchObject({ applied: false, durable: false, message: OUTCOME_TEXT.unchanged })
    expect(fs.existsSync(path.join(home, '.kawai'))).toBe(false)
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Unsafe permissions refuse every access
  test('U5: every mutation on a malformed or unsafe store refuses with fixed text and the prior bytes stand', async () => {
    // | U5 | any mutation on a malformed/unsafe store | fixed reason; prior bytes stand |
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
    for (const [variant, write, code] of [
      ['malformed', () => fs.writeFileSync(storeFile(), `{"version":1,"entries":{"X":{"kind":"launch-env","value":"${SENTINEL}"}`, { mode: 0o600 }), 'malformed'],
      ['0644', () => { fs.writeFileSync(storeFile(), JSON.stringify({ version: 1, entries: { X: { kind: 'launch-env', value: SENTINEL } } }), { mode: 0o644 }); fs.chmodSync(storeFile(), 0o644) }, 'unsafe-permissions'],
    ] as const) {
      fs.rmSync(storeFile(), { force: true })
      write()
      const before = fs.readFileSync(storeFile())
      for (const response of [await put('X', { value: 'new' }), await del('X'), await reclassify('X', 'secret-source')]) {
        const text = await response.text()
        expect({ variant, status: response.status }).toEqual({ variant, status: 409 })
        expect({ variant, code: (JSON.parse(text) as CredentialRefusal).code }).toEqual({ variant, code })
        expect(text).not.toContain(SENTINEL)
      }
      expect(fs.readFileSync(storeFile())).toEqual(before)
      const listing = await list()
      expect(listing.store).toMatchObject({ ok: false, reason: code })
    }
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('U6: an applied-but-not-durable write reports it with the fixed warning and is not retried', async () => {
    // | U6 | applied but not durable | outcome reports applied-not-durable; UI shows the warning; no retry |
    const { createCredentialStore } = await import('../chat/credentialStore')
    let fsyncs = 0
    const faulty = createCredentialStore(storeFile(), {
      retainSecretNames: { retainSecretName: () => {} },
      deps: {
        fsyncSync: (fd: number) => {
          fsyncs += 1
          // The file's own fsync succeeds; the store directory's fails.
          if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('EIO'), { code: 'EIO' })
          fs.fsyncSync(fd)
        },
      },
    })
    const faultyApp = new Hono()
    mountCredentialRoutes(faultyApp, {
      store: faulty, composition: credentials.composition, registered: () => new Set(),
      migration: () => ({ state: 'none', text: null, skipped: [], ignored: [] }),
    })
    const response = await faultyApp.request('/api/settings/credentials/PCS_X', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: SENTINEL }),
    })
    const outcome = await response.json() as CredentialMutationOutcome
    expect(outcome).toMatchObject({ applied: true, durable: false, message: OUTCOME_TEXT.notDurable })
    expect(fsyncs).toBe(2)
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL)
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Secret-source changes retain the name first
  test('a secret-source PUT whose real SQLite retain step fails refuses with fixed text and leaves the store file untouched', async () => {
    await put('KEPT', { value: 'kept' })
    const before = fs.readFileSync(storeFile())
    const setAppSetting = db.setAppSetting.bind(db)
    db.setAppSetting = (key: string, value: string) => {
      if (key === 'registered_secret_names') throw new Error(`disk full ${SENTINEL}`)
      setAppSetting(key, value)
    }
    try {
      for (const run of [() => put('PCS_RETAIN', { value: SENTINEL, kind: 'secret-source' }), () => reclassify('KEPT', 'secret-source')]) {
        const response = await run()
        const text = await response.text()
        expect(response.status).toBe(500)
        expect((JSON.parse(text) as CredentialRefusal).code).toBe('retain-collaborator-failed')
        expect(text).not.toContain(SENTINEL)
        expect(fs.readFileSync(storeFile())).toEqual(before)
      }
    } finally {
      db.setAppSetting = setAppSetting
    }
    expect(credentials.store.resolve('PCS_RETAIN')).toBeUndefined()
    expect((await list()).rows.find(row => row.name === 'KEPT')).toMatchObject({ kind: 'launch-env' })
  })

  test('U7: the retired /api/settings/chat-provider-env answers 404', async () => {
    // | U7 | old `/api/settings/chat-provider-env` | 404 (retired) |
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await app.request('/api/settings/chat-provider-env', { method })
      expect({ method, status: response.status }).toEqual({ method, status: 404 })
    }
  })

  test('reclassify through the route changes the kind, keeps the value, and marks the inert collision', async () => {
    await put('PCS_RECLASS', { value: SENTINEL, kind: 'secret-source' })
    const response = await reclassify('PCS_RECLASS', 'launch-env')
    expect(await response.json()).toMatchObject({ applied: true, durable: true })
    const row = (await list()).rows.find(r => r.name === 'PCS_RECLASS')
    expect(row).toMatchObject({ kind: 'launch-env', collision: true })
    expect(credentials.store.resolve('PCS_RECLASS')).toBe(SENTINEL)
  })
})
