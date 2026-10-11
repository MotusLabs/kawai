import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatWorker } from '../../shared/chat'
import { ChatWorkerStore } from '../chat/chatWorkerStore'

describe('ChatWorkerStore', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-workerstore-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const liveWorker = (): ChatWorker => ({
    workerId: 'toolu_01XKUDMFUEHpYGekHvc9x5Qm',
    taskId: 'b01c9a58-5c93-4a9e-9d0f-8a33ff65f247',
    agentType: 'Explore',
    description: 'Map the workspace structure',
    depth: 1,
    status: 'running',
    live: true,
    lastTool: 'Grep',
    elapsedMs: 4_000,
  })

  test('round-trips the restart-relevant shape and drops live-only fields', async () => {
    const store = new ChatWorkerStore({ dir })
    const workers: ChatWorker[] = [
      { ...liveWorker(), status: 'completed', live: false, summary: 'Mapped 14 files' },
      {
        ...liveWorker(),
        workerId: 'toolu_failed',
        taskId: 'task_failed',
        status: 'failed',
        live: false,
        summary: 'endpoint down',
      },
    ]
    await store.write('chat-1', workers)
    expect(store.read('chat-1')).toEqual([
      {
        workerId: 'toolu_01XKUDMFUEHpYGekHvc9x5Qm',
        taskId: 'b01c9a58-5c93-4a9e-9d0f-8a33ff65f247',
        agentType: 'Explore',
        description: 'Map the workspace structure',
        depth: 1,
        status: 'completed',
        summary: 'Mapped 14 files',
      },
      {
        workerId: 'toolu_failed',
        taskId: 'task_failed',
        agentType: 'Explore',
        description: 'Map the workspace structure',
        depth: 1,
        status: 'failed',
        summary: 'endpoint down',
      },
    ])
  })

  test('a missing file and a corrupt file both read as empty', () => {
    const store = new ChatWorkerStore({ dir })
    expect(store.read('chat-none')).toEqual([])
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'chat-corrupt.json'), '\u0000\u0000 not json')
    expect(store.read('chat-corrupt')).toEqual([])
    // A non-array payload is equally unusable.
    fs.writeFileSync(path.join(dir, 'chat-shape.json'), '{"workerId":"x"}')
    expect(store.read('chat-shape')).toEqual([])
    // Records missing their identity or status are dropped, not fatal.
    fs.writeFileSync(
      path.join(dir, 'chat-partial.json'),
      JSON.stringify([{ status: 'completed' }, { workerId: 'toolu_ok', status: 'stopped' }])
    )
    expect(store.read('chat-partial')).toEqual([{ workerId: 'toolu_ok', status: 'stopped' }])
  })

  test('delete removes the sidecar and later writes start clean', async () => {
    const store = new ChatWorkerStore({ dir })
    await store.write('chat-1', [liveWorker()])
    await store.delete('chat-1')
    expect(store.read('chat-1')).toEqual([])
    await store.write('chat-1', [{ ...liveWorker(), status: 'stopped', live: false }])
    expect(store.read('chat-1')).toEqual([
      expect.objectContaining({ status: 'stopped' }),
    ])
  })

  test('a delete queued behind the settle write wins (kill cannot resurrect)', async () => {
    const store = new ChatWorkerStore({ dir })
    // Kill's composition: the process_end rewrite is in flight when the
    // delete is queued; the chain must run the delete after it.
    const write = store.write('chat-1', [
      { ...liveWorker(), status: 'stopped', live: false },
    ])
    const remove = store.delete('chat-1')
    await Promise.all([write, remove])
    expect(fs.existsSync(path.join(dir, 'chat-1.json'))).toBe(false)
  })

  test('unsafe session ids are refused without touching the disk', async () => {
    const store = new ChatWorkerStore({ dir })
    await expect(
      store.write('../../escape', [liveWorker()])
    ).resolves.toBeUndefined()
    expect(store.read('../../escape')).toEqual([])
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
