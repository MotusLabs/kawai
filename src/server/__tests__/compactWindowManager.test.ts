// Role auto-compaction windows through the REAL ChatSessionManager
// (mimo-million-token-context D3, rows L1, L6, L7): the manager's per-spawn
// getCompactWindow callback reaches claudeSpawnLaunch, which composes the
// window and the cleared disable switches into both env layers the package
// receives (the SDK options' env and settings.env), and the package's
// context tracker and the start observation read the composed window. A
// composed name registered after the driver exists (its catalog binding then
// removed, so only the retained row keeps it) refuses the next spawn —
// start and respawn alike, on the Default, named and credentialed branches —
// before any query is created; a noncolliding preference launches and leaves
// the registered and retained sets unchanged.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ChatContextUsage } from '../../shared/chat'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { readRetainedNames } from '../chat/secretNameRegistry'
import { type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { anyDirectory, assistantUsage, fakeQueryFactory, flush, initMessage, installManagerCleanup, managedManager, resultWithWindow, spawned, waitForCondition, type FakeHandle } from './helpers/chatSessionManagerHarness'
import { freshTestDatabase } from './helpers/testDatabase'

installManagerCleanup()

const ENV_KEYS = [
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'COMPACT_TOKEN_ENV',
] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let project: string
let home: string
let db: SessionDatabase

/** The shipped MiMo declaration, copied into the user level beside a credentialed provider. */
const MIMO = {
  label: 'MiMo', model: 'mimo-v2.6-pro[1m]', autoCompactWindow: 300000,
  env: {
    ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic', ANTHROPIC_MODEL: 'mimo-v2.6-pro[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.6-flash[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.6-pro[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.6-pro[1m]', ANTHROPIC_DEFAULT_FABLE_MODEL: 'mimo-v2.6-pro[1m]',
  },
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-compact-window-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  db = freshTestDatabase(path.join(tempDir, 'test.db'))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  process.env.COMPACT_TOKEN_ENV = 'relay-token-value'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const writeGroup = (frontmatter: string) =>
  fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), `---\n${frontmatter}\n---\nBuild.`)

/** A user-level catalog: MiMo, and a credentialed relay whose token variable name is `tokenEnv`. */
function writeUserCatalog(tokenEnv = 'COMPACT_TOKEN_ENV'): void {
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ mimo: MIMO }))
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
    relay: {
      label: 'Relay', authTokenEnv: tokenEnv,
      env: { ANTHROPIC_BASE_URL: 'https://relay.example.internal/api' },
      models: { 'relay-opus': { label: 'Relay Opus', model: 'opus' } },
    },
  }))
}

interface Started {
  manager: ChatSessionManager
  handles: FakeHandle[]
  readings: ChatContextUsage[]
  settings: Array<{ contextWindow: number | null }>
}

async function startManager(): Promise<Started> {
  const handles: FakeHandle[] = []
  const readings: ChatContextUsage[] = []
  const manager = await managedManager({
    isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {},
    onContextUsage: (_id, usage) => { if (usage) readings.push(usage) },
    queryFactory: fakeQueryFactory(handles),
    executableCheck: async () => ({ path: '/opt/claude', identity: 'id-1' }),
    availabilityProbe: async () => {},
    profileCatalogHome: home,
  })
  const settings: Array<{ contextWindow: number | null }> = []
  const observe = manager.observations.chat
  const original = observe.settings.bind(observe)
  spyOn(observe, 'settings').mockImplementation((sessionId, data) => {
    settings.push({ contextWindow: (data as { contextWindow: number | null }).contextWindow })
    original(sessionId, data)
  })
  return { manager, handles, readings, settings }
}

async function create(manager: ChatSessionManager, input: { claudeProfileId?: string; spawned?: boolean }): Promise<string> {
  const created = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', ...input })
  if (!created.ok) throw new Error(created.error)
  return created.session.id
}

const layers = (options: Options) => ({
  env: options.env ?? {},
  settings: (options.settings as { env?: Record<string, string> } | undefined)?.env ?? {},
})

/** One finished turn on a fresh process, so the next send respawns after `close`. */
async function finishTurn(handle: FakeHandle, sdkId: string): Promise<void> {
  handle.push(initMessage(sdkId))
  handle.push(resultWithWindow())
  await flush()
}

describe('L1: human-created and staffed MiMo members with a role override', () => {
  // @covers: agent-teams › Roles can choose an auto-compaction window › Human-created and spawned members
  test('L1 both package launches carry the role window in childEnv and settings.env with switches blank; tracker and start observation use it', async () => {
    writeGroup('workers: [mimo]\nautoCompactWindow: 250000\nprofileAutoCompactWindow: { mimo: 400000 }')
    const { manager, handles, readings, settings } = await startManager()
    try {
      const human = await create(manager, { claudeProfileId: 'mimo' })
      const staffed = await create(manager, { claudeProfileId: 'mimo', spawned: true })
      for (const [index, id] of [human, staffed].entries()) {
        expect((await manager.send(id, 'go')).ok).toBe(true)
        await spawned(handles, index)
        handles[index]!.push(assistantUsage(40_000, `msg-${index}`))
        await flush()
      }
      expect(handles).toHaveLength(2)
      for (const handle of handles) {
        const { env, settings: flag } = layers(handle.options)
        for (const layer of [env, flag]) {
          expect(layer.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('400000')
          expect(layer.DISABLE_AUTO_COMPACT).toBe('')
          expect(layer.DISABLE_COMPACT).toBe('')
          // MiMo's declaration carries [1m]: the 1M opt-out is cleared too (D1).
          expect(layer.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('')
        }
        expect(env.ANTHROPIC_MODEL).toBe('mimo-v2.6-pro[1m]')
      }
      // The package's tracker took the composed window, not the catalog's 300000.
      expect(readings.slice(0, 2).map(reading => [reading.thresholdTokens, reading.thresholdApproximate]))
        .toEqual([[400_000, true], [400_000, true]])
      await waitForCondition(() => settings.length >= 2)
      expect(settings.map(entry => entry.contextWindow)).toEqual([400_000, 400_000])
    } finally {
      manager.shutdown()
    }
  })
})

/** The three launch branches a refusal must cover (row L6). */
const BRANCHES = [
  { branch: 'Default', profile: 'default' },
  { branch: 'named', profile: 'mimo' },
  { branch: 'credentialed', profile: 'relay-opus' },
] as const

describe('L6/L7: a composed name registered after driver creation', () => {
  for (const { branch, profile } of BRANCHES) {
    // @covers: agent-teams › Roles can choose an auto-compaction window › Preference colliding with a registered name
    // @covers: claude-session-profiles › Selected window preferences compose within the launch's protections › Registered-name collision refuses the launch
    test(`L6 ${branch} branch: the start succeeds, then a respawn and a later start refuse names-only with zero launches`, async () => {
      writeUserCatalog()
      writeGroup('autoCompactWindow: 250000')
      const { manager, handles } = await startManager()
      try {
        const id = await create(manager, { claudeProfileId: profile })
        // L7 control: no collision yet, so the start launches the window.
        expect((await manager.send(id, 'first')).ok).toBe(true)
        await spawned(handles)
        await finishTurn(handles[0]!, `sdk-${branch}`)
        expect(layers(handles[0]!.options).env.DISABLE_COMPACT).toBe('')
        // Bind DISABLE_COMPACT as a credential name (registered and retained),
        // then remove the binding: only the retained row keeps it registered.
        // The credentialed branch reads its token from the bound name.
        process.env.DISABLE_COMPACT = 'bound-token-value'
        writeUserCatalog('DISABLE_COMPACT')
        expect([...readRetainedNames(db)]).not.toContain('DISABLE_COMPACT')
        handles[0]!.query.close()
        await flush()
        const respawn = await manager.send(id, 'respawn')
        expect(respawn.ok).toBe(false)
        if (respawn.ok) throw new Error('expected a refused respawn')
        expect(respawn.error).toContain('DISABLE_COMPACT')
        expect(respawn.error).toContain('auto-compaction')
        expect(respawn.error).not.toContain('bound-token-value')
        expect(handles).toHaveLength(1)
        writeUserCatalog()
        expect([...readRetainedNames(db)]).toContain('DISABLE_COMPACT')
        // The binding is gone; the retained name still refuses the respawn.
        const retainedOnly = await manager.send(id, 'respawn again')
        expect(retainedOnly.ok).toBe(false)
        if (retainedOnly.ok) throw new Error('expected a refused respawn')
        expect(retainedOnly.error).toContain('DISABLE_COMPACT')
        expect(handles).toHaveLength(1)
        // A fresh session's first start refuses on the retained name alone.
        const fresh = await create(manager, { claudeProfileId: profile })
        const start = await manager.send(fresh, 'start')
        expect(start.ok).toBe(false)
        if (start.ok) throw new Error('expected a refused start')
        expect(start.error).toContain('DISABLE_COMPACT')
        expect(handles).toHaveLength(1)
      } finally {
        manager.shutdown()
      }
    })
  }

  test('L7 a noncolliding preference launches at start and respawn and leaves the retained set unchanged', async () => {
    writeUserCatalog()
    writeGroup('autoCompactWindow: 250000')
    const { manager, handles } = await startManager()
    try {
      const id = await create(manager, { claudeProfileId: 'relay-opus' })
      expect((await manager.send(id, 'first')).ok).toBe(true)
      await spawned(handles)
      const retained = [...readRetainedNames(db)].sort()
      await finishTurn(handles[0]!, 'sdk-l7')
      handles[0]!.query.close()
      await flush()
      expect((await manager.send(id, 'respawn')).ok).toBe(true)
      await spawned(handles, 1)
      for (const handle of handles) {
        const { env, settings } = layers(handle.options)
        expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('250000')
        expect(settings.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('250000')
        // The credentialed pins are untouched by the composition.
        expect(settings.ANTHROPIC_BASE_URL).toBe('https://relay.example.internal/api')
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('relay-token-value')
        // No [1m] declaration on this profile: the 1M opt-out keeps its behavior.
        expect('CLAUDE_CODE_DISABLE_1M_CONTEXT' in settings).toBe(false)
      }
      const after = [...readRetainedNames(db)].sort()
      expect(after).toEqual(retained)
      for (const name of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT']) expect(after).not.toContain(name)
    } finally {
      manager.shutdown()
    }
  })
})
