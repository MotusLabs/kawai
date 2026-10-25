// The filtered-env audit (provider-relay-setup tasks 1.1/1.2, table W, D5's
// composition table): every launch branch withholds the registered-name set;
// a name stays withheld after its entry is removed or dropped, because the
// registry persists it (names only, app_settings "registered_secret_names");
// and an unregistered ambient variable passes exactly as before on every
// branch (W1). The seeded P7 generator and the registry's failure behavior
// live in registeredNamesRetention.test.ts; the scenarios that must fail on
// origin/master live in registeredNameSurvivesRemoval.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROFILE_CONTROLLED_ENV,
  resolveClaudeProfile,
  withheldCredentialNamesAt,
  type ClaudeLaunchConfiguration,
} from '../chat/ClaudeProfiles'
import { codexSpawnEnv } from '../chat/codexProfiles'
import {
  RETAINED_SECRET_NAMES_KEY,
  collidingLaunchEnvNames,
  observeRegisteredNames,
  readRetainedNames,
} from '../chat/secretNameRegistry'
import { initDatabase, type SessionDatabase } from '../db'

let tempHome: string
let db: SessionDatabase
const savedProcessEnv: Record<string, string | undefined> = {}

/** The catalog under test: a credentialed provider, a named-profile overlay,
 * a wrapper, and a provider the trusted invariants drop (credentialed with no
 * trusted base URL — parsed, so its names register, but never resolved). */
function writeBaseCatalog(): void {
  writeProvidersCatalog({
    or2: {
      label: 'OR2',
      authTokenEnv: 'OR2_KEY',
      balanceKeyEnv: 'OR2_MANAGEMENT_KEY',
      env: { ANTHROPIC_BASE_URL: 'https://or2.example.internal/api' },
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

const ctx = () => ({ homeDir: tempHome })

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-registry-audit-'))
  db = initDatabase({ path: ':memory:' })
  writeBaseCatalog()
})

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
  db.close()
  for (const [name, value] of Object.entries(savedProcessEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete savedProcessEnv[name]
  }
})

function setProcessEnv(name: string, value: string): void {
  if (!(name in savedProcessEnv)) savedProcessEnv[name] = process.env[name]
  process.env[name] = value
}

const AMBIENT = {
  OR2_KEY: 'or-inference-sentinel',
  OR2_MANAGEMENT_KEY: 'or-management-sentinel',
  DROP_KEY: 'dropped-sentinel',
  UNRELATED_VAR: 'kept-value',
  ANTHROPIC_BASE_URL: 'https://ambient.example.internal',
  HTTPS_PROXY: 'http://192.0.2.10:3128',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
}

/** One launch of each kind, so every branch is audited against the same
 * ambient environment and the same registered set (D5's withheld-set row).
 * The registry's db rides the production arguments: resolution persists the
 * catalog's names before filtering, and the Codex arm's set comes from the
 * same store-backed read the manager makes. */
const BRANCH_PROBES = {
  default: () => resolveClaudeLaunch('default', AMBIENT, ctx(), undefined, db),
  namedProfile: () => resolveClaudeLaunch('glm', AMBIENT, ctx(), undefined, db),
  wrapper: () => resolveClaudeLaunch('wrap', AMBIENT, ctx(), undefined, db),
  credentialed: () => resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db),
  codex: () => codexSpawnEnv({ ...process.env, ...AMBIENT }, '/srv/codex', withheldCredentialNamesAt(ctx(), db)),
} as const

describe('every launch branch withholds the registered-name set (D5 composition table)', () => {
  test('the Default branch filters registered names and keeps unregistered ambient ones', () => {
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db) // register
    const launch = BRANCH_PROBES.default()
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env).not.toHaveProperty('DROP_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
    // W1: ambient route variables are not registered — a Default launch
    // keeps an ambient base URL or proxy exactly as at the base.
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://ambient.example.internal')
    expect(launch.env?.HTTPS_PROXY).toBe('http://192.0.2.10:3128')
    expect(launch.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('32000')
    expect(launch.settings).toBeUndefined()
  })

  test('the named-profile branch keeps its deletions and still filters registered names', () => {
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db)
    const launch = BRANCH_PROBES.namedProfile()
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env).not.toHaveProperty('DROP_KEY')
    // Unrelated overrides are retained, per today's named-profile rule.
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
    expect(launch.env?.HTTPS_PROXY).toBe('http://192.0.2.10:3128')
    // The controlled variable the profile sets wins; the one it does not
    // set is the branch's own deletion, not the registry's.
    expect(launch.env?.ANTHROPIC_MODEL).toBe('glm-5.3')
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://zai.example.internal/api')
    expect(launch.env).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS')
  })

  test('the wrapper branch keeps its ambient environment and filters registered names', () => {
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db)
    const launch = BRANCH_PROBES.wrapper()
    // The branch's own carve-outs (D5): the wrapper owns provider
    // configuration — no controlled settings are injected and it never
    // receives a token — so none of those appears here either.
    expect(launch.executable).toBe('/usr/local/bin/claude-wrap')
    expect(launch.settings).toBeUndefined()
    expect(launch.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env).not.toHaveProperty('DROP_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://ambient.example.internal')
    expect(launch.env?.HTTPS_PROXY).toBe('http://192.0.2.10:3128')
  })

  test('the credentialed branch composes its token and filters every other registered name', () => {
    const launch = BRANCH_PROBES.credentialed()
    // The branch's own carve-outs (D5), named so the registered-absent claim
    // is never read to cover them: the token composes under ANTHROPIC_AUTH_TOKEN,
    // the transport pins compose from the server environment (a set variable
    // keeps its value, the rest blank), the other credential variables blank,
    // and the entry's own base URL overlays the ambient one. None of these is
    // a registered name riding under its own.
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('or-inference-sentinel')
    expect(launch.env?.ANTHROPIC_API_KEY).toBe('')
    expect(launch.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://or2.example.internal/api')
    expect(launch.env?.HTTPS_PROXY).toBe('http://192.0.2.10:3128')
    expect(launch.env?.HTTP_PROXY).toBe('')
    expect(launch.env?.NO_PROXY).toBe('')
    expect(launch.env?.NODE_TLS_REJECT_UNAUTHORIZED).toBe('')
    expect(launch.env?.NODE_EXTRA_CA_CERTS).toBe('')
    // The registered names themselves are absent, under their own or any name.
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    expect(launch.env).not.toHaveProperty('DROP_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
  })

  test('the Codex branch filters registered names beside its provider variables', () => {
    // The arm composes from the server environment; its set is the same
    // store-backed read the manager makes (withheldCredentialNamesAt with
    // the db), so retained names are withheld here too.
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db)
    const env = BRANCH_PROBES.codex()
    expect(env.OR2_KEY).toBeUndefined()
    expect(env.OR2_MANAGEMENT_KEY).toBeUndefined()
    expect(env.DROP_KEY).toBeUndefined()
    expect(env.UNRELATED_VAR).toBe('kept-value')
    // The Codex branch's own operations (D5 row): every ANTHROPIC_*/CLAUDE_*
    // variable dropped, CODEX_HOME set — the ambient base URL goes with them.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined()
    expect(env.CODEX_HOME).toBe('/srv/codex')
    expect(env.HTTPS_PROXY).toBe('http://192.0.2.10:3128')
  })
})

describe('registered secret names stay withheld (provider-credentials delta scenarios)', () => {
  // @covers: provider-credentials › Registered secret names stay withheld › Removing a provider keeps its names withheld
  test('a removed provider entry keeps its names withheld from every launch', () => {
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db) // register while present
    // The operator removes the provider by hand (the §6 write path lands later).
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
    // And the Codex arm withholds through the same persisted set: its read
    // carries the retained names, so the removed entry's credentials stay
    // out of its spawn environment.
    const codex = codexSpawnEnv({ ...process.env, ...AMBIENT }, '/srv/codex', withheldCredentialNamesAt(ctx(), db))
    expect(codex.OR2_KEY).toBeUndefined()
    expect(codex.OR2_MANAGEMENT_KEY).toBeUndefined()
    expect(codex.UNRELATED_VAR).toBe('kept-value')
  })

  // @covers: provider-credentials › Registered secret names stay withheld › A disabled entry's variables stay withheld
  test('an entry outside the resolved catalog in any state keeps its names withheld', () => {
    // Pre-§3 form: the "dropped" provider parses (its names register) but the
    // trusted invariants drop it, so no launch may inherit DROP_KEY. The
    // literal `enabled: false` state (§3) rides the same parsed-layer
    // collection and gains its own case then.
    const launch = resolveClaudeLaunch('default', AMBIENT, ctx(), undefined, db)
    expect(launch.env).not.toHaveProperty('DROP_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
    const codex = codexSpawnEnv({ ...process.env, ...AMBIENT }, '/srv/codex', withheldCredentialNamesAt(ctx(), db))
    expect(codex.DROP_KEY).toBeUndefined()
  })

  // @covers: provider-credentials › Registered secret names stay withheld › An ambient route survives a Default launch
  test('an unregistered ambient route survives Default and wrapper launches', () => {
    // Nothing registers the base URL or proxy variables: they are not in the
    // registered set, whatever the catalog resolves beside them.
    const def = BRANCH_PROBES.default()
    expect(def.env?.ANTHROPIC_BASE_URL).toBe('https://ambient.example.internal')
    expect(def.env?.HTTPS_PROXY).toBe('http://192.0.2.10:3128')
    const wrap = BRANCH_PROBES.wrapper()
    expect(wrap.env?.ANTHROPIC_BASE_URL).toBe('https://ambient.example.internal')
    expect(wrap.env?.HTTPS_PROXY).toBe('http://192.0.2.10:3128')
  })

  // @covers: provider-credentials › Registered secret names stay withheld › A launch-env entry colliding with a registered name stays inert
  test('a colliding delivery stays inert: no launch receives a registered name however it is set', () => {
    // Pre-§2 delivery sources: the process environment and the Settings/seed
    // override ride effectiveChatEnv today. Registered-name withholding wins
    // over delivery on every branch (W2/W7's filter half; the store-side
    // inertness and the listing's collision report land with §2/§7).
    setProcessEnv('OR2_KEY', 'from-process-env')
    const overrides = { ...AMBIENT, OR2_KEY: 'from-settings-override', OR2_MANAGEMENT_KEY: 'from-settings-override' }
    for (const id of ['default', 'glm', 'wrap'] as const) {
      const launch = resolveClaudeLaunch(id, overrides, ctx(), undefined, db)
      expect(launch.env).not.toHaveProperty('OR2_KEY')
      expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
    }
  })

  // @covers: provider-credentials › Registered secret names stay withheld › A launch-env entry colliding with a registered name stays inert
  test('a legacy launch-env entry colliding with a retained name is not delivered (W7)', () => {
    // The W7 withholding half: a legacy Settings/seed map (the launch env, in
    // effectiveChatEnv's merge today) carries a name that was registered
    // earlier and whose entry is now gone. Retention keeps it withheld — this
    // is the pairing with registeredNameSurvivesRemoval.test.ts, which
    // demonstrates the same behavior failing on the base.
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db) // register
    writeProvidersCatalog({
      zai: {
        label: 'Z.AI',
        env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api' },
        models: { glm: { model: 'opus' } },
      },
    })
    const legacy = { ...AMBIENT, OR2_KEY: 'legacy-seed-value', OR2_MANAGEMENT_KEY: 'legacy-seed-value' }
    for (const id of ['default', 'glm'] as const) {
      const launch = resolveClaudeLaunch(id, legacy, ctx(), undefined, db)
      expect(launch.env).not.toHaveProperty('OR2_KEY')
      expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
      expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
    }
    // The collision is exposed as data for §7's listing (names only) — every
    // registered name the legacy map carries, DROP_KEY included (the ambient
    // environment carries it and the dropped provider registers it).
    expect(collidingLaunchEnvNames(legacy, readRetainedNames(db))).toEqual([
      'DROP_KEY',
      'OR2_KEY',
      'OR2_MANAGEMENT_KEY',
    ])
  })

  // @covers: provider-credentials › Registered secret names stay withheld › A launch-env entry colliding with a registered name stays inert
  test('a name observed at an injected source is withheld by later launches (W8)', () => {
    // W8 at the seam: header variables and store keys join the registered set
    // through observation, and a launch sharing the store withholds them —
    // however the launch environment tries to deliver them — even before §2/§4
    // wire their own producers. Names only: the observed value never persists.
    observeRegisteredNames(db, {
      headerVariables: ['RELAY_VIRTUAL_KEY'],
      secretSourceKeys: ['STORE_ONLY_KEY'],
    })
    const launch = resolveClaudeLaunch(
      'default',
      { ...AMBIENT, RELAY_VIRTUAL_KEY: 'value-not-delivered', STORE_ONLY_KEY: 'value-not-delivered' },
      ctx(),
      undefined,
      db,
    )
    expect(launch.env).not.toHaveProperty('RELAY_VIRTUAL_KEY')
    expect(launch.env).not.toHaveProperty('STORE_ONLY_KEY')
    expect(launch.env?.UNRELATED_VAR).toBe('kept-value')
    // The persisted row holds the injected names beside the catalog's own
    // (the probe launch's observation persisted those too) — names only.
    const persisted = JSON.parse(db.getAppSetting(RETAINED_SECRET_NAMES_KEY) ?? '[]') as string[]
    expect(new Set(persisted)).toEqual(new Set([
      'OR2_KEY',
      'OR2_MANAGEMENT_KEY',
      'DROP_KEY',
      'RELAY_VIRTUAL_KEY',
      'STORE_ONLY_KEY',
    ]))
  })

  // @covers: provider-credentials › Registered secret names stay withheld › Reclassification does not end withholding
  test('a name stays registered through entry-state changes', () => {
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db) // OR2_KEY registers
    // The binding is cleared (the entry no longer names OR2_KEY) — the
    // pre-§2 reclassification shape: the state that delivers changes, the
    // registered name does not.
    writeProvidersCatalog({
      or2: {
        label: 'OR2',
        env: { ANTHROPIC_BASE_URL: 'https://or2.example.internal/api' },
        models: { 'or2-sonnet': { label: 'OR2 Sonnet', model: 'sonnet' } },
      },
    })
    const launch = resolveClaudeLaunch('default', AMBIENT, ctx(), undefined, db)
    expect(launch.env).not.toHaveProperty('OR2_KEY')
    expect(launch.env).not.toHaveProperty('OR2_MANAGEMENT_KEY')
  })

  test('delivery of unregistered names is unchanged on every branch (W1/W6)', () => {
    resolveClaudeLaunch('or2-sonnet', AMBIENT, ctx(), undefined, db)
    const REGISTERED = new Set(['OR2_KEY', 'OR2_MANAGEMENT_KEY', 'DROP_KEY'])
    const input = { ...process.env, ...AMBIENT }
    const def = BRANCH_PROBES.default()
    assertDeliveryUnchanged(def.env ?? {}, input, REGISTERED, {})
    const wrap = BRANCH_PROBES.wrapper()
    assertDeliveryUnchanged(wrap.env ?? {}, input, REGISTERED, {})
    // The named-profile branch's own operations: every controlled variable
    // the profile does not set is deleted (the runner's environment carries
    // several), and the profile's catalog env overlays the rest.
    const glmProfileEnv = { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api', ANTHROPIC_MODEL: 'glm-5.3' }
    const named = BRANCH_PROBES.namedProfile()
    assertDeliveryUnchanged(named.env ?? {}, input, REGISTERED, {
      deleted: PROFILE_CONTROLLED_ENV.filter(name => !(name in glmProfileEnv)),
      overwritten: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api' },
      added: { ANTHROPIC_MODEL: 'glm-5.3' },
    })
    const cred = BRANCH_PROBES.credentialed()
    assertDeliveryUnchanged(cred.env ?? {}, input, REGISTERED, {
      deleted: PROFILE_CONTROLLED_ENV.filter(name => name !== 'ANTHROPIC_BASE_URL'),
      overwritten: { ANTHROPIC_BASE_URL: 'https://or2.example.internal/api' },
      added: {
        ANTHROPIC_AUTH_TOKEN: 'or-inference-sentinel',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ...Object.fromEntries(
          ['HTTP_PROXY', 'NO_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS']
            .filter(name => !(name in input))
            .map(name => [name, '']),
        ),
      },
    })
    // Codex composes from the server environment; the probe passes one
    // explicitly instead of the runner's process.env. Its own operations:
    // ANTHROPIC_*/CLAUDE_CODE_* dropped (the ambient base URL and the
    // controlled output-tokens variable with them), CODEX_HOME added.
    const codexInput = { PATH: '/usr/bin', HOME: tempHome, ...AMBIENT }
    const codex = codexSpawnEnv(codexInput, '/srv/codex', withheldCredentialNamesAt(ctx(), db))
    assertDeliveryUnchanged(codex, codexInput, REGISTERED, {
      deleted: ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'],
      added: { CODEX_HOME: '/srv/codex' },
    })
  })

  /** Invariant 2 (W1/W6): the composed environment equals the input minus the
   * registered names, plus the branch's own documented operations — never a
   * lost or rewritten unregistered variable. */
  function assertDeliveryUnchanged(
    composed: Record<string, string | undefined>,
    input: Record<string, string>,
    registered: ReadonlySet<string>,
    branch: { deleted?: string[]; added?: Record<string, string>; overwritten?: Record<string, string> },
  ): void {
    const expected: Record<string, string> = { ...input }
    for (const name of registered) delete expected[name]
    for (const name of branch.deleted ?? []) delete expected[name]
    Object.assign(expected, branch.overwritten, branch.added)
    expect(Object.keys(composed).sort()).toEqual(Object.keys(expected).sort())
    for (const [name, value] of Object.entries(expected)) {
      expect(composed[name]).toBe(value)
    }
  }
})

