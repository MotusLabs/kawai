// Admission-equivalence proofs for the credential store's duplicated name
// grammars (design D1, provider-relay-setup): the store-wide launch-env rule
// must admit exactly what the legacy chatProviderEnv boundary admits, and the
// secret-source rule must admit exactly what the catalog binding boundary
// admits — pinned through the REAL public boundaries (validateChatProviderEnv,
// parseProviderCatalogValue), never by restating either regex here. The
// separated cap roundtrips pin the scenario's "no new entry-count or
// value-length cap" against the legacy boundary that does cap.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as realFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createCredentialStore,
  CredentialStoreError,
  type CredentialFsDeps,
} from '../chat/credentialStore'
import { validateChatProviderEnv } from '../chat/chatProviderEnv'
import { parseProviderCatalogValue } from '../chat/catalogParse'

let root: string

beforeEach(() => {
  root = realFs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cred-equiv-'))
})

afterEach(() => {
  realFs.rmSync(root, { recursive: true, force: true })
})

const countReads = (counter: { reads: number }) =>
  ({
    readSync: (fd: number, buf: Buffer, off: number, len: number, pos: number | null): number => {
      counter.reads += 1
      return realFs.readSync(fd, buf, off, len, pos)
    },
  }) as unknown as Partial<CredentialFsDeps>

// Probes straddling both grammars: accepted mixed-case legacy shapes, leading
// underscores, digits-first, separators, whitespace, empty, dots.
const TABLE_A_PROBES = [
  'http_proxy', 'HTTP_PROXY', '_x', 'a1_B', 'A', '_', '1abc', 'a-b', 'a b',
  '', 'a.b', 'A-B', '9_lives',
]

describe('store admission equivalence', () => {
  test('store-wide admission matches the legacy Settings boundary', async () => {
    // An absent parent makes reclassify a pure admission probe: admitted
    // names are no-ops after the parent stat, refused names never touch the
    // filesystem — and nothing here may create the parent.
    const store = createCredentialStore(path.join(root, 'absent', 'credentials.json'))
    for (const name of TABLE_A_PROBES) {
      const legacy = validateChatProviderEnv({ [name]: 'v' })
      let storeAdmits: boolean
      try {
        const outcome = await store.reclassify(name, 'launch-env')
        expect(outcome).toEqual({ applied: false, durable: false })
        storeAdmits = true
      } catch (err) {
        expect((err as CredentialStoreError).code).toBe('invalid-name')
        storeAdmits = false
      }
      expect({ probe: name, storeAdmits, legacyOk: legacy.ok }).toEqual(
        { probe: name, storeAdmits, legacyOk: storeAdmits },
      )
    }
    expect(realFs.existsSync(path.join(root, 'absent'))).toBe(false)
  })

  // Uppercase catalog shapes (leading underscore included — the catalog
  // grammar admits it), lowercase variants, digits-first, separators,
  // whitespace, empty, dots.
  const TABLE_B_PROBES = [
    'API_KEY', 'A_1', '_X', 'A', '_', 'X9_0', 'ApiKey', 'api_key', '1A',
    'A-B', 'A B', '', 'A.B',
  ]

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Secret sources require catalog-compatible names
  test('secret-source admission matches the catalog binding boundary', async () => {
    // Absent parent: reclassify is a pure ADMISSION probe — admitted names
    // no-op after the parent stat, refusals throw before any filesystem
    // access, the parent is never created, and the recording collaborator
    // is never invoked because the op body never runs.
    const names: string[] = []
    const store = createCredentialStore(path.join(root, 'absent-b', 'credentials.json'), {
      retainSecretNames: { retainSecretName: (name: string) => { names.push(name) } },
    })
    // Expected-tuple oracle: the TWO public validation boundaries own the
    // classification — validateChatProviderEnv owns launch admission,
    // parseProviderCatalogValue owns secret admission — and the store must
    // realize exactly the outcome tuple each probe's class predicts. No
    // expected verdict is derived from a store error or admission, from a
    // private helper, or from the other boundary; neither regex is restated.
    type ExpectedClass = 'both' | 'launch-only' | 'refused'
    const counts: Record<ExpectedClass, number> = { both: 0, 'launch-only': 0, refused: 0 }
    const seen: Record<ExpectedClass, string[]> = { both: [], 'launch-only': [], refused: [] }
    for (const name of TABLE_B_PROBES) {
      const launchAdmits = validateChatProviderEnv({ [name]: 'v' }).ok
      const secretAdmits = parseProviderCatalogValue(
        { probe: { authTokenEnv: name } }, 'equivalence', true,
      ).ok
      // Catalog-only (catalog-true, legacy-false) must be absent for these
      // probes: fail explicitly, before any store call, if it ever appears.
      if (!launchAdmits && secretAdmits) {
        throw new Error(`unexpected catalog-only probe: ${JSON.stringify(name)}`)
      }
      const expected: ExpectedClass =
        launchAdmits && secretAdmits ? 'both' : launchAdmits ? 'launch-only' : 'refused'
      counts[expected] += 1
      seen[expected].push(name)
      // Capture-only catch: each try wraps ONLY the real store call; every
      // assertion about the captured outcome runs outside it, so a failed
      // assertion can never be swallowed and reinterpreted as a refusal.
      let secretOutcome: { applied: boolean; durable: boolean } | null = null
      let secretError: unknown = null
      try {
        secretOutcome = await store.reclassify(name, 'secret-source')
      } catch (err) {
        secretError = err
      }
      let launchOutcome: { applied: boolean; durable: boolean } | null = null
      let launchError: unknown = null
      try {
        launchOutcome = await store.reclassify(name, 'launch-env')
      } catch (err) {
        launchError = err
      }
      if (expected === 'refused') {
        expect({ probe: name, secretOutcome, launchOutcome }).toEqual({
          probe: name, secretOutcome: null, launchOutcome: null,
        })
        expect(secretError).toBeInstanceOf(CredentialStoreError)
        expect(launchError).toBeInstanceOf(CredentialStoreError)
        expect((secretError as CredentialStoreError).code).toBe('invalid-name')
        expect((launchError as CredentialStoreError).code).toBe('invalid-name')
      } else if (expected === 'launch-only') {
        expect({ probe: name, secretOutcome }).toEqual({ probe: name, secretOutcome: null })
        expect(secretError).toBeInstanceOf(CredentialStoreError)
        expect((secretError as CredentialStoreError).code).toBe('name-not-catalog')
        expect(launchError).toBeNull()
        expect(launchOutcome).toEqual({ applied: false, durable: false })
      } else {
        expect({ probe: name, secretOutcome, launchOutcome }).toEqual({
          probe: name,
          secretOutcome: { applied: false, durable: false },
          launchOutcome: { applied: false, durable: false },
        })
        expect(secretError).toBeNull()
        expect(launchError).toBeNull()
      }
    }
    // The public authorities' classification of the 13 fixed witnesses and
    // the completed case accounting: 6 both-admit, 2 launch-only, 5 refused,
    // 0 catalog-only — every probe ran, none was skipped.
    expect(TABLE_B_PROBES).toHaveLength(13)
    expect(counts).toEqual({ both: 6, 'launch-only': 2, refused: 5 })
    expect(counts.both + counts['launch-only'] + counts.refused).toBe(13)
    expect(seen.both).toEqual(['API_KEY', 'A_1', '_X', 'A', '_', 'X9_0'])
    expect(seen['launch-only']).toEqual(['ApiKey', 'api_key'])
    expect(seen.refused).toEqual(['1A', 'A-B', 'A B', '', 'A.B'])
    expect(names).toEqual([])
    expect(realFs.existsSync(path.join(root, 'absent-b'))).toBe(false)
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Legacy launch-env names are preserved
  test('a 33-entry document round-trips with disjoint preservation', async () => {
    const storePath = path.join(root, 'caps', 'credentials.json')
    const priming = createCredentialStore(storePath)
    const legacyMap: Record<string, string> = {}
    for (let i = 0; i < 33; i++) {
      const name = `cap_entry_${String(i).padStart(3, '0')}`
      legacyMap[name] = `value-${i}`
      expect(await priming.set(name, `value-${i}`, 'launch-env')).toEqual({
        applied: true,
        durable: true,
      })
    }
    // The legacy boundary caps at 32 entries — the store must not.
    expect(validateChatProviderEnv(legacyMap).ok).toBe(false)
    // The 34th write's fresh in-queue read must be a REAL descriptor read of
    // the whole 33-entry document — not a stamp-cache hit, not a truncated
    // parse that silently drops entries.
    const counter = { reads: 0 }
    const reader = createCredentialStore(storePath, { deps: countReads(counter) })
    expect(await reader.set('cap_entry_disjoint_033', 'value-33', 'launch-env')).toEqual({
      applied: true,
      durable: true,
    })
    expect(counter.reads).toBeGreaterThan(0)
    const listed = createCredentialStore(storePath).list()
    expect(listed.status).toEqual({ ok: true })
    expect(listed.entries).toHaveLength(34)
    const verifier = createCredentialStore(storePath)
    for (let i = 0; i < 33; i++) {
      expect(verifier.resolve(`cap_entry_${String(i).padStart(3, '0')}`)).toBe(`value-${i}`)
    }
    expect(verifier.resolve('cap_entry_disjoint_033')).toBe('value-33')
  })

  // @covers: provider-credentials › Imported credentials live in the server-owned store › Legacy launch-env names are preserved
  test('a 5000-character value round-trips byte-for-byte with disjoint preservation', async () => {
    const storePath = path.join(root, 'caps-b', 'credentials.json')
    const store = createCredentialStore(storePath)
    expect(await store.set('sentinel_small', 's', 'launch-env')).toEqual({
      applied: true,
      durable: true,
    })
    const bigValue = 'x'.repeat(2500) + 'Y'.repeat(2499) + 'z'
    expect(bigValue).toHaveLength(5000)
    // The legacy boundary caps values at 4096 characters — the store must not.
    expect(validateChatProviderEnv({ big_value: bigValue }).ok).toBe(false)
    expect(await store.set('big_value', bigValue, 'launch-env')).toEqual({
      applied: true,
      durable: true,
    })
    // The next write's fresh read must actually re-read the stored big value
    // from disk — parsed whole, untruncated by any length cap.
    const counter = { reads: 0 }
    const reader = createCredentialStore(storePath, { deps: countReads(counter) })
    expect(await reader.set('post_big_sibling', 'p', 'launch-env')).toEqual({
      applied: true,
      durable: true,
    })
    expect(counter.reads).toBeGreaterThan(0)
    const verifier = createCredentialStore(storePath)
    expect(verifier.resolve('sentinel_small')).toBe('s')
    expect(verifier.resolve('big_value')).toBe(bigValue)
    expect(verifier.resolve('post_big_sibling')).toBe('p')
    const parsed = JSON.parse(realFs.readFileSync(storePath, 'utf8')) as {
      entries: Record<string, { kind: string; value: string }>
    }
    expect(parsed.entries.big_value.value).toBe(bigValue)
    expect(Object.keys(parsed.entries).sort()).toEqual([
      'big_value', 'post_big_sibling', 'sentinel_small',
    ])
  })
})
