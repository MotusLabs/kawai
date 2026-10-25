// The secret-name registry (provider-relay-setup D2, table W): the one
// registered-name set every launch withholds — parsed-catalog-layer binding
// names in any entry state, header variables (§4), secret-source store keys
// (§2), and retained names persisted as names only in app_settings. Names are
// not secrets: the persisted row never holds a value.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  RETAINED_SECRET_NAMES_KEY,
  collidingLaunchEnvNames,
  observeRegisteredNames,
  readRetainedNames,
  registeredSecretNames,
  type RetainedNamesDb,
} from '../chat/secretNameRegistry'
import { initDatabase } from '../db'

/** In-memory double: records writes and refuses any key but the registry's. */
class FakeNamesDb implements RetainedNamesDb {
  rows = new Map<string, string>()
  writes = 0
  failOnWrite = false

  getAppSetting(key: string): string | null {
    if (key !== RETAINED_SECRET_NAMES_KEY) throw new Error(`unexpected getAppSetting key: ${key}`)
    return this.rows.get(key) ?? null
  }

  setAppSetting(key: string, value: string): void {
    if (key !== RETAINED_SECRET_NAMES_KEY) throw new Error(`unexpected setAppSetting key: ${key}`)
    this.writes += 1
    if (this.failOnWrite) throw new Error('disk full')
    this.rows.set(key, value)
  }
}

let captured: { kind: 'warn' | 'error'; args: unknown[] }[] = []
const originalWarn = console.warn
const originalError = console.error

beforeEach(() => {
  captured = []
  console.warn = (...args: unknown[]) => captured.push({ kind: 'warn', args })
  console.error = (...args: unknown[]) => captured.push({ kind: 'error', args })
})

afterEach(() => {
  console.warn = originalWarn
  console.error = originalError
})

describe('the registered-name composition (table W)', () => {
  test('the set is the union of the four sources, deduplicated', () => {
    const set = registeredSecretNames({
      catalogNames: ['OR2_KEY', 'OR2_MANAGEMENT_KEY'],
      headerVariables: ['OR2_MANAGEMENT_KEY', 'RELAY_VIRTUAL_KEY'],
      secretSourceKeys: ['STORE_ONLY_KEY'],
      retainedNames: ['OR2_KEY', 'RETIRED_NAME'],
    })
    expect([...set].sort()).toEqual([
      'OR2_KEY',
      'OR2_MANAGEMENT_KEY',
      'RELAY_VIRTUAL_KEY',
      'RETIRED_NAME',
      'STORE_ONLY_KEY',
    ])
  })

  test('empty sources compose to an empty set — the pre-§2/§4 shape', () => {
    // Header bindings and the store do not exist yet: their sources are
    // optional and empty, so the filter is unchanged when they plug in.
    expect(registeredSecretNames({})).toEqual(new Set())
    expect(registeredSecretNames({ catalogNames: [] })).toEqual(new Set())
  })

  test('collidingLaunchEnvNames reports the registered names a delivery carries, names only', () => {
    // Table W7's collision data: the launch filter withholds silently; the
    // listing (§7) renders this list. Names only — the delivery's values
    // never reach the result.
    const registered = registeredSecretNames({
      catalogNames: ['OR2_KEY'],
      headerVariables: ['RELAY_VIRTUAL_KEY'],
    })
    expect(collidingLaunchEnvNames({ RELAY_VIRTUAL_KEY: 'a', STORE_ONLY_KEY: 'b' }, registered))
      .toEqual(['RELAY_VIRTUAL_KEY'])
    expect(collidingLaunchEnvNames({ B_KEY: 'x', A_KEY: 'y' }, new Set(['B_KEY', 'A_KEY'])))
      .toEqual(['A_KEY', 'B_KEY'])
    expect(collidingLaunchEnvNames({ UNRELATED: 'v' }, registered)).toEqual([])
  })
})

describe('retained names persist as names only', () => {
  test('observation persists newly observed names and returns the union', () => {
    const db = new FakeNamesDb()
    const first = observeRegisteredNames(db, { catalogNames: ['OR2_KEY'] })
    expect([...first]).toEqual(['OR2_KEY'])
    expect(JSON.parse(db.rows.get(RETAINED_SECRET_NAMES_KEY)!)).toEqual(['OR2_KEY'])
    // A header variable and a store key register like catalog names (§2/§4).
    const second = observeRegisteredNames(db, {
      catalogNames: ['OR2_KEY'],
      headerVariables: ['RELAY_VIRTUAL_KEY'],
      secretSourceKeys: ['STORE_ONLY_KEY'],
    })
    expect([...second].sort()).toEqual(['OR2_KEY', 'RELAY_VIRTUAL_KEY', 'STORE_ONLY_KEY'])
  })

  test('a second observation without growth writes nothing', () => {
    const db = new FakeNamesDb()
    observeRegisteredNames(db, { catalogNames: ['OR2_KEY'] })
    expect(db.writes).toBe(1)
    observeRegisteredNames(db, { catalogNames: ['OR2_KEY'] })
    expect(db.writes).toBe(1)
  })

  test('readRetainedNames reads the persisted names back', () => {
    const db = new FakeNamesDb()
    observeRegisteredNames(db, { catalogNames: ['OR2_KEY', 'OR2_MANAGEMENT_KEY'] })
    expect(readRetainedNames(db)).toEqual(new Set(['OR2_KEY', 'OR2_MANAGEMENT_KEY']))
  })

  test('the real SessionDatabase round-trips the key', () => {
    const db = initDatabase({ path: ':memory:' })
    try {
      const union = observeRegisteredNames(db, { catalogNames: ['OR2_KEY'] })
      expect([...union]).toEqual(['OR2_KEY'])
      expect(readRetainedNames(db)).toEqual(new Set(['OR2_KEY']))
    } finally {
      db.close()
    }
  })
})

describe('registry failure behavior', () => {
  test('a malformed retained key reads as empty and warns, naming the key', () => {
    const db = new FakeNamesDb()
    db.rows.set(RETAINED_SECRET_NAMES_KEY, '{not json')
    expect(readRetainedNames(db)).toEqual(new Set())
    const warn = captured.find(c => c.kind === 'warn')
    expect(warn).toBeDefined()
    expect(String(warn!.args.join(' '))).toContain(RETAINED_SECRET_NAMES_KEY)
  })

  test('a non-array retained key is malformed, not a one-name set', () => {
    const db = new FakeNamesDb()
    db.rows.set(RETAINED_SECRET_NAMES_KEY, JSON.stringify('OR2_KEY'))
    expect(readRetainedNames(db)).toEqual(new Set())
  })

  test('non-string members make the whole key malformed', () => {
    const db = new FakeNamesDb()
    db.rows.set(RETAINED_SECRET_NAMES_KEY, JSON.stringify(['OR2_KEY', 7]))
    expect(readRetainedNames(db)).toEqual(new Set())
  })

  test('a malformed key heals at the next observation', () => {
    const db = new FakeNamesDb()
    db.rows.set(RETAINED_SECRET_NAMES_KEY, '{not json')
    observeRegisteredNames(db, { catalogNames: ['OR2_KEY'] })
    expect(JSON.parse(db.rows.get(RETAINED_SECRET_NAMES_KEY)!)).toEqual(['OR2_KEY'])
    expect(readRetainedNames(db)).toEqual(new Set(['OR2_KEY']))
  })

  test('a failed observation write is logged and the in-memory union still withholds', () => {
    const db = new FakeNamesDb()
    db.failOnWrite = true
    const union = observeRegisteredNames(db, { catalogNames: ['OR2_KEY'] })
    expect([...union]).toEqual(['OR2_KEY'])
    // The log names the key and the count — never the delivery values.
    const failure = captured.find(c => c.kind === 'error')
    expect(failure).toBeDefined()
    expect(String(failure!.args.join(' '))).toContain(RETAINED_SECRET_NAMES_KEY)
  })
})
