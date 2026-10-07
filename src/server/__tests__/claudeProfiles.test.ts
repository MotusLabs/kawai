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
} from '../chat/ClaudeProfiles'

// Catalog reads are pinned to an empty temp home so a real ~/.kawai can never
// leak into these tests; the shipped default catalog provides the profiles.
let tempHome: string
beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-profiles-'))
})
afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('Claude profile resolution', () => {
  test('catalog metadata has stable order and contains only identifiers and labels', () => {
    expect(claudeProfileMetadata({ homeDir: tempHome })).toEqual([
      { id: 'default', label: 'Default' }, { id: 'glm', label: 'GLM' },
      { id: 'minimax', label: 'MiniMax' }, { id: 'mimo', label: 'MiMo' },
      { id: 'kimi', label: 'Kimi' }, { id: 'lan', label: 'LAN' },
    ])
  })
  test('documentation matches catalog labels and effective mappings', () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dir, '../../../docs/claude-session-profiles.md'), 'utf8')
    for (const { id, label } of claudeProfileMetadata({ homeDir: tempHome })) {
      expect(doc).toContain(`| ${id} | ${label} |`)
      const launch = resolveClaudeProfile(id, {}, { homeDir: tempHome })
      if (id === 'default') continue
      for (const name of PROFILE_CONTROLLED_ENV) {
        const value = launch.env?.[name]
        if (value && value !== '0') expect(doc).toContain(value)
      }
      if (launch.model && launch.model !== 'sonnet') expect(doc).toContain(launch.model)
    }
  })
  test('omitted profile preserves existing Default behavior and unknown IDs fail', () => {
    expect(resolveClaudeProfile(undefined, {}, { homeDir: tempHome })).toEqual({})
    expect(resolveClaudeProfile('default', { ANTHROPIC_MODEL: 'global' }, { homeDir: tempHome }).env?.ANTHROPIC_MODEL).toBe('global')
    for (const id of ['unknown', 'glm-flash', '__proto__']) {
      expect(() => resolveClaudeProfile(id, {}, { homeDir: tempHome })).toThrow('Unknown Claude profile')
    }
  })
  test('all effective wrapper assignments and prescribed models match', () => {
    const ctx = { homeDir: tempHome }
    const glm = resolveClaudeProfile('glm', {}, ctx)
    expect(glm.model).toBe('sonnet')
    expect(glm.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://zai.ruslan.casa/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' })
    const minimax = resolveClaudeProfile('minimax', {}, ctx)
    expect(minimax.model).toBe('MiniMax-M3')
    expect(minimax.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_MODEL: 'MiniMax-M3' })
    const mimo = resolveClaudeProfile('mimo', {}, ctx)
    expect(mimo.model).toBe('mimo-v2.6-pro')
    expect(mimo.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://xiaomi.ruslan.casa/anthropic', ANTHROPIC_MODEL: 'mimo-v2.6-pro', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.6-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.6-pro' })
    expect(resolveClaudeProfile('kimi', {}, ctx).env?.ANTHROPIC_BASE_URL).toBe('https://kimi.ruslan.casa/')
    expect(resolveClaudeProfile('lan', {}, ctx).env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://ai.lan:9292', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' })
    expect(resolveClaudeProfile('kimi', {}, ctx).model).toBeUndefined()
    expect(resolveClaudeProfile('lan', {}, ctx).model).toBeUndefined()
  })
  test('named profiles clean controlled variables, keep runtime and credentials, and never mutate inputs', () => {
    const ctx = { homeDir: tempHome }
    const input = Object.fromEntries(PROFILE_CONTROLLED_ENV.map((name) => [name, 'conflict']))
    Object.assign(input, { ANTHROPIC_AUTH_TOKEN: 'test-secret', PATH: '/test/path', HOME: '/test/home', CLAUDE_CONFIG_DIR: '/test/config', UNRELATED: 'yes' })
    const before = { ...input }
    const lan = resolveClaudeProfile('lan', input, ctx)
    expect(lan.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'test-secret', PATH: '/test/path', HOME: '/test/home', CLAUDE_CONFIG_DIR: '/test/config', UNRELATED: 'yes' })
    for (const name of PROFILE_CONTROLLED_ENV) {
      if (name !== 'ANTHROPIC_BASE_URL' && name !== 'CLAUDE_CODE_ATTRIBUTION_HEADER') expect(lan.env?.[name]).toBeUndefined()
    }
    expect(input).toEqual(before)
    const glm = resolveClaudeProfile('glm', input, ctx)
    const minimax = resolveClaudeProfile('minimax', input, ctx)
    expect(glm.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000')
    expect(minimax.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(lan.env?.HOME).toBe('/test/home')
  })
})

describe('executable-backed profiles', () => {
  function userCatalog(entries: Record<string, unknown>): void {
    const dir = path.join(tempHome, '.kawai')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(entries))
  }

  test('launch hands off the merged base environment with no inline settings', () => {
    userCatalog({ lan: { label: 'LAN', executable: '/usr/local/bin/claude-lan', env: { ANTHROPIC_BASE_URL: 'http://ai.lan:9292' } } })
    const launch = resolveClaudeProfile('lan', { ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'global-model' }, { homeDir: tempHome })
    expect(launch.executable).toBe('/usr/local/bin/claude-lan')
    // Credentials and inherited routing pass through; entry values win over them.
    expect(launch.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'http://ai.lan:9292' })
    expect(launch.env?.ANTHROPIC_MODEL).toBe('global-model')
    // No inline controlled settings: the wrapper owns its provider config.
    expect(launch.settings).toBeUndefined()
  })

  test('wrapper exports win over pre-applied entry values at launch time', () => {
    userCatalog({ wrap: { label: 'Wrap', executable: '/usr/local/bin/claude-wrap', env: { ANTHROPIC_MODEL: 'entry-model' } } })
    const launch = resolveClaudeProfile('wrap', {}, { homeDir: tempHome })
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
    const base = { env: { ANTHROPIC_BASE_URL: 'https://same.example' }, model: 'same' }
    const a = claudeLaunchKey({ ...base, executable: '/wrappers/a' })
    const b = claudeLaunchKey({ ...base, executable: '/wrappers/b' })
    const neither = claudeLaunchKey({ ...base })
    expect(a).not.toBe(b)
    expect(a).not.toBe(neither)
    expect(claudeLaunchKey({ ...base, executable: '/wrappers/a' })).toBe(a)
  })
})
