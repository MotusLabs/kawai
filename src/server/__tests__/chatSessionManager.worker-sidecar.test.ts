// chatSessionManager split: worker-sidecar tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatWorker } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatWorkerStore } from '../chat/chatWorkerStore'
import { anyDirectory, FakeHandle, managedManager, closeDispatchers, fakeQueryFactory, createHarness, flush, waitForCondition, initMessage, writeTranscript, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

describe('ChatSessionManager worker sidecar', () => {
  let tempDir: string
  let db: SessionDatabase
  let sidecarDir: string
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatworkers-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    sidecarDir = path.join(tempDir, 'chat-workers')
    // Same isolation contract as the main describe: auth pinned to a key,
    // CLI config and home inside the temp dir so nothing leaks in.
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** The Agent spawn + task_started prefix (design D1) on the fake stream. */
  async function spawnWorker(
    handle: FakeHandle,
    toolUseId: string,
    taskId: string,
    description: string
  ): Promise<void> {
    handle.push({
      type: 'assistant',
      message: {
        id: `msg_${toolUseId}`,
        content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: {} }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: `uuid-${toolUseId}`,
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    handle.push({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
      subagent_type: 'Explore',
      spawn_depth: 1,
      task_type: 'local_agent',
    } as unknown as SDKMessage)
    await flush()
  }

  /** task_notification settle frame for one worker. */
  async function settleWorker(
    handle: FakeHandle,
    toolUseId: string,
    taskId: string,
    status: 'completed' | 'failed',
    summary: string
  ): Promise<void> {
    handle.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: toolUseId,
      status,
      output_file: '/tmp/subagent.jsonl',
      summary,
    } as unknown as SDKMessage)
    await flush()
  }

  /** A fresh store over the same directory, as a restart would build. */
  const reopenedStore = () => new ChatWorkerStore({ dir: sidecarDir })

  test('settled workers round-trip through the sidecar and the snapshot', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const store = new ChatWorkerStore({ dir: sidecarDir })
    const harness = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, store
    )
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-1'))
    await spawnWorker(handle, 'toolu_w1', 'task_1', 'Map the workspace')
    await spawnWorker(handle, 'toolu_w2', 'task_2', 'Index the API')
    await settleWorker(handle, 'toolu_w1', 'task_1', 'completed', 'Mapped 14 files')
    await settleWorker(handle, 'toolu_w2', 'task_2', 'failed', 'endpoint down')
    // The sink saw every roster publish (workers design D2): spawn, fill,
    // and settle for each worker.
    expect(harness.workers.map(entry => entry.workers)).toHaveLength(6)
    harness.manager.shutdown()

    // Restart: a fresh store over the same directory recovers the rows.
    const restored = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, reopenedStore()
    )
    expect(restored.manager.getSnapshot(id)!.workers.map(({ elapsedMs: _e, ...row }) => row))
      .toEqual([
        {
          workerId: 'toolu_w1',
          taskId: 'task_1',
          agentType: 'Explore',
          description: 'Map the workspace',
          depth: 1,
          status: 'completed',
          live: false,
          summary: 'Mapped 14 files',
        },
        {
          workerId: 'toolu_w2',
          taskId: 'task_2',
          agentType: 'Explore',
          description: 'Index the API',
          depth: 1,
          status: 'failed',
          live: false,
          summary: 'endpoint down',
        },
      ])
    restored.manager.shutdown()
  })

  test('a restarted session keeps recovered outcomes when its agent starts again', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const store = new ChatWorkerStore({ dir: sidecarDir })
    const harness = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, store
    )
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-3'))
    await spawnWorker(handle, 'toolu_w1', 'task_1', 'Map the workspace')
    await settleWorker(handle, 'toolu_w1', 'task_1', 'completed', 'Mapped 14 files')
    harness.manager.shutdown()

    // Restart: the fresh driver is seeded with the recovered rows, so a new
    // spawn appends to the roster instead of replacing it — and the sidecar
    // keeps both, where a publish from an empty roster would lose the old
    // outcome on disk too. Resume needs the transcript to exist.
    writeTranscript('sdk-workers-3', `${JSON.stringify({ type: 'user', uuid: 'u1' })}\n`)
    const restored = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, reopenedStore()
    )
    const sent = await restored.manager.send(id, 'research again')
    if (!sent.ok) throw new Error(sent.error)
    await flush()
    const nextHandle = restored.handles[0]!
    nextHandle.push(initMessage('sdk-workers-3'))
    await spawnWorker(nextHandle, 'toolu_w2', 'task_2', 'Index the API')
    expect(
      restored.manager.getSnapshot(id)!.workers.map((worker) => worker.workerId)
    ).toEqual(['toolu_w1', 'toolu_w2'])
    await waitForCondition(() => {
      const rows = reopenedStore().read(id)
      return rows.some(worker => worker.workerId === 'toolu_w1') &&
        rows.some(worker => worker.workerId === 'toolu_w2')
    })
    restored.manager.shutdown()
  })

  test('a worker still running at an abrupt stop is kept and recovered as stopped', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const store = new ChatWorkerStore({ dir: sidecarDir })
    const harness = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, store
    )
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-2'))
    await spawnWorker(handle, 'toolu_run', 'task_run', 'Map the workspace')
    // The sidecar holds the running row before anything settles (D6: the
    // write happens at spawn, not at settle — the crash gap).
    await waitForCondition(() =>
      store.read(id).some(worker => worker.status === 'running')
    )
    // A reconnect mid-run receives the running roster from the live driver
    // (workers design D2), elapsed computed fresh at snapshot time.
    expect(harness.manager.getSnapshot(id)!.workers).toMatchObject([
      { workerId: 'toolu_run', status: 'running', live: true },
    ])
    // Abrupt stop: no shutdown settlement, as a crash would leave things.
    const recovered: ChatWorker[] = []
    const restored = await managedManager({
      isDirectory: anyDirectory,
      registry: new SessionRegistry(),
      db,
      onEvent: () => {},
      queryFactory: fakeQueryFactory([]),
      workerStore: reopenedStore(),
      onWorkers: (_sessionId, workers) => recovered.push(...workers),
    })
    const snapshot = restored.getSnapshot(id)!
    expect(snapshot.workers).toMatchObject([
      { workerId: 'toolu_run', status: 'stopped', live: false },
    ])
    // The corrected roster is rewritten so the file and the rows agree.
    await waitForCondition(() =>
      reopenedStore().read(id).every(worker => worker.status === 'stopped')
    )
    restored.shutdown()
    expect(recovered).toEqual([])
  })

  test('a worker roster change on a pending release re-runs the dispatch cycle (member-release D2/D3)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const harness = await createHarness(db, anyDirectory)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-release'))
    await spawnWorker(handle, 'toolu_rel', 'task_rel', 'Map the workspace')
    expect(harness.manager.hasLiveWorkers(id)).toBe(true)
    db.db.prepare(`INSERT INTO team_member_releases (session_id, task_id, team_id, reason, requested_by_kind, requested_at)
      VALUES (?, 'task-1', 'team-1', 'task done', 'human', ?)`).run(id, new Date().toISOString())
    let notified = 0
    harness.manager.dispatcher.notify = () => { notified += 1 }
    await settleWorker(handle, 'toolu_rel', 'task_rel', 'completed', 'Mapped')
    expect(harness.manager.hasLiveWorkers(id)).toBe(false)
    expect(notified).toBeGreaterThan(0)
    harness.manager.shutdown()
  })

  test('kill removes the sidecar with the session', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const store = new ChatWorkerStore({ dir: sidecarDir })
    const harness = await createHarness(
      db, anyDirectory, undefined, undefined, undefined, undefined, store
    )
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await harness.manager.send(id, 'research')
    const handle = harness.handles[0]!
    handle.push(initMessage('sdk-workers-3'))
    await spawnWorker(handle, 'toolu_kill', 'task_kill', 'Map the workspace')
    await waitForCondition(() => store.read(id).length === 1)
    harness.manager.kill(id)
    await waitForCondition(
      () => !fs.existsSync(path.join(sidecarDir, `${id}.json`))
    )
    expect(reopenedStore().read(id)).toEqual([])
  })
})
