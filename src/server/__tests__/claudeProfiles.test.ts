// @reads: docs/claude-session-profiles.md
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  claudeLaunchKey,
  claudeProfileMetadata,
  PROFILE_CONTROLLED_ENV,
  resolveClaudeProfile,
  verifyProfileExecutable,
  type ClaudeLaunchConfiguration,
} from '../chat/ClaudeProfiles'
import { resolveProfileCatalog } from '../chat/profileCatalog'

// Every resolution in this file is a Claude entry; the helper narrows the
// launch union so `.env`/`.model` read directly, failing loudly on a Codex arm.
const resolveClaudeLaunch = (
  ...args: Parameters<typeof resolveClaudeProfile>
): ClaudeLaunchConfiguration => {
  const launch = resolveClaudeProfile(...args)
  if (launch.runtime !== 'claude') throw new Error(`expected a Claude launch, got ${launch.runtime}`)
  return launch
}

// Catalog reads are pinned to an empty temp home so a real ~/.kawai can never
// leak into these tests; the shipped default catalog provides the profiles.
let tempHome: string
beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-profiles-'))
})
afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
})

/** Writes a temp user-level catalog; the shipped catalog never defines LAN. */
function userCatalog(entries: Record<string, unknown>): void {
  const dir = path.join(tempHome, '.kawai')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(entries))
}

/** A LAN-like fixture entry (reserved documentation address, no shipped twin). */
function lanEntry(extra: { label?: string; executable?: string; env?: Record<string, string> } = {}): Record<string, unknown> {
  return {
    label: 'LAN',
    ...extra,
    env: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:9292', ...extra.env },
  }
}

/**
 * A user-level catalog that keeps the shipped profiles (a user file replaces
 * both shipped defaults wholesale) and adds the LAN entry the tests exercise.
 * The GLM pair lives in the shipped providers default; these resolution tests
 * read it flattened into legacy entries, with the same launch settings.
 */
function catalogWithLan(): void {
  const shipped = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dir, '../../../config/profiles.default.json'), 'utf8'),
  ) as Record<string, unknown>
  const providers = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dir, '../../../config/providers.default.json'), 'utf8'),
  ) as Record<string, { env?: Record<string, string>; limitResetTimeZone?: string; models?: Record<string, { label?: string; model?: string }> }>
  for (const provider of Object.values(providers)) {
    for (const [key, model] of Object.entries(provider.models ?? {})) {
      shipped[key] = {
        ...(model.label ? { label: model.label } : {}),
        ...(model.model ? { model: model.model } : {}),
        ...(provider.limitResetTimeZone ? { limitResetTimeZone: provider.limitResetTimeZone } : {}),
        env: { ...provider.env },
      }
    }
  }
  userCatalog({ ...shipped, lan: lanEntry({ env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' } }) })
}

describe('Claude profile resolution', () => {
  test('catalog metadata has stable order and carries providers, identifiers, labels, and runtimes', () => {
    // D13 order: the provider holding default first, then file order.
    expect(claudeProfileMetadata({ homeDir: tempHome })).toEqual([
      { id: 'default', label: 'Default', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
      { id: 'opus', label: 'Claude Opus', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
      { id: 'sonnet', label: 'Claude Sonnet', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
      { id: 'haiku', label: 'Claude Haiku', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
      { id: 'glm', label: 'GLM', providerId: 'zai', providerLabel: 'Z.AI', runtime: 'claude' },
      { id: 'glm-flash', label: 'GLM Flash', providerId: 'zai', providerLabel: 'Z.AI', runtime: 'claude' },
      { id: 'openrouter-opus', label: 'OpenRouter Opus', providerId: 'openrouter', providerLabel: 'OpenRouter', runtime: 'claude' },
      { id: 'openrouter-sonnet', label: 'OpenRouter Sonnet', providerId: 'openrouter', providerLabel: 'OpenRouter', runtime: 'claude' },
      { id: 'openrouter-haiku', label: 'OpenRouter Haiku', providerId: 'openrouter', providerLabel: 'OpenRouter', runtime: 'claude' },
      { id: 'openrouter-deepseek-flash', label: 'OpenRouter DeepSeek V4.1 Flash', providerId: 'openrouter', providerLabel: 'OpenRouter', runtime: 'claude' },
      { id: 'openrouter-minimax-flash', label: 'OpenRouter MiniMax M3.1 Flash', providerId: 'openrouter', providerLabel: 'OpenRouter', runtime: 'claude' },
      { id: 'minimax', label: 'MiniMax', providerId: 'minimax', providerLabel: 'MiniMax', runtime: 'claude' },
      { id: 'mimo', label: 'MiMo', providerId: 'mimo', providerLabel: 'MiMo', runtime: 'claude' },
      { id: 'kimi', label: 'Kimi', providerId: 'kimi', providerLabel: 'Kimi', runtime: 'claude' },
    ])
  })
  test('Codex entries follow the provider models, each under the fixed Codex provider (task 3.4)', () => {
    userCatalog({
      codex: { label: 'Codex', runtime: 'codex', model: 'gpt-5.3-codex' },
      'work-codex': { label: 'Work Codex', runtime: 'codex', codexHome: '~/codex-work' },
    })
    const view = claudeProfileMetadata({ homeDir: tempHome })
    const codexRows = view.filter(profile => profile.runtime === 'codex')
    expect(codexRows.map(profile => profile.id)).toEqual(['codex', 'work-codex'])
    for (const row of codexRows) {
      expect(row.providerId).toMatch(/^codex-home-[0-9a-f]{12}$/)
      expect(row.providerLabel).toBe('Codex')
    }
    // The two homes hash differently, so each entry is its own provider group.
    expect(codexRows[0]!.providerId).not.toBe(codexRows[1]!.providerId)
    // And the catalog's profiles read in catalog order: providers first.
    expect(view[view.length - 2]!.id).toBe('codex')
    expect(view[view.length - 1]!.id).toBe('work-codex')
  })
  test('documentation matches catalog labels and effective mappings', () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dir, '../../../docs/claude-session-profiles.md'), 'utf8')
    for (const { id, label } of claudeProfileMetadata({ homeDir: tempHome })) {
      expect(doc).toContain(`| ${id} | ${label} |`)
      const launch = resolveClaudeLaunch(id, {}, { homeDir: tempHome })
      if (id === 'default') continue
      for (const name of PROFILE_CONTROLLED_ENV) {
        const value = launch.env?.[name]
        if (value && value !== '0') expect(doc).toContain(value)
      }
      if (launch.model && launch.model !== 'sonnet') expect(doc).toContain(launch.model)
    }
  })
  test('every fenced catalog example in the docs resolves through the real parser', () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dir, '../../../docs/claude-session-profiles.md'), 'utf8')
    const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1])
    expect(blocks.length).toBeGreaterThan(2)
    for (const block of blocks) {
      const value = JSON.parse(block) as Record<string, unknown>
      // A wire-message example is not a catalog file.
      if ('type' in value) continue
      const isProviders = Object.values(value).some(
        entry => typeof entry === 'object' && entry !== null && 'models' in entry,
      )
      const dir = path.join(tempHome, '.kawai')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(isProviders ? {} : value))
      fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(isProviders ? value : {}))
      const { errors } = resolveProfileCatalog({ homeDir: tempHome })
      expect(errors, block.slice(0, 60)).toEqual([])
    }
  })
  test("the docs' user-level OpenRouter block is the shipped entry and resolves with its key names", () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dir, '../../../docs/claude-session-profiles.md'), 'utf8')
    const block = [...doc.matchAll(/```json\n([\s\S]*?)```/g)]
      .map(match => JSON.parse(match[1]!) as Record<string, unknown>)
      .find(value => 'openrouter' in value)
    const shipped = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../../../config/providers.default.json'), 'utf8')) as Record<string, unknown>
    expect(block).toEqual({ openrouter: shipped.openrouter })
    const dir = path.join(tempHome, '.kawai')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(block))
    const { profiles, errors } = resolveProfileCatalog({ homeDir: tempHome })
    expect(errors).toEqual([])
    expect(profiles.get('openrouter-haiku')).toMatchObject({
      providerId: 'openrouter', authTokenEnv: 'OPENROUTER_API_KEY', balanceKeyEnv: 'OPENROUTER_MANAGEMENT_KEY',
    })
  })
  test('omitted profile preserves existing Default behavior and unknown IDs fail', () => {
    // The shipped catalog names OpenRouter's key variables, so Default gets
    // an explicit environment: the server's, without those variables
    // (openrouter-provider D3 withholding on the no-override path too).
    const launch = resolveClaudeLaunch(undefined, {}, { homeDir: tempHome })
    expect(Object.keys(launch).sort()).toEqual(['env', 'runtime'])
    expect(launch.env?.PATH).toBe(process.env.PATH)
    expect(launch.env).not.toHaveProperty('OPENROUTER_API_KEY')
    expect(launch.env).not.toHaveProperty('OPENROUTER_MANAGEMENT_KEY')
    expect(resolveClaudeLaunch('default', { ANTHROPIC_MODEL: 'global' }, { homeDir: tempHome }).env?.ANTHROPIC_MODEL).toBe('global')
    for (const id of ['unknown', 'glm-turbo', '__proto__']) {
      expect(() => resolveClaudeLaunch(id, {}, { homeDir: tempHome })).toThrow('Unknown Claude profile')
    }
  })
  test('all effective wrapper assignments and prescribed models match', () => {
    const ctx = { homeDir: tempHome }
    const glm = resolveClaudeLaunch('glm', {}, ctx)
    expect(glm.model).toBe('opus')
    expect(glm.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]', ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' })
    const glmFlash = resolveClaudeLaunch('glm-flash', {}, ctx)
    expect(glmFlash.model).toBe('sonnet')
    expect(glmFlash.env).toMatchObject({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]', ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3[1m]' })
    const minimax = resolveClaudeLaunch('minimax', {}, ctx)
    expect(minimax.model).toBe('MiniMax-M3')
    expect(minimax.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_MODEL: 'MiniMax-M3', ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3', ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3', ANTHROPIC_DEFAULT_FABLE_MODEL: 'MiniMax-M3' })
    const mimo = resolveClaudeLaunch('mimo', {}, ctx)
    expect(mimo.model).toBe('mimo-v2.6-pro')
    expect(mimo.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic', ANTHROPIC_MODEL: 'mimo-v2.6-pro', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.6-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.6-pro', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.6-pro', ANTHROPIC_DEFAULT_FABLE_MODEL: 'mimo-v2.6-pro' })
    const kimi = resolveClaudeLaunch('kimi', {}, ctx)
    expect(kimi.model).toBe('kimi-k3[1m]')
    // Extracted: asymmetric matchers mutate the received object, and the env
    // also carries the merged backend environment's unrelated variables.
    const kimiEnv = { ...kimi.env }
    expect(kimiEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    })
  })
  test('every shipped profile with a base URL maps every Claude tier to a provider model', () => {
    // resolveClaudeLaunch() clears inherited profile-controlled variables, so
    // an unmapped tier would send a Claude model name to the provider. The
    // shipped checks read both defaults: legacy entries and provider models,
    // whose tier maps sit at the provider level.
    const tiers = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL']
    const catalog = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../../../config/profiles.default.json'), 'utf8'),
    ) as Record<string, { model?: string; env?: Record<string, string> }>
    for (const [id, entry] of Object.entries(catalog)) {
      if (!entry.env?.ANTHROPIC_BASE_URL) continue
      expect(entry.model, `${id} startup model`).toBeTruthy()
      for (const tier of tiers) expect(entry.env?.[tier], `${id} ${tier}`).toBeTruthy()
    }
    const providers = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../../../config/providers.default.json'), 'utf8'),
    ) as Record<string, { env?: Record<string, string>; models?: Record<string, { model?: string }> }>
    for (const [id, provider] of Object.entries(providers)) {
      if (!provider.env?.ANTHROPIC_BASE_URL) continue
      for (const tier of tiers) expect(provider.env?.[tier], `${id} ${tier}`).toBeTruthy()
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        expect(model.model, `${id}/${key} startup model`).toBeTruthy()
      }
    }
    // And the shipped catalog resolves cleanly (every env name is
    // profile-controlled, no file failures).
    const reported: string[][] = []
    resolveClaudeLaunch('default', {}, { homeDir: tempHome }, errors => reported.push(errors))
    expect(reported).toEqual([])
  })
  test('a user-catalog LAN entry resolves like a shipped profile would', () => {
    catalogWithLan()
    const ctx = { homeDir: tempHome }
    expect(resolveClaudeLaunch('lan', {}, ctx).env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://192.0.2.10:9292', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' })
    expect(resolveClaudeLaunch('lan', {}, ctx).model).toBeUndefined()
  })
  test('named profiles clean controlled variables, keep runtime and credentials, and never mutate inputs', () => {
    catalogWithLan()
    const ctx = { homeDir: tempHome }
    const input = Object.fromEntries(PROFILE_CONTROLLED_ENV.map((name) => [name, 'conflict']))
    Object.assign(input, { ANTHROPIC_AUTH_TOKEN: 'test-secret', PATH: '/test/path', HOME: '/test/home', CLAUDE_CONFIG_DIR: '/test/config', UNRELATED: 'yes' })
    const before = { ...input }
    const lan = resolveClaudeLaunch('lan', input, ctx)
    expect(lan.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'test-secret', PATH: '/test/path', HOME: '/test/home', CLAUDE_CONFIG_DIR: '/test/config', UNRELATED: 'yes' })
    for (const name of PROFILE_CONTROLLED_ENV) {
      if (name !== 'ANTHROPIC_BASE_URL' && name !== 'CLAUDE_CODE_ATTRIBUTION_HEADER') expect(lan.env?.[name]).toBeUndefined()
    }
    expect(input).toEqual(before)
    const glm = resolveClaudeLaunch('glm', input, ctx)
    const minimax = resolveClaudeLaunch('minimax', input, ctx)
    expect(glm.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000')
    expect(minimax.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(lan.env?.HOME).toBe('/test/home')
  })
})

describe('executable-backed profiles', () => {
  test('launch hands off the merged base environment with no inline settings', () => {
    userCatalog({ lan: { ...lanEntry(), executable: '/usr/local/bin/claude-lan' } })
    const launch = resolveClaudeLaunch('lan', { ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'global-model' }, { homeDir: tempHome })
    expect(launch.executable).toBe('/usr/local/bin/claude-lan')
    // Credentials and inherited routing pass through; entry values win over them.
    expect(launch.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'http://192.0.2.10:9292' })
    expect(launch.env?.ANTHROPIC_MODEL).toBe('global-model')
    // No inline controlled settings: the wrapper owns its provider config.
    expect(launch.settings).toBeUndefined()
  })

  test('wrapper exports win over pre-applied entry values at launch time', () => {
    userCatalog({ wrap: { label: 'Wrap', executable: '/usr/local/bin/claude-wrap', env: { ANTHROPIC_MODEL: 'entry-model' } } })
    const launch = resolveClaudeLaunch('wrap', {}, { homeDir: tempHome })
    // The entry value is pre-applied into the environment the wrapper sees...
    expect(launch.env?.ANTHROPIC_MODEL).toBe('entry-model')
    // ...and, being a plain environment export, the wrapper's own export of
    // the same variable replaces it in the launched process (no settings
    // layer exists to re-override it).
    expect(launch.settings).toBeUndefined()
    expect(launch.executable).toBe('/usr/local/bin/claude-wrap')
  })

  test('verifyProfileExecutable produces actionable errors naming the path', () => {
    const missing = path.join(tempHome, 'no-such-wrapper')
    expect(() => verifyProfileExecutable('lan', missing)).toThrow(`Profile "lan" executable was not found: ${missing}`)
    const notExecutable = path.join(tempHome, 'plain.txt')
    fs.writeFileSync(notExecutable, 'text')
    expect(() => verifyProfileExecutable('lan', notExecutable)).toThrow('is not executable')
    const directory = fs.mkdtempSync(path.join(tempHome, 'dir-'))
    expect(() => verifyProfileExecutable('lan', directory)).toThrow('is not a file')
    const script = path.join(tempHome, 'wrapper.sh')
    fs.writeFileSync(script, '#!/bin/sh\nexec claude "$@"\n')
    fs.chmodSync(script, 0o755)
    expect(() => verifyProfileExecutable('lan', script)).not.toThrow()
  })

  test('launch key separates profiles that differ only by executable', () => {
    const base = { runtime: 'claude' as const, env: { ANTHROPIC_BASE_URL: 'https://same.example' }, model: 'same' }
    const a = claudeLaunchKey({ ...base, executable: '/wrappers/a' })
    const b = claudeLaunchKey({ ...base, executable: '/wrappers/b' })
    const neither = claudeLaunchKey({ ...base })
    expect(a).not.toBe(b)
    expect(a).not.toBe(neither)
    expect(claudeLaunchKey({ ...base, executable: '/wrappers/a' })).toBe(a)
  })
})

describe('catalog reporting', () => {
  test('home-relative project paths resolve their project catalog', () => {
    const project = path.join(tempHome, 'proj')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      'home-proj': { label: 'Home Proj', model: 'glm-5.3-flash[1m]' },
    }))
    const launch = resolveClaudeLaunch('home-proj', {}, { homeDir: tempHome, projectPath: '~/proj' })
    expect(launch.model).toBe('glm-5.3-flash[1m]')
  })

  test('launch resolution reports catalog file failures', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-profileerr-'))
    try {
      const badFile = path.join(project, '.kawai', 'profiles.json')
      fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
      fs.writeFileSync(badFile, '{ not json')
      const reported: string[][] = []
      // The invalid file is skipped (the shipped catalog still resolves), but
      // the failure reaches the reporter instead of vanishing.
      const launch = resolveClaudeLaunch('default', {}, { homeDir: tempHome, projectPath: project },
        errors => reported.push(errors))
      // Default sets no overrides: the launch carries the filtered environment
      // and the runtime discriminant, and no flag-layer settings.
      expect(Object.keys(launch).sort()).toEqual(['env', 'runtime'])
      expect(launch.settings).toBeUndefined()
      expect(reported).toHaveLength(1)
      expect(reported[0]).toHaveLength(1)
      expect(reported[0]![0]).toContain(badFile)
      // No callback, no throw: resolution keeps working for callers that
      // cannot report.
      expect(() => resolveClaudeLaunch('default', {}, { homeDir: tempHome, projectPath: project })).not.toThrow()
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})
