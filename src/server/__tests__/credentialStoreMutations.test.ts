// Focused regressions for the credential store's public clear() and the
// shared mutation spine (design D1, provider-relay-setup). Every mutation —
// set and clear alike — runs one enqueue on the file's canonical owner, one
// fresh in-queue read (install-or-clear), then old-or-new retention before
// any file change. Clear never creates anything: a missing parent is a
// plain no-op. All cases run through the real public factory on isolated
// synthetic files; faults use the factory's typed per-instance deps seam.

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
import { CredentialStoreError as DefiningCredentialStoreError } from '../chat/credentialStoreErrors'

let root: string

beforeEach(() => {
  root = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-credstore-mutations-'))
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

/** Retain collaborator that records NAME-only events (never values). */
const recorder = (events: string[]): { retainSecretName: (name: string) => void } => ({
  retainSecretName: (name: string) => {
    events.push(`retain:${name}`)
  },
})

async function expectCodeAsync(pending: Promise<unknown>, code: CredentialStoreCode): Promise<void> {
  try {
    await pending
  } catch (err) {
    expect((err as CredentialStoreError).code).toBe(code)
    return
  }
  throw new Error(`expected CredentialStoreError ${code}`)
}

describe('clear and the shared mutation spine', () => {
  test('clearing an absent entry is a no-op that leaves the file untouched', async () => {
    const store = createCredentialStore(sp())
    expect((await store.set('a', 'va', 'launch-env')).applied).toBe(true)
    const before = realFs.readFileSync(sp(), 'utf8')
    const stat = realFs.statSync(sp())
    const events: string[] = []
    const clearer = createCredentialStore(sp(), { retainSecretNames: recorder(events) })
    expect(await clearer.clear('other')).toEqual({ applied: false, durable: false })
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(before)
    const after = realFs.statSync(sp())
    expect(after.size).toBe(stat.size)
    expect(after.mtimeMs).toBe(stat.mtimeMs)
    expect(events).toEqual([])
  })

  test('clearing with no store file is a no-op that creates nothing', async () => {
    const events: string[] = []
    const clearer = createCredentialStore(sp(), { retainSecretNames: recorder(events) })
    expect(await clearer.clear('a')).toEqual({ applied: false, durable: false })
    expect(realFs.existsSync(sp())).toBe(false)
    expect(events).toEqual([])
  })

  test('clearing with an absent parent is a no-op that creates no directory', async () => {
    const missing = path.join(root, 'nope', 'credentials.json')
    const events: string[] = []
    const clearer = createCredentialStore(missing, { retainSecretNames: recorder(events) })
    expect(await clearer.clear('a')).toEqual({ applied: false, durable: false })
    expect(realFs.existsSync(path.join(root, 'nope'))).toBe(false)
    expect(events).toEqual([])
  })

  test("a parent that cannot be stat'ed refuses clear as unreadable", async () => {
    let statCalls = 0
    const faulted: CredentialStoreOptions = {
      deps: {
        statSync: () => {
          statCalls += 1
          const err = new Error('injected stat failure')
          ;(err as { code?: string }).code = 'EACCES'
          throw err
        },
      } as unknown as Partial<CredentialFsDeps>,
    }
    const clearer = createCredentialStore(sp(), faulted)
    await expectCodeAsync(clearer.clear('a'), 'unreadable')
    expect(statCalls).toBe(1)
    expect(realFs.existsSync(sp())).toBe(false)
  })

  test('an invalid clear name refuses before any filesystem access', async () => {
    const store = createCredentialStore(sp())
    expect((await store.set('a', 'va', 'launch-env')).applied).toBe(true)
    const before = realFs.readFileSync(sp(), 'utf8')
    let statCalls = 0
    const counting: CredentialStoreOptions = {
      deps: {
        statSync: (pathArg: Parameters<typeof realFs.statSync>[0]) => {
          statCalls += 1
          return realFs.statSync(pathArg)
        },
      } as unknown as Partial<CredentialFsDeps>,
    }
    const clearer = createCredentialStore(sp(), counting)
    await expectCodeAsync(clearer.clear('has space'), 'invalid-name')
    await expectCodeAsync(clearer.clear('0abc'), 'invalid-name')
    await expectCodeAsync(clearer.clear(''), 'invalid-name')
    await expectCodeAsync(clearer.clear(7 as unknown as string), 'invalid-name')
    expect(statCalls).toBe(0)
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(before)
  })

  test('clear removes exactly its own entry; a stored blank is a real removal', async () => {
    writeRaw(doc(`{"a":{"kind":"launch-env","value":"va"},"B":{"kind":"launch-env","value":""},"c":{"kind":"launch-env","value":"vc"}}`))
    const store = createCredentialStore(sp())
    expect((await store.clear('a')).applied).toBe(true)
    expect((await store.clear('B')).applied).toBe(true)
    const reader = createCredentialStore(sp())
    expect(reader.list().entries.map((entry) => entry.name)).toEqual(['c'])
    expect(reader.resolve('a')).toBeUndefined()
    expect(reader.resolve('c')).toBe('vc')
  })

  test('a raw-preseeded __proto__ entry is removed as an own key, others intact', async () => {
    writeRaw(doc(`{"a":{"kind":"launch-env","value":"va"},"__proto__":{"kind":"launch-env","value":"vp"}}`))
    const primed = createCredentialStore(sp())
    expect(primed.list().entries.map((entry) => entry.name).sort()).toEqual(['__proto__', 'a'])
    expect((await primed.clear('__proto__')).applied).toBe(true)
    const reader = createCredentialStore(sp())
    expect(reader.list().entries.map((entry) => entry.name)).toEqual(['a'])
    expect(reader.resolve('a')).toBe('va')
  })

  test('clearing a preseeded secret retains the name strictly before the rename', async () => {
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"},"a":{"kind":"launch-env","value":"va"}}`))
    const events: string[] = []
    const retainer = recorder(events)
    const observed: CredentialStoreOptions = {
      retainSecretNames: retainer,
      deps: {
        renameSync: (from: string, to: string) => {
          events.push('rename')
          return realFs.renameSync(from, to)
        },
      } as unknown as Partial<CredentialFsDeps>,
    }
    const clearer = createCredentialStore(sp(), observed)
    expect(await clearer.clear('A')).toEqual({ applied: true, durable: true })
    expect(events).toEqual(['retain:A', 'rename'])
    const reader = createCredentialStore(sp())
    expect(reader.list().entries.map((entry) => entry.name)).toEqual(['a'])
  })

  test('clearing a secret with no collaborator refuses first and the bytes stand', async () => {
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"}}`))
    const before = realFs.readFileSync(sp(), 'utf8')
    const stat = realFs.statSync(sp())
    const clearer = createCredentialStore(sp())
    await expectCodeAsync(clearer.clear('A'), 'retain-collaborator-required')
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(before)
    expect(realFs.statSync(sp()).mtimeMs).toBe(stat.mtimeMs)
  })

  test('a throwing retain collaborator fails the clear and the bytes stand', async () => {
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"}}`))
    const before = realFs.readFileSync(sp(), 'utf8')
    let renames = 0
    const observed: CredentialStoreOptions = {
      retainSecretNames: {
        retainSecretName: () => {
          throw new Error('collaborator exploded')
        },
      },
      deps: {
        renameSync: (from: string, to: string) => {
          renames += 1
          return realFs.renameSync(from, to)
        },
      } as unknown as Partial<CredentialFsDeps>,
    }
    const clearer = createCredentialStore(sp(), observed)
    await expectCodeAsync(clearer.clear('A'), 'retain-collaborator-failed')
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(before)
    expect(renames).toBe(0)
  })

  test('a malformed document refuses clear without retaining', async () => {
    writeRaw('{not json at all')
    const events: string[] = []
    const clearer = createCredentialStore(sp(), { retainSecretNames: recorder(events) })
    await expectCodeAsync(clearer.clear('A'), 'malformed')
    expect(realFs.readFileSync(sp(), 'utf8')).toBe('{not json at all')
    expect(events).toEqual([])
  })

  test('a held read failure refuses clear without retaining', async () => {
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"}}`))
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
      const clearer = createCredentialStore(sp(), faulted)
      await expectCodeAsync(clearer.clear('A'), 'unreadable')
      expect(readAttempts).toBeGreaterThan(0)
      // The refusal happened inside the fresh read, before any retain step:
      // no collaborator event while the fault remains held.
      expect(events).toEqual([])
      expect(realFs.readFileSync(sp(), 'utf8')).toBe(doc(`{"A":{"kind":"secret-source","value":"vA"}}`))
    } finally {
      readFault = false
    }
  })

  test('unsafe file permissions refuse clear without retaining', async () => {
    writeRaw(doc(`{"A":{"kind":"secret-source","value":"vA"}}`), 0o644)
    const before = realFs.readFileSync(sp(), 'utf8')
    const events: string[] = []
    const clearer = createCredentialStore(sp(), { retainSecretNames: recorder(events) })
    await expectCodeAsync(clearer.clear('A'), 'unsafe-permissions')
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(before)
    expect(realFs.statSync(sp()).mode & 0o777).toBe(0o644)
    expect(events).toEqual([])
  })

  test('a same-stamp external promotion to secret-source still retains on clear', async () => {
    const seeded = doc(`{"A":{"kind":"launch-env","value":"xyz"}}`)
    writeRaw(seeded)
    const reader = createCredentialStore(sp())
    // A no-op absent-name clear creates the path's canonical owner and
    // installs its cache from a genuinely ok fresh read; without it resolve()
    // would find no owner and never serve a stale cache.
    expect(await reader.clear('zz')).toEqual({ applied: false, durable: false })
    expect(reader.resolve('A')).toBe('xyz')
    const observed = realFs.statSync(sp())
    // Equal-length in-place rewrite: launch-env 'xyz' -> secret-source ''.
    const promoted = doc(`{"A":{"kind":"secret-source","value":""}}`)
    expect(promoted.length).toBe(seeded.length)
    const fd = realFs.openSync(sp(), 'r+')
    try {
      realFs.writeSync(fd, Buffer.from(promoted, 'utf8'), 0, promoted.length, 0)
    } finally {
      realFs.closeSync(fd)
    }
    realFs.utimesSync(sp(), new Date(T), new Date(T))
    const after = realFs.statSync(sp())
    expect(after.size).toBe(observed.size)
    expect(after.mtimeMs).toBe(observed.mtimeMs)
    expect(after.dev).toBe(observed.dev)
    expect(after.ino).toBe(observed.ino)
    // Stale-cache precondition, proven not assumed: the reader still serves
    // the primed old value through the cache hit, though the bytes now hold
    // the promoted kind (a fresh read would return '').
    expect(reader.resolve('A')).toBe('xyz')
    const events: string[] = []
    const clearer = createCredentialStore(sp(), {
      retainSecretNames: recorder(events),
      deps: {
        renameSync: (from: string, to: string) => {
          events.push('rename')
          return realFs.renameSync(from, to)
        },
      } as unknown as Partial<CredentialFsDeps>,
    })
    expect(await clearer.clear('A')).toEqual({ applied: true, durable: true })
    expect(events).toEqual(['retain:A', 'rename'])
    expect(createCredentialStore(sp()).resolve('A')).toBeUndefined()
  })

  test('a same-stamp external demotion to launch-env clears without retaining', async () => {
    const seeded = doc(`{"A":{"kind":"secret-source","value":""}}`)
    writeRaw(seeded)
    const reader = createCredentialStore(sp())
    // Owner + cache primed via the same no-op absent-name clear as above.
    expect(await reader.clear('zz')).toEqual({ applied: false, durable: false })
    expect(reader.resolve('A')).toBe('')
    const observed = realFs.statSync(sp())
    // Equal-length in-place rewrite: secret-source '' -> launch-env 'xyz'.
    const demoted = doc(`{"A":{"kind":"launch-env","value":"xyz"}}`)
    expect(demoted.length).toBe(seeded.length)
    const fd = realFs.openSync(sp(), 'r+')
    try {
      realFs.writeSync(fd, Buffer.from(demoted, 'utf8'), 0, demoted.length, 0)
    } finally {
      realFs.closeSync(fd)
    }
    realFs.utimesSync(sp(), new Date(T), new Date(T))
    const after = realFs.statSync(sp())
    expect(after.size).toBe(observed.size)
    expect(after.mtimeMs).toBe(observed.mtimeMs)
    expect(after.dev).toBe(observed.dev)
    expect(after.ino).toBe(observed.ino)
    // Stale-cache precondition: the reader still serves the primed secret
    // kind ('' value) through the cache hit, though the bytes now hold the
    // demoted launch-env kind (a fresh read would return 'xyz').
    expect(reader.resolve('A')).toBe('')
    const events: string[] = []
    const clearer = createCredentialStore(sp(), { retainSecretNames: recorder(events) })
    expect(await clearer.clear('A')).toEqual({ applied: true, durable: true })
    expect(events).toEqual([])
    expect(createCredentialStore(sp()).resolve('A')).toBeUndefined()
  })

  test('a held retain blocks a disjoint set through the same parent alias', async () => {
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
    const realOptions: CredentialStoreOptions = {
      retainSecretNames: {
        retainSecretName: (name: string) => {
          events.push(`retain:${name}`)
          return gate
        },
      },
      deps: {
        renameSync: (from: string, to: string) => {
          events.push('rename')
          return realFs.renameSync(from, to)
        },
      } as unknown as Partial<CredentialFsDeps>,
    }
    const realStore = createCredentialStore(realPath, realOptions)
    // The alias resolves to the same dev:ino:basename owner as the real path.
    const aliasStore = createCredentialStore(path.join(root, 'alias', 'credentials.json'), {
      deps: {
        renameSync: (from: string, to: string) => {
          events.push('rename')
          return realFs.renameSync(from, to)
        },
      } as unknown as Partial<CredentialFsDeps>,
    })
    const clearPending = realStore.clear('A')
    const setPending = aliasStore.set('b', 'vb', 'launch-env')
    let setSettled = false
    void setPending.then(() => {
      setSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(setSettled).toBe(false)
    expect(realFs.readFileSync(realPath, 'utf8')).toBe(seeded)
    releaseRetain?.()
    expect(await clearPending).toEqual({ applied: true, durable: true })
    expect(await setPending).toEqual({ applied: true, durable: true })
    expect(events).toEqual(['retain:A', 'rename', 'rename'])
    const reader = createCredentialStore(realPath)
    expect(reader.list().entries.map((entry) => entry.name).sort()).toEqual(['a', 'b'])
    expect(reader.resolve('A')).toBeUndefined()
    expect(reader.resolve('b')).toBe('vb')
  })

  test('a removal is visible to later instances, and a re-set revives the name', async () => {
    const first = createCredentialStore(sp())
    expect((await first.set('a', 'va', 'launch-env')).applied).toBe(true)
    const second = createCredentialStore(sp())
    expect((await second.clear('a')).applied).toBe(true)
    expect(second.resolve('a')).toBeUndefined()
    expect((await second.set('a', 'va2', 'launch-env')).applied).toBe(true)
    const third = createCredentialStore(sp())
    expect(third.resolve('a')).toBe('va2')
    expect((await third.clear('a')).applied).toBe(true)
    expect(createCredentialStore(sp()).resolve('a')).toBeUndefined()
  })

  test('a rename failure before the commit keeps the old bytes and leaves no temp', async () => {
    const seeded = doc(`{"a":{"kind":"launch-env","value":"va"},"b":{"kind":"launch-env","value":"vb"}}`)
    writeRaw(seeded)
    const observed: CredentialStoreOptions = {
      deps: {
        renameSync: () => {
          const err = new Error('injected rename failure')
          ;(err as { code?: string }).code = 'EPERM'
          throw err
        },
      } as unknown as Partial<CredentialFsDeps>,
    }
    const clearer = createCredentialStore(sp(), observed)
    await expectCodeAsync(clearer.clear('a'), 'write-failed')
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(seeded)
    expect(realFs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([])
    expect(createCredentialStore(sp()).resolve('a')).toBe('va')
  })

  test('a directory-fsync failure after the rename reports applied but not durable', async () => {
    const seeded = doc(`{"a":{"kind":"launch-env","value":"va"},"b":{"kind":"launch-env","value":"vb"}}`)
    writeRaw(seeded)
    const observed: CredentialStoreOptions = {
      deps: {
        fsyncSync: (fd: number) => {
          if (realFs.fstatSync(fd).isDirectory()) {
            throw new Error('injected directory fsync failure')
          }
          return realFs.fsyncSync(fd)
        },
      } as unknown as Partial<CredentialFsDeps>,
    }
    const clearer = createCredentialStore(sp(), observed)
    expect(await clearer.clear('a')).toEqual({ applied: true, durable: false })
    const reader = createCredentialStore(sp())
    expect(reader.list().entries.map((entry) => entry.name)).toEqual(['b'])
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(doc(`{"b":{"kind":"launch-env","value":"vb"}}`))
  })

  test('the extracted error keeps one class identity across the module boundary', async () => {
    // The facade's export IS the defining binding — not a facade-local copy.
    expect(CredentialStoreError).toBe(DefiningCredentialStoreError)
    const direct = new CredentialStoreError('invalid-name')
    expect(direct).toBeInstanceOf(CredentialStoreError)
    expect(direct.code).toBe('invalid-name')
    expect(direct.message).toBe('credential store: invalid-name')
    writeRaw('{not json at all')
    expect(createCredentialStore(sp()).status()).toEqual({ ok: false, reason: 'malformed' })
    try {
      await createCredentialStore(sp()).clear('A')
      throw new Error('expected clear to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialStoreError)
    }
  })
})

