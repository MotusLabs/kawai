// Shared-login detection (dispatch-worker-choice D6, 3.3a): only Claude
// launches on the stored login — no credential variable present, even blank,
// no base URL but Anthropic's API, no wrapper executable — have a key, the
// absolute config directory as a path string; a provider is marked only when
// all its workers share one key. Positive and negative cases also run through
// the real catalog resolution with an injected home and environment.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveClaudeProfile, type ChatLaunchConfiguration } from '../chat/ClaudeProfiles'
import { sharedLogins, storedLoginKey } from '../team/routing/sharedLogins'

const DIR = '/tmp/kawai-shared-login-example/claude'
const fake = (...parts: string[]) => parts.join('')
const claude = (env: Record<string, string | undefined>, extra: Partial<ChatLaunchConfiguration> = {}): ChatLaunchConfiguration =>
  ({ runtime: 'claude', env, ...extra }) as ChatLaunchConfiguration

describe('storedLoginKey', () => {
  test('a launch with no credential and no base URL keys on its resolved config dir', () => {
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: `${DIR}/../claude/` }), {})).toBe(DIR)
    expect(storedLoginKey(claude({ HOME: '/tmp/kawai-shared-login-example' }), {})).toBe('/tmp/kawai-shared-login-example/.claude')
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR, ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }), {})).toBe(DIR)
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR, ANTHROPIC_BASE_URL: '' }), {})).toBe(DIR)
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR, ANTHROPIC_API_KEY: undefined }), {})).toBe(DIR)
  })

  test('an unset SDK env is judged over the inherited environment', () => {
    expect(storedLoginKey({ runtime: 'claude' } as ChatLaunchConfiguration, { CLAUDE_CONFIG_DIR: DIR })).toBe(DIR)
    expect(storedLoginKey({ runtime: 'claude' } as ChatLaunchConfiguration, { CLAUDE_CONFIG_DIR: DIR, ANTHROPIC_API_KEY: fake('sk-', 'x') })).toBeNull()
  })

  test.each([
    ['ANTHROPIC_API_KEY', fake('sk-ant-', 'example')],
    ['ANTHROPIC_AUTH_TOKEN', fake('tok-', 'example')],
    ['CLAUDE_CODE_OAUTH_TOKEN', fake('oat-', 'example')],
    ['ANTHROPIC_API_KEY', ''],
    ['ANTHROPIC_AUTH_TOKEN', ''],
  ])('%s present (value %p) in the env is never the stored login', (name, value) => {
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR, [name]: value }), {})).toBeNull()
  })

  test('a credential in the flag settings layer counts too', () => {
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR }, { settings: { env: { CLAUDE_CODE_OAUTH_TOKEN: '' } } }), {})).toBeNull()
  })

  test.each([
    'https://gateway.example.internal/api/anthropic',
    'http://api.anthropic.com',
    'https://api.anthropic.com/v1',
    'https://api.anthropic.com.example.internal',
    'https://user@api.anthropic.com',
    'not a url',
  ])('a base URL %p other than Anthropic\'s API is never the stored login', url => {
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR, ANTHROPIC_BASE_URL: url }), {})).toBeNull()
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR }, { settings: { env: { ANTHROPIC_BASE_URL: url } } }), {})).toBeNull()
  })

  test('Codex launches, wrapper executables, and a relative config dir have no key', () => {
    expect(storedLoginKey({ runtime: 'codex', codexHome: DIR, network: true } as ChatLaunchConfiguration, { CLAUDE_CONFIG_DIR: DIR })).toBeNull()
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR }, { executable: '/usr/local/bin/claude-wrap' }), {})).toBeNull()
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: 'relative/claude' }), {})).toBeNull()
    expect(storedLoginKey(claude({ CLAUDE_CONFIG_DIR: DIR }, { settings: '/tmp/kawai-shared-login-example/settings.json' }), {})).toBeNull()
  })
})

describe('sharedLogins', () => {
  test('providers on one key name each other, sorted; different keys and null keys stay unmarked', () => {
    const logins = sharedLogins([
      { provider: 'claude', key: '/a' }, { provider: 'zeta', key: '/a' }, { provider: 'alpha', key: '/a' },
      { provider: 'other', key: '/b' }, { provider: 'none', key: null }, { provider: 'none2', key: null },
    ])
    expect(logins.get('claude')).toEqual(['alpha', 'zeta'])
    expect(logins.get('alpha')).toEqual(['claude', 'zeta'])
    expect([logins.get('other'), logins.get('none'), logins.get('none2')]).toEqual([[], [], []])
  })

  test('a provider whose workers do not all share one key is never marked, nor marks others', () => {
    const mixed = sharedLogins([
      { provider: 'claude', key: '/a' }, { provider: 'claude', key: null }, { provider: 'anthropic', key: '/a' },
    ])
    expect([mixed.get('claude'), mixed.get('anthropic')]).toEqual([[], []])
    const split = sharedLogins([
      { provider: 'claude', key: '/a' }, { provider: 'claude', key: '/b' }, { provider: 'anthropic', key: '/a' },
    ])
    expect([split.get('claude'), split.get('anthropic')]).toEqual([[], []])
  })
})

describe('through the real catalog resolution', () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-shared-login-'))
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
      first: { label: 'First', models: { 'first-opus': { model: 'opus' } } },
      second: { label: 'Second', models: { 'second-sonnet': { model: 'sonnet' } } },
      keyed: { label: 'Keyed', authTokenEnv: 'EXAMPLE_KEYED_TOKEN', env: { ANTHROPIC_BASE_URL: 'https://gateway.example.internal/api' }, models: { 'keyed-opus': { model: 'opus' } } },
    }))
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), '{}')
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  test('two stored-login profiles of different providers on one config dir are marked both ways; a credentialed one on that dir is not', () => {
    // Blank out any host credential so only the injected environment decides.
    const env = {
      CLAUDE_CONFIG_DIR: path.join(home, 'claude'), HOME: home,
      ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
      EXAMPLE_KEYED_TOKEN: fake('example-', 'keyed-', 'token'),
    } as unknown as Record<string, string>
    const keyOf = (id: string) => storedLoginKey(resolveClaudeProfile(id, env, { homeDir: home }), env)
    expect(keyOf('first-opus')).toBe(path.join(home, 'claude'))
    expect(keyOf('keyed-opus')).toBeNull()
    const logins = sharedLogins(['first-opus', 'second-sonnet', 'keyed-opus'].map(id => ({ provider: id.split('-')[0]!, key: keyOf(id) })))
    expect(logins.get('first')).toEqual(['second'])
    expect(logins.get('second')).toEqual(['first'])
    expect(logins.get('keyed')).toEqual([])
  })
})
