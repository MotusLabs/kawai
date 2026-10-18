// The rev 5 acceptance cells (a)-(g), I3, and the S8 label-preservation
// probes, split from profileCatalogMasterParity.test.ts (finding N-B). Each
// cell runs over X in {claude, zai} on the shipped and operator bases, with
// a fresh HOME per combination. Constants mirror the shipped defaults so
// both bases give the same per-key settings absent overlays.
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
const DEFAULT: Omit<CatalogProfile, 'providerId'> = { label: 'Default', env: {} }
const OPUS: Omit<CatalogProfile, 'providerId'> = { label: 'Claude Opus', env: {}, model: 'claude-opus-5-5' }
const SONNET: Omit<CatalogProfile, 'providerId'> = { label: 'Claude Sonnet', env: {}, model: 'claude-sonnet-5-5' }
const HAIKU: Omit<CatalogProfile, 'providerId'> = { label: 'Claude Haiku', env: {}, model: 'claude-haiku-5-5' }

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

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-rev5-cells-')))
  home = path.join(root, 'no-home')
  fs.mkdirSync(home, { recursive: true })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('rev 5 acceptance cells', () => {
  const P = (d: string) => path.join(d, '.kawai', 'providers.json')
  const F = (d: string) => path.join(d, '.kawai', 'profiles.json')
  const MODEL = (file: string, key: string, provider: string, origin: string) =>
    `${file}: model "${key}" is already defined under provider "${provider}" (${origin}); the nearer definition is ignored.`
  const ENTRY = (file: string, key: string, provider: string, origin: string) =>
    `${file}: profile "${key}" is a model of provider "${provider}" (${origin}); the entry is ignored.`
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
    for (const [, overlay, assert$] of overlayCases) {
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
        expect(head.errors).toEqual([MODEL(P(project), key, x, P(home))])
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

  test('(g, S6) one providers.json overlaying X and moving one of its keys to a new provider resolves identically in both JSON key orders', () => {
    for (const x of ['claude', 'zai']) {
      for (const base of ['shipped', 'operator'] as const) {
        // A fresh HOME per combination: no user file leaks across combos.
        home = path.join(root, `home-${x}-${base}-${Math.random().toString(36).slice(2, 6)}`)
        fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
        if (base === 'operator') {
          // The operator base: a user-level providers.json defining X with
          // its keys replaces the shipped layer.
          fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify(OPERATOR_USER[x]))
          fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), '{}')
        }
        const moving = x === 'zai' ? 'glm' : 'opus'
        const target = x === 'zai' ? 'zai2' : 'claude2'
        const orders: Array<Record<string, unknown>> = [
          { [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }, [target]: { models: { [moving]: {} } } },
          { [target]: { models: { [moving]: {} } }, [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
        ]
        const runs = orders.map(order => {
          const project = projectWith(`g-${x}-${base}-${Math.random().toString(36).slice(2, 6)}`, { 'providers.json': order })
          const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
          if (base === 'shipped') {
            // Shipped-held: the key re-homes with the overlay.
            expect(head.errors).toEqual([])
          } else {
            // Operator-held: the nearer definition is refused with the error.
            expect(head.errors).toEqual([MODEL(P(project), moving, x, P(home))])
          }
          return head
        })
        for (const head of runs) {
          // Either way the moved key carries the overlay base URL; X's
          // remaining keys keep it too.
          expect(head.profiles.get(moving)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
          expect(head.profiles.get(moving)?.providerId).toBe(base === 'shipped' ? target : x)
          for (const key of X_KEYS[x]) {
            if (key === moving) continue
            expect(head.profiles.get(key)?.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.internal')
            expect(head.profiles.get(key)?.providerId).toBe(x)
          }
        }
        expect(JSON.stringify([...runs[0]!.profiles.entries()])).toEqual(JSON.stringify([...runs[1]!.profiles.entries()]))
      }
    }
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
        expect(head.errors).toEqual([ENTRY(F(project), key, x, P(home))])
        expect(head.profiles.get(key)?.providerId).toBe(x)
      }
    }, x => ({
      'providers.json': { [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } },
      'profiles.json': { [X_KEYS[x][0]]: { label: 'Moved' } },
    }))
  })

  test('(S1) an entry whose id names no provider becomes provider <id> holding exactly model <id>, the entry label on both', () => {
    forAll((x, _base, project) => {
      // A NEW id (neither a provider nor a key of X): L4 makes it a
      // one-model provider whose label is the entry's, on both levels.
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      expect(head.errors).toEqual([])
      expect(head.providers.get('fresh')).toEqual({ label: 'Fresh', models: ['fresh'] })
      expect(head.profiles.get('fresh')).toEqual({
        label: 'Fresh', env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' }, providerId: 'fresh',
      })
    }, () => ({ 'profiles.json': { fresh: { label: 'Fresh', env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } } } }))
  })

  test('(S8, N-A) a re-homed key keeps its own label over X on the shipped base', () => {
    for (const x of ['claude', 'zai']) {
      const moving = x === 'zai' ? 'glm' : 'default'
      const target = x === 'zai' ? 'zai2' : 'claude2'
      const ownLabel = x === 'zai' ? 'GLM' : 'Default'
      const targetLabel = x === 'zai' ? 'Z2' : 'C2'
      // CC's probe: the re-home target's label must not reach the key.
      const project = projectWith(`s8-${x}`, {
        'providers.json': { [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }, [target]: { label: targetLabel, models: { [moving]: {} } } },
      })
      const head = resolveProfileCatalog({ homeDir: home, projectPath: project })
      expect(head.errors).toEqual([])
      expect(head.profiles.get(moving)?.providerId).toBe(target)
      expect(head.profiles.get(moving)?.label).toBe(ownLabel)
      // The profiles.json re-home variant carries no label and expects the
      // shipped label.
      const variant = projectWith(`s8p-${x}`, {
        'profiles.json': { [moving]: {} },
        'providers.json': { [x]: { env: { ANTHROPIC_BASE_URL: 'https://gw.example.internal' } }, [target]: { label: targetLabel, models: {} } },
      })
      const vhead = resolveProfileCatalog({ homeDir: home, projectPath: variant })
      expect(vhead.errors).toEqual([])
      expect(vhead.profiles.get(moving)?.providerId).toBe(moving)
      expect(vhead.profiles.get(moving)?.label).toBe(ownLabel)
    }
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
