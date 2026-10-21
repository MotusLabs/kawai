// chatSessionManager split: context-usage tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase, type SessionDatabase } from '../db'
import { anyDirectory, createHarness, flush, waitForCondition, assistantUsage, resultWithWindow, compactBoundary, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

describe('ChatSessionManager context usage', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalHome = process.env.HOME
  const originalAutoCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-context-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    // Pinned like the main describe: a real ~/.kawai must not leak into
    // launch resolution — and neither may an operator-level auto-compact
    // window (an agent dev shell carries one), or the profile-window
    // fallback would outrank the report thresholds these tests assert.
    process.env.HOME = tempDir
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  })
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalAutoCompact !== undefined) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = originalAutoCompact
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('the snapshot prefers the fresher in-memory reading over the stored column', async () => {
    const seed = await createHarness(db)
    const created = seed.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    // A reading persisted at an earlier boundary, before a restart.
    const stale = { usedTokens: 90_000, thresholdTokens: 200_000, percentage: 45, at: '2026-10-10T10:00:00.000Z' }
    db.updateChatSession(id, { contextUsage: stale })

    const harness = await createHarness(db)
    expect(harness.manager.getSnapshot(id)!.contextUsage).toEqual(stale)

    await harness.manager.send(id, 'turn')
    harness.handles[0]!.push(assistantUsage(120_000, 'msg_1'))
    harness.handles[0]!.push(resultWithWindow())
    await flush()
    expect(harness.manager.getSnapshot(id)!.contextUsage).toMatchObject({ usedTokens: 120_000 })

    // Mid-turn of the next turn: in-memory is fresher than the column, and
    // the snapshot prefers it (design D5).
    await harness.manager.send(id, 'second turn')
    harness.handles[0]!.push(assistantUsage(130_000, 'msg_2'))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 120_000 })
    expect(harness.manager.getSnapshot(id)!.contextUsage).toMatchObject({ usedTokens: 130_000 })
    harness.manager.shutdown()
  })

  test('a multi-request turn writes the reading at its boundary, not per frame', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'long turn')
    const fake = harness.handles[0]!

    // Three requests mid-turn: none reaches the database (no boundary yet).
    fake.push(assistantUsage(40_000, 'msg_1'))
    fake.push(assistantUsage(60_000, 'msg_2'))
    fake.push(assistantUsage(80_000, 'msg_3'))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toBeNull()

    // The result reveals the window and ends the turn: exactly one write
    // lands, carrying the last reading.
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000, thresholdTokens: 200_000 })

    // A second turn publishes live frames (the threshold is known now)...
    await harness.manager.send(id, 'second turn')
    fake.push(assistantUsage(85_000, 'msg_4'))
    fake.push(assistantUsage(95_000, 'msg_5'))
    await flush()
    expect(harness.contextUsage.length).toBeGreaterThanOrEqual(3)
    // ...but the stored value stays at the last boundary until the next one.
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000 })
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 95_000 })
    harness.manager.shutdown()
  })

  test('compaction and driver death write the reading too', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(assistantUsage(80_000, 'msg_1'))
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000 })

    // Compaction is a write point: the adopted size lands immediately.
    fake.push(compactBoundary(12_000))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 12_000 })

    // A later frame publishes live without touching the column; driver
    // death is the final write point, so the last live value survives.
    fake.push(assistantUsage(30_000, 'msg_2'))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 12_000 })
    fake.query.close()
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 30_000 })
    harness.manager.shutdown()
  })

  test('a late threshold correction persists without waiting for another boundary', async () => {
    // The turn-boundary probe resolves after turn_completed has already
    // written the reading; the correction itself must reach the database, or
    // an abrupt restart would restore a different percentage than the one
    // last displayed.
    let threshold = 200_000
    let probes = 0
    let finishBoundaryProbe: (() => void) | undefined
    const report = () => ({
      categories: [], totalTokens: 0, maxTokens: 200_000, rawMaxTokens: 200_000,
      percentage: 0, gridRows: [], model: 'claude-sonnet-4-5', memoryFiles: [],
      mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
      autoCompactThreshold: threshold,
    })
    const harness = await createHarness(db, anyDirectory, undefined, undefined, () => {
      probes += 1
      // Attach answers at once; the boundary probe resolves late.
      if (probes === 1) return Promise.resolve(report())
      return new Promise((resolve) => {
        finishBoundaryProbe = () => resolve(report())
      })
    })
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(assistantUsage(157_900, 'msg_1'))
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 157_900, thresholdTokens: 200_000 })

    threshold = 100_000
    expect(finishBoundaryProbe).toBeDefined()
    finishBoundaryProbe!()
    await waitForCondition(() => db.getChatSession(id)?.contextUsage?.thresholdTokens === 100_000)
    // No further turn or event: the correction wrote the re-scaled reading.
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 157_900, thresholdTokens: 100_000, percentage: 157.9 })
    harness.manager.shutdown()
  })

  test('a conversation reset clears the reading and persists the clear', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(assistantUsage(80_000, 'msg_1'))
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000 })

    fake.push({
      type: 'conversation_reset',
      trigger: 'plan_mode_exit',
      new_conversation_id: 'fresh',
      uuid: 'reset-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    // The stored column goes too: a restart must not resurrect the old
    // conversation's occupancy.
    expect(db.getChatSession(id)!.contextUsage).toBeNull()
    expect(harness.manager.getSnapshot(id)!.contextUsage).toBeNull()
    expect(harness.contextUsage.at(-1)?.usage).toBeNull()
    harness.manager.shutdown()
  })

  test('compaction persists on the notice kind, not its display text', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await harness.manager.send(id, 'turn')
    const fake = harness.handles[0]!
    fake.push(assistantUsage(80_000, 'msg_1'))
    fake.push(resultWithWindow())
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 80_000 })

    // The driver tags the compact_boundary notice with kind: 'compacted';
    // that tag — not the string 'Context compacted' — is what makes this
    // write happen. The published reading is dropped to post_tokens first.
    fake.push(compactBoundary(12_000))
    await flush()
    expect(db.getChatSession(id)!.contextUsage).toMatchObject({ usedTokens: 12_000 })
    const notice = harness.events
      .map((entry) => entry.event)
      .find((event) => event.type === 'notice')
    expect(notice).toMatchObject({ type: 'notice', kind: 'compacted' })
    harness.manager.shutdown()
  })
})
