// Store scenarios for the background-task sidecar (background tasks design
// D6): the persisted shape, no-op skipping, corrupt/missing files, unsafe
// session ids, and delete.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BackgroundTaskRecord } from '../chat/chatBackgroundTasks'
import { ChatTaskStore } from '../chat/chatTaskStore'

describe('ChatTaskStore', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-taskstore-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const shellRecord = (overrides: Partial<BackgroundTaskRecord> = {}): BackgroundTaskRecord => ({
    taskId: 'bnozyv5av',
    toolCallId: 'call_33dd57efbe6645178a8c9e6b',
    kind: 'shell',
    description: 'Wait for CI',
    status: 'completed',
    summary: 'Background command "Wait for CI" completed (exit code 0)',
    outputFile: '/tmp/claude-1000/-tmp-proj/9da24b54/tasks/bnozyv5av.output',
    startedAtMs: 1_000,
    endedAtMs: 9_000,
    ...overrides,
  })

  test('round-trips the restart-relevant shape including the output file', async () => {
    const store = new ChatTaskStore({ dir })
    await store.write('chat-1', [
      shellRecord(),
      shellRecord({ taskId: 'bwatch', kind: 'monitor', status: 'stopped', summary: 'Monitor "Watch" stream ended', outputFile: undefined, endedAtMs: undefined }),
    ])
    expect(store.read('chat-1')).toEqual([
      {
        taskId: 'bnozyv5av',
        toolCallId: 'call_33dd57efbe6645178a8c9e6b',
        kind: 'shell',
        description: 'Wait for CI',
        status: 'completed',
        summary: 'Background command "Wait for CI" completed (exit code 0)',
        outputFile: '/tmp/claude-1000/-tmp-proj/9da24b54/tasks/bnozyv5av.output',
        startedAtMs: 1_000,
        endedAtMs: 9_000,
      },
      {
        taskId: 'bwatch',
        toolCallId: 'call_33dd57efbe6645178a8c9e6b',
        kind: 'monitor',
        description: 'Wait for CI',
        status: 'stopped',
        summary: 'Monitor "Watch" stream ended',
        startedAtMs: 1_000,
      },
    ])
  })

  test('an identical persisted shape skips the disk write', async () => {
    const store = new ChatTaskStore({ dir })
    await store.write('chat-1', [shellRecord()])
    const before = fs.statSync(path.join(dir, 'chat-1.json')).mtimeMs
    // A later publish with a different elapsed but the same persisted shape.
    await store.write('chat-1', [shellRecord()])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fs.statSync(path.join(dir, 'chat-1.json')).mtimeMs).toBe(before)
    // A settle change rewrites.
    await store.write('chat-1', [shellRecord({ status: 'failed', summary: 'exit 1' })])
    expect(store.read('chat-1')[0]).toMatchObject({ status: 'failed', summary: 'exit 1' })
  })

  test('a missing file reads as empty and delete removes it', async () => {
    const store = new ChatTaskStore({ dir })
    expect(store.read('chat-none')).toEqual([])
    await store.write('chat-1', [shellRecord()])
    await store.delete('chat-1')
    expect(store.read('chat-1')).toEqual([])
    expect(fs.existsSync(path.join(dir, 'chat-1.json'))).toBe(false)
  })

  test('unsafe session ids are refused without touching the disk', async () => {
    const store = new ChatTaskStore({ dir })
    await store.write('../escape', [shellRecord()])
    expect(store.read('../escape')).toEqual([])
    await expect(store.delete('../escape')).resolves.toBeUndefined()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test('a corrupt file reads as empty, not a crash', () => {
    const store = new ChatTaskStore({ dir })
    fs.writeFileSync(path.join(dir, 'chat-1.json'), '{not json')
    expect(store.read('chat-1')).toEqual([])
    // Records with a bad shape drop out individually.
    fs.writeFileSync(
      path.join(dir, 'chat-2.json'),
      JSON.stringify([{ taskId: 'ok', kind: 'shell', status: 'completed', startedAtMs: 1 }, { taskId: '', kind: 'shell', status: 'running', startedAtMs: 2 }])
    )
    expect(store.read('chat-2')).toEqual([{ taskId: 'ok', kind: 'shell', status: 'completed', startedAtMs: 1 }])
  })
})
