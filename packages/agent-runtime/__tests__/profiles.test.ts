// @reads: packages/agent-runtime/__tests__/fixtures/**
// Profile helper oracles (task 3.1, P01-P04/I3). The pure helpers return
// exact maps from explicit inputs; then the real Claude session spawns the
// fake CLI with a helper's map, and the process sees exactly that map, on
// first launch and after a respawn, with no secret in its argv (M-env).
import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { ClaudeSession } from '../src/claude/session.js'
import { AgentRuntimeError } from '../src/errors.js'
import { CLAUDE_AGENT_SDK_VERSION, anthropicOAuthProfile, claudeProxyProfile, codexProfile } from '../src/profiles/index.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

/** A host map holding every kind of authority a launch must not inherit. */
const POISONED = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  HTTPS_PROXY: 'http://corp-proxy:3128',
  ANTHROPIC_API_KEY: 'sk-ant-host-key',
  ANTHROPIC_AUTH_TOKEN: 'host-auth-token',
  ANTHROPIC_BASE_URL: 'https://evil.example',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Host: secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CONFIG_DIR: '/home/operator/.claude',
  CODEX_HOME: '/home/operator/.codex',
  OPENAI_API_KEY: 'sk-openai-host',
  REGISTERED_RELAY_KEY: 'relay-secret',
})

const PINS_EMPTY = { HTTP_PROXY: '', NO_PROXY: '', NODE_TLS_REJECT_UNAUTHORIZED: '', NODE_EXTRA_CA_CERTS: '' }
const PROTOCOL = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION }

function configurationFailure(build: () => unknown): string {
  try {
    build()
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect((error as AgentRuntimeError).category).toBe('configuration')
    return (error as AgentRuntimeError).message
  }
  throw new Error('expected a configuration error')
}

describe('profile helpers (pure)', () => {
  // @covers: agent-runtime-policy › Provider helpers isolate credentials › Anthropic OAuth and Codex home
  test('P02: Anthropic OAuth selects its token and inherits no foreign authority', () => {
    const before = JSON.stringify(POISONED)
    const envBefore = JSON.stringify(process.env)
    const profile = anthropicOAuthProfile({ base: POISONED, oauthToken: 'oauth-selected', withheld: ['REGISTERED_RELAY_KEY'] })
    expect(profile.childEnv).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://corp-proxy:3128',
      ...PINS_EMPTY,
      ...PROTOCOL,
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-selected',
    })
    expect(profile.settings.env).toEqual({
      HTTPS_PROXY: 'http://corp-proxy:3128',
      ...PINS_EMPTY,
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
    })
    expect(JSON.stringify(profile.settings)).not.toContain('oauth-selected')
    expect(Object.isFrozen(profile.childEnv) && Object.isFrozen(profile.settings.env)).toBe(true)
    expect([JSON.stringify(POISONED), JSON.stringify(process.env)]).toEqual([before, envBefore])
  })

  // @covers: agent-runtime-policy › Provider helpers isolate credentials › Z.AI-style proxy profile
  test('P03: a proxy keeps its URL, header and placeholder token; alternatives are blanked; settings hold no secret', () => {
    const profile = claudeProxyProfile({
      base: POISONED,
      baseUrl: 'https://api.z.ai/api/anthropic',
      authToken: 'placeholder',
      customHeaders: 'X-Api-Key: zai-secret',
      withheld: ['REGISTERED_RELAY_KEY'],
    })
    expect(profile.childEnv).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://corp-proxy:3128',
      ...PINS_EMPTY,
      ...PROTOCOL,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: zai-secret',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    })
    expect(profile.settings.env).toEqual({
      HTTPS_PROXY: 'http://corp-proxy:3128',
      ...PINS_EMPTY,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    })
    const settings = JSON.stringify(profile.settings)
    for (const secret of ['placeholder', 'zai-secret']) expect(settings).not.toContain(secret)
  })

  test('P04: Codex selects its home and drops Claude and other Codex authority', () => {
    const profile = codexProfile({ base: POISONED, codexHome: '/srv/sessions/a/codex', withheld: ['REGISTERED_RELAY_KEY'] })
    expect(profile.childEnv).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://corp-proxy:3128', CODEX_HOME: '/srv/sessions/a/codex' })
  })

  test('P08: two sessions built from one base map share no mutable state', () => {
    const base = { PATH: '/usr/bin' }
    const a = anthropicOAuthProfile({ base, oauthToken: 'a' })
    const b = claudeProxyProfile({ base, baseUrl: 'https://proxy.example', authToken: 'b' })
    expect([a.childEnv.CLAUDE_CODE_OAUTH_TOKEN, b.childEnv.CLAUDE_CODE_OAUTH_TOKEN, b.childEnv.ANTHROPIC_AUTH_TOKEN]).toEqual(['a', '', 'b'])
    expect(base).toEqual({ PATH: '/usr/bin' })
  })

  test('P01: missing or malformed inputs are configuration errors', () => {
    const cases: Array<[string, () => unknown]> = [
      ['empty token', () => anthropicOAuthProfile({ base: {}, oauthToken: '' })],
      ['no base', () => anthropicOAuthProfile({ base: undefined as never, oauthToken: 't' })],
      ['non-string base value', () => anthropicOAuthProfile({ base: { PATH: 1 } as never, oauthToken: 't' })],
      ['relative URL', () => claudeProxyProfile({ base: {}, baseUrl: '/v1', authToken: 't' })],
      ['non-http URL', () => claudeProxyProfile({ base: {}, baseUrl: 'file:///etc/passwd', authToken: 't' })],
      ['empty header', () => claudeProxyProfile({ base: {}, baseUrl: 'https://p.example', authToken: 't', customHeaders: '' })],
      ['relative Codex home', () => codexProfile({ base: {}, codexHome: 'codex' })],
      ['withheld not a list', () => codexProfile({ base: {}, codexHome: '/c', withheld: 'X' as never })],
    ]
    for (const [, build] of cases) configurationFailure(build)
  })

  test('a withheld name the profile must deliver is refused, a blanked one is not', () => {
    expect(configurationFailure(() => codexProfile({ base: {}, codexHome: '/c', withheld: ['CODEX_HOME'] }))).toContain('CODEX_HOME')
    expect(configurationFailure(() => anthropicOAuthProfile({ base: {}, oauthToken: 't', withheld: ['CLAUDE_CODE_OAUTH_TOKEN'] }))).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    // OAuth only blanks ANTHROPIC_BASE_URL, so withholding it delivers nothing.
    expect(anthropicOAuthProfile({ base: {}, oauthToken: 't', withheld: ['ANTHROPIC_BASE_URL', 'HTTPS_PROXY'] }).childEnv.ANTHROPIC_BASE_URL).toBe('')
  })

  test('the protocol version constant matches the installed peer SDK', () => {
    const require = createRequire(import.meta.url)
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const pkg = require(sdkEntry.replace(/sdk\.mjs$/, 'package.json')) as { version: string }
    expect(CLAUDE_AGENT_SDK_VERSION).toBe(pkg.version)
  })
})

/** Names /bin/sh adds when the fake's wrapper execs Bun; test infrastructure, not the runtime. */
const SHELL_ADDED = ['PWD', 'SHLVL', '_', 'OLDPWD']

function withoutShellAdded(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SHELL_ADDED.includes(name)))
}

describe('profiles through the real Claude session', () => {
  test('P03/I3/M-env: the spawned CLI sees exactly the proxy profile map, first launch and respawn, and no secret in argv', async () => {
    const home = fakeClaudeHome()
    const infra = home.launch()
    const marker = 'AR_POISONED_HOST_MARKER'
    process.env[marker] = 'leaked'
    const profile = claudeProxyProfile({
      base: { ...POISONED, ...infra.childEnv },
      baseUrl: 'https://api.z.ai/api/anthropic',
      authToken: 'placeholder-token',
      customHeaders: 'X-Api-Key: zai-secret',
      withheld: ['REGISTERED_RELAY_KEY'],
    })
    const s = new ClaudeSession({
      launch: { ...infra, childEnv: profile.childEnv },
      callbacks: { onEvent: () => {} },
      sdkOptions: { settings: { env: { ...profile.settings.env } } },
      terminate: { graceMs: 300, killMs: 3000 },
    })
    try {
      await s.start()
      const first = JSON.parse((await (await s.send('env-all')).result).finalText!) as Record<string, string>
      expect(withoutShellAdded(first)).toEqual({ ...profile.childEnv })
      await (await s.send('crash')).result
      await s.start()
      const second = JSON.parse((await (await s.send('env-all')).result).finalText!) as Record<string, string>
      expect(withoutShellAdded(second)).toEqual({ ...profile.childEnv })
      const argv = home.argv()
      expect(argv).toHaveLength(2)
      for (const args of argv) {
        const joined = args.join('\n')
        for (const secret of ['placeholder-token', 'zai-secret', 'sk-ant-host-key', 'relay-secret', 'leaked']) expect(joined).not.toContain(secret)
        expect(joined).toContain('--settings')
        expect(joined).toContain('https://api.z.ai/api/anthropic')
      }
    } finally {
      delete process.env[marker]
      await s.kill().catch(() => {})
    }
  })
})
