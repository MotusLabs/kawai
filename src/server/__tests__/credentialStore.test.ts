// Focused proofs for the credential-store first filesystem path (design D1,
// provider-relay-setup). Real files, real modes, real atomic writes through
// the module's public API — no alternate writer. Controlled faults use the
// factory's narrow deps seam (a directory fsync that fails once) or real
// directory permissions (a 0500 parent, skipped under uid 0). The separated
// name-pattern equivalence tables pin the store-wide rule against the legacy
// chatProviderEnv grammar and the secret-source rule against the catalog
// binding grammar.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as realFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createCredentialStore,
  CredentialStoreError,
  defaultCredentialStorePath,
  type CredentialKind,
  type CredentialStoreCode,
} from '../chat/credentialStore'

let root: string

beforeEach(() => {
  root = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-credstore-'))
})

afterEach(() => {
  realFs.rmSync(root, { recursive: true, force: true })
})

const sp = () => path.join(root, 'credentials.json')

function writeRaw(storePath: string, content: string, mode = 0o600): void {
  realFs.writeFileSync(storePath, content)
  realFs.chmodSync(storePath, mode)
}

const doc = (entries: string): string => `{"version":1,"entries":${entries}}`

function recorder() {
  const names: string[] = []
  return {
    names,
    collaborator: {
      retainSecretName: (name: string) => {
        names.push(name)
      },
    },
  }
}

async function expectCodeAsync(pending: Promise<unknown>, code: CredentialStoreCode): Promise<void> {
  try {
    await pending
  } catch (err) {
    expect((err as CredentialStoreError).code).toBe(code)
    return
  }
  throw new Error(`expected CredentialStoreError ${code}`)
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('credential store factory', () => {
  test('inert construction and pure default path; reads never create the file', () => {
    expect(defaultCredentialStorePath()).toBe(
      path.join(os.homedir(), '.kawai', 'credentials.json'),
    )
    const store = createCredentialStore(sp())
    expect(realFs.existsSync(sp())).toBe(false)
    expect(store.status()).toEqual({ ok: false, reason: 'missing' })
    expect(store.resolve('any_var')).toBeUndefined()
    expect(store.list()).toEqual({ status: { ok: false, reason: 'missing' }, entries: [] })
    expect(realFs.existsSync(sp())).toBe(false)
  })
})

describe('launch-env roundtrip', () => {
  test('set, blank, unset, value-free listing, mixed-case name preserved on disk', async () => {
    const store = createCredentialStore(sp())
    expect(await store.set('http_proxy', 'http://p:1', 'launch-env')).toEqual({
      applied: true,
      durable: true,
    })
    expect(realFs.statSync(sp()).mode & 0o777).toBe(0o600)
    expect(store.resolve('http_proxy')).toBe('http://p:1')
    expect(store.resolve('unset_key')).toBeUndefined()
    await store.set('empty_var', '', 'launch-env')
    expect(store.resolve('empty_var')).toBe('')
    const listing = store.list()
    expect(listing.status).toEqual({ ok: true })
    expect(listing.entries).toContainEqual({
      name: 'http_proxy',
      kind: 'launch-env',
      state: 'set',
    })
    expect(listing.entries).toContainEqual({ name: 'empty_var', kind: 'launch-env', state: 'blank' })
    for (const entry of listing.entries) {
      expect(Object.keys(entry).sort()).toEqual(['kind', 'name', 'state'])
    }
    const parsed = JSON.parse(realFs.readFileSync(sp(), 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.entries.http_proxy).toEqual({ kind: 'launch-env', value: 'http://p:1' })
    expect(parsed.entries.empty_var.value).toBe('')
  })
})

describe('name admission', () => {
  const legacyOk = ['http_proxy', 'HTTP_PROXY', '_x', 'a1_B']
  test.each(legacyOk)('launch-env accepts the legacy name %s', async (name) => {
    const store = createCredentialStore(sp())
    expect((await store.set(name, 'v', 'launch-env')).applied).toBe(true)
    expect(store.resolve(name)).toBe('v')
  })

  const invalidAnywhere = ['1abc', 'a-b', 'a b', '', 'a.b']
  test.each(invalidAnywhere)('name %j is invalid for both kinds', async (name) => {
    const store = createCredentialStore(sp())
    await expectCodeAsync(store.set(name, 'v', 'launch-env'), 'invalid-name')
    await expectCodeAsync(store.set(name, 'v', 'secret-source'), 'invalid-name')
    expect(realFs.existsSync(sp())).toBe(false)
  })

  const catalogOnly = ['api_key', 'ApiKey', 'x9']
  test.each(catalogOnly)('secret-source refuses %j; launch-env accepts it unchanged', async (name) => {
    const { collaborator } = recorder()
    const store = createCredentialStore(sp(), { retainSecretNames: collaborator })
    await expectCodeAsync(store.set(name, 'v', 'secret-source'), 'name-not-catalog')
    expect((await store.set(name, 'v', 'launch-env')).applied).toBe(true)
  })

  const catalogOk = ['API_KEY', 'X_1', '_A']
  test.each(catalogOk)('secret-source accepts the catalog name %s', async (name) => {
    const { collaborator, names } = recorder()
    const store = createCredentialStore(sp(), { retainSecretNames: collaborator })
    expect((await store.set(name, 'v', 'secret-source')).applied).toBe(true)
    expect(names).toEqual([name])
  })
})

describe('NUL and malformed arguments refuse before any side effect', () => {
  test('NUL value, NUL secret value, invalid kind, invalid value type', async () => {
    const { collaborator, names } = recorder()
    const store = createCredentialStore(sp(), { retainSecretNames: collaborator })
    await store.set('a', 'a', 'launch-env')
    const before = realFs.readFileSync(sp())
    await expectCodeAsync(store.set('b', 'x\0y', 'launch-env'), 'value-nul')
    await expectCodeAsync(store.set('c', 'x\0', 'secret-source'), 'value-nul')
    await expectCodeAsync(
      store.set('d', 'v', 'weird' as unknown as CredentialKind),
      'invalid-kind',
    )
    await expectCodeAsync(
      store.set('e', 1 as unknown as string, 'launch-env'),
      'invalid-value',
    )
    expect(names).toEqual([])
    expect(realFs.readFileSync(sp())).toEqual(before)
  })
})

const malformedDocs: [string, string][] = [
  ['not json', '{oops'],
  ['array', '[1]'],
  ['wrong version', '{"version":2,"entries":{}}'],
  ['missing entries', '{"version":1}'],
  ['entries array', '{"version":1,"entries":[]}'],
  ['extra top key', '{"version":1,"entries":{},"x":1}'],
  ['entry not object', '{"version":1,"entries":{"A":1}}'],
  ['entry extra key', '{"version":1,"entries":{"A":{"kind":"launch-env","value":"v","x":1}}}'],
  ['entry missing value', '{"version":1,"entries":{"A":{"kind":"launch-env"}}}'],
  ['unknown kind', '{"version":1,"entries":{"A":{"kind":"other","value":"v"}}}'],
  ['non-string value', '{"version":1,"entries":{"A":{"kind":"launch-env","value":1}}}'],
  ['nul in stored value', '{"version":1,"entries":{"A":{"kind":"launch-env","value":"a\\u0000b"}}}'],
  ['invalid stored name', '{"version":1,"entries":{"1bad":{"kind":"launch-env","value":"v"}}}'],
  ['secret-source lowercase name', '{"version":1,"entries":{"api_key":{"kind":"secret-source","value":"v"}}}'],
]

describe('malformed documents are never salvaged; mutations refuse keeping bytes', () => {
  test.each(malformedDocs)('%s', async (_label, raw) => {
    writeRaw(sp(), raw)
    const store = createCredentialStore(sp())
    expect(store.status()).toEqual({ ok: false, reason: 'malformed' })
    await expectCodeAsync(store.set('b', 'v', 'launch-env'), 'malformed')
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(raw)
  })

  test('a valid mixed-case launch-env document is not malformed', () => {
    writeRaw(sp(), doc(JSON.stringify({ http_proxy: { kind: 'launch-env', value: 'p' } })))
    expect(createCredentialStore(sp()).status()).toEqual({ ok: true })
  })
})

describe('permissions', () => {
  test('0644 refuses read and mutation, never chmodded, bytes stand', async () => {
    const raw = doc(JSON.stringify({ a: { kind: 'launch-env', value: 'a' } }))
    writeRaw(sp(), raw, 0o644)
    const store = createCredentialStore(sp())
    expect(store.status()).toEqual({ ok: false, reason: 'unsafe-permissions' })
    await expectCodeAsync(store.set('b', 'v', 'launch-env'), 'unsafe-permissions')
    expect(realFs.statSync(sp()).mode & 0o777).toBe(0o644)
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(raw)
  })

  test('0400 reads, and an explicit set replaces it atomically with a fresh 0600', async () => {
    writeRaw(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'a' } })), 0o400)
    const store = createCredentialStore(sp())
    expect(store.resolve('a')).toBe('a')
    expect((await store.set('a', 'a2', 'launch-env')).durable).toBe(true)
    expect(realFs.statSync(sp()).mode & 0o777).toBe(0o600)
    expect(store.resolve('a')).toBe('a2')
  })

  test('a 0000 file is unreadable and mutations refuse', async () => {
    const raw = doc(JSON.stringify({ a: { kind: 'launch-env', value: 'a' } }))
    writeRaw(sp(), raw, 0o000)
    const store = createCredentialStore(sp())
    expect(store.status()).toEqual({ ok: false, reason: 'unreadable' })
    await expectCodeAsync(store.set('b', 'v', 'launch-env'), 'unreadable')
    realFs.chmodSync(sp(), 0o600)
    expect(realFs.readFileSync(sp(), 'utf8')).toBe(raw)
  })
})

describe('symlinked store path', () => {
  test('read and write refuse; the target is never followed', async () => {
    const target = path.join(root, 'target.json')
    writeRaw(target, 'do not follow')
    realFs.symlinkSync(target, sp())
    const store = createCredentialStore(sp())
    expect(store.status()).toEqual({ ok: false, reason: 'symlink' })
    await expectCodeAsync(store.set('a', 'v', 'launch-env'), 'symlink')
    expect(realFs.readFileSync(target, 'utf8')).toBe('do not follow')
  })
})

describe('gates precede any cached value', () => {
  test('a warmed cache never serves past a symlink or unsafe mode; edits reload', async () => {
    const store = createCredentialStore(sp())
    await store.set('a', 'old', 'launch-env')
    expect(store.resolve('a')).toBe('old')
    realFs.unlinkSync(sp())
    const target = path.join(root, 'target.json')
    writeRaw(target, 'x')
    realFs.symlinkSync(target, sp())
    expect(store.status()).toEqual({ ok: false, reason: 'symlink' })
    realFs.unlinkSync(sp())
    writeRaw(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'open' } })), 0o644)
    expect(store.status()).toEqual({ ok: false, reason: 'unsafe-permissions' })
    realFs.chmodSync(sp(), 0o600)
    realFs.writeFileSync(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'new' } })))
    expect(store.resolve('a')).toBe('new')
  })
})

describe('one owner per file across instances and stable parent aliases', () => {
  function aliasedDirs(): { dir: string; alias: string } {
    const dir = path.join(root, 'dirA')
    realFs.mkdirSync(dir)
    const alias = path.join(root, 'aliasA')
    realFs.symlinkSync(dir, alias)
    return { dir, alias }
  }

  test('mutations serialize: a held retain blocks a disjoint set through the alias', async () => {
    const { dir, alias } = aliasedDirs()
    const storePath = path.join(dir, 'credentials.json')
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = createCredentialStore(storePath, {
      retainSecretNames: {
        retainSecretName: async (name) => {
          events.push(`retain:${name}`)
          await gate
        },
      },
    })
    const b = createCredentialStore(path.join(alias, 'credentials.json'))
    const pa = a
      .set('SECRET_A', 'va', 'secret-source')
      .then(() => events.push('done:SECRET_A'))
    await until(() => events.includes('retain:SECRET_A'))
    expect(realFs.existsSync(storePath)).toBe(false)
    const pb = b.set('b_var', 'vb', 'launch-env').then(() => events.push('done:b_var'))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(events).toEqual(['retain:SECRET_A'])
    expect(realFs.existsSync(storePath)).toBe(false)
    release()
    await Promise.all([pa, pb])
    expect(events).toEqual(['retain:SECRET_A', 'done:SECRET_A', 'done:b_var'])
    expect(a.resolve('b_var')).toBe('vb')
    expect(b.resolve('SECRET_A')).toBe('va')
  })

  test('concurrent disjoint sets through both paths preserve both', async () => {
    const { dir, alias } = aliasedDirs()
    const a = createCredentialStore(path.join(dir, 'credentials.json'))
    const b = createCredentialStore(path.join(alias, 'credentials.json'))
    await Promise.all([
      a.set('one', '1', 'launch-env'),
      b.set('two', '2', 'launch-env'),
    ])
    expect(a.resolve('one')).toBe('1')
    expect(a.resolve('two')).toBe('2')
    expect(b.resolve('one')).toBe('1')
    expect(b.resolve('two')).toBe('2')
    const parsed = JSON.parse(realFs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'))
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.entries).sort()).toEqual(['one', 'two'])
  })
})

describe('failure boundaries around the commit point', () => {
  test('pre-rename fault: refusal keeps old bytes, cache, and leaves no temp', async () => {
    if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
      return // stated skip: root bypasses directory permissions, so the fault cannot be produced
    }
    const store = createCredentialStore(sp())
    await store.set('a', 'old', 'launch-env')
    const before = realFs.readFileSync(sp())
    const dir = path.dirname(sp())
    realFs.chmodSync(dir, 0o500)
    try {
      await expectCodeAsync(store.set('b', 'v', 'launch-env'), 'write-failed')
      expect(realFs.readFileSync(sp())).toEqual(before)
      expect(store.resolve('a')).toBe('old')
      expect(store.resolve('b')).toBeUndefined()
      expect(realFs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([])
    } finally {
      realFs.chmodSync(dir, 0o700)
    }
  })

  test('post-rename directory-fsync failure: applied, not durable, no retry, verified reload', async () => {
    const dirFds = new Set<number>()
    let dirFsyncAttempts = 0
    const deps = {
      openSync: (target: Parameters<typeof realFs.openSync>[0], flags: number, ...rest: unknown[]) => {
        const fd = (realFs.openSync as (...args: unknown[]) => number)(target, flags, ...rest)
        if (flags & realFs.constants.O_DIRECTORY) dirFds.add(fd)
        return fd
      },
      fsyncSync: (fd: number) => {
        if (dirFds.has(fd)) {
          dirFsyncAttempts += 1
          throw new Error('injected directory fsync failure')
        }
        realFs.fsyncSync(fd)
      },
    } as unknown as Partial<import('../chat/credentialStore').CredentialFsDeps>
    const store = createCredentialStore(sp(), { deps })
    const outcome = await store.set('x', 'vx', 'launch-env')
    expect(outcome).toEqual({ applied: true, durable: false })
    expect(dirFsyncAttempts).toBe(1)
    const parsed = JSON.parse(realFs.readFileSync(sp(), 'utf8'))
    expect(parsed.entries.x.value).toBe('vx')
    expect(store.resolve('x')).toBe('vx')
    expect(store.status()).toEqual({ ok: true })
  })
})

describe('required retain-name collaborator for secret-source', () => {
  test('missing collaborator refuses before any file change', async () => {
    const store = createCredentialStore(sp())
    await expectCodeAsync(
      store.set('SECRET_A', 'v', 'secret-source'),
      'retain-collaborator-required',
    )
    expect(realFs.existsSync(sp())).toBe(false)
  })

  test('throwing collaborator refuses with prior bytes standing', async () => {
    writeRaw(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'a' } })))
    const before = realFs.readFileSync(sp())
    const store = createCredentialStore(sp(), {
      retainSecretNames: {
        retainSecretName: () => {
          throw new Error('registry unavailable')
        },
      },
    })
    await expectCodeAsync(
      store.set('SECRET_B', 'v', 'secret-source'),
      'retain-collaborator-failed',
    )
    expect(realFs.readFileSync(sp())).toEqual(before)
    expect((await store.set('plain', 'v', 'launch-env')).applied).toBe(true)
  })

  test('retain runs before the credential file changes', async () => {
    writeRaw(sp(), doc(JSON.stringify({ a: { kind: 'launch-env', value: 'a' } })))
    let sawAtRetain = ''
    const store = createCredentialStore(sp(), {
      retainSecretNames: {
        retainSecretName: (name) => {
          const raw = realFs.readFileSync(sp(), 'utf8')
          sawAtRetain = JSON.parse(raw).entries[name] ? 'present' : 'absent'
        },
      },
    })
    expect((await store.set('SECRET_C', 'v', 'secret-source')).applied).toBe(true)
    expect(sawAtRetain).toBe('absent')
    expect(store.resolve('SECRET_C')).toBe('v')
  })
})

describe('missing parents', () => {
  test('first set creates the parent 0700 and the file 0600', async () => {
    const deep = path.join(root, 'p', 'q', 'credentials.json')
    const store = createCredentialStore(deep)
    expect(await store.set('a', 'a', 'launch-env')).toEqual({ applied: true, durable: true })
    expect(realFs.statSync(path.join(root, 'p', 'q')).mode & 0o777).toBe(0o700)
    expect(realFs.statSync(deep).mode & 0o777).toBe(0o600)
    expect(store.resolve('a')).toBe('a')
  })
})
