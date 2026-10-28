// Focused cache-coherence regressions for the credential store's fresh
// mutation read (design D1, provider-relay-setup). A mutation read inside
// the owner queue must either install the shared cache from its own ok
// document or clear that same owner's older cache on ANY non-ok result: a
// refused malformed or unreadable read may never leave known-bad bytes
// masked by a still-healthy cached document. All three cases run through
// the real public factory on isolated synthetic files; the error case uses
// the factory's typed per-instance deps seam with a fault that stays held
// while the shared readers are observed.

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
  root = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-credstore-cache-'))
})

afterEach(() => {
  realFs.rmSync(root, { recursive: true, force: true })
})

const sp = () => path.join(root, 'credentials.json')

const T = 1700000000000

async function expectCodeAsync(pending: Promise<unknown>, code: CredentialStoreCode): Promise<void> {
  try {
    await pending
  } catch (err) {
    expect((err as CredentialStoreError).code).toBe(code)
    return
  }
  throw new Error(`expected CredentialStoreError ${code}`)
}

describe('fresh mutation read cache coherence', () => {
  test('a same-stamp malformed rewrite fails shared readers closed after the refusal', async () => {
    const bootstrap = createCredentialStore(sp())
    expect((await bootstrap.set('a', 'va', 'launch-env')).applied).toBe(true)
    // Whole-ms mtime BEFORE the cache is primed, so the restore round-trips.
    realFs.utimesSync(sp(), new Date(T), new Date(T))
    const reader = createCredentialStore(sp())
    expect(reader.list().entries.map((entry) => entry.name)).toEqual(['a'])
    const observed = realFs.statSync(sp())
    // In-place equal-length malformed rewrite (unsupported version), mtime
    // restored: the stamp and identity the cache observed stay identical.
    const healthy = realFs.readFileSync(sp(), 'utf8')
    const corrupt = healthy.replace('"version":1', '"version":2')
    expect(corrupt.length).toBe(healthy.length)
    const fd = realFs.openSync(sp(), 'r+')
    try {
      realFs.writeSync(fd, Buffer.from(corrupt, 'utf8'), 0, corrupt.length, 0)
    } finally {
      realFs.closeSync(fd)
    }
    realFs.utimesSync(sp(), new Date(T), new Date(T))
    const after = realFs.statSync(sp())
    expect(after.size).toBe(observed.size)
    expect(after.mtimeMs).toBe(observed.mtimeMs)
    expect(after.dev).toBe(observed.dev)
    expect(after.ino).toBe(observed.ino)
    // A mutation over the now-corrupt bytes refuses; the bytes stand.
    const writer = createCredentialStore(sp())
    await expectCodeAsync(writer.set('b', 'vb', 'launch-env'), 'malformed')
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(corrupt)
    // The reader that primed the shared cache must fail closed, not serve
    // the older healthy document.
    expect(reader.status()).toEqual({ ok: false, reason: 'malformed' })
    expect(reader.list()).toEqual({ status: { ok: false, reason: 'malformed' }, entries: [] })
    expect(reader.resolve('a')).toBeUndefined()
  })

  test('a held read failure fails shared readers closed while the fault stands', async () => {
    let readFault = false
    let readAttempts = 0
    const faultDeps = (): Partial<CredentialFsDeps> => ({
      readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        readAttempts += 1
        if (readFault) {
          const err = new Error('injected read failure')
          ;(err as { code?: string }).code = 'EIO'
          throw err
        }
        return realFs.readSync(fd, buffer, offset, length, position)
      },
    } as unknown as Partial<CredentialFsDeps>)
    // ONE explicitly typed options object shared by both faulted instances,
    // so the deps seam cannot be silently unwired.
    const faultOptions: CredentialStoreOptions = { deps: faultDeps() }
    const bootstrap = createCredentialStore(sp())
    expect((await bootstrap.set('a', 'va', 'launch-env')).applied).toBe(true)
    const seeded = realFs.readFileSync(sp(), 'utf8')
    realFs.utimesSync(sp(), new Date(T), new Date(T))
    const observed = realFs.statSync(sp())
    const reader = createCredentialStore(sp(), faultOptions)
    expect(reader.resolve('a')).toBe('va')
    expect(readAttempts).toBeGreaterThan(0)
    const readsAtPrime = readAttempts
    readFault = true
    try {
      const writer = createCredentialStore(sp(), faultOptions)
      await expectCodeAsync(writer.set('b', 'vb', 'launch-env'), 'unreadable')
      expect(readAttempts).toBeGreaterThan(readsAtPrime)
      const after = realFs.statSync(sp())
      expect(after.size).toBe(observed.size)
      expect(after.mtimeMs).toBe(observed.mtimeMs)
      expect(after.dev).toBe(observed.dev)
      expect(after.ino).toBe(observed.ino)
      expect(realFs.readFileSync(sp(), 'utf8')).toBe(seeded)
      // The fault still stands: no real recovery can explain these readings.
      expect(reader.status()).toEqual({ ok: false, reason: 'unreadable' })
      expect(reader.list()).toEqual({ status: { ok: false, reason: 'unreadable' }, entries: [] })
      expect(reader.resolve('a')).toBeUndefined()
    } finally {
      readFault = false
    }
  })

  test('valid fresh reads and writes keep healthy shared-cache behavior', async () => {
    const bootstrap = createCredentialStore(sp())
    expect((await bootstrap.set('a', 'va', 'launch-env')).applied).toBe(true)
    const reader = createCredentialStore(sp())
    expect(reader.resolve('a')).toBe('va')
    const writer = createCredentialStore(sp())
    expect((await writer.set('b', 'vb', 'launch-env')).applied).toBe(true)
    expect(writer.resolve('a')).toBe('va')
    expect(reader.resolve('b')).toBe('vb')
    expect(reader.status()).toEqual({ ok: true })
    expect(reader.list().entries.map((entry) => entry.name).sort()).toEqual(['a', 'b'])
  })
})
