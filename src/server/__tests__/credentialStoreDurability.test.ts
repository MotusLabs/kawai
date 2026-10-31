// Durability proofs for the credential store's real-directory chain
// confirmation (design D1, provider-relay-setup): every renamed write must
// confirm the store directory's whole real ancestor chain up to the
// filesystem root before reporting durable — whatever lexical spelling or
// symlink reached it, including a parent chain that predates the process —
// and any required confirmation failure leaves the write applied but not
// durable, with no ancestor substituted. Faults and records use fstat(fd)
// identities (dev:ino, never fd numbers) inside the fsync seam; the expected
// target set is derived from kernel-resolved '<dir>/..' fixture geometry,
// independent of the implementation's own walk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as realFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createCredentialStore,
  CredentialStoreError,
  type CredentialFsDeps,
} from '../chat/credentialStore'

const isRoot = (): boolean =>
  typeof process.geteuid === 'function' && process.geteuid() === 0

let root: string
const extras: string[] = []

beforeEach(() => {
  root = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-dur-'))
})

afterEach(() => {
  for (const dir of extras.reverse()) {
    realFs.chmodSync(dir, 0o700)
    realFs.rmSync(dir, { recursive: true, force: true })
  }
  extras.length = 0
  realFs.rmSync(root, { recursive: true, force: true })
})

interface FsyncRecord {
  /** dev:ino of every directory fd that reached fsync. */
  dirs: Set<string>
  /** Count of non-directory (file data) fsyncs. */
  files: number
}

const newRecord = (): FsyncRecord => ({ dirs: new Set(), files: 0 })

const idOf = (st: { dev: number; ino: number }): string => `${st.dev}:${st.ino}`

const statId = (p: string): { dev: number; ino: number } => {
  const st = realFs.statSync(p)
  return { dev: st.dev, ino: st.ino }
}

const dirIdentity = (p: string): string => idOf(statId(p))

type Fault = { dev: number; ino: number } | null

/** Recording fsync seam: directory fds are logged by fstat identity before
 * any injected throw, so a short-circuit still shows the failed target. */
const recordingDeps = (record: FsyncRecord, fault: Fault): Partial<CredentialFsDeps> => ({
  fsyncSync: (fd: number) => {
    const st = realFs.fstatSync(fd)
    if (st.isDirectory()) {
      record.dirs.add(idOf(st))
      if (fault && st.dev === fault.dev && st.ino === fault.ino) {
        throw new Error('injected directory fsync failure')
      }
    } else {
      record.files += 1
    }
    return realFs.fsyncSync(fd)
  },
})

const subsetOf = (subset: Set<string>, of: Set<string>): boolean => {
  for (const id of subset) if (!of.has(id)) return false
  return true
}

/** Expected confirmation targets, derived from the KERNEL not from the
 * implementation: stat('<D>/..') walking up from the store's parent. The raw
 * `${dir}/..` string reaches statSync UNNORMALIZED, so the kernel resolves
 * each '..' AFTER any symlink — the set is the store directory's REAL
 * ancestor chain, root included, and a symlink's lexical parent appears only
 * if it is genuinely on that chain. path.join/resolve would normalize
 * lexically and yield the wrong (lexical) parent. */
const kernelChain = (storePath: string): Set<string> => {
  const expected = new Set<string>()
  let dir = path.dirname(storePath)
  expected.add(idOf(realFs.statSync(dir)))
  for (;;) {
    const up = `${dir}/..`
    const upId = idOf(realFs.statSync(up))
    if (expected.has(upId)) return expected // fixed point: same id as previous
    expected.add(upId)
    dir = up
  }
}

describe('credential store durability: real-directory chain confirmation', () => {
  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('an exact store-directory fsync fault reports applied but not durable', async () => {
    const dir = path.join(root, 'd')
    realFs.mkdirSync(dir, 0o700)
    const storePath = path.join(dir, 'credentials.json')
    const rec = newRecord()
    const store = createCredentialStore(storePath, {
      deps: recordingDeps(rec, statId(dir)),
    })
    expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: false })
    expect(rec.dirs.has(dirIdentity(dir))).toBe(true)
    expect(subsetOf(rec.dirs, kernelChain(storePath))).toBe(true)
    expect(rec.files).toBe(1)
    // No rollback, no retry: the new content stands.
    expect(createCredentialStore(storePath).resolve('a')).toBe('v1')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a write creating a multi-level parent confirms the whole real chain', async () => {
    const storePath = path.join(root, 'p', 'q', 'credentials.json')
    const rec = newRecord()
    const store = createCredentialStore(storePath, { deps: recordingDeps(rec, null) })
    expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: true })
    expect(rec.dirs).toEqual(kernelChain(storePath))
    expect(rec.files).toBe(1)
    expect(realFs.statSync(path.join(root, 'p', 'q')).mode & 0o777).toBe(0o700)
    expect(realFs.statSync(storePath).mode & 0o777).toBe(0o600)
    expect(createCredentialStore(storePath).resolve('a')).toBe('v1')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a restart-visible parent chain is still confirmed before durable', async () => {
    const storePath = path.join(root, 'p', 'q', 'credentials.json')
    realFs.mkdirSync(path.join(root, 'p', 'q'), { recursive: true, mode: 0o700 })
    // Fresh factory, fault at the chain's home directory: visibility to this
    // process must not stand in for confirmation (the prior process's fsync
    // of the home entry never happened).
    const rec = newRecord()
    const store = createCredentialStore(storePath, {
      deps: recordingDeps(rec, statId(root)),
    })
    expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: false })
    expect(rec.dirs.has(dirIdentity(root))).toBe(true)
    expect(subsetOf(rec.dirs, kernelChain(storePath))).toBe(true)
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a lexically normalized multi-component path confirms the real chain', async () => {
    // path.resolve in createCredentialStore normalizes x/.. away before any
    // fs access, so this is a plain-chain control, not alias evidence.
    const real = path.join(root, 'd')
    realFs.mkdirSync(real, 0o700)
    realFs.mkdirSync(path.join(root, 'x'), 0o700)
    const storePath = path.join(root, 'x', '..', 'd', 'credentials.json')
    const rec = newRecord()
    const store = createCredentialStore(storePath, { deps: recordingDeps(rec, null) })
    expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: true })
    expect(rec.dirs).toEqual(kernelChain(storePath))
    expect(createCredentialStore(path.join(real, 'credentials.json')).resolve('a')).toBe('v1')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a symlinked store directory confirms the real chain, not the lexical parent', async () => {
    const root2 = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-dur-b-'))
    extras.push(root2)
    const real = path.join(root2, 'd')
    realFs.mkdirSync(real, 0o700)
    realFs.symlinkSync(path.join(root2, 'd'), path.join(root, 'link'), 'dir')
    const storePath = path.join(root, 'link', 'credentials.json')
    const rec = newRecord()
    const store = createCredentialStore(storePath, { deps: recordingDeps(rec, null) })
    expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: true })
    expect(rec.dirs).toEqual(kernelChain(storePath))
    // The link's lexical parent is outside the real chain: never confirmed.
    expect(rec.dirs.has(dirIdentity(root))).toBe(false)
    expect(createCredentialStore(path.join(real, 'credentials.json')).resolve('a')).toBe('v1')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a fault at a symlink target parent reports applied but not durable', async () => {
    const root2 = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-dur-c-'))
    extras.push(root2)
    const real = path.join(root2, 'd')
    realFs.mkdirSync(real, 0o700)
    realFs.symlinkSync(path.join(root2, 'd'), path.join(root, 'link'), 'dir')
    const storePath = path.join(root, 'link', 'credentials.json')
    const rec = newRecord()
    const store = createCredentialStore(storePath, {
      deps: recordingDeps(rec, statId(root2)),
    })
    expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: false })
    expect(rec.dirs.has(dirIdentity(root2))).toBe(true)
    expect(subsetOf(rec.dirs, kernelChain(storePath))).toBe(true)
    expect(rec.dirs.has(dirIdentity(root))).toBe(false)
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a 0300 ancestor above a created parent leaves the write applied but not durable', async () => {
    if (isRoot()) {
      return // stated skip: root bypasses directory permissions, so the fault cannot be produced
    }
    const sub = path.join(root, 'sub')
    const storePath = path.join(sub, 'credentials.json')
    realFs.chmodSync(root, 0o300) // parent creatable (w+x), confirmation-open impossible (no r)
    try {
      const rec = newRecord()
      const store = createCredentialStore(storePath, { deps: recordingDeps(rec, null) })
      expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: false })
      // The created subdirectory was fsynced BEFORE the 0300 ancestor refused
      // its confirmation open (stat needs only +x on the 0300 root).
      expect(rec.dirs.has(dirIdentity(sub))).toBe(true)
      // The rename stands; only confirmation failed.
      expect(realFs.statSync(storePath).mode & 0o777).toBe(0o600)
      expect(createCredentialStore(storePath).resolve('a')).toBe('v1')
    } finally {
      realFs.chmodSync(root, 0o700)
    }
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a plain write into an existing parent confirms the whole chain', async () => {
    const storePath = path.join(root, 'credentials.json')
    const rec = newRecord()
    const store = createCredentialStore(storePath, { deps: recordingDeps(rec, null) })
    expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: true })
    expect(rec.dirs).toEqual(kernelChain(storePath))
    expect(rec.files).toBe(1)
    expect(createCredentialStore(storePath).resolve('a')).toBe('v1')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a pre-created multi-level parent is confirmed all the same', async () => {
    const storePath = path.join(root, 'p', 'q', 'credentials.json')
    realFs.mkdirSync(path.join(root, 'p', 'q'), { recursive: true, mode: 0o700 })
    const rec = newRecord()
    const store = createCredentialStore(storePath, { deps: recordingDeps(rec, null) })
    expect(await store.set('a', 'v1', 'launch-env')).toEqual({ applied: true, durable: true })
    expect(rec.dirs).toEqual(kernelChain(storePath))
    expect(createCredentialStore(storePath).resolve('a')).toBe('v1')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('clear confirms the whole chain it makes durable', async () => {
    const storePath = path.join(root, 'credentials.json')
    await createCredentialStore(storePath).set('a', 'v1', 'launch-env')
    const rec = newRecord()
    const clearing = createCredentialStore(storePath, { deps: recordingDeps(rec, null) })
    expect(await clearing.clear('a')).toEqual({ applied: true, durable: true })
    expect(rec.dirs).toEqual(kernelChain(storePath))
    expect(rec.files).toBe(1)
    expect(createCredentialStore(storePath).resolve('a')).toBeUndefined()
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('reclassify confirms the whole chain it makes durable, value preserved', async () => {
    const storePath = path.join(root, 'credentials.json')
    await createCredentialStore(storePath).set('A', 'v1', 'launch-env')
    const rec = newRecord()
    const retainCalls: string[] = []
    const store = createCredentialStore(storePath, {
      retainSecretNames: { retainSecretName: (name) => { retainCalls.push(name) } },
      deps: recordingDeps(rec, null),
    })
    expect(await store.reclassify('A', 'secret-source')).toEqual({
      applied: true,
      durable: true,
    })
    expect(retainCalls).toEqual(['A'])
    expect(rec.dirs).toEqual(kernelChain(storePath))
    expect(createCredentialStore(storePath).resolve('A')).toBe('v1')
    expect(createCredentialStore(storePath).list().entries).toEqual([
      { name: 'A', kind: 'secret-source', state: 'set' },
    ])
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › A change that changes nothing writes nothing
  test('a clear that changes nothing performs no fsync at all', async () => {
    const storePath = path.join(root, 'credentials.json')
    const rec = newRecord()
    const store = createCredentialStore(storePath, { deps: recordingDeps(rec, null) })
    expect(await store.clear('a')).toEqual({ applied: false, durable: false })
    expect(rec.dirs.size).toBe(0)
    expect(rec.files).toBe(0)
    expect(realFs.existsSync(storePath)).toBe(false)
  })

  // @covers: provider-credentials › The credential UI is write-only › Errors carry fixed safe text only
  test('a post-mkdir stat failure refuses with the fixed text and writes nothing', async () => {
    // Fixed-text case: the stat after mkdir must sit inside the fixed-error
    // boundary — a raw, path-bearing error must never escape set().
    const sub = path.join(root, 'sub')
    const storePath = path.join(sub, 'credentials.json')
    const rec = newRecord()
    let armed = false
    const deps = {
      ...recordingDeps(rec, null),
      mkdirSync: (p: Parameters<typeof realFs.mkdirSync>[0], ...rest: unknown[]) => {
        const made = (realFs.mkdirSync as (...args: unknown[]) => unknown)(p, ...rest)
        if (p === sub) armed = true
        return made
      },
      statSync: (p: Parameters<typeof realFs.statSync>[0]) => {
        if (armed && p === sub) {
          const err = new Error(`EIO: stat failed: ${String(p)}`) as NodeJS.ErrnoException
          err.code = 'EIO'
          throw err
        }
        return realFs.statSync(p)
      },
    } as unknown as Partial<CredentialFsDeps>
    const store = createCredentialStore(storePath, { deps })
    let caught: unknown
    try {
      await store.set('a', 'v1', 'launch-env')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CredentialStoreError)
    const failure = caught as InstanceType<typeof CredentialStoreError>
    expect(failure.message).toBe('credential store: write-failed')
    expect(failure.code).toBe('write-failed')
    expect((failure as { cause?: unknown }).cause).toBeUndefined()
    expect(failure.message.includes(sub)).toBe(false)
    expect(realFs.existsSync(storePath)).toBe(false)
    // No temp file, no secret bytes: the created parent stays empty.
    expect(realFs.readdirSync(sub)).toEqual([])
    expect(rec.dirs.size).toBe(0)
    expect(rec.files).toBe(0)
  })
})

// The realpath step of the confirmation walk is required, not optional: the
// walk RESOLVES the store directory to its real location first, and its
// failure must report applied but not durable without any lexical ancestor
// substituted and without any directory open or fsync standing in for the
// unresolvable chain. The fault arms only after the real rename returns —
// the sole reachable call site — so every counted open/fsync below is
// strictly post-commit.
describe('required realpath failure after the rename', () => {
  /** Recorder seam: the rename really succeeds (counted once), then
   * realpathSync records its argument and throws; opens classify into
   * directory opens vs the store reload open only while renamed; directory
   * fsyncs count only while renamed. Everything else stays real node:fs. */
  const realpathFaultDeps = (storePath: string, fault: {
    renamed: boolean
    renameCount: number
    realpathCalls: string[]
    commitDirOpens: string[]
    storeReloadOpens: number
    commitDirFsyncs: number
  }): Partial<CredentialFsDeps> =>
    ({
      renameSync: (from: unknown, to: unknown) => {
        ;(realFs.renameSync as (...a: unknown[]) => void)(from, to)
        fault.renamed = true
        fault.renameCount += 1
      },
      realpathSync: (p: unknown) => {
        if (fault.renamed) {
          fault.realpathCalls.push(String(p))
          throw new Error('injected realpath failure')
        }
        return (realFs.realpathSync as (...a: unknown[]) => unknown)(p)
      },
      openSync: (target: unknown, flags: number, ...rest: unknown[]) => {
        const fd = (realFs.openSync as (...a: unknown[]) => number)(target, flags, ...rest)
        if (fault.renamed) {
          if (flags & realFs.constants.O_DIRECTORY) fault.commitDirOpens.push(String(target))
          else if (String(target) === storePath) fault.storeReloadOpens += 1
        }
        return fd
      },
      fsyncSync: (fd: number) => {
        if (fault.renamed && realFs.fstatSync(fd).isDirectory()) fault.commitDirFsyncs += 1
        return realFs.fsyncSync(fd)
      },
    }) as unknown as Partial<CredentialFsDeps>

  const newFault = () => ({
    renamed: false,
    renameCount: 0,
    realpathCalls: [] as string[],
    commitDirOpens: [] as string[],
    storeReloadOpens: 0,
    commitDirFsyncs: 0,
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('a realpath failure after the rename reports applied, not durable, substituting no ancestor', async () => {
    const dir = path.join(root, 'd')
    realFs.mkdirSync(dir, 0o700)
    const storePath = path.join(dir, 'credentials.json')
    const fault = newFault()
    const store = createCredentialStore(storePath, { deps: realpathFaultDeps(storePath, fault) })
    expect(await store.set('x', 'vx', 'launch-env')).toEqual({ applied: true, durable: false })
    // Exactly one rename; realpath was required of the store directory and
    // nothing else; no directory open or fsync substituted the unresolved
    // chain; the one post-rename store open is the verified reload.
    expect(fault.renameCount).toBe(1)
    expect(fault.realpathCalls).toEqual([dir])
    expect(fault.commitDirOpens).toEqual([])
    expect(fault.commitDirFsyncs).toBe(0)
    expect(fault.storeReloadOpens).toBe(1)
    // Asserted before any further public read: the new content stands, no
    // temp remains.
    const parsed = JSON.parse(realFs.readFileSync(storePath, 'utf8')) as {
      entries: Record<string, { kind: string; value: string }>
    }
    expect(parsed.entries.x).toEqual({ kind: 'launch-env', value: 'vx' })
    expect(realFs.readdirSync(dir)).toEqual(['credentials.json'])
    const fresh = createCredentialStore(storePath)
    expect(fresh.status()).toEqual({ ok: true })
    expect(fresh.resolve('x')).toBe('vx')
    expect(fresh.list().entries).toEqual([{ name: 'x', kind: 'launch-env', state: 'set' }])
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Applied and durable report separately
  test('the same realpath fault through reclassify reports applied, not durable', async () => {
    const dir = path.join(root, 'd2')
    const storePath = path.join(dir, 'credentials.json')
    // Seed with real deps, wholly outside the fault window; the pre-rename
    // in-queue read of the reclassify then happens before `renamed` is true,
    // so it is never counted as post-commit I/O.
    await createCredentialStore(storePath).set('PLAIN', 'p', 'launch-env')
    const retainCalls: string[] = []
    const fault = newFault()
    const store = createCredentialStore(storePath, {
      retainSecretNames: { retainSecretName: (name: string) => { retainCalls.push(name) } },
      deps: realpathFaultDeps(storePath, fault),
    })
    expect(await store.reclassify('PLAIN', 'secret-source')).toEqual({
      applied: true,
      durable: false,
    })
    expect(fault.renameCount).toBe(1)
    expect(fault.realpathCalls).toEqual([dir])
    expect(fault.commitDirOpens).toEqual([])
    expect(fault.commitDirFsyncs).toBe(0)
    expect(fault.storeReloadOpens).toBe(1)
    expect(retainCalls).toEqual(['PLAIN'])
    const parsed = JSON.parse(realFs.readFileSync(storePath, 'utf8')) as {
      entries: Record<string, { kind: string; value: string }>
    }
    expect(parsed.entries.PLAIN).toEqual({ kind: 'secret-source', value: 'p' })
    expect(realFs.readdirSync(dir)).toEqual(['credentials.json'])
    const fresh = createCredentialStore(storePath)
    expect(fresh.status()).toEqual({ ok: true })
    expect(fresh.resolve('PLAIN')).toBe('p')
    expect(fresh.list().entries).toEqual([{ name: 'PLAIN', kind: 'secret-source', state: 'set' }])
  })
})
