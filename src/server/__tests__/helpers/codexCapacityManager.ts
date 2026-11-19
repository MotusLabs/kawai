// A Codex chat through Kawai's production composition (ChatSessionManager,
// its mailbox and dispatcher, the limit store and LimitOutcomes, the Codex
// adapter and the in-tree package session) for the codex-capacity-retry W
// rows and P4. Only two private package seams are replaced, for every Codex
// driver the manager creates: the transport's process spawn (the in-process
// app-server of packages/agent-runtime/__tests__/helpers/capacityAppServer.ts,
// which the test answers by hand) and the capacity clock (its fake clock), so
// backoff and the ten-minute window run without real time. The Codex entry
// is mocked by keeping every export and wrapping createCodexDriver only; the
// options Kawai composes (capacityRecovery included) pass through unchanged.
// Two profiles share the default home (`codex`, `codex-fast`, the sibling
// whose cooldown a shared-login limit would set) and `codex-2` has its own.
import { mock } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatActivity, ChatEvent } from '../../../shared/chat'
import type { CodexDriverOptions } from '../../../../packages/agent-runtime/src/options'
import { createCodexDriverWith } from '../../../../packages/agent-runtime/src/codex/driver'
import { hasCodexLogin } from '../../../../packages/agent-runtime/src/codex/auth'
import * as continuation from '../../../../packages/agent-runtime/src/codex/continuation'
import { capacityAppServer, FakeCapacityClock, type AppServer } from '../../../../packages/agent-runtime/__tests__/helpers/capacityAppServer'
import { ChatSessionManager } from '../../chat/ChatSessionManager'
import { resetCodexExecutableCache } from '../../chat/codex/codexExecutable'
import { providerOf } from '../../chat/profileCatalog'
import type { SessionDatabase } from '../../db'
import { SessionRegistry } from '../../SessionRegistry'
import { FAKE_CODEX, until } from '../codexDriverHarness'
import { freshTestDatabase } from './testDatabase'

export const CAPACITY_THREAD = 'thread-capacity-0001'

interface Active { server: AppServer; clock: FakeCapacityClock; options: CodexDriverOptions[] }
let active: Active | null = null

mock.module('@motuslabs/agent-runtime/codex', () => ({
  ...continuation,
  hasCodexLogin,
  createCodexDriver: (options: CodexDriverOptions) => {
    if (!active) throw new Error('codexCapacityManager: no active app-server')
    active.options.push(options)
    const { server, clock } = active
    return createCodexDriverWith(options, { spawn: (request) => server.spawn(request), capacityClock: clock })
  },
}))

const ENV_KEYS = ['CODEX_HOME', 'KAWAI_CODEX_PATH', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY'] as const

export interface CapacityManager {
  manager: ChatSessionManager
  db: SessionDatabase
  server: AppServer
  clock: FakeCapacityClock
  /** Every option set Kawai passed to the package factory. */
  options: CodexDriverOptions[]
  events: ChatEvent[]
  /** Every activity the manager pushed (its onActivity sink), in order. */
  activities: Array<ChatActivity | null>
  id: string
  teamId: string
  project: string
  rollout: string
  /** The default home's provider, shared by `codex` and `codex-fast`. */
  homeProvider: string
  otherProvider: string
  /** Codex's rollout writer: append the user row of `text`. */
  writeUserRow(text: string): void
  cleanup(): Promise<void>
}

/** A started Codex chat on profile `codex` in a plain-directory team. */
export async function capacityManager(): Promise<CapacityManager> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-capacity-')))
  const project = path.join(tempDir, 'project')
  const home = path.join(tempDir, 'home')
  const codexHome = path.join(tempDir, 'codex-home')
  const otherHome = path.join(tempDir, 'codex-home-2')
  const rollout = path.join(codexHome, 'sessions', '2026', '11', '18', `rollout-2026-11-18T12-00-00-${CAPACITY_THREAD}.jsonl`)
  for (const dir of [project, otherHome, path.dirname(rollout), path.join(home, '.kawai')]) fs.mkdirSync(dir, { recursive: true })
  // A temp home's fake login: the real ~/.codex is never touched.
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
    codex: { label: 'Codex', runtime: 'codex' },
    'codex-fast': { label: 'Codex Fast', runtime: 'codex' },
    'codex-2': { label: 'Codex 2', runtime: 'codex', codexHome: otherHome },
  }))
  fs.writeFileSync(rollout, '')
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = FAKE_CODEX
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  delete process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_MANAGEMENT_KEY
  resetCodexExecutableCache()
  const clock = new FakeCapacityClock()
  const server = capacityAppServer(clock, { id: CAPACITY_THREAD, path: rollout, model: 'gpt-test' })
  active = { server, clock, options: [] }
  const db = freshTestDatabase(path.join(tempDir, 'test.db'))
  const events: ChatEvent[] = []
  const activities: Array<ChatActivity | null> = []
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: (_id, event) => events.push(event), onActivity: (_id, activity) => activities.push(activity), isDirectory: () => true,
    profileCatalogHome: home, availabilityProbe: async () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
  })
  const cleanup = async () => {
    manager.dispatcher.close()
    manager.shutdown()
    active = null
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    resetCodexExecutableCache()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  try {
    await manager.whenRestored()
    const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex dev' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await until(() => manager.teams.teamOf(id) !== undefined)
    if (!(await manager.start(id)).ok) throw new Error('start failed')
    await until(() => db.getChatSession(id)?.sdkSessionId === CAPACITY_THREAD)
    const ctx = { homeDir: home, projectPath: project }
    return {
      manager, db, server, clock, options: active.options, events, activities, id, teamId: manager.teams.teamOf(id)!.teamId, project, rollout,
      homeProvider: providerOf('codex', ctx), otherProvider: providerOf('codex-2', ctx),
      writeUserRow: (text) => fs.appendFileSync(rollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })}\n`),
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
