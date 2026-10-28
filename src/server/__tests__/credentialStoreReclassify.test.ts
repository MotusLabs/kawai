// Focused regressions for the credential store's public reclassify() —
// value-preserving kind changes on the shared mutation spine (design D1,
// provider-relay-setup). Admission runs before any filesystem read, and the
// changed entry is a NEW object: the fresh mutation copy shares entry
// objects with the owner's cache, so an in-place kind edit would corrupt the
// cached kind when a write fails before the rename. All cases run the real
// public factory on isolated synthetic files; held gates release in finally.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as realFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createCredentialStore,
  CredentialStoreError,
  type CredentialFsDeps,
  type CredentialStoreCode,
  type CredentialStoreOptions,
} from '../chat/credentialStore'

let root: string

beforeEach(() => {
  root = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-credstore-reclassify-'))
})

afterEach(() => {
  realFs.rmSync(root, { recursive: true, force: true })
})

const sp = () => path.join(root, 'credentials.json')

// Whole-ms fixed mtime for every seeded file, so external same-stamp edits
// round-trip exactly.
const T = 1700000000000

const doc = (entries: string): string => `{"version":1,"entries":${entries}}`

const writeRaw = (content: string, mode: number = 0o600): void => {
  realFs.writeFileSync(sp(), content, { mode })
  realFs.chmodSync(sp(), mode)
  realFs.utimesSync(sp(), new Date(T), new Date(T))
}

/** Equal-length in-place rewrite with the whole-ms mtime restored, so the
 * stamp and identity the cache observed stay identical. */
const replaceInPlace = (content: string): void => {
  const fd = realFs.openSync(sp(), 'r+')
  try {
    realFs.writeSync(fd, Buffer.from(content, 'utf8'), 0, content.length, 0)
  } finally {
    realFs.closeSync(fd)
  }
  realFs.utimesSync(sp(), new Date(T), new Date(T))
}

/** Retain collaborator that records NAME-only events (never values). */
const recorder = (events: string[]): { retainSecretName: (name: string) => void } => ({
  retainSecretName: (name: string) => {
    events.push(`retain:${name}`)
  },
})

/** renameSync wrapper that appends to the shared event log, so retain/rename
 * ordering is asserted, not assumed. */
const renameLogger = (events: string[]) =>
  ({
    renameSync: (from: string, to: string) => {
      events.push('rename')
      return realFs.renameSync(from, to)
    },
  }) as unknown as Partial<CredentialFsDeps>

async function expectCodeAsync(pending: Promise<unknown>, code: CredentialStoreCode): Promise<void> {
  try {
    await pending
  } catch (err) {
    expect((err as CredentialStoreError).code).toBe(code)
    return
  }
  throw new Error(`expected CredentialStoreError ${code}`)
}

/** Counting deps over the real filesystem: proves an admission or presence
 * refusal happened before ANY filesystem call — every counter stays 0. */
const countedDeps = (): { counts: Record<string, number>; options: CredentialStoreOptions } => {
  const counts: Record<string, number> = {
    statSync: 0, lstatSync: 0, openSync: 0, fstatSync: 0, readSync: 0, mkdirSync: 0, renameSync: 0, unlinkSync: 0,
  }
  const real = realFs as unknown as Record<string, (...args: unknown[]) => unknown>
  const deps: Record<string, (...args: unknown[]) => unknown> = {}
  for (const key of Object.keys(counts)) {
    deps[key] = (...args: unknown[]) => {
      counts[key] += 1
      return real[key](...args)
    }
  }
  return { counts, options: { deps: deps as unknown as Partial<CredentialFsDeps> } }
}

/** The observed stat matches on size, whole-ms mtime, dev and ino. */
const expectStatEqual = (after: realFs.Stats, observed: realFs.Stats): void => {
  expect(after.size).toBe(observed.size)
  expect(after.mtimeMs).toBe(observed.mtimeMs)
  expect(after.dev).toBe(observed.dev)
  expect(after.ino).toBe(observed.ino)
}

describe('reclassify: value-preserving kind changes on the shared spine', () => {
  test('same-stamp hidden kind: the fresh in-queue read decides, in all three directions', async () => {
    // (a) cached launch, fresh secret — the demotion retains and writes.
    const seededLaunch = doc(`{"A":{"kind":"launch-env","value":"xyz"}}`)
    writeRaw(seededLaunch)
    const reader = createCredentialStore(sp())
    expect(await reader.clear('zz')).toEqual({ applied: false, durable: false })
    expect(reader.resolve('A')).toBe('xyz')
    const promoted = doc(`{"A":{"kind":"secret-source","value":""}}`)
    replaceInPlace(promoted)
    // Stale-cache premise proven, not assumed: the same-stamp rewrite leaves
    // the primed reader serving the old value over the promoted bytes.
    expect(reader.resolve('A')).toBe('xyz')
    const events: string[] = []
    const demoter = createCredentialStore(sp(), {
      retainSecretNames: recorder(events),
      deps: renameLogger(events),
    })
    expect(await demoter.reclassify('A', 'launch-env')).toEqual({ applied: true, durable: true })
    expect(events).toEqual(['retain:A', 'rename'])
    expect(createCredentialStore(sp()).list().entries).toEqual([
      { name: 'A', kind: 'launch-env', state: 'blank' },
    ])
    // (b) cached secret, fresh launch — the promotion retains and writes.
    const seededSecret = doc(`{"A":{"kind":"secret-source","value":""}}`)
    writeRaw(seededSecret)
    const secretReader = createCredentialStore(sp())
    expect(await secretReader.clear('zz')).toEqual({ applied: false, durable: false })
    expect(secretReader.resolve('A')).toBe('')
    const demoted = doc(`{"A":{"kind":"launch-env","value":"xyz"}}`)
    replaceInPlace(demoted)
    expect(secretReader.resolve('A')).toBe('')
    const promotionEvents: string[] = []
    const promoter = createCredentialStore(sp(), {
      retainSecretNames: recorder(promotionEvents),
      deps: renameLogger(promotionEvents),
    })
    expect(await promoter.reclassify('A', 'secret-source')).toEqual({ applied: true, durable: true })
    expect(promotionEvents).toEqual(['retain:A', 'rename'])
    expect(createCredentialStore(sp()).list().entries).toEqual([
      { name: 'A', kind: 'secret-source', state: 'set' },
    ])
    // (c) cached launch, fresh secret — same-kind reclassify no-ops on the fresh read.
    writeRaw(seededLaunch)
    const stale = createCredentialStore(sp())
    expect(await stale.clear('zz')).toEqual({ applied: false, durable: false })
    replaceInPlace(promoted)
    expect(stale.resolve('A')).toBe('xyz')
    const noopEvents: string[] = []
    expect(await createCredentialStore(sp(), { retainSecretNames: recorder(noopEvents) }).reclassify('A', 'secret-source')).toEqual({
      applied: false,
      durable: false,
    })
    expect(noopEvents).toEqual([])
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(promoted)
  })

  test('a pre-rename failure keeps the old bytes AND the cached OLD kind', async () => {
    const seeded = doc(`{"A":{"kind":"launch-env","value":"va"}}`)
    writeRaw(seeded)
    const reader = createCredentialStore(sp())
    expect(await reader.clear('zz')).toEqual({ applied: false, durable: false })
    let renames = 0
    const events: string[] = []
    const reclassifier = createCredentialStore(sp(), {
      retainSecretNames: recorder(events),
      deps: {
        renameSync: () => {
          renames += 1
          const err = new Error('injected rename failure')
          ;(err as { code?: string }).code = 'EPERM'
          throw err
        },
      } as unknown as Partial<CredentialFsDeps>,
    })
    await expectCodeAsync(reclassifier.reclassify('A', 'secret-source'), 'write-failed')
    // One rename after the retention; the bytes stand; no temp survives.
    expect(renames).toBe(1)
    expect(events).toEqual(['retain:A'])
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(seeded)
    expect(realFs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([])
    // C3 oracle: the primed cache still reports the OLD kind — a failed
    // mutation never leaks its in-memory entry change into the cache.
    expect(reader.list().entries).toEqual([{ name: 'A', kind: 'launch-env', state: 'set' }])
    expect(reader.resolve('A')).toBe('va')
  })

  test('target-secret without a collaborator refuses before any filesystem read', async () => {
    writeRaw(doc(`{"a":{"kind":"launch-env","value":"va"}}`))
    const before = realFs.readFileSync(sp(), 'utf8')
    const existing = countedDeps()
    await expectCodeAsync(
      createCredentialStore(sp(), existing.options).reclassify('A', 'secret-source'),
      'retain-collaborator-required',
    )
    expect(Object.values(existing.counts).every((n) => n === 0)).toBe(true)
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(before)
    // Over an already-secret entry.
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"}}`))
    const secreted = countedDeps()
    await expectCodeAsync(
      createCredentialStore(sp(), secreted.options).reclassify('A', 'secret-source'),
      'retain-collaborator-required',
    )
    expect(Object.values(secreted.counts).every((n) => n === 0)).toBe(true)
    // Over a missing parent — presence precedes even the parent stat; nothing is created.
    const orphan = countedDeps()
    await expectCodeAsync(
      createCredentialStore(path.join(root, 'nope', 'credentials.json'), orphan.options).reclassify('A', 'secret-source'),
      'retain-collaborator-required',
    )
    expect(Object.values(orphan.counts).every((n) => n === 0)).toBe(true)
    expect(realFs.existsSync(path.join(root, 'nope'))).toBe(false)
  })

  test('invalid arguments refuse before any filesystem or collaborator access', async () => {
    writeRaw(doc(`{"a":{"kind":"launch-env","value":"va"}}`))
    const before = realFs.readFileSync(sp(), 'utf8')
    const counted = countedDeps()
    const events: string[] = []
    const store = createCredentialStore(sp(), {
      retainSecretNames: recorder(events),
      deps: counted.options.deps,
    })
    await expectCodeAsync(store.reclassify('has space', 'launch-env'), 'invalid-name')
    await expectCodeAsync(store.reclassify('0abc', 'launch-env'), 'invalid-name')
    await expectCodeAsync(store.reclassify('', 'launch-env'), 'invalid-name')
    await expectCodeAsync(store.reclassify(7 as unknown as string, 'launch-env'), 'invalid-name')
    await expectCodeAsync(store.reclassify('a', 'bogus' as unknown as 'launch-env'), 'invalid-kind')
    await expectCodeAsync(store.reclassify('a', 7 as unknown as 'launch-env'), 'invalid-kind')
    // Lower-case secret target: the catalog pattern precedes collaborator presence.
    await expectCodeAsync(store.reclassify('a', 'secret-source'), 'name-not-catalog')
    // The same refusal with a present collaborator, which is never called.
    await expectCodeAsync(
      createCredentialStore(sp(), { retainSecretNames: recorder(events) }).reclassify('a', 'secret-source'),
      'name-not-catalog',
    )
    expect(Object.values(counted.counts).every((n) => n === 0)).toBe(true)
    expect(events).toEqual([])
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(before)
  })

  test('valid no-ops return false/false and never touch bytes or the registry', async () => {
    writeRaw(doc(`{"a":{"kind":"launch-env","value":"va"}}`))
    const counted = countedDeps()
    const events: string[] = []
    const store = createCredentialStore(sp(), {
      retainSecretNames: recorder(events),
      deps: counted.options.deps,
    })
    expect(await store.reclassify('zz', 'launch-env')).toEqual({ applied: false, durable: false })
    // Same kind, both directions — a present collaborator is still no call at all.
    expect(await store.reclassify('a', 'launch-env')).toEqual({ applied: false, durable: false })
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"}}`))
    const seeded = realFs.readFileSync(sp(), 'utf8')
    const observed = realFs.statSync(sp())
    expect(await store.reclassify('A', 'secret-source')).toEqual({ applied: false, durable: false })
    expect(events).toEqual([])
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(seeded)
    expectStatEqual(realFs.statSync(sp()), observed)
    realFs.rmSync(sp())
    expect(await store.reclassify('a', 'launch-env')).toEqual({ applied: false, durable: false })
    expect(realFs.existsSync(sp())).toBe(false)
    // Missing parent (valid launch target) — nothing is created.
    const orphan = createCredentialStore(path.join(root, 'nope', 'credentials.json'), {
      retainSecretNames: recorder(events),
    })
    expect(await orphan.reclassify('a', 'launch-env')).toEqual({ applied: false, durable: false })
    expect(realFs.existsSync(path.join(root, 'nope'))).toBe(false)
    expect(events).toEqual([])
    expect(counted.counts.mkdirSync).toBe(0)
    expect(counted.counts.renameSync).toBe(0)
    expect(counted.counts.unlinkSync).toBe(0)
  })

  test('preseeded promotion and demotion preserve set and blank values byte-for-byte', async () => {
    const events: string[] = []
    writeRaw(doc(`{"A":{"kind":"launch-env","value":"abc"}}`))
    const promoter = createCredentialStore(sp(), {
      retainSecretNames: recorder(events),
      deps: renameLogger(events),
    })
    expect(await promoter.reclassify('A', 'secret-source')).toEqual({ applied: true, durable: true })
    expect(events).toEqual(['retain:A', 'rename'])
    expect(createCredentialStore(sp()).resolve('A')).toBe('abc')
    expect(createCredentialStore(sp()).list().entries).toEqual([
      { name: 'A', kind: 'secret-source', state: 'set' },
    ])
    // Demotion of a stored blank still retains (the OLD kind is secret).
    writeRaw(doc(`{"A":{"kind":"secret-source","value":""}}`))
    const demoter = createCredentialStore(sp(), {
      retainSecretNames: recorder(events),
      deps: renameLogger(events),
    })
    expect(await demoter.reclassify('A', 'launch-env')).toEqual({ applied: true, durable: true })
    expect(events).toEqual(['retain:A', 'rename', 'retain:A', 'rename'])
    expect(createCredentialStore(sp()).resolve('A')).toBe('')
    expect(createCredentialStore(sp()).list().entries).toEqual([
      { name: 'A', kind: 'launch-env', state: 'blank' },
    ])
  })

  test('a missing or throwing retainer fails the demotion before any file change', async () => {
    const seeded = doc(`{"A":{"kind":"secret-source","value":"vA"}}`)
    writeRaw(seeded)
    const observed = realFs.statSync(sp())
    const counted = countedDeps()
    // Missing collaborator: the in-queue current-secret retention refuses.
    await expectCodeAsync(
      createCredentialStore(sp(), counted.options).reclassify('A', 'launch-env'),
      'retain-collaborator-required',
    )
    expect(counted.counts.renameSync).toBe(0)
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(seeded)
    expectStatEqual(realFs.statSync(sp()), observed)
    // Throwing collaborator: a typed fixed code with no cause and no value.
    let thrown: unknown
    try {
      await createCredentialStore(sp(), {
        retainSecretNames: {
          retainSecretName: () => {
            throw new Error('collaborator exploded with vA')
          },
        },
        deps: counted.options.deps,
      }).reclassify('A', 'launch-env')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(CredentialStoreError)
    expect((thrown as CredentialStoreError).code).toBe('retain-collaborator-failed')
    expect((thrown as Error).message).toBe('credential store: retain-collaborator-failed')
    expect(counted.counts.renameSync).toBe(0)
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(seeded)
  })

  test('a held reclassify serializes a disjoint set through the parent alias', async () => {
    const parent = path.join(root, 'real')
    realFs.mkdirSync(parent)
    realFs.symlinkSync(parent, path.join(root, 'alias'), 'dir')
    const realPath = path.join(parent, 'credentials.json')
    const seeded = doc(`{"A":{"kind":"secret-source","value":"vA"},"a":{"kind":"launch-env","value":"va"}}`)
    realFs.writeFileSync(realPath, seeded, { mode: 0o600 })
    realFs.utimesSync(realPath, new Date(T), new Date(T))
    const events: string[] = []
    let releaseRetain: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseRetain = resolve
    })
    const realStore = createCredentialStore(realPath, {
      retainSecretNames: {
        retainSecretName: (name: string) => {
          events.push(`retain:${name}`)
          return gate
        },
      },
      deps: renameLogger(events),
    })
    // The alias resolves to the same dev:ino:basename owner as the real path.
    const aliasStore = createCredentialStore(path.join(root, 'alias', 'credentials.json'), {
      deps: renameLogger(events),
    })
    const reclassifyPending = realStore.reclassify('A', 'launch-env')
    const setPending = aliasStore.set('b', 'vb', 'launch-env')
    let setSettled = false
    void setPending.then(() => {
      setSettled = true
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(setSettled).toBe(false)
      expect(realFs.readFileSync(realPath, 'utf8')).toBe(seeded)
    } finally {
      releaseRetain?.()
    }
    expect(await reclassifyPending).toEqual({ applied: true, durable: true })
    expect(await setPending).toEqual({ applied: true, durable: true })
    expect(events).toEqual(['retain:A', 'rename', 'rename'])
    const reader = createCredentialStore(realPath)
    expect(reader.list().entries.map((entry) => entry.name).sort()).toEqual(['A', 'a', 'b'])
    expect(reader.resolve('A')).toBe('vA')
  })

  test('malformed stores, including a stored NUL, refuse without retaining or cache leak', async () => {
    // A primed healthy cache, then an equal-length corrupt rewrite.
    writeRaw(doc(`{"a":{"kind":"launch-env","value":"va"}}`))
    const reader = createCredentialStore(sp())
    expect(await reader.clear('zz')).toEqual({ applied: false, durable: false })
    const healthy = realFs.readFileSync(sp(), 'utf8')
    const corrupt = healthy.replace('"version":1', '"version":2')
    expect(corrupt.length).toBe(healthy.length)
    replaceInPlace(corrupt)
    const events: string[] = []
    await expectCodeAsync(
      createCredentialStore(sp(), { retainSecretNames: recorder(events) }).reclassify('zz', 'launch-env'),
      'malformed',
    )
    expect(events).toEqual([])
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(corrupt)
    // No cache leak: the primed reader fails closed over the older healthy document.
    expect(reader.list()).toEqual({ status: { ok: false, reason: 'malformed' }, entries: [] })
    expect(reader.resolve('a')).toBeUndefined()
    // A stored NUL value is malformed at parse, before any op or retention.
    writeRaw(`{"version":1,"entries":{"a":{"kind":"launch-env","value":"a\u0000b"}}}`)
    const nulEvents: string[] = []
    const nulBytes = realFs.readFileSync(sp(), 'utf8')
    await expectCodeAsync(
      createCredentialStore(sp(), { retainSecretNames: recorder(nulEvents) }).reclassify('a', 'launch-env'),
      'malformed',
    )
    expect(nulEvents).toEqual([])
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(nulBytes)
  })

  test('held-EIO and unsafe stores refuse even an absent-name no-op', async () => {
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"}}`))
    const seeded = realFs.readFileSync(sp(), 'utf8')
    let readFault = false
    let readAttempts = 0
    const events: string[] = []
    const faulted: CredentialStoreOptions = {
      retainSecretNames: recorder(events),
      deps: {
        readSync: (
          fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          readAttempts += 1
          if (readFault) {
            const err = new Error('injected read failure')
            ;(err as { code?: string }).code = 'EIO'
            throw err
          }
          return realFs.readSync(fd, buffer, offset, length, position)
        },
      } as unknown as Partial<CredentialFsDeps>,
    }
    readFault = true
    try {
      await expectCodeAsync(createCredentialStore(sp(), faulted).reclassify('zz', 'launch-env'), 'unreadable')
      expect(readAttempts).toBeGreaterThan(0)
      expect(events).toEqual([])
      expect(realFs.readFileSync(sp(), 'utf8')).toBe(seeded)
    } finally {
      readFault = false
    }
    // Unsafe permissions refuse at the gate before any op or retention.
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"}}`), 0o644)
    const unsafeBytes = realFs.readFileSync(sp(), 'utf8')
    const unsafeEvents: string[] = []
    await expectCodeAsync(
      createCredentialStore(sp(), { retainSecretNames: recorder(unsafeEvents) }).reclassify('zz', 'launch-env'),
      'unsafe-permissions',
    )
    expect(unsafeEvents).toEqual([])
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(unsafeBytes)
    expect(realFs.statSync(sp()).mode & 0o777).toBe(0o644)
  })

  test('a directory-fsync failure after the rename reports applied but not durable', async () => {
    writeRaw(doc(`{"A":{"kind":"launch-env","value":"va"}}`))
    let renames = 0
    const events: string[] = []
    const store = createCredentialStore(sp(), {
      retainSecretNames: recorder(events),
      deps: {
        renameSync: (from: string, to: string) => {
          renames += 1
          return realFs.renameSync(from, to)
        },
        fsyncSync: (fd: number) => {
          if (realFs.fstatSync(fd).isDirectory()) {
            throw new Error('injected directory fsync failure')
          }
          return realFs.fsyncSync(fd)
        },
      } as unknown as Partial<CredentialFsDeps>,
    })
    expect(await store.reclassify('A', 'secret-source')).toEqual({ applied: true, durable: false })
    // No rollback, no retry: one rename, and a reload shows the new kind.
    expect(renames).toBe(1)
    expect(events).toEqual(['retain:A'])
    expect(createCredentialStore(sp()).list().entries).toEqual([
      { name: 'A', kind: 'secret-source', state: 'set' },
    ])
  })
})
