// The shared catalog resolution memo (catalog-resolution-cache D1–D2): Table K
// (which lookups share a key) and Table E (LRU eviction) from the design, one
// test per oracle id, counting resolutions through the memo's resolver seam.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CatalogMemo, catalogInputKey } from '../chat/catalogMemo'
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
