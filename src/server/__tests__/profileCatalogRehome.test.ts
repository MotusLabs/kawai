// R3 and R1 coverage for spec.md :55 ("A nearer definition re-homes a
// shipped model key"), split from the master-parity files (finding
// f7e07798, rev 8). R3: once an operator file has taken a shipped key
// over, that key is operator-held — a still nearer definition of it is
// refused with the error naming both files, whatever kind of file took
// it over. R1: a re-homed key carries the shipped provider's executable.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveProfileCatalog } from '../chat/profileCatalog'

let root: string
let home: string

const projectWith = (name: string, files: Record<string, unknown>): string => {
  const project = path.join(root, name)
  fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
  for (const [file, json] of Object.entries(files)) {
    fs.writeFileSync(path.join(project, '.kawai', file), JSON.stringify(json))
  }
  return project
}

/** A deeper project dir: its files are nearer on the walk than `outer`'s. */
const nearerProject = (outer: string): string => {
  const project = path.join(outer, 'deep')
  fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
  return project
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-rehome-')))
  home = path.join(root, 'no-home')
  fs.mkdirSync(home, { recursive: true })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const P = (d: string) => path.join(d, '.kawai', 'providers.json')
const F = (d: string) => path.join(d, '.kawai', 'profiles.json')
// The two refusal strings, rebuilt here from the rev 9 templates so the
// assertions cover the whole error including both file names.
const MODEL = (file: string, key: string, provider: string, origin: string) =>
  `${file}: model "${key}" is already defined under provider "${provider}" (${origin}); the nearer definition is ignored.`
const ENTRY = (file: string, key: string, provider: string, origin: string) =>
  `${file}: profile "${key}" is a model of provider "${provider}" (${origin}); the entry is ignored.`

describe('R3: operator levels keep the farther definition', () => {
  // T1: a project providers.json moves a shipped key of X to a new
  // provider (operator-held). A nearer file defining it under yet another
  // provider — or naming it in profiles.json — is refused.
  test('T1: a nearer definition of a providers.json-re-homed key is refused', () => {
    for (const x of ['claude', 'zai']) {
      const key = x === 'zai' ? 'glm' : 'opus'
      const mover = x === 'zai' ? 'zai2' : 'cl2'
      const other = x === 'zai' ? 'zai3' : 'cl3'
      const outer = projectWith(`t1-outer-${x}`, {
        'providers.json': { [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }, [mover]: { models: { [key]: {} } } },
      })
      // A nearer providers.json defines the key under another provider.
      const nearer = nearerProject(outer)
      fs.writeFileSync(path.join(nearer, '.kawai', 'providers.json'), JSON.stringify({ [other]: { models: { [key]: {} } } }))
      const head = resolveProfileCatalog({ homeDir: home, projectPath: nearer })
      expect(head.errors).toEqual([MODEL(P(nearer), key, mover, P(outer))])
      const farther = resolveProfileCatalog({ homeDir: home, projectPath: outer })
      expect(head.profiles.get(key)).toEqual(farther.profiles.get(key))
      expect(head.profiles.get(key)?.providerId).toBe(mover)
      // A nearer profiles.json names it: refused the same way. A separate
      // tree — the first nearer dir stays on any deeper walk.
      const outer2 = projectWith(`t1-outer2-${x}`, {
        'providers.json': { [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }, [mover]: { models: { [key]: {} } } },
      })
      const nearer2 = nearerProject(outer2)
      fs.writeFileSync(path.join(nearer2, '.kawai', 'profiles.json'), JSON.stringify({ [key]: { label: 'Nearer' } }))
      const head2 = resolveProfileCatalog({ homeDir: home, projectPath: nearer2 })
      expect(head2.errors).toEqual([ENTRY(F(nearer2), key, mover, P(outer2))])
      const farther2 = resolveProfileCatalog({ homeDir: home, projectPath: outer2 })
      expect(head2.profiles.get(key)).toEqual(farther2.profiles.get(key))
      expect(head2.profiles.get(key)?.providerId).toBe(mover)
    }
  })

  // T2: a project profiles.json re-homes a shipped key of X into its own
  // provider (operator-held). A nearer providers.json defining it under
  // another provider is refused.
  test('T2: a nearer definition of a profiles.json-re-homed key is refused', () => {
    for (const x of ['claude', 'zai']) {
      const key = x === 'zai' ? 'glm' : 'opus'
      const other = x === 'zai' ? 'zai3' : 'cl3'
      const outer = projectWith(`t2-outer-${x}`, {
        'profiles.json': { [key]: { label: 'Moved' } },
      })
      const nearer = nearerProject(outer)
      fs.writeFileSync(path.join(nearer, '.kawai', 'providers.json'), JSON.stringify({ [other]: { models: { [key]: {} } } }))
      const head = resolveProfileCatalog({ homeDir: home, projectPath: nearer })
      expect(head.errors).toEqual([MODEL(P(nearer), key, key, F(outer))])
      const farther = resolveProfileCatalog({ homeDir: home, projectPath: outer })
      expect(head.profiles.get(key)).toEqual(farther.profiles.get(key))
      expect(head.profiles.get(key)?.providerId).toBe(key)
      expect(head.profiles.get(key)?.label).toBe('Moved')
    }
  })

  // T3: a project providers.json overlays a shipped key of X under X
  // itself (the P3 same-provider merge, operator-held). A nearer file
  // defining it under another provider — or naming it — is refused.
  test('T3: a nearer definition of a P3-overlaid shipped key is refused', () => {
    for (const x of ['claude', 'zai']) {
      const key = x === 'zai' ? 'glm' : 'opus'
      const other = x === 'zai' ? 'zai3' : 'cl3'
      const outer = projectWith(`t3-outer-${x}`, {
        'providers.json': { [x]: { models: { [key]: { model: 'overlay-model' } } } },
      })
      const nearer = nearerProject(outer)
      fs.writeFileSync(path.join(nearer, '.kawai', 'providers.json'), JSON.stringify({ [other]: { models: { [key]: {} } } }))
      const head = resolveProfileCatalog({ homeDir: home, projectPath: nearer })
      expect(head.errors).toEqual([MODEL(P(nearer), key, x, P(outer))])
      const farther = resolveProfileCatalog({ homeDir: home, projectPath: outer })
      expect(head.profiles.get(key)).toEqual(farther.profiles.get(key))
      expect(head.profiles.get(key)?.providerId).toBe(x)
      const outer2 = projectWith(`t3-outer2-${x}`, {
        'providers.json': { [x]: { models: { [key]: { model: 'overlay-model' } } } },
      })
      const nearer2 = nearerProject(outer2)
      fs.writeFileSync(path.join(nearer2, '.kawai', 'profiles.json'), JSON.stringify({ [key]: { label: 'Nearer' } }))
      const head2 = resolveProfileCatalog({ homeDir: home, projectPath: nearer2 })
      expect(head2.errors).toEqual([ENTRY(F(nearer2), key, x, P(outer2))])
      const farther2 = resolveProfileCatalog({ homeDir: home, projectPath: outer2 })
      expect(head2.profiles.get(key)).toEqual(farther2.profiles.get(key))
      expect(head2.profiles.get(key)?.providerId).toBe(x)
    }
  })

  // T4: a project profiles.json entry merges into the shipped one-model
  // entry mimo (operator-held). A nearer providers.json defining mimo
  // under another provider is refused.
  test('T4: a nearer definition of an overlaid shipped one-model entry is refused', () => {
    const outer = projectWith('t4-outer', {
      'profiles.json': { mimo: { label: 'My MiMo' } },
    })
    const nearer = nearerProject(outer)
    fs.writeFileSync(path.join(nearer, '.kawai', 'providers.json'), JSON.stringify({ mimo2: { models: { mimo: {} } } }))
    const head = resolveProfileCatalog({ homeDir: home, projectPath: nearer })
    expect(head.errors).toEqual([MODEL(P(nearer), 'mimo', 'mimo', F(outer))])
    const farther = resolveProfileCatalog({ homeDir: home, projectPath: outer })
    expect(head.profiles.get('mimo')).toEqual(farther.profiles.get('mimo'))
    expect(head.profiles.get('mimo')?.providerId).toBe('mimo')
    expect(head.profiles.get('mimo')?.label).toBe('My MiMo')
  })
})

describe('R1: a re-homed key keeps the shipped provider’s executable', () => {
  test('an image-default executable reaches the re-homed key through imageDefaultProvidersPath', () => {
    const shipped = path.join(root, 'image', 'providers.json')
    fs.mkdirSync(path.dirname(shipped), { recursive: true })
    fs.writeFileSync(shipped, JSON.stringify({
      zai: {
        label: 'Z.AI',
        executable: '/usr/local/bin/claude-zai',
        models: { glm: { label: 'GLM', model: 'opus' }, 'glm-flash': { label: 'GLM Flash', model: 'sonnet' } },
      },
    }))
    // A project providers.json re-home: the key's executable can only come
    // from the re-home's inherited flattened settings.
    const project = projectWith('r1', {
      'providers.json': { mover: { models: { glm: {} } } },
    })
    const head = resolveProfileCatalog({
      homeDir: path.join(root, 'no-home'),
      imageDefaultProvidersPath: shipped,
      imageDefaultPath: path.join(root, 'image', 'profiles.json'),
      projectPath: project,
    })
    expect(head.errors).toEqual([])
    // The re-homed key resolves with the shipped provider's executable.
    expect(head.profiles.get('glm')).toEqual({
      label: 'GLM', model: 'opus',
      env: {},
      executable: '/usr/local/bin/claude-zai',
      providerId: 'mover',
    })
    // The sibling keeps both the executable and the shipped provider.
    expect(head.profiles.get('glm-flash')?.executable).toBe('/usr/local/bin/claude-zai')
    expect(head.profiles.get('glm-flash')?.providerId).toBe('zai')
  })
})
