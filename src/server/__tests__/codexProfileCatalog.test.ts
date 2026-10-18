// §3.1 unit tests: the claude-session-profiles delta's runtime scenarios —
// catalog entries declare their runtime, codex homes and network are
// named only at the trusted tier — plus the parse-level refusals behind
// them and the R2 home-derived provider id.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  codexHomeProviderId,
  resolveCodexHome,
} from '../chat/codexProfiles'
import {
  parseCatalogValue,
  parseProviderCatalogValue,
  resolveProfileCatalog,
} from '../chat/profileCatalog'

let tempRoot: string
let homeDir: string
let projectDir: string

function writeCatalog(dir: string, name: string, json: unknown): string {
  const file = path.join(dir, '.kawai', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(json))
  return file
}

const writeProfiles = (dir: string, json: unknown): string => writeCatalog(dir, 'profiles.json', json)
const writeProviders = (dir: string, json: unknown): string => writeCatalog(dir, 'providers.json', json)

const HOME_ENV = { HOME: '/home/smoke' }

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-codex-catalog-'))
  homeDir = path.join(tempRoot, 'home')
  projectDir = path.join(tempRoot, 'work', 'proj')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

describe('catalog entries declare their runtime (D4, R1)', () => {
  test('a Codex entry resolves with its model and a home-derived provider id', () => {
    writeProfiles(homeDir, { codex: { label: 'Codex', runtime: 'codex', model: 'gpt-5.3-codex' } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, serverCodexHome: '/tmp/codex-home-a' })
    expect(errors).toEqual([])
    expect(profiles.get('codex')).toEqual({
      label: 'Codex',
      env: {},
      model: 'gpt-5.3-codex',
      runtime: 'codex',
      providerId: codexHomeProviderId('/tmp/codex-home-a'),
    })
    // R2: the id is the hash prefix, never the path.
    expect(profiles.get('codex')?.providerId).toMatch(/^codex-home-[0-9a-f]{12}$/)
    expect(profiles.get('codex')?.label).not.toContain('codex-home')
  })

  test('two homes hash differently; one home is one cooldown and usage key', () => {
    writeProfiles(homeDir, {
      'codex-a': { label: 'Codex A', runtime: 'codex', codexHome: '/tmp/codex-home-a' },
      'codex-b': { label: 'Codex B', runtime: 'codex', codexHome: '/tmp/codex-home-b' },
      'codex-a-2': { label: 'Codex A again', runtime: 'codex', codexHome: '/tmp/codex-home-a/' },
    })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, serverCodexHome: '/tmp/codex-home-a' })
    expect(errors).toEqual([])
    expect(profiles.get('codex-a')?.providerId).toBe(profiles.get('codex-a-2')?.providerId)
    expect(profiles.get('codex-b')?.providerId).not.toBe(profiles.get('codex-a')?.providerId)
  })

  test('providers.json cannot hold a Codex profile: the file is reported, the profile stays usable', () => {
    writeProviders(homeDir, {
      acme: { label: 'Acme', models: { codex: { label: 'Codex' }, other: { label: 'Other' } } },
    })
    writeProfiles(homeDir, { codex: { runtime: 'codex', model: 'gpt-5.3-codex' } })
    const providersFile = path.join(homeDir, '.kawai', 'providers.json')
    const { profiles, providers, errors } = resolveProfileCatalog({ homeDir, serverCodexHome: '/tmp/codex-home-a' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(providersFile)
    expect(errors[0]).toContain('Codex profile')
    expect(profiles.get('codex')).toEqual({
      label: 'codex',
      env: {},
      model: 'gpt-5.3-codex',
      runtime: 'codex',
      providerId: codexHomeProviderId('/tmp/codex-home-a'),
    })
    // The provider's other models are untouched; the released key is gone.
    expect(providers.get('acme')?.models).toEqual(['other'])
    expect(profiles.get('other')?.providerId).toBe('acme')
  })

  test('a project providers.json cannot claim a user-level Codex profile', () => {
    writeProfiles(homeDir, { codex: { label: 'Codex', runtime: 'codex', model: 'gpt-5.3-codex' } })
    const projectProviders = writeProviders(projectDir, {
      acme: { label: 'Acme', models: { codex: { label: 'Codex' } } },
    })
    const { profiles, providers, errors } = resolveProfileCatalog({
      homeDir, projectPath: projectDir, serverCodexHome: '/tmp/codex-home-a',
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(projectProviders)
    expect(profiles.get('codex')?.runtime).toBe('codex')
    expect(profiles.get('codex')?.model).toBe('gpt-5.3-codex')
    expect(providers.get('acme')?.models).toEqual([])
  })

  test('a Claude field on a Codex entry reports the file; other files stay usable', () => {
    writeProfiles(homeDir, { mimo: { label: 'MiMo', env: { ANTHROPIC_BASE_URL: 'https://mimo.example.internal' } } })
    const projectFile = writeProfiles(projectDir, {
      codex: { runtime: 'codex', env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } },
    })
    const { profiles, errors } = resolveProfileCatalog({
      homeDir, projectPath: projectDir, serverCodexHome: '/tmp/codex-home-a',
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(projectFile)
    // The field allowlist fires before env validation: the entry is
    // Claude-shaped by its env field alone.
    expect(errors[0]).toContain('belongs to Claude entries')
    // The whole project file is skipped; the user level stays usable.
    expect(profiles.get('codex')).toBeUndefined()
    expect(profiles.get('mimo')?.label).toBe('MiMo')
  })

  test('a project Claude entry cannot overlay a user-level Codex profile (cross-level conflict)', () => {
    writeProfiles(homeDir, { codex: { label: 'Codex', runtime: 'codex', model: 'gpt-5.3-codex' } })
    const projectFile = writeProfiles(projectDir, {
      codex: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } },
    })
    const { profiles, errors } = resolveProfileCatalog({
      homeDir, projectPath: projectDir, serverCodexHome: '/tmp/codex-home-a',
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(projectFile)
    // The user-level Codex entry remains usable, untouched.
    expect(profiles.get('codex')).toEqual({
      label: 'Codex',
      env: {},
      model: 'gpt-5.3-codex',
      runtime: 'codex',
      providerId: codexHomeProviderId('/tmp/codex-home-a'),
    })
  })

  test('an explicit claude runtime is rejected over a Codex profile; a label-only overlay is not', () => {
    writeProfiles(homeDir, { codex: { label: 'Codex', runtime: 'codex', model: 'gpt-5.3-codex' } })
    writeProfiles(projectDir, { codex: { runtime: 'claude', label: 'Not Codex' } })
    const { profiles, errors } = resolveProfileCatalog({
      homeDir, projectPath: projectDir, serverCodexHome: '/tmp/codex-home-a',
    })
    expect(errors).toHaveLength(1)
    expect(profiles.get('codex')?.label).toBe('Codex')

    fs.writeFileSync(path.join(projectDir, '.kawai', 'profiles.json'), JSON.stringify({
      codex: { label: 'Project Codex' },
    }))
    const neutral = resolveProfileCatalog({ homeDir, projectPath: projectDir, serverCodexHome: '/tmp/codex-home-a' })
    expect(neutral.errors).toEqual([])
    expect(neutral.profiles.get('codex')).toEqual({
      label: 'Project Codex',
      env: {},
      model: 'gpt-5.3-codex',
      runtime: 'codex',
      providerId: codexHomeProviderId('/tmp/codex-home-a'),
    })
  })
})

describe('codex homes and network are named only at the trusted tier (D4)', () => {
  test('the home resolves from the entry, then CODEX_HOME, then ~/.codex', () => {
    expect(resolveCodexHome({}, { CODEX_HOME: '/srv/codex', ...HOME_ENV })).toBe('/srv/codex')
    expect(resolveCodexHome({}, HOME_ENV)).toBe('/home/smoke/.codex')
    expect(resolveCodexHome({ codexHome: '~/codex-alt' }, { CODEX_HOME: '/srv/codex', ...HOME_ENV })).toBe('/home/smoke/codex-alt')
    expect(resolveCodexHome({ codexHome: '/abs/home' }, HOME_ENV)).toBe('/abs/home')
  })

  test('the user level may set codexHome and network; the id follows the named home', () => {
    writeProfiles(homeDir, {
      codex: { label: 'Codex', runtime: 'codex', codexHome: '~/codex-alt', network: false },
    })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, serverCodexHome: '/tmp/codex-home-a' })
    expect(errors).toEqual([])
    expect(profiles.get('codex')).toEqual({
      label: 'Codex',
      env: {},
      runtime: 'codex',
      codexHome: '~/codex-alt',
      network: false,
      // `~` expands against the context's home (the same HOME the catalog
      // levels use), not a hardcoded path.
      providerId: codexHomeProviderId(path.join(homeDir, 'codex-alt')),
    })
  })

  test('a project file naming a home or setting network is reported', () => {
    const homeFile = writeProfiles(projectDir, {
      codex: { runtime: 'codex', codexHome: '/tmp/evil-home' },
    })
    const { profiles, errors } = resolveProfileCatalog({
      homeDir, projectPath: projectDir, serverCodexHome: '/tmp/codex-home-a',
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(homeFile)
    expect(errors[0]).toContain('user-level')
    expect(profiles.has('codex')).toBe(false)

    const networkFile = writeProfiles(projectDir, { codex: { runtime: 'codex', network: true } })
    const second = resolveProfileCatalog({ homeDir, projectPath: projectDir, serverCodexHome: '/tmp/codex-home-a' })
    expect(second.errors).toHaveLength(1)
    expect(second.errors[0]).toContain(networkFile)
    expect(second.profiles.has('codex')).toBe(false)
  })
})

describe('parse-level refusals behind the runtime rules', () => {
  const SOURCE = '/tmp/kawai-test/profiles.json'

  test('an unknown runtime value is refused', () => {
    const parsed = parseCatalogValue({ codex: { runtime: 'gemini' } }, SOURCE, true)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('runtime must be')
  })

  test('Claude fields on a Codex entry and Codex fields on a Claude entry are refused by name', () => {
    const envOnCodex = parseCatalogValue({ codex: { runtime: 'codex', env: { ANTHROPIC_MODEL: 'x' } } }, SOURCE, true)
    expect(envOnCodex.ok).toBe(false)
    if (!envOnCodex.ok) expect(envOnCodex.error).toContain('"env" belongs to Claude entries')

    const execOnCodex = parseCatalogValue({ codex: { runtime: 'codex', executable: '/bin/x' } }, SOURCE, true)
    expect(execOnCodex.ok).toBe(false)
    if (!execOnCodex.ok) expect(execOnCodex.error).toContain('"executable" belongs to Claude entries')

    const homeOnClaude = parseCatalogValue({ c: { runtime: 'claude', codexHome: '/tmp/x' } }, SOURCE, true)
    expect(homeOnClaude.ok).toBe(false)
    if (!homeOnClaude.ok) expect(homeOnClaude.error).toContain('"codexHome" belongs to Codex entries')

    const netOnClaude = parseCatalogValue({ c: { runtime: 'claude', network: true } }, SOURCE, true)
    expect(netOnClaude.ok).toBe(false)
    if (!netOnClaude.ok) expect(netOnClaude.error).toContain('"network" belongs to Codex entries')
  })

  test('codexHome must be absolute or ~-prefixed; network must be a boolean', () => {
    const relative = parseCatalogValue({ codex: { runtime: 'codex', codexHome: 'rel/home' } }, SOURCE, true)
    expect(relative.ok).toBe(false)
    if (!relative.ok) expect(relative.error).toContain('absolute path or start with ~')

    const badNetwork = parseCatalogValue({ codex: { runtime: 'codex', network: 'yes' } }, SOURCE, true)
    expect(badNetwork.ok).toBe(false)
    if (!badNetwork.ok) expect(badNetwork.error).toContain('network must be a boolean')
  })

  test('codexHome and network are trusted-tier fields, like executable', () => {
    const untrustedHome = parseCatalogValue({ codex: { runtime: 'codex', codexHome: '/tmp/x' } }, SOURCE, false)
    expect(untrustedHome.ok).toBe(false)
    if (!untrustedHome.ok) expect(untrustedHome.error).toContain('user-level catalog')

    const untrustedNetwork = parseCatalogValue({ codex: { runtime: 'codex', network: false } }, SOURCE, false)
    expect(untrustedNetwork.ok).toBe(false)
    if (!untrustedNetwork.ok) expect(untrustedNetwork.error).toContain('user-level catalog')

    // Trusted files accept both.
    const trusted = parseCatalogValue({ codex: { runtime: 'codex', codexHome: '/tmp/x', network: false } }, SOURCE, true)
    expect(trusted.ok).toBe(true)
  })

  test('a providers.json model cannot declare runtime (R2)', () => {
    const SOURCEP = '/tmp/kawai-test/providers.json'
    for (const value of ['codex', 'claude']) {
      const parsed = parseProviderCatalogValue(
        { acme: { models: { m1: { runtime: value } } } },
        SOURCEP,
        true,
      )
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.error).toContain('cannot declare runtime')
        expect(parsed.error).toContain('Codex profile cannot be a model')
      }
    }
  })

  test('providerOf keys a Codex profile by its home-derived provider id (R2)', () => {
    writeProfiles(homeDir, { codex: { label: 'Codex', runtime: 'codex' } })
    const ctx = { homeDir, serverCodexHome: '/tmp/codex-home-a' }
    const resolved = resolveProfileCatalog(ctx)
    expect(resolved.profiles.get('codex')?.providerId).toBe(codexHomeProviderId('/tmp/codex-home-a'))
  })
})
