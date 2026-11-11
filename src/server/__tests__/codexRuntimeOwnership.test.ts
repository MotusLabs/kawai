// @reads: packages/agent-runtime/__tests__/fixtures/**
// Ownership of Kawai's Codex composition (task 6.1, A5/A10; decision
// note-d342e9bf). createChatDriver → codexRuntime.ts → the public package
// factory → the fake app-server as a real child. "The process ended" is the
// package wire's own lifecycle exit frame for that child; failures are the
// objects this test's callbacks threw or rejected with.
// - A kill from inside a host callback during start is refused by the package
//   as a self-join while its teardown runs on: settled() re-issues it from
//   the outside caller and resolves only after the process exit.
// - A callback's returned promise is owned: a held one holds settled(), a
//   rejected one reaches settled() as the original object (inside the
//   package stop's causes), once.
// - A synchronous throw reaches settled() once, the same way; concurrent
//   waits share one report and a later wait reports nothing again.
// - A successor driver on the same home reports nothing of its predecessor.
// - The manager joins the drivers it kills: retiredSettled() resolves only
//   after the process exit.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import type { ChatEvent } from '../../shared/chat'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { createChatDriver } from '../chat/provider/createChatDriver'
import type { ChatAgentDriver } from '../chat/provider/driver'
import { RetiredDrivers } from '../chat/retiredDrivers'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { codexRoot, type CodexRoot } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'
import { FAKE_CODEX, Script } from './codexDriverHarness'

type Adapter = ChatAgentDriver & { settled(): Promise<void> }
type Wire = Array<[string, string]>
const live: Adapter[] = []
afterEach(async () => {
  for (const driver of live.splice(0)) {
    driver.kill()
    await driver.settled().catch(() => {})
  }
})

interface Hooks {
  onTranscriptPath?: (driver: Adapter, path: string) => unknown
  onModel?: (driver: Adapter) => unknown
  env?: Record<string, string>
}

function adapter(root: CodexRoot, hooks: Hooks = {}) {
  const wire: Wire = []
  const box: { driver?: Adapter } = {}
  const driver = createChatDriver({
    runtime: 'codex',
    options: {
      sessionId: 'chat-codex-ownership',
      projectPath: join(root.root, 'work'),
      executable: root.wrapper,
      codexHome: root.home,
      network: true,
      serverEnv: { PATH: process.env.PATH ?? '', HOME: root.root, ...hooks.env },
      withheldCredentials: () => new Set(),
      wire: { record: (dir, raw) => void wire.push([dir, raw]) },
      onEvent: () => {},
      onStatus: () => {},
      ...(hooks.onTranscriptPath ? { onTranscriptPath: (p: string) => hooks.onTranscriptPath!(box.driver!, p) as void } : {}),
      ...(hooks.onModel ? { onModel: () => hooks.onModel!(box.driver!) as void } : {}),
    },
  }) as Adapter
  box.driver = driver
  live.push(driver)
  return { driver, wire, exited: () => wire.some(([dir, raw]) => dir === 'lifecycle' && raw.includes('"event":"exit"')) }
}

async function until(probe: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** What settled() did: resolved (with whether the process had exited by then) or the raw rejection. */
async function outcome(h: ReturnType<typeof adapter>): Promise<{ resolved: boolean; exited: boolean; error?: unknown }> {
  try {
    await h.driver.settled()
    return { resolved: true, exited: h.exited() }
  } catch (error) {
    return { resolved: false, exited: h.exited(), error }
  }
}

const causes = (error: unknown) => (error instanceof AgentRuntimeError ? error.causes : [])

describe('Codex adapter ownership through the public factory', () => {
  test('a kill from inside a host callback is re-acquired: settled() resolves only after the process exit', async () => {
    let calls = 0
    // The app-server ignores SIGTERM: its teardown outlasts the cancelled start until SIGKILL.
    const h = adapter(codexRoot(), { onTranscriptPath: (driver) => void (calls++, driver.kill()), env: { FAKE_CODEX_TERM: 'ignore' } })
    h.driver.start()
    await until(() => calls === 1)
    expect(await outcome(h)).toEqual({ resolved: true, exited: true })
    // A later outside kill and wait add nothing.
    h.driver.kill()
    expect(await outcome(h)).toEqual({ resolved: true, exited: true })
  })

  test('a held callback promise holds settled(); its rejection is reported once as the original object', async () => {
    let release!: (value?: unknown) => void
    const held = new Promise((resolve) => (release = resolve))
    const h = adapter(codexRoot(), { onTranscriptPath: () => held })
    h.driver.start()
    await until(() => h.wire.some(([dir, raw]) => dir === 'in' && raw.includes('"thread"')))
    await new Promise((resolve) => setTimeout(resolve, 50))
    h.driver.kill()
    const order: string[] = []
    const waiting = outcome(h).then((o) => (order.push('settled'), o))
    await new Promise((resolve) => setTimeout(resolve, 100))
    order.push('release')
    release()
    expect((await waiting).resolved).toBe(true)
    expect(order).toEqual(['release', 'settled'])

    const boom = new Error('path store down')
    const r = adapter(codexRoot(), { onTranscriptPath: () => Promise.reject(boom) })
    r.driver.start()
    await until(() => r.wire.some(([dir, raw]) => dir === 'in' && raw.includes('"thread"')))
    await new Promise((resolve) => setTimeout(resolve, 50))
    r.driver.kill()
    const first = await outcome(r)
    expect([first.resolved, first.exited, causes(first.error).includes(boom)]).toEqual([false, true, true])
    expect(await outcome(r)).toEqual({ resolved: true, exited: true })
  })

  test('a synchronous callback throw reaches settled() once; concurrent waits share one report', async () => {
    const boom = new Error('model observer bug')
    const h = adapter(codexRoot(), { onModel: () => { throw boom } })
    h.driver.send('hello')
    await until(() => h.wire.some(([dir, raw]) => dir === 'in' && raw.includes('turn/completed')))
    h.driver.kill()
    const [a, b] = await Promise.all([outcome(h), outcome(h)])
    expect(a.error).toBe(b.error)
    expect([a.resolved, a.exited, causes(a.error).filter((cause) => cause === boom).length]).toEqual([false, true, 1])
    expect(await outcome(h)).toEqual({ resolved: true, exited: true })
  })

  test('a successor on the same home reports nothing of its predecessor; RetiredDrivers lists each failure once', async () => {
    const root = codexRoot()
    const boom = new Error('first driver observer')
    const first = adapter(root, { onModel: () => { throw boom } })
    first.driver.send('one')
    await until(() => first.wire.some(([dir, raw]) => dir === 'in' && raw.includes('turn/completed')))
    first.driver.kill()
    const retired = new RetiredDrivers()
    retired.retire('chat-a', first.driver)
    const second = adapter(root)
    second.driver.send('two')
    await until(() => second.wire.some(([dir, raw]) => dir === 'in' && raw.includes('turn/completed')))
    second.driver.kill()
    retired.retire('chat-b', second.driver)
    const listed = await retired.settled()
    expect(listed.map((f) => [f.sessionId, causes(f.error).includes(boom)])).toEqual([['chat-a', true]])
    expect([first.exited(), second.exited()]).toEqual([true, true])
    expect(await retired.settled()).toEqual([])
  })
})

describe('the manager joins the drivers it stops', () => {
  test('retiredSettled() after a kill resolves only once the Codex process exited', async () => {
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-retire-')))
    const keys = ['CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'ANTHROPIC_API_KEY'] as const
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    const project = path.join(tempDir, 'project')
    const home = path.join(tempDir, 'home')
    const codexHome = path.join(tempDir, 'codex-home')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ codex: { label: 'Codex', runtime: 'codex' } }))
    const db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.CODEX_HOME = codexHome
    process.env.KAWAI_CODEX_PATH = FAKE_CODEX
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.FAKE_RUN = '1'
    resetCodexExecutableCache()
    const wire: Array<{ dir: string; raw: string }> = []
    const events: ChatEvent[] = []
    const wireLogs = { get: () => ({ record: (dir: string, raw: string) => wire.push({ dir, raw }) }), pruneOrphans: async () => {}, delete: async () => {} }
    const manager = new ChatSessionManager({
      db, registry: new SessionRegistry(), onEvent: (_id, event) => events.push(event),
      profileCatalogHome: home, availabilityProbe: async () => {},
      providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
      wireLogs: wireLogs as unknown as ChatWireLogs,
    })
    try {
      await manager.whenRestored()
      const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex dev' })
      if (!created.ok) throw new Error(created.error)
      process.env.FAKE_TRANSCRIPT = new Script().boot('thread/start', 'gpt-test', path.join(codexHome, 'rollout.jsonl')).request('account/rateLimits/read', {}).write(tempDir)
      expect((await manager.start(created.session.id)).ok).toBe(true)
      await until(() => wire.some((entry) => entry.dir === 'in' && entry.raw.includes('"thread"')))
      const exited = () => wire.some((entry) => entry.dir === 'lifecycle' && entry.raw.includes('"event":"exit"'))
      expect(manager.kill(created.session.id)).toBe(true)
      const failures = await manager.retiredSettled()
      expect([exited(), failures]).toEqual([true, []])
    } finally {
      manager.shutdown()
      await manager.retiredSettled()
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      resetCodexExecutableCache()
      db.close()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
