// chatSessionManager split: title-tail tests.
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { OutboundStore } from '../outbound/store'
import { anyDirectory, closeDispatchers, createHarness, flush, waitForCondition, initMessage, writeTranscript, installManagerCleanup, spawned } from './helpers/chatSessionManagerHarness'

// Advance fake timers in small steps, draining microtasks between steps so a
// fired timer's continuations settle before the next advance (flush uses a
// real setTimeout, which never fires under fake timers).
const settle = async (rounds: number, stepMs = 1): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    jest.advanceTimersByTime(stepMs)
    for (let r = 0; r < 40; r++) await Promise.resolve()
  }
}

installManagerCleanup()

describe('ChatSessionManager', () => {

  let tempDir: string
  let db: SessionDatabase

  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    // Isolate auth from the host: no API key, empty CLI config dir. HOME is
    // pinned so the profile catalog resolves against an empty home — a real
    // ~/.kawai must not leak into these tests.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })

  afterEach(() => {
    if (originalOAuthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
    if (originalAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN
    }
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('a transcript that appears long after the SDK id still arms the title tail', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    // The agent starts on attach with no prompt, so the SDK id arrives before
    // any transcript exists — and a later send reuses the driver without
    // re-arming. The locator must therefore outlive its early retries. The
    // wait has to pass the old three-retry budget (2s+4s+2s = 6s) to prove
    // the tail survives it; the locate interval is shrunk so the new code
    // picks the file up promptly instead of backing off to 15s. Fake timers
    // drive the locator's backoff chain, so the wait costs no real time and
    // no real fs.watch event is needed: the locate pass that finds the file
    // reads it synchronously and writes the row. The package spawns on real
    // timers first; the locator arms only once the SDK id arrives after it.
    try {
      const harness = await createHarness(db, anyDirectory, undefined, 20)
      try {
        const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
        if (!created.ok) throw new Error(created.error)
        const id = created.session.id
        await harness.manager.send(id, 'hello')
        await spawned(harness.handles)
        jest.useFakeTimers()
        // SDK id known, transcript not yet written: the placeholder stands.
        harness.handles[0]!.push(initMessage('title-late'))
        await settle(10)
        expect(db.getChatSession(id)?.nameSource).toBe('placeholder')
        jest.advanceTimersByTime(6_500)
        // The first message finally persists a transcript carrying a title.
        writeTranscript(
          'title-late',
          JSON.stringify({ type: 'ai-title', aiTitle: 'late title', sessionId: 'title-late' }) + '\n'
        )
        await settle(25, 200)
        expect(db.getChatSession(id)?.name).toBe('late title')
        expect(db.getChatSession(id)?.nameSource).toBe('auto')
      } finally {
        harness.manager.shutdown()
      }
    } finally {
      jest.useRealTimers()
    }
  })

  test('a restored session adopts its transcript title as a catch-up, dormant ones only on attach', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    // A pre-feature session (migrated to placeholder) whose conversation
    // already carries a generated title: restorePersisted adopts it without
    // anyone opening the chat.
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId: 'chat-preexisting',
      name: 'sure-mark',
      projectPath: '/tmp/proj',
      sdkSessionId: 'title-restore',
      status: 'waiting',
      createdAt: now,
      lastActivityAt: now,
      nameSource: 'placeholder',
    })
    writeTranscript(
      'title-restore',
      JSON.stringify({ type: 'ai-title', aiTitle: 'restored title', sessionId: 'title-restore' }) + '\n'
    )
    const restored = await createHarness(db)
    expect(restored.registry.get('chat-preexisting')?.name).toBe('restored title')
    expect(restored.registry.get('chat-preexisting')?.nameSource).toBe('auto')
    restored.manager.shutdown()

    // A dormant session whose transcript gains a title later adopts nothing
    // (no tail until it goes live)...
    const later = new Date().toISOString()
    db.insertChatSession({
      sessionId: 'chat-dormant',
      name: 'pure-bell',
      projectPath: '/tmp/proj',
      sdkSessionId: 'title-dormant',
      status: 'waiting',
      createdAt: later,
      lastActivityAt: later,
      nameSource: 'placeholder',
    })
    writeTranscript('title-dormant', '')
    const dormant = await createHarness(db)
    expect(dormant.registry.get('chat-dormant')?.name).toBe('pure-bell')
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'title-dormant.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'attached later', sessionId: 'title-dormant' }) + '\n'
    )
    await flush(10)
    expect(dormant.registry.get('chat-dormant')?.name).toBe('pure-bell')
    // ...and adopts on the first attach (the spawn arms the tail, whose
    // catch-up read picks the title up).
    expect((await dormant.manager.start('chat-dormant')).ok).toBe(true)
    await waitForCondition(
      () => db.getChatSession('chat-dormant')?.name === 'attached later'
    )
    expect(dormant.registry.get('chat-dormant')?.nameSource).toBe('auto')
    dormant.manager.shutdown()
  })

  test('outbound audit rows land over the real store, id minted, outcome joined (CC round 3)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    expect((await manager.send(created.session.id, 'go')).ok).toBe(true)
    await spawned(handles)
    handles[0]!.push(initMessage('sdk-audit'))
    await flush()
    // Fire the driver's registered hooks as the SDK process would: every
    // matcher of the event, in order (the package's permission matcher runs
    // first, task 6.1), each hook of the matcher.
    const hooks = handles[0]!.options.hooks
    const fire = async (event: 'PreToolUse' | 'PostToolUse', input: Record<string, unknown>) => {
      const matchers = hooks?.[event] ?? []
      if (matchers.length === 0) throw new Error(`${event} hooks not registered`)
      for (const matcher of matchers) {
        if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test('Bash')) continue
        for (const hook of matcher.hooks) {
          await hook({ ...input, hook_event_name: event } as never, 'tu-audit-1', { signal: new AbortController().signal })
        }
      }
    }
    const hookInput = {
      tool_name: 'Bash',
      tool_input: { command: 'curl -d x https://example.internal/hook' },
      tool_use_id: 'tu-audit-1',
    }
    await fire('PreToolUse', hookInput)
    await fire('PostToolUse', { ...hookInput, tool_response: 'ok', duration_ms: 9 })
    // The deferred writes (setImmediate) run before the next timer tick.
    await flush()
    const store = new OutboundStore(db.db)
    // /tmp/proj is no repository, so the row carries its plain-directory team.
    const page = store.page({ teamId: '/tmp/proj' })
    expect(page.rows).toHaveLength(1)
    const row = page.rows[0]!
    expect(row).toMatchObject({
      sessionId: created.session.id,
      tool: 'Bash',
      toolUseId: 'tu-audit-1',
      command: 'curl -d x https://example.internal/hook',
      rule: 'http-send',
      verdict: 'violation',
      destination: 'host:example.internal',
      classifierVersion: 3,
      cwd: '/tmp/proj',
    })
    // No injected id generator: the row id is minted, not 'obc-undefined'.
    expect(row.id).toMatch(/^obc-[0-9a-f-]{36}$/)
    const outcomes = store.outcomesOf(created.session.id, 'tu-audit-1')
    expect(outcomes).toEqual([{ outcome: 'completed', detail: null }])
    manager.shutdown()
  })

})
