// Runtime origin tiers (design D4): a key's origin is the farthest tier that
// defines it as Claude, and no key with a farther Claude origin resolves to
// Codex — in the catalog or through resolveClaudeProfile. The matrix crosses
// the user-level shapes with the project shapes that reopened B1 (round-3
// probes); the named rows pin each earlier failure and the boundaries.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveClaudeProfile } from '../chat/ClaudeProfiles'
import {
  DEFAULT_PROFILE_CATALOG_PATH,
  DEFAULT_PROVIDER_CATALOG_PATH,
  profileCatalogLevels,
  resolveProfileCatalog,
} from '../chat/profileCatalog'

type Files = { providers?: unknown; profiles?: unknown }

let tempRoot: string
let homeDir: string
let farDir: string
let projectDir: string

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-codex-origins-')))
  homeDir = path.join(tempRoot, 'home')
  farDir = path.join(tempRoot, 'ws')
  projectDir = path.join(farDir, 'proj')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

const catalogFile = (dir: string, kind: 'providers' | 'profiles'): string =>
  path.join(dir, '.kawai', `${kind}.json`)

/** Write a directory's catalog files; returns nothing, paths come from catalogFile. */
function writeLevel(dir: string, files: Files): void {
  for (const kind of ['providers', 'profiles'] as const) {
    if (files[kind] === undefined) continue
    fs.mkdirSync(path.join(dir, '.kawai'), { recursive: true })
    fs.writeFileSync(catalogFile(dir, kind), JSON.stringify(files[kind]))
  }
}

/** Resolve one key both ways: the merged catalog and the launch resolver. */
function resolveKey(key: string) {
  const ctx = { homeDir, projectPath: projectDir, serverCodexHome: '/tmp/codex-home-a' }
  const { profiles, errors } = resolveProfileCatalog(ctx)
  const launch = resolveClaudeProfile(key, {}, ctx)
  return {
    catalog: profiles.get(key)?.runtime ?? 'claude',
    launch: launch.runtime ?? 'claude',
    label: profiles.get(key)?.label,
    errors,
  }
}

const refusal = (file: string, key: string, originFile: string): string =>
  `${file}: profile "${key}" is a Codex entry here but a Claude entry in ${originFile}; the entry is ignored.`

const acme = (key: string) => ({ acme: { label: 'Acme', models: { [key]: { label: 'K' } } } })

// The user-level shapes of the matrix (round-3 matrix.ts).
const USER: Record<string, Files> = {
  'absent': {},
  'profiles.json without default': { profiles: { mimo: { label: 'MiMo', env: { ANTHROPIC_MODEL: 'x' } } } },
  'profiles.json with default': { profiles: { default: { label: 'Default' }, mimo: { label: 'MiMo' } } },
  'providers.json only': { providers: acme('a1') },
  'both, without default': { providers: acme('a1'), profiles: { mimo: { label: 'MiMo' } } },
  'providers.json with a provider named default': { providers: { default: { label: 'D', models: { default: { label: 'D' } } } } },
}

// The project shapes for `default`; `refused` names the file whose Codex
// entry the merge must refuse ('far' or 'near'), none when no Codex entry.
const PROJECT: Record<string, { far?: Files; near: Files; refused?: 'far' | 'near' }> = {
  'plain codex default': { near: { profiles: { default: { runtime: 'codex' } } }, refused: 'near' },
  'providers.json acme, profiles.json codex default': {
    near: { providers: acme('a1'), profiles: { default: { runtime: 'codex' } } }, refused: 'near',
  },
  'providers.json claims default via acme, profiles.json codex default': {
    near: { providers: acme('default'), profiles: { default: { runtime: 'codex' } } }, refused: 'near',
  },
  'providers.json claims default via a provider named default, profiles.json codex default': {
    near: { providers: { default: { label: 'D', models: { default: { label: 'D' } } } }, profiles: { default: { runtime: 'codex' } } },
    refused: 'near',
  },
  'a Claude default only': { near: { profiles: { default: { label: 'X' } } } },
  'far Claude default, near codex default': {
    far: { profiles: { default: { label: 'X' } } }, near: { profiles: { default: { runtime: 'codex' } } }, refused: 'near',
  },
  'far codex default, near Claude default': {
    far: { profiles: { default: { runtime: 'codex' } } }, near: { profiles: { default: { label: 'Y' } } }, refused: 'far',
  },
}

describe('the default key never flips to Codex (matrix: user level × project)', () => {
  for (const [userName, user] of Object.entries(USER)) {
    for (const [projectName, project] of Object.entries(PROJECT)) {
      test(`user ${userName} | project ${projectName}`, () => {
        writeLevel(homeDir, user)
        if (project.far) writeLevel(farDir, project.far)
        writeLevel(projectDir, project.near)
        const got = resolveKey('default')
        expect(got.catalog).toBe('claude')
        expect(got.launch).toBe('claude')
        const defaultCodexErrors = got.errors.filter(e => e.includes('profile "default" is a Codex entry'))
        if (project.refused === undefined) {
          expect(defaultCodexErrors).toEqual([])
        } else {
          // The refusal names the refused file and the implicit tier-0 origin.
          const dir = project.refused === 'far' ? farDir : projectDir
          expect(defaultCodexErrors).toEqual([refusal(catalogFile(dir, 'profiles'), 'default', '(implicit)')])
        }
      })
    }
  }
})

describe('earlier B1 failures, one row each', () => {
  test('round 1: a user level without default, project codex default', () => {
    writeLevel(homeDir, { providers: acme('m') })
    writeLevel(projectDir, { profiles: { default: { runtime: 'codex' } } })
    const got = resolveKey('default')
    expect([got.catalog, got.launch]).toEqual(['claude', 'claude'])
    expect(got.errors).toEqual([refusal(catalogFile(projectDir, 'profiles'), 'default', '(implicit)')])
  })

  test('round 3 matrix.ts: a project providers.json claims default, its profiles.json sets codex', () => {
    writeLevel(homeDir, USER['profiles.json without default'])
    writeLevel(projectDir, { providers: acme('default'), profiles: { default: { runtime: 'codex' } } })
    const got = resolveKey('default')
    expect([got.catalog, got.launch]).toEqual(['claude', 'claude'])
    expect(got.errors).toContain(refusal(catalogFile(projectDir, 'profiles'), 'default', '(implicit)'))
  })

  // round-3 rehome.ts: the shipped origin file of each key.
  const SHIPPED_ORIGIN: Record<string, string> = {
    opus: DEFAULT_PROVIDER_CATALOG_PATH,
    glm: DEFAULT_PROVIDER_CATALOG_PATH,
    mimo: DEFAULT_PROFILE_CATALOG_PATH,
  }
  for (const key of Object.keys(SHIPPED_ORIGIN)) {
    test(`round 3 rehome.ts, no user level: acme re-homes shipped ${key}, codex refused`, () => {
      writeLevel(projectDir, { providers: acme(key), profiles: { [key]: { runtime: 'codex' } } })
      const got = resolveKey(key)
      expect([got.catalog, got.launch]).toEqual(['claude', 'claude'])
      // The re-home moved the holder to acme; the origin stays shipped.
      expect(got.label).toBe('K')
      expect(got.errors).toEqual([refusal(catalogFile(projectDir, 'profiles'), key, SHIPPED_ORIGIN[key])])
    })

    test(`round 3 rehome.ts, user level defines ${key}: the user origin holds`, () => {
      writeLevel(homeDir, { profiles: { [key]: { label: 'U', env: { ANTHROPIC_MODEL: 'x' } } } })
      writeLevel(projectDir, { providers: acme(key), profiles: { [key]: { runtime: 'codex' } } })
      const got = resolveKey(key)
      expect([got.catalog, got.launch]).toEqual(['claude', 'claude'])
      expect(got.errors).toContain(refusal(catalogFile(projectDir, 'profiles'), key, catalogFile(homeDir, 'profiles')))
    })
  }
})

describe('origin boundaries', () => {
  test('a user base replaces the shipped base: a shipped-only key is new, only default is tier 0', () => {
    writeLevel(homeDir, { profiles: { mimo: { label: 'MiMo' } } })
    writeLevel(projectDir, { profiles: { opus: { runtime: 'codex' }, default: { runtime: 'codex' } } })
    const opus = resolveKey('opus')
    expect([opus.catalog, opus.launch]).toEqual(['codex', 'codex'])
    expect(opus.errors).toEqual([refusal(catalogFile(projectDir, 'profiles'), 'default', '(implicit)')])
    expect(resolveKey('default').catalog).toBe('claude')
  })

  test('the shipped base: a shipped key has a tier-0 origin', () => {
    writeLevel(projectDir, { profiles: { opus: { runtime: 'codex' } } })
    const got = resolveKey('opus')
    expect([got.catalog, got.launch]).toEqual(['claude', 'claude'])
    expect(got.errors).toEqual([refusal(catalogFile(projectDir, 'profiles'), 'opus', DEFAULT_PROVIDER_CATALOG_PATH)])
  })

  test('same-directory release at the user level (Codex profile under a providers.json provider)', () => {
    writeLevel(homeDir, { providers: acme('k1'), profiles: { k1: { runtime: 'codex', model: 'gpt-5.3-codex' } } })
    const got = resolveKey('k1')
    expect([got.catalog, got.launch]).toEqual(['codex', 'codex'])
    expect(got.errors).toHaveLength(1)
    expect(got.errors[0]).toStartWith(`${catalogFile(homeDir, 'profiles')}: profile "k1" is a model of provider "acme"`)
    expect(got.errors[0]).toContain('providers.json cannot hold a Codex profile')
  })

  test('same-directory release at a project level', () => {
    writeLevel(projectDir, { providers: acme('k1'), profiles: { k1: { runtime: 'codex' } } })
    const got = resolveKey('k1')
    expect([got.catalog, got.launch]).toEqual(['codex', 'codex'])
    expect(got.errors).toHaveLength(1)
    expect(got.errors[0]).toStartWith(`${catalogFile(projectDir, 'profiles')}: profile "k1" is a model of provider "acme"`)
  })

  test('a farther directory\'s Claude key refuses a nearer Codex entry', () => {
    writeLevel(farDir, { providers: acme('k1') })
    writeLevel(projectDir, { profiles: { k1: { runtime: 'codex' } } })
    const got = resolveKey('k1')
    expect([got.catalog, got.launch]).toEqual(['claude', 'claude'])
    expect(got.errors).toEqual([refusal(catalogFile(projectDir, 'profiles'), 'k1', catalogFile(farDir, 'providers'))])
  })

  test('multi-directory chain: a middle claim never moves the farthest origin', () => {
    // user Claude k2 → far providers.json claims it (an operator duplicate,
    // ignored) → near profiles.json sets codex: refused against the user file.
    writeLevel(homeDir, { profiles: { k2: { label: 'User' } } })
    writeLevel(farDir, { providers: acme('k2') })
    writeLevel(projectDir, { profiles: { k2: { runtime: 'codex' } } })
    const got = resolveKey('k2')
    expect([got.catalog, got.launch]).toEqual(['claude', 'claude'])
    expect(got.errors).toContain(refusal(catalogFile(projectDir, 'profiles'), 'k2', catalogFile(homeDir, 'profiles')))
  })

  test('a key released in a farther directory takes a nearer Codex overlay', () => {
    writeLevel(farDir, { providers: acme('k3'), profiles: { k3: { runtime: 'codex' } } })
    writeLevel(projectDir, { profiles: { k3: { runtime: 'codex', label: 'Near' } } })
    const got = resolveKey('k3')
    expect([got.catalog, got.launch]).toEqual(['codex', 'codex'])
    expect(got.label).toBe('Near')
    expect(got.errors).toHaveLength(1)
    expect(got.errors[0]).toContain('providers.json cannot hold a Codex profile')
  })

  test('a user Codex profile takes a nearer Codex overlay', () => {
    writeLevel(homeDir, { profiles: { cx: { runtime: 'codex' } } })
    writeLevel(projectDir, { profiles: { cx: { runtime: 'codex', label: 'Project' } } })
    const got = resolveKey('cx')
    expect([got.catalog, got.launch, got.label]).toEqual(['codex', 'codex', 'Project'])
    expect(got.errors).toEqual([])
  })

  test('a user-level Codex default is refused: the implicit default is tier 0', () => {
    writeLevel(homeDir, { profiles: { default: { runtime: 'codex' } } })
    const got = resolveKey('default')
    expect([got.catalog, got.launch]).toEqual(['claude', 'claude'])
    expect(got.errors).toEqual([refusal(catalogFile(homeDir, 'profiles'), 'default', '(implicit)')])
  })

  test('Claude over Codex: a nearer Claude entry is refused, the key stays Codex', () => {
    writeLevel(homeDir, { profiles: { cx: { runtime: 'codex' } } })
    writeLevel(projectDir, { profiles: { cx: { runtime: 'claude' } } })
    const got = resolveKey('cx')
    expect([got.catalog, got.launch]).toEqual(['codex', 'codex'])
    expect(got.errors).toEqual([
      `${catalogFile(projectDir, 'profiles')}: profile "cx" is a Claude entry here but a Codex entry in ${catalogFile(homeDir, 'profiles')}; the entry is ignored.`,
    ])
  })

  test('providers.json on a Codex key is refused, the key stays Codex', () => {
    writeLevel(homeDir, { profiles: { cx: { runtime: 'codex' } } })
    writeLevel(projectDir, { providers: acme('cx') })
    const got = resolveKey('cx')
    expect([got.catalog, got.launch]).toEqual(['codex', 'codex'])
    expect(got.errors).toHaveLength(1)
    expect(got.errors[0]).toStartWith(`${catalogFile(projectDir, 'providers')}: model "cx" is defined as a Codex profile`)
  })
})

describe('catalog read order (catalogMerge header)', () => {
  test('per directory, farthest first: providers.json then profiles.json, one tier each', () => {
    writeLevel(homeDir, { profiles: {} })
    const levels = profileCatalogLevels({ homeDir, projectPath: projectDir })
    expect(levels.slice(0, 2)).toEqual([
      { file: catalogFile(homeDir, 'providers'), kind: 'providers', trusted: true, tier: 1 },
      { file: catalogFile(homeDir, 'profiles'), kind: 'profiles', trusted: true, tier: 1 },
    ])
    const project = levels.slice(2)
    const dirs = ['/', ...projectDir.split(path.sep).filter(Boolean).map((_, i, parts) => `/${parts.slice(0, i + 1).join('/')}`)]
    expect(project.map(level => [level.file, level.kind, level.tier])).toEqual(dirs.flatMap((dir, i) => [
      [catalogFile(dir, 'providers'), 'providers', 2 + i],
      [catalogFile(dir, 'profiles'), 'profiles', 2 + i],
    ]))
  })

  test('without a user level the shipped pair is tier 0, providers first', () => {
    const levels = profileCatalogLevels({ homeDir, projectPath: projectDir })
    expect(levels.slice(0, 2).map(level => [level.file, level.kind, level.tier, level.shipped])).toEqual([
      [DEFAULT_PROVIDER_CATALOG_PATH, 'providers', 0, true],
      [DEFAULT_PROFILE_CATALOG_PATH, 'profiles', 0, true],
    ])
  })
})
