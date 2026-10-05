import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { claudeProfileMetadata, PROFILE_CONTROLLED_ENV, resolveClaudeProfile } from '../chat/ClaudeProfiles'

describe('Claude profile resolution', () => {
  test('catalog metadata has stable order and contains only identifiers and labels', () => {
    expect(claudeProfileMetadata()).toEqual([
      { id: 'default', label: 'Default' }, { id: 'glm', label: 'GLM' },
      { id: 'minimax', label: 'MiniMax' }, { id: 'mimo', label: 'MiMo' },
      { id: 'kimi', label: 'Kimi' }, { id: 'lan', label: 'LAN' },
    ])
  })
  test('documentation matches catalog labels and effective mappings', () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dir, '../../../docs/claude-session-profiles.md'), 'utf8')
    for (const { id, label } of claudeProfileMetadata()) {
      expect(doc).toContain(`| ${id} | ${label} |`)
      const launch = resolveClaudeProfile(id)
      if (id === 'default') continue
      for (const name of PROFILE_CONTROLLED_ENV) {
        const value = launch.env?.[name]
        if (value && value !== '0') expect(doc).toContain(value)
      }
      if (launch.model && launch.model !== 'sonnet') expect(doc).toContain(launch.model)
    }
  })
  test('omitted profile preserves existing Default behavior and unknown IDs fail', () => {
    expect(resolveClaudeProfile()).toEqual({})
    expect(resolveClaudeProfile('default', { ANTHROPIC_MODEL: 'global' }).env?.ANTHROPIC_MODEL).toBe('global')
    for (const id of ['unknown', 'glm-flash', '__proto__']) expect(() => resolveClaudeProfile(id)).toThrow('Unknown Claude profile')
  })
  test('all effective wrapper assignments and prescribed models match', () => {
    const glm = resolveClaudeProfile('glm')
    expect(glm.model).toBe('sonnet')
    expect(glm.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://zai.ruslan.casa/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' })
    const minimax = resolveClaudeProfile('minimax')
    expect(minimax.model).toBe('MiniMax-M3')
    expect(minimax.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_MODEL: 'MiniMax-M3' })
    const mimo = resolveClaudeProfile('mimo')
    expect(mimo.model).toBe('mimo-v2.6-pro')
    expect(mimo.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://xiaomi.ruslan.casa/anthropic', ANTHROPIC_MODEL: 'mimo-v2.6-pro', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.6-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.6-pro' })
    expect(resolveClaudeProfile('kimi').env?.ANTHROPIC_BASE_URL).toBe('https://kimi.ruslan.casa/')
    expect(resolveClaudeProfile('lan').env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://ai.lan:9292', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' })
    expect(resolveClaudeProfile('kimi').model).toBeUndefined()
    expect(resolveClaudeProfile('lan').model).toBeUndefined()
  })
  test('named profiles clean controlled variables, keep runtime and credentials, and never mutate inputs', () => {
    const input = Object.fromEntries(PROFILE_CONTROLLED_ENV.map((name) => [name, 'conflict']))
    Object.assign(input, { ANTHROPIC_AUTH_TOKEN: 'test-secret', PATH: '/test/path', HOME: '/test/home', CLAUDE_CONFIG_DIR: '/test/config', UNRELATED: 'yes' })
    const before = { ...input }
    const lan = resolveClaudeProfile('lan', input)
    expect(lan.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'test-secret', PATH: '/test/path', HOME: '/test/home', CLAUDE_CONFIG_DIR: '/test/config', UNRELATED: 'yes' })
    for (const name of PROFILE_CONTROLLED_ENV) {
      if (name !== 'ANTHROPIC_BASE_URL' && name !== 'CLAUDE_CODE_ATTRIBUTION_HEADER') expect(lan.env?.[name]).toBeUndefined()
    }
    expect(input).toEqual(before)
    const glm = resolveClaudeProfile('glm', input)
    const minimax = resolveClaudeProfile('minimax', input)
    expect(glm.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000')
    expect(minimax.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(lan.env?.HOME).toBe('/test/home')
  })
})
