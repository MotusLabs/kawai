import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase, type SessionDatabase } from '../db'
import { createHarness, flush, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

describe('ChatSessionManager activity', () => {
  let tempDir: string
  let db: SessionDatabase
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-activity-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('snapshot mid-phase reports the phase and a growing elapsed time', async () => {
    const { manager, handles, activities } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'hello')
    handles[0]!.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      parent_tool_use_id: null,
      uuid: 'p-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(activities.map((entry) => entry.activity?.phase)).toEqual([
      'requesting',
      'thinking',
    ])

    await new Promise((resolve) => setTimeout(resolve, 25))
    const snapshot = manager.getSnapshot(id)!
    expect(snapshot.activity).toMatchObject({ phase: 'thinking' })
    expect(snapshot.activity!.elapsedMs).toBeGreaterThanOrEqual(20)

    // A later snapshot of the same phase keeps counting, not restarting.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(manager.getSnapshot(id)!.activity!.elapsedMs).toBeGreaterThanOrEqual(40)

    // Turn end clears it: the driver's null reaches the sink and the snapshot.
    handles[0]!.push({
      type: 'result',
      subtype: 'success',
      result: '',
      num_turns: 1,
      total_cost_usd: 0,
    } as unknown as SDKMessage)
    await flush()
    expect(activities.at(-1)).toEqual({ sessionId: id, activity: null })
    expect(manager.getSnapshot(id)!.activity).toBeNull()
    manager.kill(id)
  })

  test('idle, archived, and dead sessions report no activity', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id

    // Idle: never sent a turn.
    expect(manager.getSnapshot(id)!.activity).toBeNull()

    // Archived mid-phase: the row must not survive the archive.
    await manager.send(id, 'hello')
    handles[0]!.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} },
      },
      parent_tool_use_id: null,
      uuid: 'p-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.getSnapshot(id)!.activity).toMatchObject({
      phase: 'preparing_tool',
    })
    manager.archive(id)
    expect(manager.getSnapshot(id)!.activity).toBeNull()

    // Restored and restarted: the new turn reports until the driver dies.
    manager.restore(id)
    const resent = await manager.send(id, 'again')
    expect(resent.ok).toBe(true)
    expect(handles).toHaveLength(2)
    handles[1]!.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      parent_tool_use_id: null,
      uuid: 'p-2',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.getSnapshot(id)!.activity).toMatchObject({ phase: 'thinking' })

    // A crashed driver clears the activity with its turn.
    handles[1]!.query.close()
    await flush()
    expect(manager.getSnapshot(id)!.activity).toBeNull()
    manager.kill(id)
  })
})
