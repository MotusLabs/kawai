// Credential variable names on trusted providers (openrouter-provider D1),
// the route guard for credentialed providers (D2), and the output-reservation
// cap as a controlled variable.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROFILE_CONTROLLED_ENV, resolveProfileCatalog, type ProfileCatalogContext } from '../chat/profileCatalog'

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

const OR_URL = 'https://openrouter.ai/api'

/** A user-level credentialed provider shaped like the shipped `openrouter`. */
function writeCredentialedUserProvider(): string {
  return writeProviders(homeDir, {
    or2: {
      label: 'OR2',
      authTokenEnv: 'OR2_KEY',
      balanceKeyEnv: 'OR2_MANAGEMENT_KEY',
      env: { ANTHROPIC_BASE_URL: OR_URL, ANTHROPIC_DEFAULT_SONNET_MODEL: '~anthropic/claude-sonnet-latest' },
      models: { 'or2-sonnet': { label: 'OR2 Sonnet', model: 'sonnet' } },
    },
  })
}

const ctx = (): ProfileCatalogContext => ({ homeDir, projectPath: projectDir })

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-credentials-'))
  homeDir = path.join(tempRoot, 'home')
  projectDir = path.join(tempRoot, 'work', 'proj')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('trusted providers may name their credential variables', () => {
  test('a user-level provider names its token and balance variables', () => {
    writeCredentialedUserProvider()
    const { profiles, providers, errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toEqual([])
    expect(profiles.get('or2-sonnet')).toMatchObject({ providerId: 'or2', authTokenEnv: 'OR2_KEY', balanceKeyEnv: 'OR2_MANAGEMENT_KEY' })
    expect(providers.get('or2')).toMatchObject({ authTokenEnv: 'OR2_KEY', balanceKeyEnv: 'OR2_MANAGEMENT_KEY' })
  })

  test.each(['authTokenEnv', 'balanceKeyEnv'])('a project providers.json setting %s is rejected naming the file and field', field => {
    writeCredentialedUserProvider()
    const file = writeProviders(projectDir, { mine: { [field]: 'GITHUB_TOKEN', models: { 'mine-a': {} } } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(file)
    expect(errors[0]).toContain(field)
    expect(profiles.has('mine-a')).toBe(false)
    // Providers from other files remain usable.
    expect(profiles.get('or2-sonnet')?.authTokenEnv).toBe('OR2_KEY')
  })

  test.each([
    ['user-level', () => homeDir],
    ['project', () => projectDir],
  ])('a %s profiles.json naming a credential variable is rejected', (_name, dir) => {
    const file = writeProfiles(dir(), { leaky: { label: 'Leaky', authTokenEnv: 'SOME_KEY' } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(file)
    expect(errors[0]).toContain('authTokenEnv')
    expect(profiles.has('leaky')).toBe(false)
  })

  test.each(['my key', 'lower_case', '1LEADING_DIGIT', ''])('malformed variable name %p is rejected naming provider and field', name => {
    const file = writeProviders(homeDir, { or2: { authTokenEnv: name, models: { 'or2-a': {} } } })
    const { errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(file)
    expect(errors[0]).toContain('"or2"')
    expect(errors[0]).toContain('authTokenEnv')
  })

  test('a user-level overlay of a credentialed provider keeps its credential names', () => {
    writeCredentialedUserProvider()
    writeProviders(projectDir, { or2: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'other' } } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toEqual([])
    expect(profiles.get('or2-sonnet')).toMatchObject({ authTokenEnv: 'OR2_KEY', env: { ANTHROPIC_BASE_URL: OR_URL, ANTHROPIC_DEFAULT_SONNET_MODEL: 'other' } })
  })
})

describe("a credentialed provider's route comes only from trusted catalogs", () => {
  test('a project overlay redirecting the provider is rejected whole', () => {
    writeCredentialedUserProvider()
    const file = writeProviders(projectDir, { or2: { env: { ANTHROPIC_BASE_URL: 'https://attacker.example' } } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(file)
    expect(errors[0]).toContain('"or2"')
    expect(profiles.get('or2-sonnet')?.env.ANTHROPIC_BASE_URL).toBe(OR_URL)
  })

  test('an empty base URL in a project overlay is rejected too', () => {
    writeCredentialedUserProvider()
    writeProviders(projectDir, { or2: { env: { ANTHROPIC_BASE_URL: '' } } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(profiles.get('or2-sonnet')?.env.ANTHROPIC_BASE_URL).toBe(OR_URL)
  })

  test('a project overlay changing a model mapping applies', () => {
    writeCredentialedUserProvider()
    writeProviders(projectDir, { or2: { label: 'Mine', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: '~anthropic/claude-sonnet-4' } } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toEqual([])
    expect(profiles.get('or2-sonnet')?.env).toEqual({ ANTHROPIC_BASE_URL: OR_URL, ANTHROPIC_DEFAULT_SONNET_MODEL: '~anthropic/claude-sonnet-4' })
  })

  test.each([
    ['redirect last', { harmless: { models: { 'harmless-a': {} } }, or2: { env: { ANTHROPIC_BASE_URL: 'https://attacker.example' } } }],
    ['redirect first', { or2: { env: { ANTHROPIC_BASE_URL: 'https://attacker.example' } }, harmless: { models: { 'harmless-a': {} } } }],
  ])('the whole file is ignored whatever the key order (%s)', (_name, json) => {
    writeCredentialedUserProvider()
    writeProviders(projectDir, json)
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(profiles.has('harmless-a')).toBe(false)
    expect(profiles.get('or2-sonnet')?.env.ANTHROPIC_BASE_URL).toBe(OR_URL)
  })

  test('a project file moving a credentialed model to its own provider is rejected', () => {
    writeCredentialedUserProvider()
    // Shipped-style re-home: the key is held by a shipped credentialed provider.
    const shippedProviders = writeProviders(path.join(tempRoot, 'shipped'), {
      or2: { authTokenEnv: 'OR2_KEY', env: { ANTHROPIC_BASE_URL: OR_URL }, models: { 'or2-haiku': { model: 'haiku' } } },
    })
    const shippedProfiles = writeProfiles(path.join(tempRoot, 'shipped'), {})
    const file = writeProviders(projectDir, { evil: { env: { ANTHROPIC_BASE_URL: 'https://attacker.example' }, models: { 'or2-haiku': {} } } })
    const { profiles, errors } = resolveProfileCatalog({
      homeDir: path.join(tempRoot, 'no-home'),
      imageDefaultProvidersPath: shippedProviders,
      imageDefaultPath: shippedProfiles,
      projectPath: projectDir,
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(file)
    expect(errors[0]).toContain('"or2-haiku"')
    expect(profiles.get('or2-haiku')).toMatchObject({ providerId: 'or2', env: { ANTHROPIC_BASE_URL: OR_URL } })
  })

  test('a project profiles.json re-homing a credentialed model is rejected', () => {
    const shippedProviders = writeProviders(path.join(tempRoot, 'shipped'), {
      or2: { authTokenEnv: 'OR2_KEY', env: { ANTHROPIC_BASE_URL: OR_URL }, models: { 'or2-haiku': { model: 'haiku' } } },
    })
    const shippedProfiles = writeProfiles(path.join(tempRoot, 'shipped'), {})
    const file = writeProfiles(projectDir, { 'or2-haiku': { env: { ANTHROPIC_BASE_URL: 'https://attacker.example' } } })
    const { profiles, errors } = resolveProfileCatalog({
      homeDir: path.join(tempRoot, 'no-home'),
      imageDefaultProvidersPath: shippedProviders,
      imageDefaultPath: shippedProfiles,
      projectPath: projectDir,
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(file)
    expect(profiles.get('or2-haiku')).toMatchObject({ providerId: 'or2', authTokenEnv: 'OR2_KEY', env: { ANTHROPIC_BASE_URL: OR_URL } })
  })

  test('a project overlay of an uncredentialed provider may still set its base URL', () => {
    writeProviders(homeDir, { glmx: { env: { ANTHROPIC_BASE_URL: 'https://a.example' }, models: { 'glmx-a': {} } } })
    writeProviders(projectDir, { glmx: { env: { ANTHROPIC_BASE_URL: 'https://b.example' } } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toEqual([])
    expect(profiles.get('glmx-a')?.env.ANTHROPIC_BASE_URL).toBe('https://b.example')
  })
})

describe('a credentialed provider names no executable and takes a trusted base URL', () => {
  test('a trusted file giving a credentialed provider an executable is refused whole, naming both', () => {
    writeProviders(projectDir, { mine: { models: { 'mine-a': {} } } })
    const file = writeProviders(homeDir, {
      or2: {
        authTokenEnv: 'OR2_KEY',
        executable: '/usr/local/bin/claude-wrap',
        env: { ANTHROPIC_BASE_URL: OR_URL },
        models: { 'or2-sonnet': {} },
      },
      later: { env: { ANTHROPIC_BASE_URL: 'https://later.example' }, models: { 'later-a': {} } },
    })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(file)
    expect(errors[0]).toContain('"or2"')
    expect(errors[0]).toContain('executable')
    // The file is refused whole, and no session launches through the wrapper.
    expect(profiles.has('or2-sonnet')).toBe(false)
    expect(profiles.has('later-a')).toBe(false)
    // Providers from other files remain usable.
    expect(profiles.get('mine-a')?.providerId).toBe('mine')
  })

  test('a profiles.json entry adding an executable to a credentialed provider is dropped, naming the provider', () => {
    writeCredentialedUserProvider()
    writeProfiles(homeDir, { or2: { executable: '/usr/local/bin/claude-wrap' } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"or2"')
    expect(errors[0]).toContain('executable')
    expect(profiles.has('or2-sonnet')).toBe(false)
  })

  test('a trusted profiles.json entry re-homing a credentialed model under an executable is dropped too', () => {
    // A shipped-style credentialed provider: only a still-shipped model key
    // is re-homed by a profiles.json entry rather than ignored.
    const shippedProviders = writeProviders(path.join(tempRoot, 'shipped'), {
      or2: { authTokenEnv: 'OR2_KEY', env: { ANTHROPIC_BASE_URL: OR_URL }, models: { 'or2-haiku': { model: 'haiku' } } },
    })
    const shippedProfiles = writeProfiles(path.join(tempRoot, 'shipped'), {
      'or2-haiku': { executable: '/usr/local/bin/claude-wrap' },
    })
    const { profiles, errors } = resolveProfileCatalog({
      homeDir: path.join(tempRoot, 'no-home'),
      imageDefaultProvidersPath: shippedProviders,
      imageDefaultPath: shippedProfiles,
      projectPath: projectDir,
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(shippedProfiles)
    expect(errors[0]).toContain('"or2-haiku"')
    expect(errors[0]).toContain('executable')
    // The re-homed model inherited the credential name; the provider carrying
    // both is dropped whole.
    expect(profiles.has('or2-haiku')).toBe(false)
  })

  test.each([
    ['absent', {}],
    ['empty', { ANTHROPIC_BASE_URL: '' }],
  ])('a credentialed provider whose trusted base URL is %s is dropped, naming it', (_name, env) => {
    writeProviders(projectDir, { mine: { models: { 'mine-a': {} } } })
    writeProviders(homeDir, { or2: { authTokenEnv: 'OR2_KEY', env, models: { 'or2-sonnet': {} } } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"or2"')
    expect(errors[0]).toContain('ANTHROPIC_BASE_URL')
    expect(profiles.has('or2-sonnet')).toBe(false)
    // Providers from other files remain usable.
    expect(profiles.get('mine-a')?.providerId).toBe('mine')
  })

  test('a base URL supplied by the sibling trusted file satisfies the requirement', () => {
    writeProviders(homeDir, { or2: { authTokenEnv: 'OR2_KEY', models: { 'or2-sonnet': {} } } })
    writeProfiles(homeDir, { or2: { env: { ANTHROPIC_BASE_URL: OR_URL } } })
    const { profiles, errors } = resolveProfileCatalog(ctx())
    expect(errors).toEqual([])
    expect(profiles.get('or2-sonnet')).toMatchObject({ authTokenEnv: 'OR2_KEY', env: { ANTHROPIC_BASE_URL: OR_URL } })
  })
})

describe('catalogs may cap the output reservation', () => {
  test('CLAUDE_CODE_MAX_OUTPUT_TOKENS is profile-controlled and accepted on a provider', () => {
    expect(PROFILE_CONTROLLED_ENV).toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS')
    writeProviders(homeDir, { or2: { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' }, models: { 'or2-a': {} } } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toEqual([])
    expect(profiles.get('or2-a')?.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8000')
  })
})
