import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PROFILE_CATALOG_PATH, PROFILE_CONTROLLED_ENV, resolveProfileCatalog } from '../chat/profileCatalog'

let tempRoot: string
let homeDir: string
let projectDir: string

function writeCatalog(dir: string, json: unknown): string {
  const file = path.join(dir, '.kawai', 'profiles.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json))
  return file
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-catalog-'))
  homeDir = path.join(tempRoot, 'home')
  projectDir = path.join(tempRoot, 'work', 'proj')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('catalog file parsing and validation', () => {
  test('valid file resolves entries and omits absent files', () => {
    const file = writeCatalog(homeDir, {
      glm: { label: 'GLM', model: 'sonnet', env: { ANTHROPIC_BASE_URL: 'https://zai.example' } },
    })
    const { profiles, errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toEqual([])
    expect(profiles.get('glm')).toEqual({
      label: 'GLM', model: 'sonnet', env: { ANTHROPIC_BASE_URL: 'https://zai.example' },
    })
    // The file exists; a sibling directory without one contributes nothing.
    expect(file).toBeTruthy()
    expect(profiles.has('default')).toBe(true)
  })

  test('partial entries parse and labels fall back to the profile id', () => {
    writeCatalog(homeDir, { 'glm-flash': { model: 'glm-5.3-flash[1m]' } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toEqual([])
    expect(profiles.get('glm-flash')).toEqual({
      label: 'glm-flash', env: {}, model: 'glm-5.3-flash[1m]',
    })
  })

  test.each([
    ['not an object', '"a string"'],
    ['array', '[]'],
    ['invalid JSON', '{'],
  ])('malformed file (%s) is reported by path', (_name, raw) => {
    const file = writeCatalog(homeDir, raw)
    const { errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(file)
  })

  test.each([
    ['Bad_ID', { bad_ID: { label: 'X' } }],
    ['unknown field', { glm: { label: 'GLM', favorite: 'yes' } }],
    ['empty label', { glm: { label: '' } }],
    ['non-string model', { glm: { model: 3 } }],
    ['non-object env', { glm: { env: 'nope' } }],
  ])('invalid entry (%s) is reported', (_name, json) => {
    writeCatalog(homeDir, json)
    const { errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(path.join(homeDir, '.kawai', 'profiles.json'))
  })

  test('every profile-controlled variable is accepted in one entry', () => {
    const env = Object.fromEntries(
      PROFILE_CONTROLLED_ENV.map(name => [name, 'value'])
    )
    writeCatalog(homeDir, { full: { label: 'Full', env } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toEqual([])
    expect(profiles.get('full')?.env).toEqual(env)
  })

  test('credential-style env keys are refused; controlled keys pass', () => {
    const file = writeCatalog(homeDir, {
      leaky: { label: 'Leaky', env: { ANTHROPIC_AUTH_TOKEN: 'secret' } },
    })
    const refused = resolveProfileCatalog({ homeDir })
    expect(refused.errors).toHaveLength(1)
    expect(refused.errors[0]).toContain(file)
    expect(refused.errors[0]).toContain('ANTHROPIC_AUTH_TOKEN')
    expect(refused.profiles.has('leaky')).toBe(false)

    writeCatalog(homeDir, { ok: { label: 'OK', env: { ANTHROPIC_BASE_URL: 'https://x', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000' } } })
    const allowed = resolveProfileCatalog({ homeDir })
    expect(allowed.errors).toEqual([])
    expect(allowed.profiles.get('ok')?.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://x', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000',
    })
  })

  test('oversized env value is refused', () => {
    writeCatalog(homeDir, { big: { label: 'Big', env: { ANTHROPIC_MODEL: 'x'.repeat(4097) } } })
    const { errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('ANTHROPIC_MODEL')
  })

  test('executable accepted in the user-level catalog only', () => {
    writeCatalog(homeDir, { lan: { label: 'LAN', executable: '/usr/local/bin/claude-lan' } })
    const trusted = resolveProfileCatalog({ homeDir })
    expect(trusted.errors).toEqual([])
    expect(trusted.profiles.get('lan')?.executable).toBe('/usr/local/bin/claude-lan')

    const projectFile = writeCatalog(projectDir, { evil: { label: 'Evil', executable: '/tmp/evil' } })
    const untrusted = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(untrusted.errors).toHaveLength(1)
    expect(untrusted.errors[0]).toContain(projectFile)
    expect(untrusted.errors[0]).toContain('user-level')
    expect(untrusted.profiles.has('evil')).toBe(false)
    expect(untrusted.profiles.has('default')).toBe(true)
  })

  test('relative executable path is refused', () => {
    writeCatalog(homeDir, { rel: { label: 'Rel', executable: 'bin/claude-rel' } })
    const { errors } = resolveProfileCatalog({ homeDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('absolute')
  })
})

describe('layered resolution', () => {
  test('nearest file wins for the same profile', () => {
    writeCatalog(homeDir, { glm: { label: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://user.example' } } })
    writeCatalog(projectDir, { glm: { label: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://project.example' } } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(errors).toEqual([])
    expect(profiles.get('glm')?.env.ANTHROPIC_BASE_URL).toBe('https://project.example')
  })

  test('per-key extension inherits unmerged keys', () => {
    writeCatalog(homeDir, {
      glm: { label: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://user.example', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]' } },
    })
    writeCatalog(projectDir, { glm: { env: { ANTHROPIC_MODEL: 'glm-5.3' } } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(errors).toEqual([])
    expect(profiles.get('glm')).toEqual({
      label: 'GLM',
      env: {
        ANTHROPIC_BASE_URL: 'https://user.example',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]',
        ANTHROPIC_MODEL: 'glm-5.3',
      },
    })
  })

  test('empty value neutralizes an inherited key', () => {
    writeCatalog(homeDir, { glm: { label: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://user.example', ANTHROPIC_MODEL: 'glm-5.3' } } })
    writeCatalog(projectDir, { glm: { env: { ANTHROPIC_MODEL: '' } } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(errors).toEqual([])
    expect(profiles.get('glm')?.env).toEqual({ ANTHROPIC_BASE_URL: 'https://user.example', ANTHROPIC_MODEL: '' })
  })

  test('scalar fields follow nearest-set-wins', () => {
    writeCatalog(homeDir, { glm: { label: 'GLM', model: 'glm-5.3' } })
    writeCatalog(projectDir, { glm: { model: 'glm-5.3-flash[1m]' } })
    const { profiles } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(profiles.get('glm')?.model).toBe('glm-5.3-flash[1m]')
    expect(profiles.get('glm')?.label).toBe('GLM')
  })

  test('user-level catalog replaces the image default', () => {
    writeCatalog(homeDir, { only: { label: 'Only' } })
    const replaced = resolveProfileCatalog({ homeDir })
    expect(replaced.errors).toEqual([])
    expect([...replaced.profiles.keys()]).toEqual(['only', 'default'])
    // Without a user file the shipped default applies.
    const shipped = resolveProfileCatalog({ homeDir: path.join(tempRoot, 'no-home') })
    expect(shipped.errors).toEqual([])
    expect(shipped.profiles.has('glm')).toBe(true)
    expect(shipped.profiles.has('mimo')).toBe(true)
  })

  test('default is definable in catalog files and always synthesized when absent', () => {
    writeCatalog(homeDir, { default: { label: 'My Default', env: { ANTHROPIC_BASE_URL: 'https://default.example' } } })
    const defined = resolveProfileCatalog({ homeDir })
    expect(defined.profiles.get('default')).toEqual({
      label: 'My Default', env: { ANTHROPIC_BASE_URL: 'https://default.example' },
    })

    writeCatalog(homeDir, { glm: { label: 'GLM' } })
    const implicit = resolveProfileCatalog({ homeDir })
    expect(implicit.profiles.get('default')).toEqual({ label: 'Default', env: {} })
  })

  test('a malformed file does not blank the rest of the catalog', () => {
    writeCatalog(homeDir, { glm: { label: 'GLM' } })
    const badFile = writeCatalog(projectDir, '{ not json')
    const { profiles, errors } = resolveProfileCatalog({ homeDir, projectPath: projectDir })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(badFile)
    expect(profiles.get('glm')?.label).toBe('GLM')
    expect(profiles.has('default')).toBe(true)
  })

  test('image default path is overridable for tests and deployments', () => {
    const custom = path.join(tempRoot, 'custom-default.json')
    fs.writeFileSync(custom, JSON.stringify({ custom: { label: 'Custom' } }))
    const { profiles, errors } = resolveProfileCatalog({
      homeDir: path.join(tempRoot, 'no-home'),
      imageDefaultPath: custom,
    })
    expect(errors).toEqual([])
    expect(profiles.get('custom')?.label).toBe('Custom')
    expect(DEFAULT_PROFILE_CATALOG_PATH).toContain('config/profiles.default.json')
  })

  test('home-relative project paths expand before discovery', () => {
    // The project lives under the home directory; the request carries the
    // path as the client typed it.
    const project = path.join(homeDir, 'work', 'proj')
    fs.mkdirSync(project, { recursive: true })
    writeCatalog(project, { 'home-proj': { label: 'Home Proj' } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir, projectPath: '~/work/proj' })
    expect(errors).toEqual([])
    expect(profiles.get('home-proj')?.label).toBe('Home Proj')

    // Bare `~` reads the home directory's own catalog.
    writeCatalog(homeDir, { 'home-root': { label: 'Home Root' } })
    const atRoot = resolveProfileCatalog({ homeDir, projectPath: '~' })
    expect(atRoot.errors).toEqual([])
    expect(atRoot.profiles.get('home-root')?.label).toBe('Home Root')

    // The home file is not re-read as an untrusted project layer: its
    // executables stay valid when the project path walks through home.
    writeCatalog(homeDir, { lan: { label: 'LAN', executable: '/usr/local/bin/claude-lan' } })
    const throughHome = resolveProfileCatalog({ homeDir, projectPath: '~/work/proj' })
    expect(throughHome.errors).toEqual([])
    expect(throughHome.profiles.get('lan')?.executable).toBe('/usr/local/bin/claude-lan')

    // Absolute paths are unchanged by expansion.
    const absolute = resolveProfileCatalog({ homeDir, projectPath: project })
    expect(absolute.profiles.get('home-proj')?.label).toBe('Home Proj')
  })
})
