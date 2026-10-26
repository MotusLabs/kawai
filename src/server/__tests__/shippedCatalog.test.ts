// @reads: .kawai/groups, .kawai/groups/**
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_PROVIDER_CATALOG_PATH,
  EMBEDDED_PROFILE_CATALOG_SOURCE,
  EMBEDDED_PROVIDER_CATALOG_SOURCE,
  resolveProfileCatalog,
} from '../chat/profileCatalog'

// The shipped default resolves as grouped providers: `zai` holds the GLM
// pair, one `claude` provider holds the four Claude models, and the legacy
// profiles default keeps the one-model gateways. Every key keeps the launch
// settings of the pre-provider shipped catalog, apart from `providerId`.
let tempRoot: string
let projectDir: string

const freshHomeCtx = () => ({ homeDir: path.join(tempRoot, 'no-home') })

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-shipped-'))
  projectDir = path.join(tempRoot, 'work', 'proj')
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('grouped shipped default on a fresh HOME', () => {
  test('glm and glm-flash belong to zai; the four Claude models share one provider', () => {
    const { profiles, providers, errors } = resolveProfileCatalog(freshHomeCtx())
    expect(errors).toEqual([])
    expect(profiles.get('glm')?.providerId).toBe('zai')
    expect(profiles.get('glm-flash')?.providerId).toBe('zai')
    for (const id of ['default', 'opus', 'sonnet', 'haiku']) {
      expect(profiles.get(id)?.providerId).toBe('claude')
    }
    for (const id of ['mimo', 'kimi', 'minimax']) {
      expect(profiles.get(id)?.providerId).toBe(id)
    }
    expect(providers.get('claude')?.models).toEqual(['default', 'opus', 'sonnet', 'haiku'])
    expect(providers.get('zai')?.models).toEqual(['glm', 'glm-flash'])
  })

  test('every shipped key keeps the pre-provider launch settings, apart from providerId', () => {
    const { profiles, errors } = resolveProfileCatalog(freshHomeCtx())
    expect(errors).toEqual([])
    const zaiEnv = {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    }
    expect(profiles.get('glm')).toEqual({
      label: 'GLM', model: 'opus', env: zaiEnv, limitResetTimeZone: 'Asia/Shanghai', providerId: 'zai',
    })
    expect(profiles.get('glm-flash')).toEqual({
      label: 'GLM Flash', model: 'sonnet', env: zaiEnv, limitResetTimeZone: 'Asia/Shanghai', providerId: 'zai',
    })
    expect(profiles.get('default')).toEqual({ label: 'Default', env: {}, providerId: 'claude' })
    expect(profiles.get('opus')).toEqual({ label: 'Claude Opus', model: 'claude-opus-5-5', env: {}, providerId: 'claude' })
    expect(profiles.get('sonnet')).toEqual({ label: 'Claude Sonnet', model: 'claude-sonnet-5-5', env: {}, providerId: 'claude' })
    expect(profiles.get('haiku')).toEqual({ label: 'Claude Haiku', model: 'claude-haiku-5-5', env: {}, providerId: 'claude' })
    expect(profiles.get('minimax')?.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic')
    expect(profiles.get('mimo')?.model).toBe('mimo-v2.6-pro')
    expect(profiles.get('kimi')?.model).toBe('kimi-k3[1m]')
  })

  test('the three tier OpenRouter models resolve to provider openrouter with its key names and mappings', () => {
    const { profiles, providers, errors } = resolveProfileCatalog(freshHomeCtx())
    expect(errors).toEqual([])
    const env = {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '~anthropic/claude-opus-latest[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '~anthropic/claude-sonnet-latest[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: '~anthropic/claude-haiku-latest',
      ANTHROPIC_DEFAULT_FABLE_MODEL: '~anthropic/claude-opus-latest[1m]',
    }
    const credentials = { authTokenEnv: 'OPENROUTER_API_KEY', balanceKeyEnv: 'OPENROUTER_MANAGEMENT_KEY' }
    for (const [id, label, model] of [
      ['openrouter-opus', 'OpenRouter Opus', 'opus'],
      ['openrouter-sonnet', 'OpenRouter Sonnet', 'sonnet'],
      ['openrouter-haiku', 'OpenRouter Haiku', 'haiku'],
    ]) {
      expect(profiles.get(id!)).toEqual({ label, model, env, providerId: 'openrouter', ...credentials })
    }
    expect(providers.get('openrouter')).toEqual({
      label: 'OpenRouter',
      models: ['openrouter-opus', 'openrouter-sonnet', 'openrouter-haiku', 'openrouter-deepseek-flash', 'openrouter-minimax-flash'],
      ...credentials,
    })
  })

  test('the flash OpenRouter models start on their slugs; every alias maps to it', () => {
    const { profiles, errors } = resolveProfileCatalog(freshHomeCtx())
    expect(errors).toEqual([])
    const credentials = { authTokenEnv: 'OPENROUTER_API_KEY', balanceKeyEnv: 'OPENROUTER_MANAGEMENT_KEY' }
    const env = (slug: string) => ({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_DEFAULT_OPUS_MODEL: slug,
      ANTHROPIC_DEFAULT_SONNET_MODEL: slug,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: slug,
      ANTHROPIC_DEFAULT_FABLE_MODEL: slug,
    })
    for (const [id, label, slug] of [
      ['openrouter-deepseek-flash', 'OpenRouter DeepSeek V4.1 Flash', 'deepseek/deepseek-v4.1-flash-1017'],
      ['openrouter-minimax-flash', 'OpenRouter MiniMax M3.1 Flash', 'minimax/minimax-m3.1-flash'],
    ]) {
      expect(profiles.get(id!)).toEqual({ label, model: slug, env: env(slug!), providerId: 'openrouter', ...credentials })
    }
  })

  test('the shipped Codex entries resolve with runtime codex and their models', () => {
    const { profiles, errors } = resolveProfileCatalog(freshHomeCtx())
    expect(errors).toEqual([])
    for (const [id, label, model] of [
      ['codex-sol', 'Codex Sol', 'gpt-6.1-sol'],
      ['codex-luna', 'Codex Luna', 'gpt-6-luna'],
    ]) {
      // Codex entries sit outside every provider: the provider id is the
      // resolved home's hash (R2), so it is shape-checked, then echoed.
      const profile = profiles.get(id!)
      expect(profile?.providerId).toMatch(/^codex-home-[0-9a-f]{12}$/)
      expect(profile).toEqual({ label, env: {}, model, runtime: 'codex', providerId: profile!.providerId })
    }
  })

  test('the providers view orders the default-holder first, then file order (D13)', () => {
    const { providers } = resolveProfileCatalog(freshHomeCtx())
    expect([...providers.keys()]).toEqual(['claude', 'zai', 'openrouter', 'minimax', 'mimo', 'kimi'])
    expect(providers.get('minimax')).toEqual({ label: 'MiniMax', models: ['minimax'] })
  })

  test('a project-level legacy glm override resolves as its own provider, settings unchanged', () => {
    const project = path.join(projectDir, '.kawai', 'profiles.json')
    fs.mkdirSync(path.dirname(project), { recursive: true })
    fs.writeFileSync(project, JSON.stringify({
      glm: { label: 'Private GLM', env: { ANTHROPIC_BASE_URL: 'https://private.example.internal/api' } },
    }))
    const { profiles, providers, errors } = resolveProfileCatalog({ ...freshHomeCtx(), projectPath: projectDir })
    expect(errors).toEqual([])
    // Deep-equal to the flat merge of the shipped glm entry with the override.
    expect(profiles.get('glm')).toEqual({
      label: 'Private GLM',
      model: 'opus',
      env: {
        ANTHROPIC_BASE_URL: 'https://private.example.internal/api',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3[1m]',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      },
      limitResetTimeZone: 'Asia/Shanghai',
      providerId: 'glm',
    })
    expect(providers.get('zai')?.models).toEqual(['glm-flash'])
    expect(profiles.get('glm-flash')?.providerId).toBe('zai')
  })

  test('a user-level profiles.json alone replaces both shipped files', () => {
    const home = path.join(tempRoot, 'home')
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ only: { label: 'Only' } }))
    const { profiles, errors } = resolveProfileCatalog({ homeDir: home })
    expect(errors).toEqual([])
    expect([...profiles.keys()]).toEqual(['only', 'default'])
  })

  test('the tracked group files name profile ids the shipped catalog resolves', () => {
    const groupsDir = path.resolve(process.cwd(), '.kawai', 'groups')
    const files = fs.readdirSync(groupsDir).filter(name => name.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
    const { profiles, errors } = resolveProfileCatalog(freshHomeCtx())
    expect(errors).toEqual([])
    const named = new Set<string>()
    for (const name of files) {
      const text = fs.readFileSync(path.join(groupsDir, name), 'utf8')
      for (const match of text.matchAll(/^(?:profiles|workers):\s*(.+)$/gm)) {
        const value = match[1]
        const items = value.startsWith('[') || value.startsWith('{')
          ? value.slice(1, -1).split(',').map(part => (part.split(':')[0] ?? '').trim().replace(/['"]/g, ''))
          : [value.trim().replace(/['"]/g, '')]
        for (const item of items) {
          if (/^[a-z0-9][a-z0-9-]*$/.test(item)) named.add(item)
        }
      }
    }
    expect(named.size).toBeGreaterThan(0)
    for (const id of named) {
      expect(profiles.has(id)).toBe(true)
    }
  })
})

describe('embedded shipped defaults', () => {
  // Findings L1/L2 from the embedded-shipped-catalog review, for BOTH files:
  // a non-ENOENT read error never falls back to the embedded copy, and the
  // literal "(embedded)" source names are pinned, not just the constants.
  const expectSources = ['config/profiles.default.json (embedded)', 'config/providers.default.json (embedded)']

  test('the literal embedded source names are pinned', () => {
    expect(EMBEDDED_PROFILE_CATALOG_SOURCE).toBe(expectSources[0])
    expect(EMBEDDED_PROVIDER_CATALOG_SOURCE).toBe(expectSources[1])
  })

  test('a shipped default path that cannot be read reports the error with no embedded fallback', () => {
    const dirProfiles = path.join(tempRoot, 'profiles.default.json')
    const dirProviders = path.join(tempRoot, 'providers.default.json')
    fs.mkdirSync(dirProfiles)
    fs.mkdirSync(dirProviders)
    const { errors } = resolveProfileCatalog({
      homeDir: path.join(tempRoot, 'no-home'),
      imageDefaultPath: dirProfiles,
      imageDefaultProvidersPath: dirProviders,
    })
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain(dirProviders)
    expect(errors[0]).toContain('cannot be read (EISDIR)')
    expect(errors[0]).not.toContain('(embedded)')
    expect(errors[1]).toContain(dirProfiles)
    expect(errors[1]).toContain('cannot be read (EISDIR)')
    expect(errors[1]).not.toContain('(embedded)')
  })

  test('missing shipped files resolve the embedded copies with no errors', () => {
    const embedded = resolveProfileCatalog({
      homeDir: path.join(tempRoot, 'no-home'),
      imageDefaultPath: path.join(tempRoot, 'absent-profiles.json'),
      imageDefaultProvidersPath: path.join(tempRoot, 'absent-providers.json'),
    })
    const fromFiles = resolveProfileCatalog(freshHomeCtx())
    expect(embedded.errors).toEqual([])
    expect([...embedded.profiles.keys()].sort()).toEqual([...fromFiles.profiles.keys()].sort())
    for (const [id, profile] of fromFiles.profiles) {
      expect(embedded.profiles.get(id)).toEqual(profile)
    }
    expect(DEFAULT_PROVIDER_CATALOG_PATH).toContain('config/providers.default.json')
  })
})
