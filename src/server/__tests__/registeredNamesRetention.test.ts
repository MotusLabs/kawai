// P7 and the registry's failure behavior (provider-relay-setup): a seeded
// generator runs the Lead's four mutation ops — remove (catalog-layer edit),
// disable (the entry drops out of the resolved catalog), clear (a name leaves
// the injected header source), reclassify (a name moves from the injected
// store-key source to a launch-env entry) — against the registry seam, with a
// named-profile probe launch per step asserting every ever-registered name
// stays withheld; and a malformed or unwritable retained key never un-hides a
// live credential. Companion to registeredNamesWithholding.test.ts, which
// audits the launch branches and the delta scenarios.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveClaudeProfile, type ClaudeLaunchConfiguration } from '../chat/ClaudeProfiles'
import { RETAINED_SECRET_NAMES_KEY, observeRegisteredNames } from '../chat/secretNameRegistry'
import { resolveProfileCatalog } from '../chat/profileCatalog'
import { initDatabase, type SessionDatabase } from '../db'

let tempHome: string
let db: SessionDatabase

/** The catalog under test: a credentialed provider, a named-profile overlay,
 * a wrapper, and a provider the trusted invariants drop (credentialed with no
 * trusted base URL — parsed, so its names register, but never resolved). */
function writeBaseCatalog(): void {
  writeProvidersCatalog({
    or2: {
      label: 'OR2',
      authTokenEnv: 'OR2_KEY',
      balanceKeyEnv: 'OR2_MANAGEMENT_KEY',
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
      models: { 'or2-sonnet': { label: 'OR2 Sonnet', model: 'sonnet' } },
    },
    zai: {
      label: 'Z.AI',
      env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api' },
      models: { glm: { model: 'opus', env: { ANTHROPIC_MODEL: 'glm-5.3' } } },
    },
    wrapped: {
      label: 'Wrapped',
      executable: '/usr/local/bin/claude-wrap',
      models: { wrap: {} },
    },
    dropped: {
      label: 'Dropped',
      authTokenEnv: 'DROP_KEY',
      models: { dropmodel: {} },
    },
  })
}

function writeProvidersCatalog(json: unknown): void {
  fs.mkdirSync(path.join(tempHome, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(tempHome, '.kawai', 'providers.json'), JSON.stringify(json))
}

/** Every resolution here is a Claude entry; the helper narrows the union. */
function resolveClaudeLaunch(...args: Parameters<typeof resolveClaudeProfile>): ClaudeLaunchConfiguration {
  const launch = resolveClaudeProfile(...args)
  if (launch.runtime !== 'claude') throw new Error(`expected a Claude launch, got ${launch.runtime}`)
  return launch
}

const ctx = () => ({ homeDir: tempHome })

const AMBIENT = {
  OR2_KEY: 'or-inference-sentinel',
  OR2_MANAGEMENT_KEY: 'or-management-sentinel',
  DROP_KEY: 'dropped-sentinel',
  UNRELATED_VAR: 'kept-value',
  ANTHROPIC_BASE_URL: 'https://ambient.example.internal',
  HTTPS_PROXY: 'http://192.0.2.10:3128',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-registry-p7-'))
  db = initDatabase({ path: ':memory:' })
  writeBaseCatalog()
})

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
  db.close()
})

describe('P7 — withholding survives every mutation op (generated at the registry seam)', () => {
  const SEED = 20261025
  const CASES = 24

  /** mulberry32: a tiny seeded PRNG — the design forbids a new dependency. */
  function rng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  test('every remove/disable/clear/reclassify sequence keeps registered names withheld', () => {
    const random = rng(SEED)
    for (let caseIndex = 0; caseIndex < CASES; caseIndex++) {
      db.deleteAppSetting(RETAINED_SECRET_NAMES_KEY)
      // A stable named-profile host the ops never touch, so every step's
      // probe is a named-profile launch.
      const providers: Record<string, Record<string, unknown>> = {
        host: {
          label: 'Host',
          env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api' },
          models: { glm: { model: 'opus' } },
        },
      }
      const headerVars: string[] = []
      const storeKeys: string[] = []
      const probeEnv: Record<string, string> = { ...AMBIENT }
      const registered: string[] = []
      const nextName = (step: number) => `KEY_${caseIndex}_${step}`
      const observeSeam = () =>
        observeRegisteredNames(db, {
          catalogNames: resolveProfileCatalog(ctx()).credentialNames,
          headerVariables: headerVars,
          secretSourceKeys: storeKeys,
        })
      // A fresh name enters one of the three sources: a catalog binding, the
      // injected header source, or the injected store-key source.
      const introduce = (step: number) => {
        const name = nextName(step)
        const where = Math.floor(random() * 3)
        if (where === 0) {
          providers[`p${step}`] = {
            label: `P${step}`,
            authTokenEnv: name,
            env: { ANTHROPIC_BASE_URL: 'https://relay.example.internal' },
            models: { [`m${step}`]: {} },
          }
        } else if (where === 1) {
          headerVars.push(name)
        } else {
          storeKeys.push(name)
        }
        registered.push(name)
      }
      const steps = 3 + Math.floor(random() * 5)
      introduce(0)
      writeProvidersCatalog(providers)
      observeSeam()
      for (let step = 1; step <= steps; step++) {
        const op = Math.floor(random() * 4)
        if (op === 0) {
          // remove: a catalog-layer edit — the entry goes away entirely.
          const ids = Object.keys(providers).filter(id => id !== 'host')
          if (ids.length === 0) introduce(step)
          else delete providers[ids[Math.floor(random() * ids.length)]!]
        } else if (op === 1) {
          // disable: the entry drops out of the resolved catalog (a
          // credentialed entry loses its trusted base URL) while the parsed
          // layer still names its variable.
          const id = Object.keys(providers).find(candidate => {
            const entry = providers[candidate]!
            return entry.authTokenEnv !== undefined
              && (entry.env as Record<string, string>).ANTHROPIC_BASE_URL !== undefined
          })
          if (id === undefined) introduce(step)
          else delete (providers[id]!.env as Record<string, string>).ANTHROPIC_BASE_URL
        } else if (op === 2) {
          // clear: a name leaves the injected header source.
          if (headerVars.length === 0) introduce(step)
          else headerVars.splice(Math.floor(random() * headerVars.length), 1)
        } else {
          // reclassify: a name moves from the injected store-key source to a
          // launch-env delivery attempt, while retention keeps it registered.
          if (storeKeys.length === 0) introduce(step)
          else {
            const index = Math.floor(random() * storeKeys.length)
            probeEnv[storeKeys[index]!] = 'reclassified-delivery'
            storeKeys.splice(index, 1)
          }
        }
        writeProvidersCatalog(providers)
        observeSeam()
        const launch = resolveClaudeLaunch('glm', probeEnv, ctx(), undefined, db)
        for (const name of registered) {
          expect(launch.env, `case ${caseIndex} step ${step}: ${name} delivered`).not.toHaveProperty(name)
        }
        expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://zai.example.internal/api')
        expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
      }
      // The persisted set holds every name the sequence ever registered.
      const persisted = JSON.parse(db.getAppSetting(RETAINED_SECRET_NAMES_KEY) ?? '[]') as string[]
      expect(new Set(persisted)).toEqual(new Set(registered))
    }
  })
})

describe('registry failures never un-hide a live credential', () => {
  test('a malformed retained key warns and live catalog names stay withheld', () => {
    db.setAppSetting(RETAINED_SECRET_NAMES_KEY, '{not json')
    const warns: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warns.push(args)
    try {
      const launch = resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db)
      expect(launch.env).not.toHaveProperty('OR2_KEY')
      expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
      expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
    } finally {
      console.warn = original
    }
    expect(warns.some(args => String(args.join(' ')).includes(RETAINED_SECRET_NAMES_KEY))).toBe(true)
  })

  test('a launch without a registry still withholds the live catalog names', () => {
    // The db-less contract (direct resolution, tests): present entries'
    // names are withheld exactly as before — persistence needs a store.
    const launch = resolveClaudeLaunch('default', AMBIENT, ctx())
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
  })
})
