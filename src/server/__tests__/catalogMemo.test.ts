// The shared catalog resolution memo (catalog-resolution-cache D1–D2): Table K
// (which lookups share a key), Table E (LRU eviction), and Table N (the
// synchronous snapshot) from the design, one test per oracle id, counting
// resolutions through the memo's resolver seam and key work through statSync.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CatalogMemo, type CatalogEntry, catalogInputKey, providerOf, resolvedCatalog, withCatalogSnapshot } from '../chat/catalogMemo'
import { resolveProfileCatalog, type ProfileCatalog, type ProfileCatalogContext } from '../chat/profileCatalog'

let root: string
let home: string
let shipped: Pick<ProfileCatalogContext, 'imageDefaultPath' | 'imageDefaultProvidersPath'>

function write(dir: string, name: 'providers.json' | 'profiles.json', json: unknown): string {
  const file = path.join(dir, '.kawai', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(json))
  return file
}

/** A memo over the real resolver that counts resolutions. */
function countingMemo(limit?: number): { memo: CatalogMemo; resolutions: () => number } {
  let count = 0
  const memo = new CatalogMemo(ctx => {
    count++
    return resolveProfileCatalog(ctx)
  }, limit)
  return { memo, resolutions: () => count }
}

/** Bumps a file's mtime by whole seconds so the stamp changes on any filesystem. */
function bump(file: string, seconds = 5): void {
  const stat = fs.statSync(file)
  const at = new Date(stat.mtimeMs + seconds * 1000)
  fs.utimesSync(file, at, at)
}

const ctx = (projectPath: string, extra: Partial<ProfileCatalogContext> = {}): ProfileCatalogContext => ({
  homeDir: home,
  serverCodexHome: path.join(root, 'codex-home'),
  projectPath,
  ...shipped,
  ...extra,
})

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-catalog-memo-')))
  home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  // Shipped fixtures stand in for the image defaults, so no test reads the real ones.
  const shippedDir = path.join(root, 'shipped')
  shipped = {
    imageDefaultProvidersPath: write(shippedDir, 'providers.json', {}),
    imageDefaultPath: write(shippedDir, 'profiles.json', { default: { label: 'Default' } }),
  }
  write(path.join(root, 'work'), 'profiles.json', { glm: { label: 'GLM', model: 'opus' } })
  for (const dir of ['a', 'b', 'a/deep']) fs.mkdirSync(path.join(root, 'work', dir), { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Table K — memo key', () => {
  test('K1: another project path under the same .kawai directories shares one resolution', () => {
    const { memo, resolutions } = countingMemo()
    const first = memo.get(ctx(path.join(root, 'work', 'a')))
    const second = memo.get(ctx(path.join(root, 'work', 'b')))
    expect(resolutions()).toBe(1)
    expect(second).toBe(first)
    expect(catalogInputKey(ctx(path.join(root, 'work', 'a')))).toBe(catalogInputKey(ctx(path.join(root, 'work', 'b'))))
  })

  test('K2: a project path that reaches an extra .kawai file resolves again', () => {
    write(path.join(root, 'work', 'a'), 'profiles.json', { mimo: { label: 'MiMo' } })
    const { memo, resolutions } = countingMemo()
    memo.get(ctx(path.join(root, 'work', 'b')))
    const deep = memo.get(ctx(path.join(root, 'work', 'a', 'deep')))
    expect(resolutions()).toBe(2)
    expect(deep.catalog.profiles.has('mimo')).toBe(true)
  })

  test('K3: an edited catalog file (mtime or size) resolves again', () => {
    const file = path.join(root, 'work', '.kawai', 'profiles.json')
    const { memo, resolutions } = countingMemo()
    const at = ctx(path.join(root, 'work', 'a'))
    memo.get(at)
    bump(file)
    memo.get(at)
    expect(resolutions()).toBe(2)
    fs.writeFileSync(file, JSON.stringify({ glm: { label: 'GLM 5', model: 'opus' } }))
    bump(file, 10)
    expect(memo.get(at).catalog.profiles.get('glm')?.label).toBe('GLM 5')
    expect(resolutions()).toBe(3)
  })

  test('K4: a catalog file created where none existed resolves again', () => {
    const { memo, resolutions } = countingMemo()
    const at = ctx(path.join(root, 'work', 'a'))
    memo.get(at)
    write(path.join(root, 'work', 'a'), 'providers.json', { zai: { label: 'Z.AI', models: { 'glm-flash': {} } } })
    expect(memo.get(at).catalog.profiles.get('glm-flash')?.providerId).toBe('zai')
    expect(resolutions()).toBe(2)
  })

  test('K5: a deleted catalog file resolves again', () => {
    const { memo, resolutions } = countingMemo()
    const at = ctx(path.join(root, 'work', 'a'))
    expect(memo.get(at).catalog.profiles.has('glm')).toBe(true)
    fs.rmSync(path.join(root, 'work', '.kawai', 'profiles.json'))
    expect(memo.get(at).catalog.profiles.has('glm')).toBe(false)
    expect(resolutions()).toBe(2)
  })

  test('K6: a user-level file appearing replaces the shipped defaults and resolves again', () => {
    const { memo, resolutions } = countingMemo()
    const at = ctx(path.join(root, 'work', 'a'))
    expect(memo.get(at).catalog.profiles.get('default')?.label).toBe('Default')
    write(home, 'profiles.json', { default: { label: 'Mine' } })
    expect(memo.get(at).catalog.profiles.get('default')?.label).toBe('Mine')
    expect(resolutions()).toBe(2)
  })

  test('K7: a changed HOME or CODEX_HOME resolves again', () => {
    write(home, 'profiles.json', { codex: { label: 'Codex', runtime: 'codex', model: 'gpt-5.3-codex' } })
    const otherHome = path.join(root, 'home2')
    fs.cpSync(home, otherHome, { recursive: true, preserveTimestamps: true })
    const { memo, resolutions } = countingMemo()
    const project = path.join(root, 'work', 'a')
    const first = memo.get(ctx(project)).catalog.profiles.get('codex')?.providerId
    const codexMoved = memo.get(ctx(project, { serverCodexHome: path.join(root, 'codex-other') })).catalog.profiles.get('codex')?.providerId
    expect(resolutions()).toBe(2)
    expect(codexMoved).not.toBe(first)
    memo.get(ctx(project, { homeDir: otherHome }))
    expect(resolutions()).toBe(3)
  })

  test('K8: the same path with the same files and no edit shares one resolution', () => {
    const { memo, resolutions } = countingMemo()
    const at = ctx(path.join(root, 'work', 'a'))
    const first = memo.get(at)
    expect(memo.get(at)).toBe(first)
    expect(memo.get({ ...at })).toBe(first)
    expect(resolutions()).toBe(1)
  })
})

describe('Table E — eviction', () => {
  const stub = (): { memo: CatalogMemo; resolved: string[] } => {
    const resolved: string[] = []
    const memo = new CatalogMemo(c => {
      resolved.push(c.homeDir ?? '')
      return { profiles: new Map(), providers: new Map(), merged: new Map(), credentialNames: new Set(), errors: [] } satisfies ProfileCatalog
    })
    return { memo, resolved }
  }
  // Distinct (missing) homes give distinct keys without touching the disk.
  const keyed = (i: number): ProfileCatalogContext => ({ ...shipped, homeDir: path.join(root, `h${i}`), serverCodexHome: '' })

  test('E1: 65 distinct keys, then the first: the first resolves again (evicted)', () => {
    const { memo, resolved } = stub()
    for (let i = 0; i < 65; i++) memo.get(keyed(i))
    expect(memo.size).toBe(64)
    memo.get(keyed(0))
    expect(resolved.length).toBe(66)
    expect(resolved.at(-1)).toBe(path.join(root, 'h0'))
  })

  test('E2: 64 keys, touch the first, add one: the first stays, the second is evicted', () => {
    const { memo, resolved } = stub()
    for (let i = 0; i < 64; i++) memo.get(keyed(i))
    memo.get(keyed(0))
    memo.get(keyed(64))
    expect(resolved.length).toBe(65)
    memo.get(keyed(0))
    expect(resolved.length).toBe(65)
    memo.get(keyed(1))
    expect(resolved.length).toBe(66)
    expect(resolved.at(-1)).toBe(path.join(root, 'h1'))
  })
})

describe('Table N — synchronous snapshot', () => {
  /** statSync calls made by `read`, which runs under a spy. */
  function stats(read: () => void): number {
    const spy = spyOn(fs, 'statSync')
    try {
      read()
      return spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
  }
  const a = () => ctx(path.join(root, 'work', 'a'))
  const deep = () => ctx(path.join(root, 'work', 'a', 'deep'))

  test('N1: repeated lookups of one context inside a snapshot compute its key once', () => {
    const one = stats(() => providerOf('glm', a()))
    expect(one).toBeGreaterThan(0)
    expect(stats(() => withCatalogSnapshot(() => {
      for (let i = 0; i < 50; i++) providerOf('glm', a())
    }))).toBe(one)
  })

  test('N2: each distinct context inside a snapshot gets its own entry', () => {
    write(path.join(root, 'work', 'a', 'deep'), 'profiles.json', { mimo: { label: 'MiMo' } })
    const seen = withCatalogSnapshot(() => [a(), deep(), a()].map(at => resolvedCatalog(at).catalog.profiles.has('mimo')))
    expect(seen).toEqual([false, true, false])
  })

  test('N3: an edit applies at the first lookup after the snapshot, never inside it', () => {
    const file = path.join(root, 'work', '.kawai', 'profiles.json')
    const inside = withCatalogSnapshot(() => {
      const before = resolvedCatalog(a()).catalog.profiles.get('glm')?.label
      fs.writeFileSync(file, JSON.stringify({ glm: { label: 'GLM 5', model: 'opus' } }))
      bump(file, 10)
      return [before, resolvedCatalog(a()).catalog.profiles.get('glm')?.label]
    })
    expect(inside).toEqual(['GLM', 'GLM'])
    expect(resolvedCatalog(a()).catalog.profiles.get('glm')?.label).toBe('GLM 5')
  })

  test('N4: a nested snapshot joins the open one', () => {
    // One spy for the whole read: Bun hands a nested spyOn the same mock.
    const spy = spyOn(fs, 'statSync')
    try {
      withCatalogSnapshot(() => {
        providerOf('glm', a())
        const outer = spy.mock.calls.length
        expect(outer).toBeGreaterThan(0)
        withCatalogSnapshot(() => providerOf('glm', a()))
        expect(spy.mock.calls.length).toBe(outer)
      })
    } finally {
      spy.mockRestore()
    }
    // The outer snapshot is still the one that ends: a later edit is seen.
    const file = path.join(root, 'work', '.kawai', 'profiles.json')
    fs.writeFileSync(file, JSON.stringify({ glm: { label: 'GLM 6', model: 'opus' } }))
    bump(file, 20)
    expect(resolvedCatalog(a()).catalog.profiles.get('glm')?.label).toBe('GLM 6')
  })
})

// Both image-default paths, each varied alone (findings-f4b1ebad B4), in three
// regimes: the default files exist with different content; they are missing
// (both contexts fall back to the same embedded catalog, so only key
// precision is observable); or user-level files replace them (the defaults
// are never read, so again only precision is observable).
describe('Table K/N — image-default paths', () => {
  type Which = 'imageDefaultProvidersPath' | 'imageDefaultPath'
  type Defaults = Pick<ProfileCatalogContext, Which>
  /** A second shipped pair: one more provider, and another default label. */
  const shippedB = (): Defaults => {
    const dir = path.join(root, 'shipped-b')
    return {
      imageDefaultProvidersPath: write(dir, 'providers.json', { zai: { label: 'Z.AI', models: { 'glm-flash': {} } } }),
      imageDefaultPath: write(dir, 'profiles.json', { default: { label: 'Shipped B' } }),
    }
  }
  const missing = (dir: string): Defaults => ({
    imageDefaultProvidersPath: path.join(root, dir, 'providers.json'),
    imageDefaultPath: path.join(root, dir, 'profiles.json'),
  })
  /** Contexts A and B that differ only in `which`, under one regime. */
  function regime(kind: 'present' | 'missing' | 'override', which: Which): { a: ProfileCatalogContext; b: ProfileCatalogContext } {
    const base = kind === 'present' ? shipped : missing('none-a')
    if (kind === 'override') {
      write(home, 'providers.json', {})
      write(home, 'profiles.json', { default: { label: 'User' } })
    }
    const other = kind === 'present' ? shippedB() : missing('none-b')
    const project = path.join(root, 'work', 'a')
    return { a: ctx(project, base), b: ctx(project, { ...base, [which]: other[which] }) }
  }
  /** What a catalog shows: every profile's label and provider, and the provider labels. */
  const view = (catalog: ProfileCatalog) => ({
    profiles: [...catalog.profiles].map(([id, profile]) => [id, profile.label, profile.providerId]),
    providers: [...catalog.providers].map(([id, provider]) => [id, provider.label]),
  })
  /** readFileSync calls on either context's default files while `read` runs. */
  function defaultReads(read: () => void, ...contexts: ProfileCatalogContext[]): number {
    const files = new Set(contexts.flatMap(at => [at.imageDefaultProvidersPath, at.imageDefaultPath]))
    const spy = spyOn(fs, 'readFileSync')
    try {
      read()
      return spy.mock.calls.filter(call => files.has(String(call[0]))).length
    } finally {
      spy.mockRestore()
    }
  }
  const PRESENT: Array<[string, Which, (catalog: ProfileCatalog) => unknown, unknown, unknown]> = [
    ['K9a', 'imageDefaultProvidersPath', catalog => catalog.profiles.get('glm-flash')?.providerId, undefined, 'zai'],
    ['K9b', 'imageDefaultPath', catalog => catalog.profiles.get('default')?.label, 'Default', 'Shipped B'],
  ]

  test.each(PRESENT)('%s: only %s differs, default present with different content: two keys, two resolutions, each its own value', (_id, which, read, inA, inB) => {
    const { a, b } = regime('present', which)
    const { memo, resolutions } = countingMemo()
    expect(catalogInputKey(b)).not.toBe(catalogInputKey(a))
    expect([read(memo.get(a).catalog), read(memo.get(b).catalog), read(memo.get(a).catalog)]).toEqual([inA, inB, inA])
    expect(resolutions()).toBe(2)
  })

  test.each([
    ['K11a', 'missing', 'imageDefaultProvidersPath'],
    ['K11b', 'missing', 'imageDefaultPath'],
    ['K11c', 'override', 'imageDefaultProvidersPath'],
    ['K11d', 'override', 'imageDefaultPath'],
  ] as const)('%s: regime %s, only %s differs: two keys and two resolutions of an equal catalog (precision)', (_id, kind, which) => {
    const { a, b } = regime(kind, which)
    const { memo, resolutions } = countingMemo()
    expect(catalogInputKey(b)).not.toBe(catalogInputKey(a))
    let first: CatalogEntry | undefined
    let second: CatalogEntry | undefined
    const reads = defaultReads(() => { first = memo.get(a); second = memo.get(b) }, a, b)
    expect(resolutions()).toBe(2)
    expect(second).not.toBe(first)
    expect(view(second!.catalog)).toEqual(view(first!.catalog))
    // A user-level pair means the defaults are never read; missing defaults
    // are attempted and fall back to the embedded catalog.
    expect(reads).toBe(kind === 'override' ? 0 : 4)
    expect(first!.catalog.profiles.get('default')?.label).toBe(kind === 'override' ? 'User' : 'Default')
  })

  test.each([
    ['N5a', 'present', 'imageDefaultProvidersPath'],
    ['N5b', 'present', 'imageDefaultPath'],
    ['N5c', 'missing', 'imageDefaultProvidersPath'],
    ['N5d', 'missing', 'imageDefaultPath'],
    ['N5e', 'override', 'imageDefaultProvidersPath'],
    ['N5f', 'override', 'imageDefaultPath'],
  ] as const)('%s: regime %s, only %s differs: a snapshot keeps A and B apart', (_id, kind, which) => {
    const { a, b } = regime(kind, which)
    const [ea, eb, again] = withCatalogSnapshot(() => [a, b, a].map(at => resolvedCatalog(at)))
    expect(eb).not.toBe(ea!)
    expect(again).toBe(ea!)
    if (kind === 'present') {
      const row = PRESENT.find(([, at]) => at === which)!
      expect([ea, eb, again].map(entry => row[2](entry!.catalog))).toEqual([row[3], row[4], row[3]])
    } else {
      expect(view(eb!.catalog)).toEqual(view(ea!.catalog))
    }
  })
})
