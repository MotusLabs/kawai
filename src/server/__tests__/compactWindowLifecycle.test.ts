// @reads: config/profiles.default.json, config/providers.default.json
// Role auto-compaction windows across a session's life, through the REAL
// ChatSessionManager (mimo-million-token-context D3): row L2 (an edit
// reaches only the next start, removal falls back), L3 (two concurrent
// sessions and the process env stay isolated), L4 (wrapper-backed and Codex
// members keep their existing launch) and M1 (the composed window seeds the
// tracker's approximate threshold until a report's exact one wins).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ChatContextUsage, ChatEvent } from '../../shared/chat'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { FAKE_CODEX, Script, until } from './codexDriverHarness'
import { anyDirectory, assistantUsage, createHarness, fakeQueryFactory, flush, initMessage, installManagerCleanup, managedManager, resultWithWindow, spawned, waitForCondition, type FakeHandle } from './helpers/chatSessionManagerHarness'
import { freshTestDatabase } from './helpers/testDatabase'

installManagerCleanup()

const COMPOSED = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT'] as const
const ENV_KEYS = [
  ...COMPOSED, 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME',
  'CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_ENV_NAMES',
] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let project: string
let home: string
let db: SessionDatabase

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-compact-life-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  db = freshTestDatabase(path.join(tempDir, 'test.db'))
  for (const key of COMPOSED) delete process.env[key]
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  process.env.HOME = home
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  resetCodexExecutableCache()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const writeGroup = (frontmatter: string) =>
  fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), `---\n${frontmatter}\n---\nBuild.`)

async function manager(handles: FakeHandle[]): Promise<ChatSessionManager> {
  return managedManager({
    isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {},
    queryFactory: fakeQueryFactory(handles),
    executableCheck: async () => ({ path: '/opt/claude', identity: 'id-1' }),
    availabilityProbe: async () => {},
    profileCatalogHome: home,
  })
}

async function create(chat: ChatSessionManager, input: { claudeProfileId?: string; groupId?: string }): Promise<string> {
  const created = await chat.createAvailableSession({ projectPath: project, ...input })
  if (!created.ok) throw new Error(created.error)
  return created.session.id
}

const layers = (options: Options) => ({
  env: options.env ?? {},
  settings: (options.settings as { env?: Record<string, string> } | undefined)?.env ?? {},
})

/** End the current process after a finished turn, so the next send is a fresh start. */
async function endProcess(handle: FakeHandle, sdkId: string): Promise<void> {
  handle.push(initMessage(sdkId))
  handle.push(resultWithWindow())
  await flush()
  handle.query.close()
  await flush()
}

describe('row L2: edits reach the next start only', () => {
  // @covers: agent-teams › Role compaction preferences apply at agent start › Edit and removal
  test('L2 the running launch keeps its value, the next start uses the edit, and removal falls back to the role default then the catalog', async () => {
    writeGroup('autoCompactWindow: 250000\nprofileAutoCompactWindow: { mimo: 300000 }')
    const handles: FakeHandle[] = []
    const chat = await manager(handles)
    try {
      const id = await create(chat, { claudeProfileId: 'mimo', groupId: 'devs' })
      const windows = () => handles.map(handle => layers(handle.options).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
      expect((await chat.send(id, 'one')).ok).toBe(true)
      await spawned(handles)
      writeGroup('autoCompactWindow: 250000\nprofileAutoCompactWindow: { mimo: 400000 }')
      expect(windows()).toEqual(['300000'])
      await endProcess(handles[0]!, 'sdk-l2')
      expect((await chat.send(id, 'two')).ok).toBe(true)
      await spawned(handles, 1)
      expect(windows()).toEqual(['300000', '400000'])
      writeGroup('autoCompactWindow: 250000')
      await endProcess(handles[1]!, 'sdk-l2')
      expect((await chat.send(id, 'three')).ok).toBe(true)
      await spawned(handles, 2)
      writeGroup('label: Devs')
      await endProcess(handles[2]!, 'sdk-l2')
      expect((await chat.send(id, 'four')).ok).toBe(true)
      await spawned(handles, 3)
      // The shipped MiMo scalar is the last fallback.
      expect(windows()).toEqual(['300000', '400000', '250000', '300000'])
      for (const handle of handles) {
        const { env, settings } = layers(handle.options)
        expect(settings.CLAUDE_CODE_AUTO_COMPACT_WINDOW as string | undefined).toBe(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
      }
    } finally {
      chat.shutdown()
    }
  })
})

describe('row L3: concurrent sessions', () => {
  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › Profiles do not leak between sessions
  test('L3 two concurrent sessions: only the first is overridden, the second keeps its default, and process.env is unchanged', async () => {
    writeGroup('autoCompactWindow: 250000')
    const handles: FakeHandle[] = []
    const chat = await manager(handles)
    try {
      const envBefore = JSON.stringify(process.env)
      const first = await create(chat, { claudeProfileId: 'minimax', groupId: 'devs' })
      const second = await create(chat, { claudeProfileId: 'minimax' })
      const [a, b] = await Promise.all([chat.send(first, 'go'), chat.send(second, 'go')])
      expect(a.ok && b.ok).toBe(true)
      await spawned(handles, 1)
      const byWindow = handles.map(handle => layers(handle.options))
      const overridden = byWindow.filter(layer => layer.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === '250000')
      const untouched = byWindow.filter(layer => layer.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === undefined)
      expect(overridden).toHaveLength(1)
      expect(untouched).toHaveLength(1)
      expect(overridden[0]!.settings.DISABLE_COMPACT).toBe('')
      expect('DISABLE_COMPACT' in untouched[0]!.env || 'DISABLE_COMPACT' in untouched[0]!.settings).toBe(false)
      expect(untouched[0]!.settings.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('')
      expect(JSON.stringify(process.env)).toBe(envBefore)
    } finally {
      chat.shutdown()
    }
  })
})

describe('row L4: wrapper-backed and Codex members', () => {
  // @covers: agent-teams › Roles can choose an auto-compaction window › Other runtimes and executable-backed agents
  test('L4 a wrapper-backed member with a role preference launches as before, with no role-composed keys', async () => {
    const wrapper = path.join(tempDir, 'wrapper.sh')
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o755 })
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
      wrap: { label: 'Wrap', executable: wrapper, model: 'w[1m]', env: { ANTHROPIC_MODEL: 'w[1m]' } },
    }))
    writeGroup('autoCompactWindow: 250000\nprofileAutoCompactWindow: { wrap: 300000 }')
    const handles: FakeHandle[] = []
    const chat = await manager(handles)
    try {
      const id = await create(chat, { claudeProfileId: 'wrap', groupId: 'devs' })
      expect((await chat.send(id, 'go')).ok).toBe(true)
      await spawned(handles)
      const { env, settings } = layers(handles[0]!.options)
      for (const name of COMPOSED) {
        expect(name in env, name).toBe(false)
        expect(name in settings, name).toBe(false)
      }
      expect(handles[0]!.options.pathToClaudeCodeExecutable).toBe(wrapper)
    } finally {
      chat.shutdown()
    }
  })

  test('L4 a Codex member with a role preference spawns its app-server without any role-composed variable', async () => {
    const codexHome = path.join(tempDir, 'codex-home')
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
    const rollout = path.join(codexHome, 'sessions', 'rollout-l4.jsonl')
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.writeFileSync(rollout, '')
    process.env.CODEX_HOME = codexHome
    process.env.KAWAI_CODEX_PATH = FAKE_CODEX
    process.env.FAKE_TRANSCRIPT = new Script().boot('thread/start', 'gpt-test', rollout).write(tempDir)
    const namesFile = path.join(tempDir, 'env-names.txt')
    process.env.FAKE_ENV_NAMES = namesFile
    resetCodexExecutableCache()
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ codex: { label: 'Codex', runtime: 'codex' } }))
    writeGroup('autoCompactWindow: 250000\nprofileAutoCompactWindow: { codex: 300000 }')
    const events: ChatEvent[] = []
    const wireLogs = { get: () => ({ record: () => {} }), pruneOrphans: async () => {}, delete: async () => {} }
    const chat = await managedManager({
      db, registry: new SessionRegistry(), onEvent: (_id, event) => events.push(event),
      profileCatalogHome: home, availabilityProbe: async () => {}, wireLogs: wireLogs as unknown as ChatWireLogs,
    })
    let id: string | undefined
    try {
      id = await create(chat, { claudeProfileId: 'codex', groupId: 'devs' })
      expect((await chat.start(id)).ok).toBe(true)
      await until(() => fs.existsSync(namesFile), 10_000)
      const names = fs.readFileSync(namesFile, 'utf8').split('\n')
      expect(names).toContain('CODEX_HOME')
      for (const name of COMPOSED) expect(names, name).not.toContain(name)
    } finally {
      if (id) {
        try { chat.kill(id) } catch { /* already gone */ }
      }
      await Bun.sleep(50)
      chat.shutdown()
    }
  })
})

describe('row M1: the composed window and a later report', () => {
  // @covers: agent-teams › Roles can choose an auto-compaction window › Global MiMo preference is inherited
  test('M1 window 300000: the first reading is approximate 300000, then the report threshold 267000 wins exactly', async () => {
    let answer: ((report: unknown) => void) | undefined
    const report = {
      categories: [{ name: 'Autocompact buffer', kind: 'buffer', tokens: 33_000 }],
      totalTokens: 0, maxTokens: 300_000, rawMaxTokens: 300_000, percentage: 0, gridRows: [],
      model: 'mimo-v2.6-pro[1m]', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true,
      apiUsage: null, autoCompactThreshold: 267_000,
    }
    const harness = await createHarness(db, anyDirectory, undefined, undefined, () => new Promise((resolve) => {
      answer = resolve
    }), undefined, undefined, home)
    try {
      const id = await create(harness.manager, { claudeProfileId: 'mimo' })
      expect((await harness.manager.send(id, 'turn')).ok).toBe(true)
      await spawned(harness.handles)
      const env = layers(harness.handles[0]!.options).env
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000')
      harness.handles[0]!.push(assistantUsage(60_000, 'msg-m1'))
      await flush()
      const readings = (): ChatContextUsage[] => harness.contextUsage.flatMap(entry => entry.usage ? [entry.usage] : [])
      await waitForCondition(() => readings().length > 0)
      expect(readings()[0]).toMatchObject({ usedTokens: 60_000, thresholdTokens: 300_000, thresholdApproximate: true })
      await waitForCondition(() => answer !== undefined)
      answer!(report)
      await waitForCondition(() => readings().at(-1)?.thresholdTokens === 267_000)
      const last = { ...readings().at(-1)! }
      expect(last.usedTokens).toBe(60_000)
      expect(Boolean(last.thresholdApproximate)).toBe(false)
    } finally {
      harness.manager.shutdown()
    }
  })
})
