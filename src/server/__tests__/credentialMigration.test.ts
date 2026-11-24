// The bound table M of provider-credential-store (task 3.1/3.3, decision-
// 0c2937c6): every row as its own test, through the real store core on a
// disposable HOME, the real SQLite settings table, the production
// composition's listing and overrides, and the migration's single entry
// point. Each "start" is a fresh store instance and one migration run, as a
// server restart would be. Faults use the core's `deps` seam (directory
// fsync for applied-not-durable, rename for write-failed) and the
// migration's transaction seam (a throw before the commit). Mutants it
// kills: "delete the map before the durable acknowledgement" (M8, M12),
// "stamp ignored" (M2, M13), "map as a source" (M8-M10), "stamp the empty
// map" (M3).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CredentialMigrationState } from '../../shared/credentials'
import { CredentialComposition, deliveryEnv, resolutionEnv } from '../chat/credentialComposition'
import { CHAT_PROVIDER_ENV_KEY, MIGRATION_STAMP_KEY, MIGRATION_TEXT, migrateLegacyProviderEnv, migrationStatus } from '../chat/credentialMigration'
import { createCredentialStore, type CredentialFsDeps, type CredentialStore } from '../chat/credentialStore'
import { readRetainedNames, retainSecretName } from '../chat/secretNameRegistry'
import { initDatabase, type SessionDatabase } from '../db'
import { freshTestDatabase } from './helpers/testDatabase'

let root: string
let home: string
let db: SessionDatabase

const storeFile = () => path.join(home, '.kawai', 'credentials.json')
const SEED = { SEED_ONLY: 'zq-seed-value' }

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-mig-')))
  home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  db = freshTestDatabase(path.join(root, 'test.db'))
})

afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

/** Faults for one start's store, through the core's fs seam. */
type Fault = 'none' | 'not-durable' | 'write-failed'

function faultDeps(fault: Fault): Partial<CredentialFsDeps> {
  if (fault === 'not-durable') {
    return { fsyncSync: (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('EIO'); fs.fsyncSync(fd) } }
  }
  if (fault === 'write-failed') return { renameSync: () => { throw new Error('EIO') } }
  return {}
}

function newStore(fault: Fault = 'none'): CredentialStore {
  return createCredentialStore(storeFile(), {
    retainSecretNames: { retainSecretName: name => retainSecretName(db, name) },
    deps: faultDeps(fault),
  })
}

/** One server start: a fresh store and one migration run. */
async function start(fault: Fault = 'none', beforeCommit?: () => void) {
  const store = newStore(fault)
  const state = await migrateLegacyProviderEnv({ db, store, ...(beforeCommit ? { beforeCommit } : {}) })
  const composition = new CredentialComposition({ store, seed: SEED, processEnv: () => ({}) })
  const registered = readRetainedNames(db)
  return {
    state,
    store,
    listing: composition.listing(registered, state),
    delivery: deliveryEnv(resolutionEnv(composition.overrides(), {}), registered),
  }
}

const seedMap = (env: Record<string, string>) => db.setAppSetting(CHAT_PROVIDER_ENV_KEY, JSON.stringify(env))
const settings = () => db.db.query('SELECT key, value FROM app_settings ORDER BY key').all() as { key: string; value: string }[]
const storeBytes = () => (fs.existsSync(storeFile()) ? fs.readFileSync(storeFile(), 'utf8') : null)
const stamp = () => db.getAppSetting(MIGRATION_STAMP_KEY)
const mapRow = () => db.getAppSetting(CHAT_PROVIDER_ENV_KEY)
const storeEntries = (store: CredentialStore) =>
  Object.fromEntries(store.list().entries.map(entry => [entry.name, { kind: entry.kind, value: store.resolve(entry.name) }]))

const complete = (skipped: string[] = [], ignored: string[] = []): CredentialMigrationState =>
  ({ state: 'complete', text: ignored.length > 0 ? MIGRATION_TEXT.ignored : null, skipped, ignored })
const pendingState = (text: string, skipped: string[] = []): CredentialMigrationState => ({ state: 'pending', text, skipped, ignored: [] })

/** Seed the store as a previous run or the operator left it. */
async function seedStore(entries: Record<string, { value: string; kind: 'launch-env' | 'secret-source' }>) {
  const store = newStore()
  for (const [name, entry] of Object.entries(entries)) expect((await store.set(name, entry.value, entry.kind)).durable).toBe(true)
}

describe('table M — the startup migration of the legacy Settings map', () => {
  test('M1: a stamp with no map stands — no write, complete with the stamp\'s skip names', async () => {
    // | M1 | present | absent | * | — | — | none | normal | Prior state stands | Map absent, existing stamp stands | Normal, complete, with stamp's skip names | Normal |
    await seedStore({ KEEP: { value: 'zq-keep', kind: 'launch-env' } })
    db.setAppSetting(MIGRATION_STAMP_KEY, JSON.stringify({ version: 1, skipped: ['OLD_SKIP'] }))
    const before = { rows: settings(), bytes: storeBytes() }
    const run = await start()
    expect({ rows: settings(), bytes: storeBytes() }).toEqual(before)
    expect(run.listing.migration).toEqual(complete(['OLD_SKIP']))
    expect(run.delivery.KEEP).toBe('zq-keep')
  })

  test('M2: a residual map beside a stamp is ignored and listed by name — no migration write, never delivered', async () => {
    // | M2 | present | non-empty | * | * | — | none | normal | Prior state stands | Residual map and existing stamp stand, no migration writes | Normal, complete, fixed diagnostic with ignored valid names | Normal |
    db.setAppSetting(MIGRATION_STAMP_KEY, JSON.stringify({ version: 1, skipped: [] }))
    seedMap({ RESIDUAL_B: 'zq-res-b', RESIDUAL_A: 'zq-res-a' })
    const before = { rows: settings(), bytes: storeBytes() }
    const run = await start()
    expect({ rows: settings(), bytes: storeBytes() }).toEqual(before)
    expect(run.listing.migration).toEqual(complete([], ['RESIDUAL_A', 'RESIDUAL_B']))
    expect(run.delivery.RESIDUAL_A).toBeUndefined()
    expect(JSON.stringify(run.listing)).not.toContain('zq-res')
  })

  for (const variant of [{ label: 'absent', row: null }, { label: 'empty', row: '{}' }] as const) {
    test(`M3: an ${variant.label} map with no stamp is left as found — no stamp, no store file, nothing to migrate`, async () => {
      // | M3 | absent | absent or empty | * | — | — | none | normal | Prior state stands, missing remains missing | Absent or empty map left as found, no stamp or migration writes | Normal, nothing to migrate | Normal |
      if (variant.row !== null) db.setAppSetting(CHAT_PROVIDER_ENV_KEY, variant.row)
      const before = settings()
      const run = await start()
      expect(settings()).toEqual(before)
      expect(mapRow()).toBe(variant.row)
      expect(stamp()).toBeNull()
      expect(fs.existsSync(storeFile())).toBe(false)
      expect(run.listing.migration).toEqual({ state: 'none', text: null, skipped: [], ignored: [] })
      expect(run.delivery.SEED_ONLY).toBe('zq-seed-value')
    })
  }

  // @covers: provider-credentials › Legacy Settings credentials migrate to the store at upgrade › Migration moves the map once
  test('M4: absent names move durably as launch-env, the map is deleted and the stamp set together, and a restart moves nothing', async () => {
    // | M4 | absent | non-empty | missing or ok | name absent | durable | none | normal | Eligible absent entry added durably as launch-env, preserving name and value | Delete map and set stamp atomically | Normal, new store entry and complete | Normal using new entry at next eligible launch |
    seedMap({ MOVED_A: 'zq-moved-a', moved_lower: 'zq-moved-lower' })
    const run = await start()
    expect(storeEntries(run.store)).toEqual({
      MOVED_A: { kind: 'launch-env', value: 'zq-moved-a' },
      moved_lower: { kind: 'launch-env', value: 'zq-moved-lower' },
    })
    expect(fs.statSync(storeFile()).mode & 0o777).toBe(0o600)
    expect(mapRow()).toBeNull()
    expect(JSON.parse(stamp()!)).toEqual({ version: 1, skipped: [] })
    expect(run.listing.migration).toEqual(complete())
    expect(run.listing.rows.filter(row => row.source === 'store').map(row => row.name)).toEqual(['MOVED_A', 'moved_lower'])
    expect(run.delivery).toMatchObject({ MOVED_A: 'zq-moved-a', moved_lower: 'zq-moved-lower' })
    expect(JSON.stringify(settings())).not.toContain('zq-moved')

    const before = { rows: settings(), bytes: storeBytes() }
    const again = await start()
    expect({ rows: settings(), bytes: storeBytes() }).toEqual(before)
    expect(again.listing.migration).toEqual(complete())
  })

  test('M5: an identical entry is absorbed keeping its existing kind, with no skip, and the commit still follows durability', async () => {
    // | M5 | absent | non-empty | ok | same value | durable | none | normal | Identical entry absorbed, including its existing kind, with durability confirmed | Delete map and set stamp atomically | Normal, complete, no skip for equality | Normal using existing entry |
    await seedStore({ SAME_TOKEN: { value: 'zq-same', kind: 'secret-source' } })
    seedMap({ SAME_TOKEN: 'zq-same' })
    const run = await start()
    expect(storeEntries(run.store)).toEqual({ SAME_TOKEN: { kind: 'secret-source', value: 'zq-same' } })
    expect(mapRow()).toBeNull()
    expect(run.listing.migration).toEqual(complete())
    // A secret-source stays withheld from delivery, as before the migration.
    expect(run.delivery.SAME_TOKEN).toBeUndefined()
  })

  test('M6: a different-valued existing entry wins and the name is skipped names-only on the stamp', async () => {
    // | M6 | absent | non-empty | ok | different value | durable | none | normal | Existing different-valued entry wins with durability confirmed | Delete map and set stamp with its skip name atomically | Normal, complete, names-only collision skip | Normal using the winner |
    await seedStore({ DIFFERS: { value: 'zq-store-wins', kind: 'launch-env' } })
    seedMap({ DIFFERS: 'zq-map-loses', FRESH: 'zq-fresh' })
    const run = await start()
    expect(storeEntries(run.store)).toEqual({
      DIFFERS: { kind: 'launch-env', value: 'zq-store-wins' },
      FRESH: { kind: 'launch-env', value: 'zq-fresh' },
    })
    expect(mapRow()).toBeNull()
    expect(JSON.parse(stamp()!)).toEqual({ version: 1, skipped: ['DIFFERS'] })
    expect(run.listing.migration).toEqual(complete(['DIFFERS']))
    expect(run.delivery.DIFFERS).toBe('zq-store-wins')
    expect(JSON.stringify(settings())).not.toContain('zq-map-loses')
  })

  test('M7: a registered name lands as an inert launch-env marked as a collision, and delivery withholds it', async () => {
    // | M7 | absent | non-empty | missing or ok | name registered | durable | none | normal | Registered name added as inert launch-env if absent, otherwise existing entry wins with the M5/M6 rule | Delete map and set stamp atomically | Normal, mark registered launch-env collision, names-only skip if different prior value wins | Registered name withheld, required composition refuses before spawning |
    retainSecretName(db, 'REG_ABSENT')
    retainSecretName(db, 'REG_DIFFERS')
    await seedStore({ REG_DIFFERS: { value: 'zq-reg-store', kind: 'launch-env' } })
    seedMap({ REG_ABSENT: 'zq-reg-new', REG_DIFFERS: 'zq-reg-map' })
    const run = await start()
    expect(storeEntries(run.store)).toEqual({
      REG_ABSENT: { kind: 'launch-env', value: 'zq-reg-new' },
      REG_DIFFERS: { kind: 'launch-env', value: 'zq-reg-store' },
    })
    expect(mapRow()).toBeNull()
    expect(run.listing.migration).toEqual(complete(['REG_DIFFERS']))
    for (const name of ['REG_ABSENT', 'REG_DIFFERS']) {
      expect(run.listing.rows.find(row => row.name === name)).toMatchObject({ kind: 'launch-env', collision: true })
      expect(run.delivery[name]).toBeUndefined()
    }
  })

  test('M8: an applied but unconfirmed write keeps the map and no stamp, reports pending with the skips, and the next start commits', async () => {
    // | M8 | absent | non-empty | missing or ok | * | applied-not-durable | none | normal | Applied rename stands without confirmed durability | Original map retained, stamp absent, next startup reattempts | Normal from readable applied store, pending with fixed unconfirmed-durability reason and observed skip names | Normal from current usable sources |
    await seedStore({ M8_DIFF: { value: 'zq-m8-store', kind: 'launch-env' } })
    const map = { M8_NEW: 'zq-m8-new', M8_DIFF: 'zq-m8-map' }
    seedMap(map)
    const run = await start('not-durable')
    expect(storeEntries(newStore())).toEqual({
      M8_DIFF: { kind: 'launch-env', value: 'zq-m8-store' },
      M8_NEW: { kind: 'launch-env', value: 'zq-m8-new' },
    })
    expect(JSON.parse(mapRow()!)).toEqual(map)
    expect(stamp()).toBeNull()
    expect(run.listing.migration).toEqual(pendingState(MIGRATION_TEXT.notDurable, ['M8_DIFF']))
    expect(run.delivery).toMatchObject({ M8_NEW: 'zq-m8-new', M8_DIFF: 'zq-m8-store' })

    const retry = await start()
    expect(mapRow()).toBeNull()
    expect(retry.listing.migration).toEqual(complete(['M8_DIFF']))
  })

  test('M9: a refused write leaves the prior bytes, the map, and no stamp; the map is never delivered meanwhile', async () => {
    // | M9 | absent | non-empty | missing or ok | * | refused (write-failed) | none | normal | Prior file bytes or absence stand after refusal | Original map retained, stamp absent, next startup reattempts | Normal plus fixed write-failure pending reason | Normal from prior usable sources |
    for (const prior of ['missing', 'ok'] as const) {
      fs.rmSync(path.join(home, '.kawai'), { recursive: true, force: true })
      db.deleteAppSetting(CHAT_PROVIDER_ENV_KEY)
      if (prior === 'ok') await seedStore({ PRIOR: { value: 'zq-prior', kind: 'launch-env' } })
      seedMap({ M9_NEW: 'zq-m9-new' })
      const before = storeBytes()
      const run = await start('write-failed')
      expect({ prior, bytes: storeBytes() }).toEqual({ prior, bytes: before })
      expect({ prior, map: mapRow(), stamp: stamp() }).toEqual({ prior, map: JSON.stringify({ M9_NEW: 'zq-m9-new' }), stamp: null })
      expect(run.listing.migration).toEqual(pendingState(MIGRATION_TEXT.writeFailed))
      expect(run.delivery.M9_NEW).toBeUndefined()
      expect(run.delivery.PRIOR).toBe(prior === 'ok' ? 'zq-prior' : undefined)
    }
  })

  for (const unusable of ['malformed', 'unsafe-permissions'] as const) {
    test(`M10: an unusable store (${unusable}) stands unrepaired, the map stays, and delivery is process and seed only`, async () => {
      // | M10 | absent | non-empty | unreadable-unsafe-malformed | * | — | none | normal | Prior unusable store stands without repair or salvage | Original map retained, stamp absent, next startup reattempts | Fixed safe store reason plus migration pending | Process and seed under the normal filters |
      fs.mkdirSync(path.join(home, '.kawai'), { recursive: true, mode: 0o700 })
      if (unusable === 'malformed') fs.writeFileSync(storeFile(), '{ not json', { mode: 0o600 })
      else {
        await seedStore({ UNSAFE: { value: 'zq-unsafe', kind: 'launch-env' } })
        fs.chmodSync(storeFile(), 0o644)
      }
      seedMap({ M10_NEW: 'zq-m10-new' })
      const before = { bytes: storeBytes(), mode: fs.statSync(storeFile()).mode }
      const run = await start()
      expect({ bytes: storeBytes(), mode: fs.statSync(storeFile()).mode }).toEqual(before)
      expect(mapRow()).toBe(JSON.stringify({ M10_NEW: 'zq-m10-new' }))
      expect(stamp()).toBeNull()
      expect(run.listing.store).toMatchObject({ ok: false, reason: unusable })
      expect(run.listing.migration).toEqual(pendingState(MIGRATION_TEXT.storeUnusable))
      expect(run.delivery).toEqual({ SEED_ONLY: 'zq-seed-value' })
    })
  }

  test('M11: a stop before the store write leaves the prior store and the map; the restart follows the import outcome from there', async () => {
    // | M11 | absent | non-empty | * | * | * | before store write | normal | Prior store remains at interruption | Map retained, stamp absent. Restart follows the applicable import outcome from that state | Service unavailable while stopped. After restart use that outcome's listing | Service unavailable while stopped. After restart use that outcome's projection |
    // The interruption: the write's first step (the temp file open) never happens.
    seedMap({ M11_NEW: 'zq-m11-new' })
    const interrupted = await migrateLegacyProviderEnv({
      db, store: createCredentialStore(storeFile(), { retainSecretNames: { retainSecretName: name => retainSecretName(db, name) }, deps: { openSync: () => { throw new Error('stopped') } } }),
    })
    expect(interrupted.state).toBe('pending')
    expect(fs.existsSync(storeFile())).toBe(false)
    expect(mapRow()).not.toBeNull()
    expect(stamp()).toBeNull()
    const restart = await start()
    expect(storeEntries(restart.store)).toEqual({ M11_NEW: { kind: 'launch-env', value: 'zq-m11-new' } })
    expect(mapRow()).toBeNull()
    expect(restart.listing.migration).toEqual(complete())
  })

  // @covers: provider-credentials › Legacy Settings credentials migrate to the store at upgrade › A crash before the database commit recovers
  test('M12: a crash after the durable store write but before the commit keeps the map; the restart absorbs, keeps winners, and commits once', async () => {
    // | M12 | absent | non-empty | ok | * | durable | after store write, before transaction | normal | Durably moved entries stand. On restart absorb equal entries and preserve any different winners | Map retained and stamp absent at interruption. Successful retry deletes and stamps together. Failed retry follows M8–M10 | Service unavailable while stopped. After restart show actual outcome and collision skips | Service unavailable while stopped. After restart use normal projection |
    await seedStore({ M12_DIFF: { value: 'zq-m12-store', kind: 'launch-env' } })
    const map = { M12_NEW: 'zq-m12-new', M12_DIFF: 'zq-m12-map' }
    seedMap(map)
    const crashed = await start('none', () => { throw new Error('crash before commit') })
    expect(crashed.state).toEqual(pendingState(MIGRATION_TEXT.commitFailed, ['M12_DIFF']))
    expect(JSON.parse(mapRow()!)).toEqual(map)
    expect(stamp()).toBeNull()
    const moved = storeBytes()
    expect(storeEntries(newStore())).toEqual({
      M12_DIFF: { kind: 'launch-env', value: 'zq-m12-store' },
      M12_NEW: { kind: 'launch-env', value: 'zq-m12-new' },
    })

    // A failed retry follows M8: still pending, map retained.
    expect((await start('not-durable')).state).toEqual(pendingState(MIGRATION_TEXT.notDurable, ['M12_DIFF']))
    expect(mapRow()).not.toBeNull()

    const restart = await start()
    expect(storeEntries(restart.store)).toEqual(storeEntries(newStore()))
    expect(JSON.parse(storeBytes()!)).toEqual(JSON.parse(moved!))
    expect(mapRow()).toBeNull()
    expect(JSON.parse(stamp()!)).toEqual({ version: 1, skipped: ['M12_DIFF'] })
    expect(restart.listing.migration).toEqual(complete(['M12_DIFF']))
    expect(restart.delivery).toMatchObject({ M12_NEW: 'zq-m12-new', M12_DIFF: 'zq-m12-store' })
  })

  test('M12: a database failure after the transaction\'s first statement rolls back the map deletion and the stamp; the file stands and the next start commits', async () => {
    // Same row as above, with the fault inside the transaction: the map
    // deletion ran, then the stamp write fails.
    seedMap({ M12_TX: 'zq-m12-tx' })
    const setAppSetting = db.setAppSetting.bind(db)
    const deleted: string[] = []
    const deleteAppSetting = db.deleteAppSetting.bind(db)
    db.deleteAppSetting = (key: string) => { deleted.push(key); deleteAppSetting(key) }
    db.setAppSetting = (key: string, value: string) => {
      if (key === MIGRATION_STAMP_KEY) throw new Error('SQLITE_IOERR')
      setAppSetting(key, value)
    }
    const failed = await start()
    db.setAppSetting = setAppSetting
    db.deleteAppSetting = deleteAppSetting
    expect(deleted).toEqual([CHAT_PROVIDER_ENV_KEY])
    expect(failed.state).toEqual(pendingState(MIGRATION_TEXT.commitFailed))
    expect(mapRow()).toBe(JSON.stringify({ M12_TX: 'zq-m12-tx' }))
    expect(stamp()).toBeNull()
    expect(storeEntries(newStore())).toEqual({ M12_TX: { kind: 'launch-env', value: 'zq-m12-tx' } })

    const restart = await start()
    expect(mapRow()).toBeNull()
    expect(JSON.parse(stamp()!)).toEqual({ version: 1, skipped: [] })
    expect(restart.listing.migration).toEqual(complete())
  })

  test('M13: after the commit the stamp survives restarts — no migration write, complete with the stamped skips', async () => {
    // | M13 | present | absent | ok | — | — | after transaction | normal | Durable store stands through restart | Map absent, stamp present, no migration writes on restart | Service unavailable while stopped. On restart normal and complete with stamped skips | Service unavailable while stopped. Normal on restart |
    await seedStore({ M13_DIFF: { value: 'zq-m13-store', kind: 'launch-env' } })
    seedMap({ M13_DIFF: 'zq-m13-map', M13_NEW: 'zq-m13-new' })
    expect((await start()).state).toEqual(complete(['M13_DIFF']))
    const before = { rows: settings(), bytes: storeBytes() }
    for (let restart = 0; restart < 3; restart++) {
      const run = await start()
      expect({ rows: settings(), bytes: storeBytes() }).toEqual(before)
      expect(run.listing.migration).toEqual(complete(['M13_DIFF']))
      expect(migrationStatus(db)).toEqual(complete(['M13_DIFF']))
    }
  })

  // @covers: provider-credentials › Legacy Settings credentials migrate to the store at upgrade › A restored pre-upgrade backup re-runs the migration
  test('M14: a restored pre-upgrade backup re-runs the migration — later store entries win, missing names import, then one commit', async () => {
    // | M14 | absent | non-empty | ok (later entries) | same or different | durable | none | restored pre-upgrade backup | Restored map merges per name. Keep later store entries and import any eligible missing name | Delete restored map and set stamp atomically after confirmed durability | Normal, complete with differing-value skips | Normal, later store entries win |
    // Through the real initDatabase on a disposable database file and its copy.
    db.close()
    const dbPath = path.join(root, 'upgrade.db')
    const backup = path.join(root, 'pre-upgrade.db')
    db = initDatabase({ path: dbPath })
    seedMap({ KEPT_SAME: 'zq-same', LATER_DIFF: 'zq-old', CLEARED: 'zq-cleared' })
    db.close()
    fs.copyFileSync(dbPath, backup)
    db = initDatabase({ path: dbPath })
    expect((await start()).state).toEqual(complete())

    // Later operator changes, then the restore of the pre-upgrade backup.
    const later = newStore()
    await later.set('LATER_DIFF', 'zq-later', 'launch-env')
    await later.clear('CLEARED')
    db.close()
    fs.copyFileSync(backup, dbPath)
    db = initDatabase({ path: dbPath })
    expect(stamp()).toBeNull()

    const run = await start()
    expect(storeEntries(run.store)).toEqual({
      CLEARED: { kind: 'launch-env', value: 'zq-cleared' },
      KEPT_SAME: { kind: 'launch-env', value: 'zq-same' },
      LATER_DIFF: { kind: 'launch-env', value: 'zq-later' },
    })
    expect(mapRow()).toBeNull()
    expect(JSON.parse(stamp()!)).toEqual({ version: 1, skipped: ['LATER_DIFF'] })
    expect(run.listing.migration).toEqual(complete(['LATER_DIFF']))
    expect(run.delivery.LATER_DIFF).toBe('zq-later')
  })

  test('M15: a name the operator cleared while M8 repeated is reimported from the retained map, and the durable retry commits', async () => {
    // | M15 | absent | non-empty | ok, operator cleared a migrated name while M8 repeated | name absent | durable | none | normal | Eligible cleared name reimported durably from retained map | Delete map and set stamp atomically in this durable row | Normal and complete with reimported entry. If confirmation fails again, M8 reports pending | Normal, eligible reimported entry can deliver |
    seedMap({ M15_CLEARED: 'zq-m15', M15_KEPT: 'zq-m15-kept' })
    expect((await start('not-durable')).state.state).toBe('pending')
    await newStore().clear('M15_CLEARED')
    expect((await start('not-durable')).state).toEqual(pendingState(MIGRATION_TEXT.notDurable))
    await newStore().clear('M15_CLEARED')
    const run = await start()
    expect(storeEntries(run.store)).toEqual({
      M15_CLEARED: { kind: 'launch-env', value: 'zq-m15' },
      M15_KEPT: { kind: 'launch-env', value: 'zq-m15-kept' },
    })
    expect(mapRow()).toBeNull()
    expect(run.listing.migration).toEqual(complete())
    expect(run.delivery.M15_CLEARED).toBe('zq-m15')
  })

  test('M16: the external store stays in place after the commit, and the pre-upgrade backup still holds the map for a rollback restore', async () => {
    // | M16 | present | absent | ok | — | — | none | downgrade to a pre-change binary | External store remains in place across binary downgrade | Map absent and stamp ignored on the post-upgrade database. Restoring the pre-upgrade backup supplies its old map | Legacy surface reports environment or none before restore, with legacy settings source when backup supplies the map | Legacy launch reads process and seed before restore and uses its configured legacy map after restore, with that binary's filters |
    // The pre-change binary itself is not run here (limitation reported);
    // this asserts what the current binary leaves for it.
    db.close()
    const dbPath = path.join(root, 'upgrade.db')
    const backup = path.join(root, 'pre-upgrade.db')
    db = initDatabase({ path: dbPath })
    seedMap({ M16_NAME: 'zq-m16' })
    db.close()
    fs.copyFileSync(dbPath, backup)
    db = initDatabase({ path: dbPath })
    await start()
    expect(mapRow()).toBeNull()
    expect(storeEntries(newStore())).toEqual({ M16_NAME: { kind: 'launch-env', value: 'zq-m16' } })
    const restored = initDatabase({ path: backup })
    try {
      expect(restored.getAppSetting(CHAT_PROVIDER_ENV_KEY)).toBe(JSON.stringify({ M16_NAME: 'zq-m16' }))
      expect(restored.getAppSetting(MIGRATION_STAMP_KEY)).toBeNull()
    } finally {
      restored.close()
    }
  })

  test('an unreadable map is never migrated or deleted; the listing names the fixed reason', async () => {
    db.setAppSetting(CHAT_PROVIDER_ENV_KEY, '{ not json')
    const run = await start()
    expect(mapRow()).toBe('{ not json')
    expect(stamp()).toBeNull()
    expect(fs.existsSync(storeFile())).toBe(false)
    expect(run.listing.migration).toEqual(pendingState(MIGRATION_TEXT.unreadableMap))
  })
})
