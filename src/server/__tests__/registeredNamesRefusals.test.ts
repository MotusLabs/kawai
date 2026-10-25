// Refusal rows of the correction-B table (provider-relay-setup, rev 5.1):
// every branch that composes its own neutralization refuses a registered
// name pre-spawn. Each refusal resolves through the REAL layered catalog
// files and the REAL retained set (a seeded app_settings row — names only),
// never a hand-built env map, and asserts the typed error names the
// variable. Preserved rows live beside them: the wrapper overlay skip and
// the Default ambient route (W1), the W2 token channel, and the Codex
// CODEX_HOME refusal on every spawn.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveClaudeProfile } from '../chat/ClaudeProfiles'
import { codexSpawnEnv } from '../chat/codexProfiles'
import { RegisteredNameRefusal, RETAINED_SECRET_NAMES_KEY } from '../chat/secretNameRegistry'
import { initDatabase, type SessionDatabase } from '../db'
import { Script, startHarness, until } from './codexDriverHarness'
import type { CodexClient } from '../chat/codex/codexThread'
import type { AppServerClientOptions } from '../chat/codex/appServerClient'

const OR_URL = 'https://relay.example.internal/api'

let tempDir: string
let home: string
let db: SessionDatabase

/** Seed the retained set directly (the documented names-only row format). */
function seedRetained(names: string[]): void {
  db.setAppSetting(RETAINED_SECRET_NAMES_KEY, JSON.stringify(names))
}

function ctx(): { homeDir: string } {
  return { homeDir: home }
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-relay-refusal-')))
  home = path.join(tempDir, 'home')
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
})

afterEach(() => {
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

/** The refusal's message names every colliding variable, values never. */
function refusalOf(resolve: () => unknown): RegisteredNameRefusal {
  try {
    resolve()
  } catch (error) {
    expect(error).toBeInstanceOf(RegisteredNameRefusal)
    return error as RegisteredNameRefusal
  }
  throw new Error('expected the launch to be refused')
}

describe('named-profile controlled collisions (row 3)', () => {
  const writeNamedProfile = (env: Record<string, string>): void => {
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
      relay: { label: 'Relay', model: 'sonnet', env },
    }))
  }

  test('a retained controlled key refuses the launch, naming it', () => {
    writeNamedProfile({ ANTHROPIC_MODEL: 'claude-opus' })
    seedRetained(['ANTHROPIC_MODEL'])
    const refusal = refusalOf(() => resolveClaudeProfile('relay', {}, ctx(), undefined, db))
    expect(refusal.branch).toBe('named-profile')
    expect(refusal.names).toEqual(['ANTHROPIC_MODEL'])
    expect(refusal.message).toContain('ANTHROPIC_MODEL')
  })

  test('a provider binding registers a controlled key and refuses without retention', () => {
    // A provider whose token variable IS a controlled key: the catalog
    // layer alone registers it — no seeded row — and every named-profile
    // launch composes that key in its controlled map.
    fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
      'relay-provider': {
        label: 'Relay', authTokenEnv: 'ANTHROPIC_MODEL',
        models: { m: { label: 'Relay M', model: 'opus' } },
      },
    }))
    writeNamedProfile({ ANTHROPIC_BASE_URL: OR_URL })
    const refusal = refusalOf(() => resolveClaudeProfile('relay', {}, ctx(), undefined, db))
    expect(refusal.names).toEqual(['ANTHROPIC_MODEL'])
  })

  test('an unregistered controlled key still launches and delivers the entry (W1)', () => {
    writeNamedProfile({ ANTHROPIC_MODEL: 'claude-opus' })
    seedRetained(['ANTHROPIC_API_KEY'])
    const launch = resolveClaudeProfile('relay', {}, ctx(), undefined, db)
    if (launch.runtime !== 'claude') throw new Error('expected the Claude launch')
    expect(launch.env?.ANTHROPIC_MODEL).toBe('claude-opus')
  })
})

describe('credentialed pin and blank collisions (rows 4, 5)', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
      'relay-provider': {
        label: 'Relay', authTokenEnv: 'RELAY_TOKEN_ENV',
        env: { ANTHROPIC_BASE_URL: OR_URL },
        models: { 'or2-opus': { label: 'Relay Opus', model: 'opus' } },
      },
    }))
  })

  const launchCredentialed = (serverEnv: Record<string, string>) =>
    resolveClaudeProfile('or2-opus', serverEnv, ctx(), undefined, db)

  test('a retained transport-pin key refuses the credentialed launch (row 4)', () => {
    seedRetained(['HTTPS_PROXY'])
    const refusal = refusalOf(() => launchCredentialed({ RELAY_TOKEN_ENV: 'relay-token-value', HTTPS_PROXY: 'https://proxy.example.internal:3128' }))
    expect(refusal.branch).toBe('credentialed')
    expect(refusal.names).toEqual(['HTTPS_PROXY'])
  })

  test('a retained base URL refuses the pinned route too (row 4)', () => {
    seedRetained(['ANTHROPIC_BASE_URL'])
    const refusal = refusalOf(() => launchCredentialed({ RELAY_TOKEN_ENV: 'relay-token-value' }))
    expect(refusal.names).toEqual(['ANTHROPIC_BASE_URL'])
  })

  test('a retained credential blank refuses the launch (row 5)', () => {
    seedRetained(['ANTHROPIC_API_KEY'])
    const refusal = refusalOf(() => launchCredentialed({ RELAY_TOKEN_ENV: 'relay-token-value' }))
    expect(refusal.names).toEqual(['ANTHROPIC_API_KEY'])
  })

  test('every collision is named together, sorted', () => {
    seedRetained(['NO_PROXY', 'CLAUDE_CODE_OAUTH_TOKEN'])
    const refusal = refusalOf(() => launchCredentialed({ RELAY_TOKEN_ENV: 'relay-token-value' }))
    expect(refusal.names).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'NO_PROXY'])
  })

  test('unregistered pins and blanks still launch and compose the settings layer', () => {
    seedRetained(['RELAY_TOKEN_ENV'])
    const launch = launchCredentialed({ RELAY_TOKEN_ENV: 'relay-token-value', HTTPS_PROXY: 'https://proxy.example.internal:3128' })
    if (launch.runtime !== 'claude') throw new Error('expected the Claude launch')
    // The token rides the W2 channel only (row 6).
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('relay-token-value')
    expect(launch.env?.RELAY_TOKEN_ENV).toBeUndefined()
    const settings = (launch.settings as { env: Record<string, string> }).env
    expect(settings.ANTHROPIC_BASE_URL).toBe(OR_URL)
    expect(settings.HTTPS_PROXY).toBe('https://proxy.example.internal:3128')
    expect(settings.ANTHROPIC_API_KEY).toBe('')
    expect(settings.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
  })
})

describe('preserved channels (rows 6, 8)', () => {
  test('a retained token name still delivers under ANTHROPIC_AUTH_TOKEN after removal (row 6)', () => {
    // The provider entry is GONE; only the retained row remembers the name.
    // The W2 channel is the one live composed destination and must survive.
    seedRetained(['RELAY_TOKEN_ENV'])
    fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({}))
    const launch = resolveClaudeProfile('default', { RELAY_TOKEN_ENV: 'relay-token-value' }, ctx(), undefined, db)
    if (launch.runtime !== 'claude') throw new Error('expected the Claude launch')
    expect(launch.env?.RELAY_TOKEN_ENV).toBeUndefined()
  })

  test('a wrapper overlay drops a registered key and keeps the rest (row 8)', () => {
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
      wrap: {
        label: 'Wrap', executable: '/usr/local/bin/claude-wrap',
        env: { ANTHROPIC_MODEL: 'claude-opus', ANTHROPIC_DEFAULT_MODEL: 'claude-sonnet' },
      },
    }))
    seedRetained(['ANTHROPIC_MODEL'])
    const launch = resolveClaudeProfile('wrap', {}, ctx(), undefined, db)
    if (launch.runtime !== 'claude' || !launch.executable) throw new Error('expected the wrapper launch')
    expect(launch.env?.ANTHROPIC_MODEL).toBeUndefined()
    expect(launch.env?.ANTHROPIC_DEFAULT_MODEL).toBe('claude-sonnet')
  })

  test('a Default launch keeps unregistered ambient route variables (row 8, W1)', () => {
    seedRetained(['ANTHROPIC_MODEL'])
    const launch = resolveClaudeProfile('default', {
      HTTPS_PROXY: 'https://proxy.example.internal:3128',
      ANTHROPIC_BASE_URL: 'https://ambient.example.internal/api',
    }, ctx(), undefined, db)
    if (launch.runtime !== 'claude') throw new Error('expected the Claude launch')
    expect(launch.env?.HTTPS_PROXY).toBe('https://proxy.example.internal:3128')
    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://ambient.example.internal/api')
    expect(launch.env?.ANTHROPIC_MODEL).toBeUndefined()
  })
})

describe('Codex home collisions (row 7)', () => {
  test('codexSpawnEnv refuses a registered CODEX_HOME before composing', () => {
    expect(() => codexSpawnEnv({ PATH: '/usr/bin', CODEX_HOME: '/secret/example-internal/home' }, '/tmp/kawai-codex-home', new Set(['CODEX_HOME'])))
      .toThrow(RegisteredNameRefusal)
    try {
      codexSpawnEnv({ PATH: '/usr/bin' }, '/tmp/kawai-codex-home', new Set(['CODEX_HOME']))
    } catch (error) {
      expect((error as RegisteredNameRefusal).names).toEqual(['CODEX_HOME'])
      expect((error as RegisteredNameRefusal).branch).toBe('Codex')
    }
  })

  test('an unregistered CODEX_HOME composes the resolved home as before', () => {
    const env = codexSpawnEnv({ PATH: '/usr/bin', HOME: '/home/example' }, '/tmp/kawai-codex-home', new Set(['RELAY_TOKEN_ENV']))
    expect(env.CODEX_HOME).toBe('/tmp/kawai-codex-home')
    expect(env.HOME).toBe('/home/example')
  })
})

describe('Codex driver refusal across spawns (row 7)', () => {
  test('a CODEX_HOME registered before any spawn refuses the first send with no client', () => {
    const harness = startHarness(new Script().boot(), { withheldCredentials: () => new Set(['CODEX_HOME']) })
    try {
      expect(() => harness.driver.send('first')).toThrow(RegisteredNameRefusal)
      expect(harness.sent).toEqual([])
    } finally {
      harness.cleanup()
    }
  })

  test('a CODEX_HOME registered after creation refuses the respawn, not the first spawn', async () => {
    let registered = new Set<string>()
    const clients: unknown[] = []
    const harness = startHarness(new Script().boot(), {
      withheldCredentials: () => new Set(registered),
      createClient: options => {
        const client = makeDieingClient(options)
        clients.push(client)
        return client
      },
    })
    try {
      harness.driver.send('first')
      await until(() => clients.length === 1 && (clients[0] as DieingClient).startedThread)
      expect(clients.length).toBe(1)
      registered = new Set(['CODEX_HOME'])
      // End the app-server: the next send respawns through ensureClient,
      // where the per-spawn refusal now fires (correction A's provider).
      ;(clients[0] as DieingClient).die()
      expect(() => harness.driver.send('second')).toThrow(RegisteredNameRefusal)
      expect(clients.length).toBe(1)
    } finally {
      harness.cleanup()
    }
  })
})

/** A minimal CodexClient double: starts a thread, exits when ended. */
interface DieingClient extends CodexClient {
  startedThread: boolean
  /** Simulate the app-server process dying. */
  die(): void
}
function makeDieingClient(options: AppServerClientOptions): DieingClient {
  const client: DieingClient = {
    startedThread: false,
    die() {
      options.onExit({ code: 0, signal: null })
    },
    start() {},
    end() {},
    async initialize() {
      return {}
    },
    async request(method: string) {
      if (method === 'thread/start' || method === 'thread/resume') {
        client.startedThread = true
        return { thread: { id: 'th-refusal' } }
      }
      return {}
    },
  }
  return client
}
