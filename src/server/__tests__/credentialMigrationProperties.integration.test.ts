// PM1 and PM2 of provider-credential-store (task 3.2): the bound table M as
// a reference model under seeded start sequences. Each case seeds a legacy
// map (names from both admission patterns, unshaped sentinel values), store
// pre-contents (absent, same-valued with either kind, different-valued),
// and registered names; then runs starts, each with a fault drawn from the
// core's `deps` seam (unconfirmed directory fsync, refused rename) or the
// migration's transaction-abort seam (a crash before the commit), until a
// fault-free start quiesces. Mutant it kills: "stamp committed in its own
// transaction" (the map row then outlives its stamp after a crash). PM1
// also checks P1s on the migration path: no value in any settings row the
// migration writes or in any log line.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHAT_PROVIDER_ENV_KEY, MIGRATION_STAMP_KEY, migrateLegacyProviderEnv } from '../chat/credentialMigration'
import { createCredentialStore, type CredentialFsDeps, type CredentialKind, type CredentialStore } from '../chat/credentialStore'
import { RETAINED_SECRET_NAMES_KEY, retainSecretName } from '../chat/secretNameRegistry'
import type { SessionDatabase } from '../db'
import { logger } from '../logger'
import { propertyCases } from './helpers/propertyCases'
import { freshTestDatabase } from './helpers/testDatabase'

let root: string
let db: SessionDatabase
let logged: string[]
const spies: { mockRestore: () => void }[] = []

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-pm-')))
  db = freshTestDatabase(path.join(root, 'test.db'))
  logged = []
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation((event: string, data?: unknown) => {
      logged.push(JSON.stringify({ level, event, data }))
    }))
  }
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  db.close()
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

const pick = <T,>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]
/** Unshaped: no provider prefix or token shape a name heuristic could key on. */
const sentinel = (next: () => number) => `zqv${Math.floor(next() * 1e9).toString(36)}w${Math.floor(next() * 1e9).toString(36)}`

type Fault = 'none' | 'not-durable' | 'write-failed' | 'crash-before-commit'
const FAULTS: readonly Fault[] = ['none', 'not-durable', 'write-failed', 'crash-before-commit']

function faultDeps(fault: Fault): Partial<CredentialFsDeps> {
  if (fault === 'not-durable') {
    return { fsyncSync: (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('EIO'); fs.fsyncSync(fd) } }
  }
  if (fault === 'write-failed') return { renameSync: () => { throw new Error('EIO') } }
  return {}
}

interface Case {
  home: string
  map: Record<string, string>
  /** The store before the first start (and its kinds). */
  prior: Record<string, { value: string; kind: CredentialKind }>
  values: string[]
}

const storeFileOf = (home: string) => path.join(home, '.kawai', 'credentials.json')

function storeAt(home: string, fault: Fault = 'none'): CredentialStore {
  return createCredentialStore(storeFileOf(home), {
    retainSecretNames: { retainSecretName: name => retainSecretName(db, name) },
    deps: faultDeps(fault),
  })
}

async function generate(next: () => number, i: number): Promise<Case> {
  // Each case starts with no map, stamp, or registered names.
  db.db.run('DELETE FROM app_settings WHERE key IN (?, ?, ?)', [CHAT_PROVIDER_ENV_KEY, MIGRATION_STAMP_KEY, RETAINED_SECRET_NAMES_KEY])
  const home = path.join(root, `case-${i}`)
  fs.mkdirSync(home, { recursive: true })
  const map: Record<string, string> = {}
  const prior: Case['prior'] = {}
  const values: string[] = []
  const count = 1 + Math.floor(next() * 5)
  for (let n = 0; n < count; n++) {
    const name = pick(next, [`PM_UPPER_${n}`, `pm_lower_${n}`, `Pm_Mixed${n}`])
    map[name] = next() < 0.1 ? '' : sentinel(next)
    if (map[name]) values.push(map[name])
    const relation = pick(next, ['absent', 'absent', 'same', 'different'] as const)
    // A secret-source needs a catalog-shaped name; launch-env takes either.
    const kind = (): CredentialKind => (name === name.toUpperCase() ? pick(next, ['launch-env', 'secret-source'] as const) : 'launch-env')
    if (relation === 'same') prior[name] = { value: map[name], kind: kind() }
    if (relation === 'different') {
      prior[name] = { value: sentinel(next), kind: kind() }
      values.push(prior[name].value)
    }
    if (next() < 0.2) retainSecretName(db, name)
  }
  if (next() < 0.3) {
    prior.PM_UNRELATED = { value: sentinel(next), kind: 'launch-env' }
    values.push(prior.PM_UNRELATED.value)
  }
  const store = storeAt(home)
  for (const [name, entry] of Object.entries(prior)) await store.set(name, entry.value, entry.kind)
  db.setAppSetting(CHAT_PROVIDER_ENV_KEY, JSON.stringify(map))
  return { home, map, prior, values }
}

async function startOnce(c: Case, fault: Fault): Promise<void> {
  await migrateLegacyProviderEnv({
    db,
    store: storeAt(c.home, fault),
    ...(fault === 'crash-before-commit' ? { beforeCommit: () => { throw new Error('crash') } } : {}),
  })
}

const settingsRows = () => db.db.query('SELECT key, value FROM app_settings ORDER BY key').all() as { key: string; value: string }[]

/** The invariants that hold after every start, faulted or not. */
function checkPairing(c: Case, label: string, failures: string[]): void {
  const map = db.getAppSetting(CHAT_PROVIDER_ENV_KEY)
  const stamp = db.getAppSetting(MIGRATION_STAMP_KEY)
  if ((map === null) !== (stamp !== null)) failures.push(`${label}: map ${map === null ? 'absent' : 'present'} with stamp ${stamp === null ? 'absent' : 'present'}`)
  if (map !== null && map !== JSON.stringify(c.map)) failures.push(`${label}: the retained map changed`)
  const rows = JSON.stringify(settingsRows().filter(row => row.key !== CHAT_PROVIDER_ENV_KEY))
  for (const value of c.values) if (rows.includes(value)) failures.push(`${label}: a value reached a migration-written settings row`)
  const lines = logged.join('\n')
  for (const value of c.values) if (lines.includes(value)) failures.push(`${label}: a value reached a log line`)
}

/** PM1 at quiescence: every map entry is in the store with its map value
 * (an equal prior keeps its kind), or skipped where the store held a
 * different value — which stands. */
function checkQuiescent(c: Case, label: string, failures: string[]): void {
  const store = storeAt(c.home)
  const stamp = JSON.parse(db.getAppSetting(MIGRATION_STAMP_KEY) ?? '{"skipped":null}') as { skipped: string[] | null }
  const expectedSkips = Object.keys(c.map).filter(name => c.prior[name] && c.prior[name].value !== c.map[name]).sort()
  if (JSON.stringify(stamp.skipped) !== JSON.stringify(expectedSkips)) failures.push(`${label}: skipped ${JSON.stringify(stamp.skipped)} != ${JSON.stringify(expectedSkips)}`)
  const kinds = new Map(store.list().entries.map(entry => [entry.name, entry.kind]))
  for (const [name, value] of Object.entries(c.map)) {
    const expected = c.prior[name] ?? { value, kind: 'launch-env' as const }
    if (store.resolve(name) !== expected.value || kinds.get(name) !== expected.kind) failures.push(`${label}: ${name} lost or changed`)
  }
  if (c.prior.PM_UNRELATED && store.resolve('PM_UNRELATED') !== c.prior.PM_UNRELATED.value) failures.push(`${label}: unrelated entry changed`)
}

describe('PM1/PM2 — the migration under seeded faults and restarts', () => {
  // @covers: provider-credentials › Legacy Settings credentials migrate to the store at upgrade › A crash before the database commit recovers
  // @covers: provider-credentials › Imported credentials live in the server-owned store › Import writes only the store
  test('PM1: no value is lost or duplicated into SQLite; the map row is absent iff the stamp is present (300 cases)', async () => {
    const CASES = 300
    const next = rng(0x9a11e)
    const failures: string[] = []
    for (let i = 0; i < propertyCases(CASES); i++) {
      const c = await generate(next, i)
      const faults = Array.from({ length: Math.floor(next() * 4) }, () => pick(next, FAULTS))
      for (const [step, fault] of faults.entries()) {
        await startOnce(c, fault)
        checkPairing(c, `case ${i} step ${step} (${fault})`, failures)
      }
      await startOnce(c, 'none')
      checkPairing(c, `case ${i} quiescent`, failures)
      if (db.getAppSetting(MIGRATION_STAMP_KEY) === null) failures.push(`case ${i}: no stamp after a fault-free start`)
      checkQuiescent(c, `case ${i}`, failures)
      if (failures.length > 0) break
    }
    expect(failures).toEqual([])
  }, 300_000)

  test('PM2: restarts after quiescence change no store byte and no app_settings row (100 cases)', async () => {
    const CASES = 100
    const next = rng(0x9a112)
    const failures: string[] = []
    for (let i = 0; i < propertyCases(CASES); i++) {
      const c = await generate(next, i)
      for (let n = Math.floor(next() * 3); n > 0; n--) await startOnce(c, pick(next, FAULTS))
      await startOnce(c, 'none')
      const before = { bytes: fs.readFileSync(storeFileOf(c.home), 'utf8'), mtime: fs.statSync(storeFileOf(c.home)).mtimeMs, rows: settingsRows() }
      for (let restart = 1 + Math.floor(next() * 3); restart > 0; restart--) {
        await startOnce(c, 'none')
        const after = { bytes: fs.readFileSync(storeFileOf(c.home), 'utf8'), mtime: fs.statSync(storeFileOf(c.home)).mtimeMs, rows: settingsRows() }
        if (JSON.stringify(after) !== JSON.stringify(before)) failures.push(`case ${i}: a restart after quiescence wrote`)
      }
      if (failures.length > 0) break
    }
    expect(failures).toEqual([])
  }, 300_000)
})
