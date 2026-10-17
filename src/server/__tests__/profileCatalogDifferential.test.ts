// Differential tests against the PR A base (master 3654e541): the same temp
// catalogs resolved through master's flat profileCatalog and this branch's
// provider catalog must give every model key the same launch settings, apart
// from `providerId` (review findings B1/B2 and the lead's rulings). Master's
// resolver at that revision imports only node builtins, its shipped JSON, and
// its limitSignals, so a detached checkout runs without node_modules.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { resolveProfileCatalog, type CatalogProfile } from '../chat/profileCatalog'

const MASTER = '3654e54121f502cc08eb87b3871a7db798777489'

interface MasterProfile {
  label: string
  env: Record<string, string>
  model?: string
  executable?: string
  limitResetTimeZone?: string
}

let root: string
let masterSrc: string

const git = (args: string[], cwd: string) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

const resolveMaster = async (ctx: {
  homeDir?: string
  projectPath?: string
}): Promise<Map<string, MasterProfile>> => {
  const mod = (await import(path.join(masterSrc, 'src', 'server', 'chat', 'profileCatalog.ts'))) as {
    resolveProfileCatalog: (ctx: unknown) => { profiles: Map<string, MasterProfile>; errors: string[] }
  }
  const resolved = mod.resolveProfileCatalog(ctx)
  expect(resolved.errors).toEqual([])
  return resolved.profiles
}

/** Master's entry and the head's must agree on every launch setting. */
const expectSameSettings = (master: MasterProfile, head: CatalogProfile | undefined, key: string) => {
  expect(head).toBeDefined()
  const { providerId: _ignored, ...headSettings } = head!
  expect({ key, settings: headSettings }).toEqual({ key, settings: master })
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-catalog-diff-')))
  masterSrc = path.join(root, 'master-src')
  git(['worktree', 'add', '--detach', '-q', masterSrc, MASTER], process.cwd())
})

afterAll(() => {
  git(['worktree', 'remove', '--force', masterSrc], process.cwd())
  fs.rmSync(root, { recursive: true, force: true })
})

const projectWith = (name: string, files: Record<string, unknown>): string => {
  const project = path.join(root, name)
  fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
  for (const [file, json] of Object.entries(files)) {
    fs.writeFileSync(path.join(project, '.kawai', file), JSON.stringify(json))
  }
  return project
}

const freshHome = () => {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(home, { recursive: true })
  return home
}

describe('differential against master 3654e541 (B1: a legacy entry named after a shipped provider)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['claude', { label: 'My Claude', env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }],
    ['zai', { label: 'My Z.AI', env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }],
  ]
  for (const [id, entry] of cases) {
    test(`a project ${id} entry keeps master's profile and never moves the shipped siblings`, async () => {
      const project = projectWith(`b1-${id}`, { 'profiles.json': { [id]: entry } })
      const home = freshHome()
      const ctx = { homeDir: home, projectPath: project }
      const master = await resolveMaster(ctx)
      const head = resolveProfileCatalog(ctx)
      // Every master profile keeps its settings; `id` among them, so the
      // entry does not vanish and the shipped provider keeps its models.
      expect([...head.profiles.keys()].sort()).toEqual([...master.keys()].sort())
      for (const [key, masterProfile] of master) {
        expectSameSettings(masterProfile, head.profiles.get(key), key)
      }
      // The reserved provider id fails PROFILE_ID_PATTERN and holds model `id`.
      const reserved = head.providers.get(`profile:${id}`)
      expect(reserved?.models).toEqual([id])
    })
  }

  test('a chain of two such entries at two project levels overlays like master', async () => {
    const mid = path.join(root, 'chain-mid')
    const project = path.join(root, 'chain-deep')
    fs.mkdirSync(path.join(mid, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(mid, '.kawai', 'profiles.json'), JSON.stringify({
      claude: { label: 'Mid Claude', env: { ANTHROPIC_BASE_URL: 'https://mid.example.internal' } },
    }))
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      claude: { label: 'Deep Claude', env: { ANTHROPIC_MODEL: 'claude-opus-5-5' } },
    }))
    const home = freshHome()
    const ctx = { homeDir: home, projectPath: project }
    const master = await resolveMaster(ctx)
    const head = resolveProfileCatalog(ctx)
    expect([...head.profiles.keys()].sort()).toEqual([...master.keys()].sort())
    for (const [key, masterProfile] of master) {
      expectSameSettings(masterProfile, head.profiles.get(key), key)
    }
  })
})

describe('differential against master 3654e541 (B2: a provider relabel must not block re-homing)', () => {
  test('a zai relabel leaves glm shipped, so a later glm override re-homes like master', async () => {
    const project = projectWith('b2', {
      'providers.json': { zai: { label: 'Z', models: {} } },
      'profiles.json': { glm: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
    })
    const home = freshHome()
    const ctx = { homeDir: home, projectPath: project }
    const master = await resolveMaster(ctx)
    const head = resolveProfileCatalog(ctx)
    expect(head.errors).toEqual([])
    // glm re-homes with master's settings; glm-flash keeps the shipped URL.
    expectSameSettings(master.get('glm')!, head.profiles.get('glm'), 'glm')
    expectSameSettings(master.get('glm-flash')!, head.profiles.get('glm-flash'), 'glm-flash')
    expect(head.providers.get('zai')?.models).toEqual(['glm-flash'])
    expect(head.providers.get('zai')?.label).toBe('Z')
  })

  test('one level: providers.json read first, then profiles.json — the override still re-homes', async () => {
    // Both files at one project level: the zai relabel is provider-level
    // (providers.json read first), so glm-flash's key stays shipped and the
    // profiles.json overlay re-homes it with master's settings.
    const project = projectWith('order', {
      'providers.json': { zai: { label: 'Z', models: {} } },
      'profiles.json': { 'glm-flash': { label: 'Flash' } },
    })
    const home = freshHome()
    const ctx = { homeDir: home, projectPath: project }
    const master = await resolveMaster(ctx)
    const head = resolveProfileCatalog(ctx)
    expect(head.errors).toEqual([])
    expectSameSettings(master.get('glm-flash')!, head.profiles.get('glm-flash'), 'glm-flash')
    expect(head.profiles.get('glm-flash')?.providerId).toBe('glm-flash')
    expect(head.providers.get('zai')?.models).toEqual(['glm'])
  })
})
