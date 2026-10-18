// Credential withholding and token injection at launch (openrouter-provider
// D3): every launch drops the catalog-named variables, and a credentialed
// provider's session gets its own token as ANTHROPIC_AUTH_TOKEN with every
// other credential blanked in the environment and the flag settings layer.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { profileCredential, resolveClaudeProfile } from '../chat/ClaudeProfiles'
import { resolveProfileCatalog } from '../chat/profileCatalog'
import { withheldCredentialNames } from '../chat/chatProviderEnv'

let tempHome: string
const savedProcessEnv: Record<string, string | undefined> = {}

function setProcessEnv(name: string, value: string): void {
  if (!(name in savedProcessEnv)) savedProcessEnv[name] = process.env[name]
  process.env[name] = value
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-profile-credentials-'))
  const dir = path.join(tempHome, '.kawai')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
    or2: {
      label: 'OR2',
      authTokenEnv: 'OR2_KEY',
      balanceKeyEnv: 'OR2_MANAGEMENT_KEY',
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_DEFAULT_SONNET_MODEL: '~anthropic/claude-sonnet-latest' },
      models: { 'or2-sonnet': { label: 'OR2 Sonnet', model: 'sonnet' } },
    },
    zai: {
      label: 'Z.AI',
      env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic' },
      models: { glm: { model: 'opus' } },
    },
    wrapped: {
      executable: '/usr/local/bin/claude-wrap',
      models: { wrap: {} },
    },
  }))
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{}')
})

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
  for (const [name, value] of Object.entries(savedProcessEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete savedProcessEnv[name]
  }
})

const ctx = () => ({ homeDir: tempHome })
const serverEnv = { OR2_KEY: 'or-inference-sentinel', OR2_MANAGEMENT_KEY: 'or-management-sentinel', ANTHROPIC_API_KEY: 'server-api-key' }

describe('named credential variables are withheld from every agent', () => {
  test('the withheld set is every token and balance name in the resolved catalog', () => {
    expect([...withheldCredentialNames(resolveProfileCatalog(ctx()))].sort()).toEqual(['OR2_KEY', 'OR2_MANAGEMENT_KEY'])
  })

  test("another provider's session cannot read either variable", () => {
    const launch = resolveClaudeProfile('glm', serverEnv, ctx())
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    // Its own credentials are untouched.
    expect(launch.env?.ANTHROPIC_API_KEY).toBe('server-api-key')
  })

  test('a default launch without overrides passes an explicit filtered environment', () => {
    setProcessEnv('OR2_MANAGEMENT_KEY', 'from-process-env')
    const launch = resolveClaudeProfile('default', {}, ctx())
    expect(launch.env).toBeDefined()
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env?.PATH).toBe(process.env.PATH)
    expect(launch.settings).toBeUndefined()
  })

  test('an executable-backed launch is filtered too', () => {
    const launch = resolveClaudeProfile('wrap', serverEnv, ctx())
    expect(launch.executable).toBe('/usr/local/bin/claude-wrap')
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
  })

  test("a credentialed provider's session sends its own key as the bearer token", () => {
    const launch = resolveClaudeProfile('or2-sonnet', serverEnv, ctx())
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('or-inference-sentinel')
    expect(launch.env?.ANTHROPIC_API_KEY).toBe('')
    expect(launch.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(launch.model).toBe('sonnet')
  })

  test('project settings cannot restore an API key: the flag layer blanks it', () => {
    const launch = resolveClaudeProfile('or2-sonnet', serverEnv, ctx())
    const settings = launch.settings as { env: Record<string, string> }
    expect(settings.env.ANTHROPIC_API_KEY).toBe('')
    expect(settings.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
    // The token never rides in the flag layer (it would reach argv).
    expect(settings.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(JSON.stringify(launch.settings)).not.toContain('or-inference-sentinel')
  })

  test('the token is read from process.env when Settings do not set it', () => {
    setProcessEnv('OR2_KEY', 'from-process-env')
    expect(resolveClaudeProfile('or2-sonnet', {}, ctx()).env?.ANTHROPIC_AUTH_TOKEN).toBe('from-process-env')
  })

  test('a missing token injects an empty bearer, never another credential', () => {
    const launch = resolveClaudeProfile('or2-sonnet', { ANTHROPIC_API_KEY: 'server-api-key' }, ctx())
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('')
    expect(launch.env?.ANTHROPIC_API_KEY).toBe('')
  })

  test('profileCredential names the provider and variable only for credentialed profiles', () => {
    expect(profileCredential('or2-sonnet', ctx())).toEqual({ providerLabel: 'OR2', authTokenEnv: 'OR2_KEY' })
    expect(profileCredential('glm', ctx())).toBeUndefined()
    expect(profileCredential('missing', ctx())).toBeUndefined()
  })

  test('a catalog naming no credentials keeps the unconfigured default launch', () => {
    fs.writeFileSync(path.join(tempHome, '.kawai', 'providers.json'), '{}')
    expect(resolveClaudeProfile('default', {}, ctx())).toEqual({})
  })
})
