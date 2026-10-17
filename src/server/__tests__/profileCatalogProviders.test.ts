import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseProviderCatalogValue,
  providerOf,
  resolveProfileCatalog,
  type ProfileCatalogContext,
} from '../chat/profileCatalog'

let tempRoot: string
let homeDir: string
let projectDir: string

function writeJson(dir: string, name: string, json: unknown): string {
  const file = path.join(dir, '.kawai', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(json))
  return file
}

const writeProviders = (dir: string, json: unknown) => writeJson(dir, 'providers.json', json)
const writeProfiles = (dir: string, json: unknown) => writeJson(dir, 'profiles.json', json)

/** Shipped fixtures read as the image defaults, so tests never see the real shipped files. */
const shippedCtx = (providers: string, profiles: string, extra: Partial<ProfileCatalogContext> = {}) => ({
  homeDir: path.join(tempRoot, 'no-home'),
  imageDefaultProvidersPath: providers,
  imageDefaultPath: profiles,
  ...extra,
})

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-providers-'))
  homeDir = path.join(tempRoot, 'home')
  projectDir = path.join(tempRoot, 'work', 'proj')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('providers.json parsing and validation', () => {
  test('two models share a provider, each starting on its own model', () => {
    writeProviders(homeDir, {
      zai: {
        label: 'Z.AI',
        env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic' },
        models: { glm: { label: 'GLM', model: 'opus' }, 'glm-flash': { label: 'GLM Flash', model: 'sonnet' } },
      },
    })
    const { profiles, providers, errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toEqual([])
    expect(profiles.get('glm')).toEqual({
      label: 'GLM', model: 'opus', providerId: 'zai',
      env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic' },
    })
    expect(profiles.get('glm-flash')?.model).toBe('sonnet')
    expect(providers.get('zai')).toEqual({ label: 'Z.AI', models: ['glm', 'glm-flash'] })
  })

  test('a model setting overrides its provider env per key; labels default to ids', () => {
    writeProviders(homeDir, {
      zai: {
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' },
        models: { glm: { model: 'opus', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' } }, bare: {} },
      },
    })
    const { profiles, errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toEqual([])
    expect(profiles.get('glm')?.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000')
    // A model without env still launches with its provider's environment.
    expect(profiles.get('bare')).toEqual({
      label: 'bare', providerId: 'zai', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' },
    })
  })

  test('a model-level base URL is refused, naming the file, provider, and model', () => {
    const bad = writeProviders(projectDir, {
      zai: { models: { glm: { env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic' } } } },
    })
    writeProviders(homeDir, { ok: { models: { fine: { label: 'Fine' } } } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(bad)
    expect(errors[0]).toContain('zai')
    expect(errors[0]).toContain('glm')
    // Providers from the other discovered files stay available.
    expect(profiles.get('fine')?.providerId).toBe('ok')
  })

  test('credentials are refused at the provider and model levels', () => {
    writeProviders(homeDir, {
      leaky: { env: { ANTHROPIC_AUTH_TOKEN: 'secret' }, models: {} },
    })
    expect(resolveProfileCatalog({ homeDir }).errors[0]).toContain('ANTHROPIC_AUTH_TOKEN')
    writeProviders(homeDir, {
      leaky2: { models: { m: { env: { ANTHROPIC_API_KEY: 'secret' } } } },
    })
    const { errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('ANTHROPIC_API_KEY')
    expect(errors[0]).toContain('"m"')
  })

  test('provider executable is trusted-files-only and absolute', () => {
    writeProviders(homeDir, { lan: { executable: 'bin/claude-lan', models: { lan: {} } } })
    expect(resolveProfileCatalog({ homeDir }).errors[0]).toContain('absolute')
    writeProviders(homeDir, { lan: { executable: '/usr/local/bin/claude-lan', models: { lan: {} } } })
    const trusted = resolveProfileCatalog({ homeDir })
    expect(trusted.errors).toEqual([])
    expect(trusted.profiles.get('lan')?.executable).toBe('/usr/local/bin/claude-lan')
    const evil = writeProviders(projectDir, { evil: { executable: '/tmp/evil', models: {} } })
    const untrusted = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(untrusted.errors[0]).toContain(evil)
    expect(untrusted.errors[0]).toContain('not operator-owned')
    expect(untrusted.profiles.has('evil')).toBe(false)
  })

  test('a model key defined under two providers of one file fails the file', () => {
    writeProviders(homeDir, {
      aa: { models: { glm: { label: 'A' } } },
      bb: { models: { glm: { label: 'B' } } },
    })
    const { errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('both provider "aa" and provider "bb"')
  })

  test('unknown provider fields and malformed shapes are refused', () => {
    writeProviders(homeDir, { zai: { favorite: 'yes', models: {} } })
    expect(resolveProfileCatalog({ homeDir }).errors).toHaveLength(1)
    writeProviders(homeDir, { zai: { models: 'nope' } })
    expect(resolveProfileCatalog({ homeDir }).errors).toHaveLength(1)
    const parsed = parseProviderCatalogValue('a string', 'src', true)
    expect(parsed.ok).toBe(false)
  })
})

describe('provider merging across levels', () => {
  test('a provider overlay reaches every model of the provider', () => {
    writeProviders(homeDir, {
      zai: {
        label: 'Z.AI',
        env: { ANTHROPIC_BASE_URL: 'https://user.example.internal/api' },
        models: { glm: { model: 'opus' }, 'glm-flash': { model: 'sonnet' } },
      },
    })
    writeProviders(projectDir, { zai: { env: { ANTHROPIC_BASE_URL: 'https://project.example.internal/api' } } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(errors).toEqual([])
    expect(profiles.get('glm')?.env.ANTHROPIC_BASE_URL).toBe('https://project.example.internal/api')
    expect(profiles.get('glm-flash')?.env.ANTHROPIC_BASE_URL).toBe('https://project.example.internal/api')
    expect(profiles.get('glm')?.providerId).toBe('zai')
  })

  test('provider labels merge nearest-wins without touching models', () => {
    writeProviders(homeDir, { zai: { label: 'Z.AI', models: { glm: { label: 'GLM' } } } })
    writeProviders(projectDir, { zai: { label: 'Z.AI Project' } })
    const { providers, profiles } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(providers.get('zai')?.label).toBe('Z.AI Project')
    expect(profiles.get('glm')?.label).toBe('GLM')
  })

  test('an entry naming a model of an operator provider is ignored with an error naming both files', () => {
    const providerFile = writeProviders(homeDir, { zai: { models: { glm: {}, 'glm-flash': {} } } })
    const entryFile = writeProfiles(projectDir, { glm: { label: 'Hijack' } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(providerFile)
    expect(errors[0]).toContain(entryFile)
    expect(profiles.get('glm')).toEqual({ label: 'glm', env: {}, providerId: 'zai' })
  })

  test('a nearer operator duplicate is ignored; the error names both providers and files', () => {
    const userFile = writeProviders(homeDir, { zai: { models: { glm: {} } } })
    const projectFile = writeProviders(projectDir, { zai2: { models: { glm: {} } } })
    const { profiles, providers, errors } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(userFile)
    expect(errors[0]).toContain(projectFile)
    expect(profiles.get('glm')?.providerId).toBe('zai')
    expect(providers.get('zai2')?.models).toEqual([])
  })
})

describe('shipped keys re-home against nearer files', () => {
  // The shipped defaults as fixtures: provider zai holding the GLM pair.
  const shippedProviders = () => {
    const file = path.join(tempRoot, 'shipped', 'providers.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      zai: {
        label: 'Z.AI',
        limitResetTimeZone: 'Asia/Shanghai',
        env: {
          ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
        },
        models: {
          glm: { label: 'GLM', model: 'opus', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' } },
          'glm-flash': { label: 'GLM Flash', model: 'sonnet' },
        },
      },
    }))
    return file
  }
  const emptyProfiles = () => {
    const file = path.join(tempRoot, 'shipped', 'profiles.json')
    fs.writeFileSync(file, '{}')
    return file
  }

  test('a project legacy override keeps the flattened shipped settings, as its own provider', () => {
    writeProfiles(projectDir, {
      glm: { label: 'My GLM', env: { ANTHROPIC_BASE_URL: 'https://private.example.internal/api' } },
    })
    const { profiles, providers, errors } = resolveProfileCatalog(
      shippedCtx(shippedProviders(), emptyProfiles(), { projectPath: projectDir })
    )
    expect(errors).toEqual([])
    // Deep-equal to the flat master merge of shipped glm with the override.
    expect(profiles.get('glm')).toEqual({
      label: 'My GLM',
      model: 'opus',
      env: {
        ANTHROPIC_BASE_URL: 'https://private.example.internal/api',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      },
      limitResetTimeZone: 'Asia/Shanghai',
      providerId: 'glm',
    })
    // Only that key left zai.
    expect(providers.get('zai')?.models).toEqual(['glm-flash'])
    expect(profiles.get('glm-flash')).toEqual({
      label: 'GLM Flash', model: 'sonnet',
      env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]' },
      limitResetTimeZone: 'Asia/Shanghai',
      providerId: 'zai',
    })
  })

  test('a nearer providers.json re-homes the key with the shipped settings as base', () => {
    writeProviders(projectDir, { zai2: { models: { glm: { label: 'P-Glm' } } } })
    const { profiles, errors } = resolveProfileCatalog(
      shippedCtx(shippedProviders(), emptyProfiles(), { projectPath: projectDir })
    )
    expect(errors).toEqual([])
    expect(profiles.get('glm')).toEqual({
      label: 'P-Glm',
      model: 'opus',
      env: {
        ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      },
      limitResetTimeZone: 'Asia/Shanghai',
      providerId: 'zai2',
    })
  })

  test('a shipped key with no override stays under its shipped provider', () => {
    const { profiles, errors } = resolveProfileCatalog(shippedCtx(shippedProviders(), emptyProfiles()))
    expect(errors).toEqual([])
    expect(profiles.get('glm')?.providerId).toBe('zai')
    expect(profiles.get('glm-flash')?.providerId).toBe('zai')
  })
})

describe('implicit default and catalog order', () => {
  test('the implicit default joins a default provider a file defines', () => {
    writeProviders(homeDir, { default: { models: {} }, zai: { models: { glm: {} } } })
    const { profiles, providers } = resolveProfileCatalog({ homeDir })
    expect(profiles.get('default')).toEqual({ label: 'Default', env: {}, providerId: 'default' })
    expect(providers.get('default')?.models).toEqual(['default'])
  })

  test('the providers view puts the default-holder first, then file order (D13)', () => {
    writeProviders(homeDir, {
      zai: { models: { glm: {} } },
      claude: { models: { default: {}, opus: {} } },
    })
    writeProfiles(homeDir, { mimo: {} })
    const { providers } = resolveProfileCatalog({ homeDir })
    expect([...providers.keys()]).toEqual(['claude', 'zai', 'mimo'])
  })

  test('a profiles-only catalog resolves the flat master output plus providerId', () => {
    writeProfiles(homeDir, {
      glm: {
        label: 'GLM', model: 'opus', limitResetTimeZone: 'Asia/Shanghai',
        env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic' },
      },
      'glm-flash': { model: 'sonnet' },
      lan: { label: 'LAN', executable: '/usr/local/bin/claude-lan' },
    })
    const { profiles, providers, errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toEqual([])
    expect([...profiles.keys()]).toEqual(['glm', 'glm-flash', 'lan', 'default'])
    expect(profiles.get('glm')).toEqual({
      label: 'GLM', model: 'opus', limitResetTimeZone: 'Asia/Shanghai',
      env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic' }, providerId: 'glm',
    })
    expect(profiles.get('glm-flash')).toEqual({ label: 'glm-flash', model: 'sonnet', env: {}, providerId: 'glm-flash' })
    expect(profiles.get('lan')).toEqual({ label: 'LAN', executable: '/usr/local/bin/claude-lan', env: {}, providerId: 'lan' })
    expect(profiles.get('default')).toEqual({ label: 'Default', env: {}, providerId: 'default' })
    expect(providers.get('glm')).toEqual({ label: 'GLM', models: ['glm'] })
  })
})

describe('providerOf', () => {
  const shippedProviders = () => {
    const file = path.join(tempRoot, 'shipped', 'providers.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ zai: { models: { glm: {} } } }))
    return file
  }

  test('resolves a provider hit and the unknown-profile fallback', () => {
    const profiles = path.join(tempRoot, 'shipped', 'profiles.json')
    fs.mkdirSync(path.dirname(profiles), { recursive: true })
    fs.writeFileSync(profiles, '{}')
    const ctx = shippedCtx(shippedProviders(), profiles)
    expect(providerOf('glm', ctx)).toBe('zai')
    expect(providerOf('ghost', ctx)).toBe('ghost')
  })

  test('the cache re-derives when either catalog file changes', () => {
    const providers = shippedProviders()
    const profiles = path.join(tempRoot, 'shipped', 'profiles.json')
    fs.writeFileSync(profiles, '{}')
    const ctx = shippedCtx(providers, profiles)
    expect(providerOf('glm', ctx)).toBe('zai')
    // A change to the providers file re-derives.
    fs.writeFileSync(providers, JSON.stringify({ zai: { models: { glm: {} } }, claude: { models: { haiku: {} } } }))
    expect(providerOf('haiku', ctx)).toBe('claude')
    // A user-level profiles.json replaces the shipped base and re-derives.
    writeProfiles(homeDir, { glm: { label: 'Own GLM' } })
    const userCtx: ProfileCatalogContext = { homeDir }
    expect(providerOf('glm', userCtx)).toBe('glm')
  })
})
