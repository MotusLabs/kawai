// Model families in the catalog (starter-team-setup D4, Table F): a model's
// `family` wins over its provider's, a profile with neither is its own
// family, `family` is a trusted-tier field, and every shipped model names
// one explicitly.
// @reads: config/profiles.default.json config/providers.default.json
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { familyOf, resolveProfileCatalog } from '../chat/profileCatalog'

let tempRoot: string
let homeDir: string
let projectDir: string

function writeCatalog(dir: string, name: string, json: unknown): string {
  const file = path.join(dir, '.kawai', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(json))
  return file
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-family-'))
  homeDir = path.join(tempRoot, 'home')
  projectDir = path.join(tempRoot, 'work', 'proj')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

/** Table F rows over user-level files: id, providers.json, profiles.json, profile, expected family. */
const RESOLUTION_ROWS: Array<{ id: string; providers?: unknown; profiles?: unknown; profile: string; family: string }> = [
  { id: 'F1', providers: { or: { label: 'OR', models: { 'or-opus': { model: 'opus', family: 'claude' } } } }, profile: 'or-opus', family: 'claude' },
  { id: 'F2', providers: { zai: { label: 'Z', family: 'glm', models: { 'glm-flash': { model: 'sonnet' } } } }, profile: 'glm-flash', family: 'glm' },
  { id: 'F2b', providers: { or: { label: 'OR', family: 'mixed', models: { 'or-ds': { model: 'x', family: 'deepseek' } } } }, profile: 'or-ds', family: 'deepseek' },
  { id: 'F3', profiles: { lan: { label: 'LAN' } }, profile: 'lan', family: 'lan' },
  { id: 'F3b', profiles: { sol: { label: 'Sol', runtime: 'codex', family: 'gpt' } }, profile: 'sol', family: 'gpt' },
  { id: 'F3c', profiles: { mm: { label: 'MM', family: 'minimax' } }, profile: 'mm', family: 'minimax' },
]

describe('Table F — family resolution', () => {
  for (const row of RESOLUTION_ROWS) {
    test(`${row.id}: ${row.profile} resolves to family ${row.family}`, () => {
      if (row.providers) writeCatalog(homeDir, 'providers.json', row.providers)
      if (row.profiles) writeCatalog(homeDir, 'profiles.json', row.profiles)
      const catalog = resolveProfileCatalog({ homeDir })
      expect(catalog.errors).toEqual([])
      expect(familyOf(catalog, row.profile)).toBe(row.family)
    })
  }

  // @covers: claude-session-profiles › Catalog entries may name a model family › A model inherits its provider's family
  test('F2: a model inherits its provider family', () => {
    writeCatalog(homeDir, 'providers.json', { zai: { label: 'Z.AI', family: 'glm', models: { 'glm-flash': { model: 'sonnet' } } } })
    expect(familyOf(resolveProfileCatalog({ homeDir }), 'glm-flash')).toBe('glm')
  })

  // @covers: claude-session-profiles › Catalog entries may name a model family › A model's family overrides its provider's
  test('F1: a model family overrides the provider family', () => {
    writeCatalog(homeDir, 'providers.json', { openrouter: { label: 'OpenRouter', models: { 'openrouter-opus': { model: 'opus', family: 'claude' } } } })
    expect(familyOf(resolveProfileCatalog({ homeDir }), 'openrouter-opus')).toBe('claude')
  })

  // @covers: claude-session-profiles › Catalog entries may name a model family › No family falls back to the profile id
  test('F3: no family falls back to the profile id, also for unknown ids', () => {
    writeCatalog(homeDir, 'profiles.json', { lan: { label: 'LAN' } })
    const catalog = resolveProfileCatalog({ homeDir })
    expect(familyOf(catalog, 'lan')).toBe('lan')
    expect(familyOf(catalog, 'never-defined')).toBe('never-defined')
  })

  test('F3d: a project re-home keeps the shipped key family', () => {
    writeCatalog(projectDir, 'profiles.json', { opus: { label: 'Project Opus' } })
    const catalog = resolveProfileCatalog({ homeDir: path.join(tempRoot, 'no-home'), projectPath: projectDir })
    expect(catalog.errors).toEqual([])
    expect(familyOf(catalog, 'opus')).toBe('claude')
  })
})

describe('Table F — refusals', () => {
  // @covers: claude-session-profiles › Model family is a trusted-tier field › A project file sets a family
  test('F4: a project profiles.json setting family is rejected, the rest stays usable', () => {
    const file = writeCatalog(projectDir, 'profiles.json', { mine: { label: 'Mine', family: 'gpt' } })
    const catalog = resolveProfileCatalog({ homeDir: path.join(tempRoot, 'no-home'), projectPath: projectDir })
    expect(catalog.errors).toHaveLength(1)
    expect(catalog.errors[0]).toContain(file)
    expect(catalog.errors[0]).toContain('family is allowed only in the user-level catalog')
    expect(catalog.profiles.has('mine')).toBe(false)
    expect(catalog.profiles.has('opus')).toBe(true)
  })

  test('F4b: a project providers.json setting family on a provider or model is rejected', () => {
    for (const json of [
      { p: { label: 'P', family: 'gpt', models: { m: { model: 'x' } } } },
      { p: { label: 'P', models: { m: { model: 'x', family: 'gpt' } } } },
    ]) {
      const file = writeCatalog(projectDir, 'providers.json', json)
      const catalog = resolveProfileCatalog({ homeDir: path.join(tempRoot, 'no-home'), projectPath: projectDir })
      expect(catalog.errors).toHaveLength(1)
      expect(catalog.errors[0]).toContain(file)
      expect(catalog.profiles.has('m')).toBe(false)
    }
  })

  // @covers: claude-session-profiles › Catalog entries may name a model family › An invalid family is an error
  test('F5: an invalid family identifier is a file error naming the entry', () => {
    const file = writeCatalog(homeDir, 'profiles.json', { lan: { label: 'LAN', family: 'Claude Opus' } })
    const catalog = resolveProfileCatalog({ homeDir })
    expect(catalog.errors).toHaveLength(1)
    expect(catalog.errors[0]).toContain(file)
    expect(catalog.errors[0]).toContain('profile "lan" family must match')
  })
})

describe('Table F — shipped catalogs', () => {
  // @covers: claude-session-profiles › Shipped catalog entries name their families › Shipped Claude aliases share a family
  test('F6: every shipped model has an explicit family', () => {
    const catalog = resolveProfileCatalog({ homeDir: path.join(tempRoot, 'no-home') })
    expect(catalog.errors).toEqual([])
    const expected: Record<string, string> = {
      default: 'claude', opus: 'claude', sonnet: 'claude', haiku: 'claude',
      'openrouter-opus': 'claude', 'openrouter-sonnet': 'claude', 'openrouter-haiku': 'claude',
      'openrouter-deepseek-flash': 'deepseek', 'openrouter-minimax-flash': 'minimax',
      glm: 'glm', 'glm-flash': 'glm', minimax: 'minimax', mimo: 'mimo', kimi: 'kimi',
      'codex-sol': 'gpt', 'codex-astra': 'gpt', 'codex-luna': 'gpt',
    }
    expect(Object.fromEntries(catalog.families)).toEqual(expected)
  })

  // Raw shipped labels, not resolved families: for entries whose family
  // equals their profile id the id fallback masks a removed label, so the
  // resolved assertion above is insensitive for mimo/kimi/minimax (review
  // F4). This one reads the shipped JSON and is checked to fail when any
  // single label — or the provider family an inheritance relies on — is
  // dropped.
  test('F6b: the raw shipped catalogs label every profile via itself or its provider', () => {
    const config = path.resolve(import.meta.dir, '../../../config')
    const profiles = JSON.parse(fs.readFileSync(path.join(config, 'profiles.default.json'), 'utf8')) as Record<string, { family?: string; provider?: string }>
    const providers = JSON.parse(fs.readFileSync(path.join(config, 'providers.default.json'), 'utf8')) as Record<string, { family?: string }>
    const unlabeled = (catalog: Record<string, { family?: string; provider?: string }>, providerTable: Record<string, { family?: string }>) =>
      Object.keys(catalog).filter(id => catalog[id]!.family === undefined && !(catalog[id]!.provider && providerTable[catalog[id]!.provider!]?.family !== undefined))
    expect(unlabeled(profiles, providers)).toEqual([])
    // Provider inheritance sources the openrouter-* rows rely on stay labeled.
    expect(providers.zai?.family).toBe('glm')
    expect(providers.claude?.family).toBe('claude')
    // Sensitivity: dropping any single shipped label fails the assertion.
    for (const id of ['mimo', 'kimi', 'minimax', 'codex-sol']) {
      const copy = structuredClone(profiles)
      delete copy[id]!.family
      expect(unlabeled(copy, providers)).toEqual([id])
    }
    const copy = structuredClone(profiles)
    copy['glm'] = { provider: 'zai' }
    expect(unlabeled(copy, providers)).toEqual([])
    expect(unlabeled(copy, {})).toEqual(['glm'])
  })
})
