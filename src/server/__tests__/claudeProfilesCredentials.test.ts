// Credential withholding and token injection at launch (openrouter-provider
// D3): every launch drops the catalog-named variables, and a credentialed
// provider's session gets its own token as ANTHROPIC_AUTH_TOKEN with every
// other credential blanked in the environment and the flag settings layer.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildClaudeLaunch, profileCredential, resolveClaudeProfile, TRANSPORT_PIN_ENV, type ClaudeLaunchConfiguration } from '../chat/ClaudeProfiles'
import { resolveProfileCatalog, type CatalogProfile } from '../chat/profileCatalog'
import { withheldCredentialNames } from '../chat/chatProviderEnv'

let tempHome: string
const savedProcessEnv: Record<string, string | undefined> = {}

const OR_URL = 'https://openrouter.ai/api'

/**
 * Every resolution in this file is a Claude entry; the helper narrows the
 * launch union so `.env`/`.settings` read directly, failing loudly on a
 * Codex arm (which carries no environment or flag layer at all).
 */
function resolveClaudeLaunch(...args: Parameters<typeof resolveClaudeProfile>): ClaudeLaunchConfiguration {
  const launch = resolveClaudeProfile(...args)
  if (launch.runtime !== 'claude') throw new Error(`expected a Claude launch, got ${launch.runtime}`)
  return launch
}

/** The flag-layer env of a launch, where the pinned route must live. */
function settingsEnvOf(launch: ClaudeLaunchConfiguration): Record<string, string> {
  return (launch.settings as { env: Record<string, string> }).env
}

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
    const launch = resolveClaudeLaunch('glm', serverEnv, ctx())
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    // Its own credentials are untouched.
    expect(launch.env?.ANTHROPIC_API_KEY).toBe('server-api-key')
  })

  test('a default launch without overrides passes an explicit filtered environment', () => {
    setProcessEnv('OR2_MANAGEMENT_KEY', 'from-process-env')
    const launch = resolveClaudeLaunch('default', {}, ctx())
    expect(launch.env).toBeDefined()
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env?.PATH).toBe(process.env.PATH)
    expect(launch.settings).toBeUndefined()
  })

  test('an executable-backed launch is filtered too', () => {
    const launch = resolveClaudeLaunch('wrap', serverEnv, ctx())
    expect(launch.executable).toBe('/usr/local/bin/claude-wrap')
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
  })

  test("a credentialed provider's session sends its own key as the bearer token", () => {
    const launch = resolveClaudeLaunch('or2-sonnet', serverEnv, ctx())
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('or-inference-sentinel')
    expect(launch.env?.ANTHROPIC_API_KEY).toBe('')
    expect(launch.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(launch.model).toBe('sonnet')
  })

  test('project settings cannot restore an API key: the flag layer blanks it', () => {
    const launch = resolveClaudeLaunch('or2-sonnet', serverEnv, ctx())
    const settings = launch.settings as { env: Record<string, string> }
    expect(settings.env.ANTHROPIC_API_KEY).toBe('')
    expect(settings.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
    // The pinned base URL rides beside the blanks.
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(OR_URL)
    // The token never rides in the flag layer (it would reach argv).
    expect(settings.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(JSON.stringify(launch.settings)).not.toContain('or-inference-sentinel')
  })

  test('the token is read from process.env when Settings do not set it', () => {
    setProcessEnv('OR2_KEY', 'from-process-env')
    expect(resolveClaudeLaunch('or2-sonnet', {}, ctx()).env?.ANTHROPIC_AUTH_TOKEN).toBe('from-process-env')
  })

  test('a missing token injects an empty bearer, never another credential', () => {
    const launch = resolveClaudeLaunch('or2-sonnet', { ANTHROPIC_API_KEY: 'server-api-key' }, ctx())
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('')
    expect(launch.env?.ANTHROPIC_API_KEY).toBe('')
  })

  test('profileCredential names the provider and variable only for credentialed profiles', () => {
    expect(profileCredential('or2-sonnet', ctx())).toEqual({ providerLabel: 'OR2', authTokenEnv: 'OR2_KEY' })
    expect(profileCredential('glm', ctx())).toBeUndefined()
    expect(profileCredential('missing', ctx())).toBeUndefined()
  })

  test('a catalog naming no credentials keeps the unconfigured default launch explicit', () => {
    fs.writeFileSync(path.join(tempHome, '.kawai', 'providers.json'), '{}')
    const launch = resolveClaudeLaunch('default', {}, ctx())
    // D3: every launch passes an explicit environment, even with nothing to
    // withhold — never a bare inheritance of process.env.
    expect(Object.keys(launch).sort()).toEqual(['env', 'runtime'])
    expect(launch.env?.PATH).toBe(process.env.PATH)
  })
})

describe("a credentialed provider's base URL is pinned on every launch", () => {
  test('project settings cannot redirect the base URL: both layers carry the trusted URL', () => {
    const launch = resolveClaudeLaunch('or2-sonnet', serverEnv, ctx())
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe(OR_URL)
    expect(settingsEnvOf(launch).ANTHROPIC_BASE_URL).toBe(OR_URL)
  })

  test('user settings cannot redirect the base URL either: the pin rides the flag layer of a minimal profile', () => {
    // A credentialed model that sets nothing itself still inherits the
    // provider's trusted base URL, and the pin reaches the flag layer.
    const file = path.join(tempHome, '.kawai', 'providers.json')
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8')) as { or2: { models: Record<string, object> } }
    catalog.or2.models['or2-bare'] = {}
    fs.writeFileSync(file, JSON.stringify(catalog))
    const launch = resolveClaudeLaunch('or2-bare', serverEnv, ctx())
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('or-inference-sentinel')
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe(OR_URL)
    expect(settingsEnvOf(launch).ANTHROPIC_BASE_URL).toBe(OR_URL)
    expect(settingsEnvOf(launch)).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
  })

  test('project settings cannot add a proxy: transports pin to the server values or empty', () => {
    const blank = Object.fromEntries(TRANSPORT_PIN_ENV.map(name => [name, '']))
    const quiet = resolveClaudeLaunch('or2-sonnet', { ...serverEnv, ...blank }, ctx())
    for (const name of TRANSPORT_PIN_ENV) {
      expect(quiet.env?.[name]).toBe('')
      expect(settingsEnvOf(quiet)[name]).toBe('')
    }
    const proxied = resolveClaudeLaunch('or2-sonnet', { ...serverEnv, HTTPS_PROXY: 'http://192.0.2.10:3128', NO_PROXY: 'localhost' }, ctx())
    expect(proxied.env?.HTTPS_PROXY).toBe('http://192.0.2.10:3128')
    expect(proxied.env?.NO_PROXY).toBe('localhost')
    expect(settingsEnvOf(proxied).HTTPS_PROXY).toBe('http://192.0.2.10:3128')
    expect(settingsEnvOf(proxied).NO_PROXY).toBe('localhost')
  })

  test('a no-override credentialed launch still builds the pinned settings layer', () => {
    // Structural: a credentialed profile whose env sets nothing. The merged
    // catalog always gives one a base URL, so this shape only reaches the
    // builder through a bypassing caller — it must still be pinned.
    const launch = buildClaudeLaunch(
      { label: 'Bare', providerId: 'or2', env: {}, authTokenEnv: 'OR2_KEY' } satisfies CatalogProfile,
      { PATH: '/usr/bin' },
      { OR2_KEY: 'or-inference-sentinel' },
      new Set(),
    )
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('or-inference-sentinel')
    const settings = settingsEnvOf(launch)
    expect(settings.ANTHROPIC_BASE_URL).toBe('')
    expect(settings.ANTHROPIC_API_KEY).toBe('')
    expect(settings.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
    for (const name of TRANSPORT_PIN_ENV) expect(settings[name]).toBe('')
    expect(settings).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(JSON.stringify(launch.settings)).not.toContain('or-inference-sentinel')
  })

  test('an executable naming a credential is refused by the parser and passes no token anyway', () => {
    fs.writeFileSync(path.join(tempHome, '.kawai', 'providers.json'), JSON.stringify({
      or2: {
        authTokenEnv: 'OR2_KEY',
        executable: '/usr/local/bin/claude-wrap',
        env: { ANTHROPIC_BASE_URL: OR_URL },
        models: { 'or2-sonnet': {} },
      },
    }))
    const { errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"or2"')
    expect(errors[0]).toContain('executable')
    // A catalog that bypassed the parser must not hand the key to the wrapper.
    const launch = buildClaudeLaunch(
      {
        label: 'Bypassed', providerId: 'or2', executable: '/usr/local/bin/claude-wrap',
        env: { ANTHROPIC_BASE_URL: OR_URL }, authTokenEnv: 'OR2_KEY',
      } satisfies CatalogProfile,
      { PATH: '/usr/bin' },
      { OR2_KEY: 'or-inference-sentinel' },
      new Set(),
    )
    expect(launch.executable).toBe('/usr/local/bin/claude-wrap')
    expect(launch.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.settings).toBeUndefined()
    expect(JSON.stringify(launch)).not.toContain('or-inference-sentinel')
  })
})
