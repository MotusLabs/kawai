// The acceptance demonstration (provider-relay-setup): these three scenarios
// must FAIL on origin/master and pass at this change's head. The registry does
// not exist there, so a removed or dropped entry's credential variables are
// delivered again, and a legacy launch-env entry colliding with a registered
// name is delivered under its own name. The file deliberately imports nothing
// from secretNameRegistry — resolveClaudeProfile's fifth argument is simply
// ignored on master — so the file runs on the base commit and its failures
// are the base's own behavior, not an import error.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveClaudeProfile } from '../chat/ClaudeProfiles'
import { initDatabase, type SessionDatabase } from '../db'

let tempHome: string
let db: SessionDatabase

function writeProvidersCatalog(json: unknown): void {
  fs.mkdirSync(path.join(tempHome, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(tempHome, '.kawai', 'providers.json'), JSON.stringify(json))
}

/** Every resolution here is a Claude entry; the helper narrows the launch
 * union so `.env` reads directly. It imports nothing from the registry, so
 * the file still runs against the base commit's modules. */
function resolveClaudeLaunch(...args: Parameters<typeof resolveClaudeProfile>) {
  const launch = resolveClaudeProfile(...args)
  if (launch.runtime !== 'claude') throw new Error(`expected a Claude launch, got ${launch.runtime}`)
  return launch
}

const AMBIENT = {
  OR2_KEY: 'or-inference-sentinel',
  OR2_MANAGEMENT_KEY: 'or-management-sentinel',
  DROP_KEY: 'dropped-sentinel',
  UNRELATED_VAR: 'kept-value',
}

const ctx = () => ({ homeDir: tempHome })

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-registry-base-'))
  db = initDatabase({ path: ':memory:' })
})

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
  db.close()
})

describe('registered names survive entry removal on the base commit too', () => {
  // @covers: provider-credentials › Registered secret names stay withheld › Removing a provider keeps its names withheld
  test('a removed provider entry keeps its names withheld', () => {
    writeProvidersCatalog({
      or2: {
        label: 'OR2',
        authTokenEnv: 'OR2_KEY',
        balanceKeyEnv: 'OR2_MANAGEMENT_KEY',
        env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
        models: { 'or2-sonnet': { label: 'OR2 Sonnet', model: 'sonnet' } },
      },
    })
    // Register while present: a launch with the store observes the names.
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db)
    // The operator removes the provider by hand.
    writeProvidersCatalog({
      zai: {
        label: 'Z.AI',
        env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api' },
        models: { glm: { model: 'opus' } },
      },
    })
    const launch = resolveClaudeLaunch('default', AMBIENT, ctx(), undefined, db)
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
  })

  // @covers: provider-credentials › Registered secret names stay withheld › A launch-env entry colliding with a registered name stays inert
  test('a legacy launch-env entry colliding with a registered name is not delivered (W7)', () => {
    // W7's withholding half: a legacy Settings/seed map (the launch env here)
    // carries a name that was registered earlier and whose entry is gone.
    // On the base the name delivers under its own; with the registry the
    // retained set withholds it.
    writeProvidersCatalog({
      or2: {
        label: 'OR2',
        authTokenEnv: 'OR2_KEY',
        balanceKeyEnv: 'OR2_MANAGEMENT_KEY',
        env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
        models: { 'or2-sonnet': { label: 'OR2 Sonnet', model: 'sonnet' } },
      },
    })
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db) // register
    writeProvidersCatalog({
      zai: {
        label: 'Z.AI',
        env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api' },
        models: { glm: { model: 'opus' } },
      },
    })
    const launch = resolveClaudeLaunch(
      'default',
      { ...AMBIENT, OR2_KEY: 'legacy-seed-value', OR2_MANAGEMENT_KEY: 'legacy-seed-value' },
      ctx(),
      undefined,
      db,
    )
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
  })

  // @covers: provider-credentials › Registered secret names stay withheld › A disabled entry's variables stay withheld
  test('an entry outside the resolved catalog in any state keeps its names withheld', () => {
    // Pre-§3 form: the "dropped" provider parses (its names register) but the
    // trusted invariants drop it, so no launch may inherit DROP_KEY. The
    // literal `enabled: false` state (§3) rides the same parsed-layer
    // collection and gains its own case then.
    writeProvidersCatalog({
      dropped: {
        label: 'Dropped',
        authTokenEnv: 'DROP_KEY',
        models: { dropmodel: {} },
      },
      zai: {
        label: 'Z.AI',
        env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api' },
        models: { glm: { model: 'opus' } },
      },
    })
    const launch = resolveClaudeLaunch('default', AMBIENT, ctx(), undefined, db)
    expect(launch.env).not.toHaveProperty('DROP_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
  })
})
