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
  fs.mkdirSync(home, { recursive: true })
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

/** The head must resolve master's profiles, settings included, plus providerId. */
const expectParity = (project: string, master: Record<string, Omit<CatalogProfile, 'providerId'>>) => {
  const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
  expect(head.errors).toEqual([])
  expect([...head.profiles.keys()].sort()).toEqual(Object.keys(master).sort())
  for (const [key, masterProfile] of Object.entries(master)) {
    const { providerId: _providerId, ...settings } = head.profiles.get(key) ?? ({} as CatalogProfile)
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

  // The F2 invariant, every overlay kind against both shipped providers: a
  // provider-level overlay never flips a shipped provider's tier, so the
  // legacy entry keeps master's settings and the siblings stay put.
  const overlays: Array<[string, Record<string, unknown>]> = [
    ['label', { label: 'Relabeled' }],
    ['env', { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }],
    ['zone', { limitResetTimeZone: 'Europe/Berlin' }],
    ['empty models', { models: {} }],
  ]
  for (const [kind, overlay] of overlays) {
    for (const id of ['claude', 'zai']) {
      test(`a ${kind} overlay of ${id} leaves it shipped; the legacy entry re-homes to the reserved id`, () => {
        const project = projectWith(`f2-${id}-${kind.replace(/\s/g, '-')}`, {
          'providers.json': { [id]: overlay },
          'profiles.json': { [id]: { label: `My ${id === 'zai' ? 'Z.AI' : 'Claude'}`, env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
        })
        const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
        expect(head.errors).toEqual([])
        // The legacy entry keeps master's settings, under the reserved id.
        expect(head.profiles.get(id)).toEqual({
          label: `My ${id === 'zai' ? 'Z.AI' : 'Claude'}`,
          env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' },
          providerId: `profile:${id}`,
        })
        // The shipped provider keeps its id, models, and settings. Rev 5's
        // overlay reach: the env and zone overlays apply to the keys.
        const expectShippedKey = (key: string, base: Omit<CatalogProfile, 'providerId'>) => {
          const expected = { ...base }
          if (kind === 'env') expected.env = { ...base.env, ANTHROPIC_BASE_URL: 'https://gw.example.internal' }
          if (kind === 'zone') expected.limitResetTimeZone = 'Europe/Berlin'
          expect(head.profiles.get(key)).toEqual({ ...expected, providerId: id })
        }
        if (id === 'zai') {
          expect(head.providers.get('zai')?.models).toEqual(['glm', 'glm-flash'])
          expectShippedKey('glm', GLM)
        } else {
          expect(head.providers.get('claude')?.models).toEqual(['default', 'opus', 'sonnet', 'haiku'])
          expectShippedKey('default', DEFAULT)
        }
      })
    }
  }
})

describe('master parity for the shipped re-home (B2, finding F2)', () => {
  test('a zai relabel leaves glm shipped, so a later glm override re-homes like master', () => {
    const project = projectWith('b2', {
      'providers.json': { zai: { label: 'Z', models: {} } },
      'profiles.json': { glm: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
    })
    const head = expectParity(project, {
      ...SHIPPED,
      glm: { ...GLM, env: { ...ZAI_ENV, ANTHROPIC_BASE_URL: 'https://gw.example.internal' } },
    })
    expect(head.providers.get('zai')?.models).toEqual(['glm-flash'])
    // The P2 overlay applies: the provider label takes 'Z'.
    expect(head.providers.get('zai')?.label).toBe('Z')
    expect(head.profiles.get('glm')?.providerId).toBe('glm')
  })

  test('one level: providers.json read first, then profiles.json — the override still re-homes', () => {
    const project = projectWith('order', {
      'providers.json': { zai: { label: 'Z', models: {} } },
      'profiles.json': { 'glm-flash': { label: 'Flash' } },
    })
    const head = expectParity(project, {
      ...SHIPPED,
      'glm-flash': { ...GLM_FLASH, label: 'Flash' },
    })
    expect(head.profiles.get('glm-flash')?.providerId).toBe('glm-flash')
    expect(head.providers.get('zai')?.models).toEqual(['glm'])
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
