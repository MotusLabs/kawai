// Trust-gate proofs for the credential store's admission path (design D1,
// provider-relay-setup): every access — a cache hit included — passes the
// lstat security gates first; the gated read opens O_NOFOLLOW and
// re-identifies the descriptor via fstat before parsing; non-regular targets
// refuse without opening. Faults inject exactly ONE Stats field at a time on
// real files and real open descriptors through the factory's public deps
// seam; the real node:fs implementation always runs underneath.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as realFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createCredentialStore,
  CredentialStoreError,
  type CredentialFsDeps,
  type CredentialStoreCode,
} from '../chat/credentialStore'

let root: string

beforeEach(() => {
  root = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-gates-'))
})

afterEach(() => {
  realFs.rmSync(root, { recursive: true, force: true })
})

const sp = (): string => path.join(root, 'credentials.json')
const doc = (entries: string): string => `{"version":1,"entries":${entries}}`

function writeRaw(storePath: string, content: string, mode = 0o600): void {
  realFs.writeFileSync(storePath, content)
  realFs.chmodSync(storePath, mode)
}

const euid = (): number =>
  typeof process.geteuid === 'function' ? process.geteuid() : (process.getuid?.() ?? 0)
const foreignUid = euid() + 1

/** Prototype-preserving clone of a real Stats object with exactly the named
 * fields overridden: every other own property (identity, stamp, mode) and
 * all prototype methods behave exactly like the real instance. */
function cloneStatsWith(
  real: realFs.Stats,
  overrides: Partial<Pick<realFs.Stats, 'dev' | 'ino' | 'uid' | 'mode'>>,
): realFs.Stats {
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(real)),
    real,
  ) as realFs.Stats
  return Object.assign(clone, overrides)
}

/** The clone premise: apart from the INTENTIONALLY overridden fields the
 * clone is indistinguishable from the real Stats — same prototype, same
 * method results, same numerical identity/stamp/permission fields. Date
 * accessors construct a fresh Date per access, so instants are compared by
 * value, never by object reference. Each caller independently asserts the
 * intended value of every field it names in `overridden`. */
function assertCloneLikeReal(
  real: realFs.Stats,
  clone: realFs.Stats,
  overridden: ReadonlySet<string> = new Set(),
): void {
  expect(Object.getPrototypeOf(clone)).toBe(Object.getPrototypeOf(real))
  expect(clone.isFile()).toBe(real.isFile())
  expect(clone.isDirectory()).toBe(real.isDirectory())
  expect(clone.isSymbolicLink()).toBe(real.isSymbolicLink())
  const fields = [
    'dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'rdev', 'blksize', 'size',
    'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs',
  ] as const
  for (const field of fields) {
    if (overridden.has(field)) continue
    expect(clone[field]).toBe(real[field])
  }
  expect(clone.atime.getTime()).toBe(real.atime.getTime())
  expect(clone.mtime.getTime()).toBe(real.mtime.getTime())
  expect(clone.ctime.getTime()).toBe(real.ctime.getTime())
  expect(clone.birthtime.getTime()).toBe(real.birthtime.getTime())
}

interface Counts {
  storeOpens: number
  tmpOpens: number
  dirOpens: number
  reads: number
  renames: number
}

const zeroCounts = (): Counts => ({ storeOpens: 0, tmpOpens: 0, dirOpens: 0, reads: 0, renames: 0 })

/** Recording passthrough seam: every call still reaches the real node:fs.
 * Opens are classified by target — the exact store path, the '.tmp-' temp
 * prefix, or the O_DIRECTORY bit — never by flag presence alone. */
function countingDeps(storePath: string, counts: Counts, extra: Partial<CredentialFsDeps> = {}) {
  const openSync = (target: unknown, flags: number, ...rest: unknown[]): number => {
    if (flags & realFs.constants.O_DIRECTORY) counts.dirOpens += 1
    else if (String(target) === storePath) counts.storeOpens += 1
    else if (String(target).includes('.tmp-')) counts.tmpOpens += 1
    return (realFs.openSync as (...a: unknown[]) => number)(target, flags, ...rest)
  }
  const readSync = (fd: number, buf: Buffer, off: number, len: number, pos: number | null): number => {
    counts.reads += 1
    return realFs.readSync(fd, buf, off, len, pos)
  }
  const renameSync = (from: unknown, to: unknown): void => {
    counts.renames += 1
    return (realFs.renameSync as (...a: unknown[]) => void)(from, to)
  }
  return { openSync, readSync, renameSync, ...extra } as unknown as Partial<CredentialFsDeps>
}

async function expectCodeAsync(
  pending: Promise<unknown>,
  code: CredentialStoreCode,
  forbiddenValue?: string,
): Promise<void> {
  try {
    await pending
  } catch (err) {
    expect((err as CredentialStoreError).code).toBe(code)
    if (forbiddenValue !== undefined) {
      expect(String((err as CredentialStoreError).message)).not.toContain(forbiddenValue)
    }
    return
  }
  throw new Error(`expected CredentialStoreError ${code}`)
}

describe('trust gates', () => {
  // @covers: provider-credentials › Imported credentials live in the server-owned store › Gates precede any cached value
  test('a warmed cache never serves past a foreign owner', async () => {
    const counts = zeroCounts()
    // Prime through the public API: a real write caches the entry in the
    // shared per-file owner.
    const priming = createCredentialStore(sp())
    await priming.set('a', 'old', 'launch-env')
    const before = realFs.lstatSync(sp())
    expect(before.isFile()).toBe(true)
    const parentIdentity = realFs.statSync(root)
    // ONE instrumented reader for BOTH witnesses: a mutable arm flag flips
    // its own lstat seam from passthrough to the armed clone — the reader
    // instance never changes between the pre-fault cache-hit witness and
    // the post-fault refusal.
    let armed = false
    const armedClone = cloneStatsWith(realFs.lstatSync(sp()), { uid: foreignUid })
    const readerDeps = countingDeps(sp(), counts, {
      lstatSync: ((p: unknown) => {
        if (armed && String(p) === sp()) return armedClone
        return realFs.lstatSync(p as Parameters<typeof realFs.lstatSync>[0])
      }) as unknown as typeof realFs.lstatSync,
    })
    const reader = createCredentialStore(sp(), { deps: readerDeps })
    // Pre-fault witness on the SAME reader: a TRUE cache hit — the sentinel
    // returns with zero store opens/reads after the counters reset.
    expect(reader.resolve('a')).toBe('old')
    expect(reader.status()).toEqual({ ok: true })
    counts.storeOpens = 0
    counts.reads = 0
    expect(reader.resolve('a')).toBe('old')
    expect(counts.storeOpens).toBe(0)
    expect(counts.reads).toBe(0)
    // Arm: the OVERRIDDEN clone itself must be indistinguishable from a
    // fresh real Stats outside the single overridden uid field, and the
    // override must have actually taken.
    const fresh = realFs.lstatSync(sp())
    assertCloneLikeReal(fresh, armedClone, new Set(['uid']))
    expect(armedClone.uid).toBe(foreignUid)
    expect(armedClone.uid).not.toBe(fresh.uid)
    armed = true
    counts.storeOpens = 0
    counts.reads = 0
    // The warmed cache is refused on every surface BEFORE any open/read.
    expect(reader.status()).toEqual({ ok: false, reason: 'foreign-owner' })
    expect(reader.list()).toEqual({ status: { ok: false, reason: 'foreign-owner' }, entries: [] })
    expect(reader.resolve('a')).toBeUndefined()
    expect(counts.storeOpens).toBe(0)
    expect(counts.reads).toBe(0)
    // Mutation path through the SAME armed seam: no retention, no temp, no
    // rename, prior bytes standing, no value in the fixed error text.
    const names: string[] = []
    const mutating = createCredentialStore(sp(), {
      deps: readerDeps,
      retainSecretNames: {
        retainSecretName: (name: string) => {
          names.push(name)
        },
      },
    })
    const beforeBytes = realFs.readFileSync(sp())
    counts.tmpOpens = 0
    counts.renames = 0
    await expectCodeAsync(mutating.set('SECRET_X', 'vx', 'secret-source'), 'foreign-owner', 'vx')
    expect(names).toEqual([])
    expect(counts.tmpOpens).toBe(0)
    expect(counts.renames).toBe(0)
    expect(realFs.readFileSync(sp())).toEqual(beforeBytes)
    const after = realFs.lstatSync(sp())
    expect(after.dev).toBe(before.dev)
    expect(after.ino).toBe(before.ino)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(realFs.statSync(root).dev).toBe(parentIdentity.dev)
    expect(realFs.statSync(root).ino).toBe(parentIdentity.ino)
  })

  test('cold read opens O_NOFOLLOW and re-identifies', () => {
    writeRaw(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'v' } })))
    const storeOpenFlags: number[] = []
    const deps = {
      openSync: (target: unknown, flags: number, ...rest: unknown[]): number => {
        if (String(target) === sp()) storeOpenFlags.push(flags)
        return (realFs.openSync as (...a: unknown[]) => number)(target, flags, ...rest)
      },
    } as unknown as Partial<CredentialFsDeps>
    const store = createCredentialStore(sp(), { deps })
    expect(store.resolve('a')).toBe('v')
    // Exactly the store read open — temps are excluded by target, and none
    // occur on a read-only path.
    expect(storeOpenFlags.length).toBe(1)
    expect(storeOpenFlags[0] & realFs.constants.O_NOFOLLOW).toBe(realFs.constants.O_NOFOLLOW)
  })

  async function expectIdentityMismatchRefused(mode: 'dev' | 'ino'): Promise<void> {
    writeRaw(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'v' } })))
    const counts = zeroCounts()
    const other = path.join(root, 'other.json')
    writeRaw(other, doc(JSON.stringify({ b: { kind: 'launch-env', value: 'w' } })))
    const otherIno = realFs.lstatSync(other).ino
    const beforeBytes = realFs.readFileSync(sp())
    const deps = countingDeps(sp(), counts, {
      fstatSync: ((fd: number) => {
        const fst = realFs.fstatSync(fd)
        const mangled =
          mode === 'dev' ? cloneStatsWith(fst, { dev: fst.dev + 1 }) : cloneStatsWith(fst, { ino: otherIno })
        // The clone premise holds OUTSIDE the one intentionally overridden
        // identity field, so the production identity guard — not this
        // helper — produces the refusal.
        assertCloneLikeReal(fst, mangled, new Set([mode]))
        expect(mangled[mode]).not.toBe(fst[mode])
        return mangled
      }) as unknown as typeof realFs.fstatSync,
    })
    // Cold public read: exact identity-changed refusal, nothing parsed.
    const cold = createCredentialStore(sp(), { deps })
    expect(cold.status()).toEqual({ ok: false, reason: 'identity-changed' })
    expect(cold.list()).toEqual({ status: { ok: false, reason: 'identity-changed' }, entries: [] })
    expect(cold.resolve('a')).toBeUndefined()
    expect(counts.storeOpens).toBeGreaterThan(0)
    expect(counts.reads).toBe(0)
    // Mutation reach: refusal before any temp/retain/rename, bytes standing.
    const names: string[] = []
    counts.tmpOpens = 0
    counts.renames = 0
    const mutating = createCredentialStore(sp(), {
      deps,
      retainSecretNames: {
        retainSecretName: (name: string) => {
          names.push(name)
        },
      },
    })
    await expectCodeAsync(mutating.set('SECRET_X', 'vx', 'secret-source'), 'identity-changed', 'vx')
    await expectCodeAsync(mutating.set('plain', 'v2', 'launch-env'), 'identity-changed')
    expect(names).toEqual([])
    expect(counts.tmpOpens).toBe(0)
    expect(counts.renames).toBe(0)
    expect(realFs.readFileSync(sp())).toEqual(beforeBytes)
  }

  test('fstat dev-only mismatch refuses before read', async () => {
    await expectIdentityMismatchRefused('dev')
  })

  test('fstat ino-only mismatch refuses before read', async () => {
    await expectIdentityMismatchRefused('ino')
  })

  test('reopened permissions mismatch refuses', () => {
    writeRaw(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'v' } })))
    const beforeBytes = realFs.readFileSync(sp())
    const counts = zeroCounts()
    const deps = countingDeps(sp(), counts, {
      fstatSync: ((fd: number) => {
        const fst = realFs.fstatSync(fd)
        // Preserve the real mode's type bits; replace only the access bits.
        const clone = cloneStatsWith(fst, { mode: (fst.mode & ~0o777) | 0o644 })
        assertCloneLikeReal(fst, clone, new Set(['mode']))
        expect(clone.mode).toBe((fst.mode & ~0o777) | 0o644)
        return clone
      }) as unknown as typeof realFs.fstatSync,
    })
    const store = createCredentialStore(sp(), { deps })
    expect(store.status()).toEqual({ ok: false, reason: 'unsafe-permissions' })
    expect(store.list()).toEqual({ status: { ok: false, reason: 'unsafe-permissions' }, entries: [] })
    expect(store.resolve('a')).toBeUndefined()
    expect(counts.reads).toBe(0)
    expect(realFs.statSync(sp()).mode & 0o777).toBe(0o600)
    expect(realFs.readFileSync(sp())).toEqual(beforeBytes)
  })

  test('reopened foreign owner refuses', () => {
    writeRaw(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'v' } })))
    const beforeBytes = realFs.readFileSync(sp())
    const counts = zeroCounts()
    const deps = countingDeps(sp(), counts, {
      fstatSync: ((fd: number) => {
        const fst = realFs.fstatSync(fd)
        const clone = cloneStatsWith(fst, { uid: foreignUid })
        assertCloneLikeReal(fst, clone, new Set(['uid']))
        expect(clone.uid).toBe(foreignUid)
        return clone
      }) as unknown as typeof realFs.fstatSync,
    })
    const store = createCredentialStore(sp(), { deps })
    expect(store.status()).toEqual({ ok: false, reason: 'foreign-owner' })
    expect(store.list()).toEqual({ status: { ok: false, reason: 'foreign-owner' }, entries: [] })
    // Without the reopened gate the value would be served here.
    expect(store.resolve('a')).toBeUndefined()
    expect(counts.reads).toBe(0)
    expect(realFs.readFileSync(sp())).toEqual(beforeBytes)
  })

  test('nonregular store path refuses without opening', async () => {
    realFs.mkdirSync(sp()) // a real directory AT the store path — safe, nonregular
    const counts = zeroCounts()
    const deps = countingDeps(sp(), counts)
    const store = createCredentialStore(sp(), { deps })
    expect(store.status()).toEqual({ ok: false, reason: 'not-regular-file' })
    expect(store.list()).toEqual({ status: { ok: false, reason: 'not-regular-file' }, entries: [] })
    expect(store.resolve('a')).toBeUndefined()
    expect(counts.storeOpens).toBe(0)
    expect(counts.reads).toBe(0)
    const names: string[] = []
    const mutating = createCredentialStore(sp(), {
      deps,
      retainSecretNames: {
        retainSecretName: (name: string) => {
          names.push(name)
        },
      },
    })
    await expectCodeAsync(mutating.set('a', 'v', 'launch-env'), 'not-regular-file')
    expect(names).toEqual([])
    expect(counts.tmpOpens).toBe(0)
    expect(realFs.statSync(sp()).isDirectory()).toBe(true)
  })
})
