// Master-parity literals (master 3654e541, the PR A base; findings-84d9a663
// F1): the resolved outputs of master's flat profileCatalog for the review's
// repro fixtures, captured once by checking that commit out and resolving
// the same temp catalogs through it (task journal, 2026-10-17). The branch's
// provider catalog must reproduce every launch setting apart from
// `providerId` — hermetically, with no git spawn. The invariant under
// rulings B1/F2: a legacy entry never changes a shipped provider's id,
// models, or settings, and keeps master's settings for its key.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveProfileCatalog, type CatalogProfile } from '../chat/profileCatalog'

const ZAI_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3[1m]',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
}
const GLM: Omit<CatalogProfile, 'providerId'> = { label: 'GLM', env: ZAI_ENV, model: 'opus', limitResetTimeZone: 'Asia/Shanghai' }
const GLM_FLASH: Omit<CatalogProfile, 'providerId'> = { label: 'GLM Flash', env: ZAI_ENV, model: 'sonnet', limitResetTimeZone: 'Asia/Shanghai' }
const MINIMAX: Omit<CatalogProfile, 'providerId'> = {
  label: 'MiniMax',
  env: {
    ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3', ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3', ANTHROPIC_DEFAULT_FABLE_MODEL: 'MiniMax-M3',
  },
  model: 'MiniMax-M3',
}
const MIMO: Omit<CatalogProfile, 'providerId'> = {
  label: 'MiMo',
  env: {
    ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic', ANTHROPIC_MODEL: 'mimo-v2.6-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.6-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.6-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.6-pro', ANTHROPIC_DEFAULT_FABLE_MODEL: 'mimo-v2.6-pro',
  },
  model: 'mimo-v2.6-pro',
}
const KIMI: Omit<CatalogProfile, 'providerId'> = {
  label: 'Kimi',
  env: {
    ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_MODEL: 'kimi-k3[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3[1m]', ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3[1m]',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  },
  model: 'kimi-k3[1m]',
}
const OPUS: Omit<CatalogProfile, 'providerId'> = { label: 'Claude Opus', env: {}, model: 'claude-opus-5-5' }
const SONNET: Omit<CatalogProfile, 'providerId'> = { label: 'Claude Sonnet', env: {}, model: 'claude-sonnet-5-5' }
const HAIKU: Omit<CatalogProfile, 'providerId'> = { label: 'Claude Haiku', env: {}, model: 'claude-haiku-5-5' }
const DEFAULT: Omit<CatalogProfile, 'providerId'> = { label: 'Default', env: {} }

/** Master's shipped catalog resolves to exactly these, in its file order. */
const SHIPPED: Record<string, Omit<CatalogProfile, 'providerId'>> = {
  default: DEFAULT, glm: GLM, 'glm-flash': GLM_FLASH, minimax: MINIMAX, mimo: MIMO, kimi: KIMI, opus: OPUS, sonnet: SONNET, haiku: HAIKU,
}

let root: string
let home: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-master-parity-')))
  home = path.join(root, 'no-home')
  projectDir = path.join(root, 'work', 'proj')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const projectWith = (name: string, files: Record<string, unknown>): string => {
  const project = path.join(root, name)
  fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
  for (const [file, json] of Object.entries(files)) {
    fs.writeFileSync(path.join(project, '.kawai', file), JSON.stringify(json))
  }
  return project
}

let projectDir: string

const writeCatalog = (dir: string, name: string, json: unknown): string => {
  const file = path.join(dir, '.kawai', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(json))
  return file
}
const writeProviders = (dir: string, json: unknown) => writeCatalog(dir, 'providers.json', json)
const writeProfiles = (dir: string, json: unknown) => writeCatalog(dir, 'profiles.json', json)

/** The head must resolve master's profiles, settings included, plus providerId. */
const expectParity = (project: string, master: Record<string, Omit<CatalogProfile, 'providerId'>>) => {
  const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
  expect(head.errors).toEqual([])
  expect([...head.profiles.keys()].sort()).toEqual(Object.keys(master).sort())
  for (const [key, masterProfile] of Object.entries(master)) {
    const { providerId, ...settings } = head.profiles.get(key) ?? ({} as CatalogProfile)
    expect({ key, settings }).toEqual({ key, settings: masterProfile })
  }
  return head
}

describe('master parity for the shipped-provider legacy entry (B1, finding F2)', () => {
  const cases: Array<[string, string]> = [
    ['claude', 'profile:claude'],
    ['zai', 'profile:zai'],
  ]
  for (const [id, reserved] of cases) {
    test(`a project ${id} entry keeps master's profile; the shipped provider is untouched`, () => {
      const project = projectWith(`b1-${id}`, {
        'profiles.json': { [id]: { label: `My ${id === 'zai' ? 'Z.AI' : 'Claude'}`, env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
      })
      const master: Record<string, Omit<CatalogProfile, 'providerId'>> = {
        ...SHIPPED,
        [id]: { label: `My ${id === 'zai' ? 'Z.AI' : 'Claude'}`, env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } },
      }
      const head = expectParity(project, master)
      // The entry holds the reserved provider id; the shipped provider keeps
      // its own id, models, and settings.
      expect(head.profiles.get(id)?.providerId).toBe(reserved)
      expect(head.providers.get(reserved)?.models).toEqual([id])
      const shippedProvider = head.providers.get(id)
      if (id === 'zai') expect(shippedProvider?.models).toEqual(['glm', 'glm-flash'])
      if (id === 'claude') expect(shippedProvider?.models).toEqual(['default', 'opus', 'sonnet', 'haiku'])
      expect(head.providers.get(id)?.label).toBe(id === 'zai' ? 'Z.AI' : 'Claude')
    })
  }

  test('a chain of two entries at two project levels overlays per key like master', () => {
    const mid = path.join(root, 'levels', 'mid')
    const project = path.join(mid, 'deep')
    fs.mkdirSync(path.join(mid, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(mid, '.kawai', 'profiles.json'), JSON.stringify({
      claude: { label: 'Mid Claude', env: { ANTHROPIC_BASE_URL: 'https://mid.example.internal' } },
    }))
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      claude: { label: 'Deep Claude', env: { ANTHROPIC_MODEL: 'claude-opus-5-5' } },
    }))
    const head = expectParity(project, {
      ...SHIPPED,
      claude: { label: 'Deep Claude', env: { ANTHROPIC_BASE_URL: 'https://mid.example.internal', ANTHROPIC_MODEL: 'claude-opus-5-5' } },
    })
    expect(head.profiles.get('claude')?.providerId).toBe('profile:claude')
  })

})
describe('master parity for the shipped re-home (B2, finding F2)', () => {
  // The shipped defaults as fixtures: provider zai holding the GLM pair.
  const shippedProviders = () => {
    const file = path.join(root, 'b2-shipped', 'providers.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      zai: {
        label: 'Z.AI',
        limitResetTimeZone: 'Asia/Shanghai',
        env: {
          ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
        },
        models: {
          glm: { label: 'GLM', model: 'opus', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' } },
          'glm-flash': { label: 'GLM Flash', model: 'sonnet' },
        },
      },
    }))
    return file
  }
  const emptyProfiles = () => {
    const file = path.join(root, 'b2-shipped', 'profiles.json')
    fs.writeFileSync(file, '{}')
    return file
  }
  const shippedCtx = (extra: Record<string, unknown> = {}) => ({
    homeDir: path.join(root, 'b2-no-home'),
    imageDefaultProvidersPath: shippedProviders(),
    imageDefaultPath: emptyProfiles(),
    ...extra,
  })

  test('a zai relabel leaves glm shipped, so a later glm override re-homes like master', () => {
    writeProfiles(projectDir, {
      glm: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } },
    })
    const { profiles, providers, errors } = resolveProfileCatalog(shippedCtx({ projectPath: projectDir }))
    expect(errors).toEqual([])
    expect(profiles.get('glm')).toEqual({
      label: 'GLM',
      model: 'opus',
      env: {
        ANTHROPIC_BASE_URL: 'https://gw.example.internal',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      },
      limitResetTimeZone: 'Asia/Shanghai',
      providerId: 'glm',
    })
    // Only that key left zai.
    expect(providers.get('zai')?.models).toEqual(['glm-flash'])
    expect(profiles.get('glm-flash')).toEqual({
      label: 'GLM Flash', model: 'sonnet',
      env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]' },
      limitResetTimeZone: 'Asia/Shanghai',
      providerId: 'zai',
    })
  })

  test('a nearer providers.json re-homes the key with the shipped settings as base', () => {
    writeProviders(projectDir, { zai2: { models: { glm: { label: 'P-Glm' } } } })
    const { profiles, errors } = resolveProfileCatalog(shippedCtx({ projectPath: projectDir }))
    expect(errors).toEqual([])
    expect(profiles.get('glm')).toEqual({
      label: 'P-Glm',
      model: 'opus',
      env: {
        ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      },
      limitResetTimeZone: 'Asia/Shanghai',
      providerId: 'zai2',
    })
  })

  test('a shipped key with no override stays under its shipped provider, label overlaid (P2)', () => {
    writeProviders(projectDir, { zai: { label: 'Z' } })
    const { profiles, providers, errors } = resolveProfileCatalog(shippedCtx({ projectPath: projectDir }))
    expect(errors).toEqual([])
    // The P2 overlay applies: the provider label takes 'Z'...
    expect(providers.get('zai')?.label).toBe('Z')
    // ...and the shipped keys keep their settings under zai.
    expect(profiles.get('glm')).toEqual({
      label: 'GLM', model: 'opus',
      env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
      limitResetTimeZone: 'Asia/Shanghai',
      providerId: 'zai',
    })
    expect(profiles.get('glm-flash')?.providerId).toBe('zai')
  })
})

describe('a user-level file replaces the shipped layer, so operator rules apply (F2 ruling)', () => {
  test('a legacy entry merges into a provider the user level defined', () => {
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
      zai: { label: 'Z.AI', env: ZAI_ENV, models: { glm: { label: 'GLM', model: 'opus' } } },
    }))
    const project = projectWith('user-merge', {
      'profiles.json': { zai: { label: 'My Z.AI', limitResetTimeZone: 'Asia/Shanghai' } },
    })
    // Nothing is shipped: rule 2 merges the entry into the operator provider.
    const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
    expect(head.errors).toEqual([])
    expect(head.profiles.get('glm')).toEqual({ ...GLM, providerId: 'zai' })
    expect(head.profiles.get('zai')).toBeUndefined()
    expect(head.providers.get('zai')).toEqual({ label: 'My Z.AI', models: ['glm'] })
  })
})

describe('rev 5 acceptance cells', () => {
  const X_KEYS: Record<string, string[]> = { zai: ['glm', 'glm-flash'], claude: ['default', 'opus', 'sonnet', 'haiku'] }
  const KEY_SETTINGS: Record<string, Record<string, Omit<CatalogProfile, 'providerId'>>> = {
    zai: { glm: GLM, 'glm-flash': GLM_FLASH },
    claude: { default: DEFAULT, opus: OPUS, sonnet: SONNET, haiku: HAIKU },
  }
  const OPERATOR_USER: Record<string, unknown> = {
    zai: { zai: { label: 'Z.AI', limitResetTimeZone: 'Asia/Shanghai', env: ZAI_ENV, models: { glm: { label: 'GLM', model: 'opus' }, 'glm-flash': { label: 'GLM Flash', model: 'sonnet' } } } },
    claude: { claude: { label: 'Claude', models: { default: { label: 'Default' }, opus: { label: 'Claude Opus', model: 'claude-opus-5-5' }, sonnet: { label: 'Claude Sonnet', model: 'claude-sonnet-5-5' }, haiku: { label: 'Claude Haiku', model: 'claude-haiku-5-5' } } } },
  }

  /** Each cell runs over X and over the shipped and operator bases, with a
   * fresh HOME per combination so no user file leaks across combinations. */
  const forAll = (run: (x: string, base: 'shipped' | 'operator', project: string) => void, files: (x: string) => Record<string, unknown>) => {
    for (const x of ['claude', 'zai']) {
      for (const base of ['shipped', 'operator'] as const) {
        home = path.join(root, `home-${x}-${base}-${Math.random().toString(36).slice(2, 6)}`)
        fs.mkdirSync(home, { recursive: true })
        if (base === 'operator') {
          fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
          fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify(OPERATOR_USER[x]))
          fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), '{}')
        }
        const project = projectWith(`${x}-${base}-${Math.random().toString(36).slice(2, 6)}`, files(x))
        run(x, base, project)
      }
    }
  }

  test('(a) label, env, zone, empty-models and new-key overlays reach every key X holds', () => {
    forAll((x, _base, project) => {
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      // The base resolves before any overlay: X's keys sit under X.
      for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.providerId).toBe(x)
    }, x => ({ 'providers.json': { [x]: {} } }))

    const overlayCases: Array<[string, Record<string, unknown>, (head: ReturnType<typeof resolveProfileCatalog>, x: string) => void]> = [
      ['label', { label: 'Relabeled' }, (head, x) => expect(head.providers.get(x)?.label).toBe('Relabeled')],
      ['env', { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }, (head, x) => {
        for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
      }],
      ['zone', { limitResetTimeZone: 'Europe/Berlin' }, (head, x) => {
        for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.limitResetTimeZone).toBe('Europe/Berlin')
      }],
    ]
    for (const [kind, overlay, assert$] of overlayCases) {
      forAll((x, _base, project) => {
        const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
        expect(head.errors).toEqual([])
        assert$(head, x)
      }, x => ({ 'providers.json': { [x]: overlay } }))
    }

    // An empty models map leaves X's keys in place.
    forAll((x, _base, project) => {
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.providerId).toBe(x)
    }, x => ({ 'providers.json': { [x]: { models: {} } } }))

    // A new key joins X with X's merged facts: the overlay env and the
    // provider label as its label fallback.
    forAll((x, _base, project) => {
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      expect(head.profiles.get('newkey')?.providerId).toBe(x)
      expect(head.profiles.get('newkey')?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
      expect(head.providers.get(x)?.label).toBe('Relabeled')
    }, x => ({ 'providers.json': { [x]: { label: 'Relabeled', env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' }, models: { newkey: {} } } } }))
  })

  test('(b) a legacy X becomes profile:X on the shipped base and merges on the operator base', () => {
    forAll((x, base, project) => {
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      if (base === 'shipped') {
        expect(head.profiles.get(x)?.providerId).toBe(`profile:${x}`)
        expect(head.profiles.get(x)).toEqual({
          label: `My ${x === 'zai' ? 'Z.AI' : 'Claude'}`,
          env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' },
          providerId: `profile:${x}`,
        })
      } else {
        expect(head.profiles.get(x)).toBeUndefined()
        expect(head.providers.get(x)?.label).toBe(`My ${x === 'zai' ? 'Z.AI' : 'Claude'}`)
      }
      for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.providerId).toBe(x)
    }, x => ({ 'profiles.json': { [x]: { label: `My ${x === 'zai' ? 'Z.AI' : 'Claude'}`, env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } } }))
  })

  test('(c) a later definition of one of the keys of X re-homes from the overlaid settings on the shipped base, and is refused on the operator base', () => {
    const files = (x: string): Record<string, unknown> => ({
      'providers.json': {
        [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } },
        moved2: { models: { [X_KEYS[x][0]]: {} } },
      },
    })
    forAll((x, base, project) => {
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      const key = X_KEYS[x][0]
      if (base === 'shipped') {
        expect(head.errors).toEqual([])
        expect(head.profiles.get(key)?.providerId).toBe('moved2')
        expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
        // The rest of X's overlaid settings ride along.
        const settings = { ...head.profiles.get(key) }
        delete (settings as Record<string, unknown>).providerId
        delete (settings as Record<string, unknown>).label
        const otherKeys = { ...KEY_SETTINGS[x][key].env, ANTHROPIC_BASE_URL: 'https://gw.example.internal' }
        expect((settings as CatalogProfile).env).toEqual(otherKeys)
      } else {
        expect(head.errors).toEqual([expect.stringContaining(`model "${key}" is already defined under provider "${x}"`)])
        expect(head.profiles.get(key)?.providerId).toBe(x)
        expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
      }
    }, files)
  })

  test('(d) the overlay and the legacy entry at one level, and at farther and nearer levels', () => {
    // One level.
    forAll((x, base, project) => {
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      expect(head.errors).toEqual([])
      // Shipped base: the entry takes the reserved id. Operator base: it
      // merges into the operator provider.
      if (base === 'shipped') expect(head.profiles.get(x)?.providerId).toBe(`profile:${x}`)
      else expect(head.providers.get(x)?.label).toBe(`My ${x === 'zai' ? 'Z.AI' : 'Claude'}`)
      for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
    }, x => ({
      'providers.json': { [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
      'profiles.json': { [x]: { label: `My ${x === 'zai' ? 'Z.AI' : 'Claude'}` } },
    }))
    // Farther overlay, nearer legacy: the legacy re-homes from the overlay.
    forAll((x, base) => {
      const outer = path.join(root, `d-far-${x}-${base}`, 'outer')
      const project = path.join(outer, 'deep')
      fs.mkdirSync(path.join(outer, '.kawai'), { recursive: true })
      fs.writeFileSync(path.join(outer, '.kawai', 'providers.json'), JSON.stringify({ [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } }))
      fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
      fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({ [x]: { label: `My ${x === 'zai' ? 'Z.AI' : 'Claude'}` } }))
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      // L3 on the shipped base: profile:X holds only the entry's settings —
      // the level's overlay reaches the shipped provider's remaining keys.
      // Rule 2 on the operator base: the entry merges into the provider.
      if (base === 'shipped') {
        expect(head.profiles.get(x)).toEqual({
          label: `My ${x === 'zai' ? 'Z.AI' : 'Claude'}`,
          env: {},
          providerId: `profile:${x}`,
        })
      } else {
        expect(head.providers.get(x)?.label).toBe(`My ${x === 'zai' ? 'Z.AI' : 'Claude'}`)
      }
      for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
    }, () => ({}))
    // Nearer overlay, farther legacy: the overlay applies to X's keys, and
    // the re-homed key is left alone.
    forAll((x, base) => {
      const outer = path.join(root, `d-near-${x}-${base}`, 'outer')
      const project = path.join(outer, 'deep')
      fs.mkdirSync(path.join(outer, '.kawai'), { recursive: true })
      fs.writeFileSync(path.join(outer, '.kawai', 'profiles.json'), JSON.stringify({ [x]: { label: `My ${x === 'zai' ? 'Z.AI' : 'Claude'}` } }))
      fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
      fs.writeFileSync(path.join(project, '.kawai', 'providers.json'), JSON.stringify({ [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } }))
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      // Shipped base: the entry re-homed at the outer level and the nearer
      // overlay leaves it alone. Operator base: the entry merged at the
      // outer level and the overlay applies to the provider's keys.
      if (base === 'shipped') {
        expect(head.profiles.get(x)?.providerId).toBe(`profile:${x}`)
        expect(head.profiles.get(x)?.env).toEqual({})
      } else {
        expect(head.providers.get(x)?.label).toBe(`My ${x === 'zai' ? 'Z.AI' : 'Claude'}`)
      }
      for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
    }, () => ({}))
  })

  test('(e) two overlays at two levels: the later wins and an empty value neutralizes', () => {
    forAll((x, _base, seed) => {
      const outer = path.join(root, `e-outer-${seed ? '' : ''}${Math.random().toString(36).slice(2, 6)}`)
      const project = path.join(outer, 'deep')
      fs.mkdirSync(path.join(outer, '.kawai'), { recursive: true })
      fs.writeFileSync(path.join(outer, '.kawai', 'providers.json'), JSON.stringify({ [x]: { label: 'Outer', env: { ANTHROPIC_BASE_URL: 'https://outer.example.internal' } } }))
      fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
      fs.writeFileSync(path.join(project, '.kawai', 'providers.json'), JSON.stringify({ [x]: { label: 'Inner', env: { ANTHROPIC_BASE_URL: '' } } }))
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      expect(head.providers.get(x)?.label).toBe('Inner')
      for (const key of X_KEYS[x]) expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('')
    }, () => ({}))
  })

  test('(f) an overlay later than a re-home leaves the re-homed key alone', () => {
    const outer = path.join(root, 'f-outer')
    const project = path.join(outer, 'deep')
    fs.mkdirSync(path.join(outer, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(outer, '.kawai', 'profiles.json'), JSON.stringify({ glm: { label: 'Moved' } }))
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'providers.json'), JSON.stringify({ zai: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } }))
    const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
    expect(head.errors).toEqual([])
    expect(head.profiles.get('glm')).toEqual({ label: 'Moved', env: ZAI_ENV, model: 'opus', limitResetTimeZone: 'Asia/Shanghai', providerId: 'glm' })
    expect(head.profiles.get('glm-flash')?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
  })

  test('(g) one providers.json overlaying zai and moving glm to zai2 resolves identically in both JSON key orders', () => {
    const orders: Array<Record<string, unknown>> = [
      { zai: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }, zai2: { models: { glm: {} } } },
      { zai2: { models: { glm: {} } }, zai: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
    ]
    const runs = orders.map(order => {
      const project = projectWith(`g-${Math.random().toString(36).slice(2, 6)}`, { 'providers.json': order })
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      expect(head.errors).toEqual([])
      return head
    })
    for (const head of runs) {
      expect(head.profiles.get('glm')?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
      expect(head.profiles.get('glm')?.providerId).toBe('zai2')
      expect(head.profiles.get('glm-flash')?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
      expect(head.profiles.get('glm-flash')?.providerId).toBe('zai')
    }
    expect(JSON.stringify([...runs[0]!.profiles.entries()])).toEqual(JSON.stringify([...runs[1]!.profiles.entries()]))
  })

  test('(c, L1) a profiles.json definition of one of the keys of X re-homes on the shipped base and reports on the operator base', () => {
    forAll((x, base, project) => {
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      const key = X_KEYS[x][0]
      if (base === 'shipped') {
        // L1: the key re-homes into its own provider from the overlaid settings.
        expect(head.errors).toEqual([])
        expect(head.profiles.get(key)?.providerId).toBe(key)
        expect(head.profiles.get(key)?.label).toBe('Moved')
        expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
      } else {
        expect(head.errors).toEqual([expect.stringContaining(`profile "${key}" is a model of provider "${x}"`)])
        expect(head.profiles.get(key)?.providerId).toBe(x)
      }
    }, x => ({
      'providers.json': { [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
      'profiles.json': { [X_KEYS[x][0]]: { label: 'Moved' } },
    }))
  })

  test('(I3) a rule-2 merge with nowhere to land reports the dropped startup model', () => {
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
      zai: { label: 'Z.AI', models: { glm: { label: 'GLM', model: 'opus' } } },
    }))
    const project = projectWith('i3', {
      'profiles.json': { zai: { label: 'My Z.AI', model: 'opus' } },
    })
    const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
    expect(head.errors).toEqual([expect.stringContaining('model "opus" is ignored: provider "zai" holds other models and takes no startup model.')])
    expect(head.providers.get('zai')?.label).toBe('My Z.AI')
    expect(head.profiles.get('glm')?.providerId).toBe('zai')
  })
})
