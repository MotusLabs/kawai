import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatTaskStore } from '../chat/chatTaskStore'
import { anyDirectory, FakeHandle, managedManager, fakeQueryFactory, createHarness, flush, waitForCondition, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

describe('ChatSessionManager background-task roster (background tasks D2)', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatbgtasks-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
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
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  })

  test('a live session publishes its roster and snapshots the fresh projection', async () => {
    const { manager, handles, backgroundTasks } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run things')
    const handle = handles[0]!
    handle.push({
      type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'call_1',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    // The sink saw the full-set publish...
    expect(backgroundTasks.at(-1)?.tasks).toMatchObject([
      { taskId: 'b1', kind: 'shell', description: 'dev server', status: 'running', live: true },
    ])
    // ...and a reconnecting client's snapshot carries the same roster.
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b1', status: 'running', live: true },
    ])
    handle.push({
      type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'call_1',
      status: 'completed', summary: 'done (exit code 0)', uuid: 'u2', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(backgroundTasks.at(-1)?.tasks).toMatchObject([
      { taskId: 'b1', status: 'completed', live: false, summary: 'done (exit code 0)' },
    ])
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b1', status: 'completed' },
    ])
  })

  test('a settling task on a pending release re-runs the dispatch cycle (member-release D2/D3)', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run things')
    const handle = handles[0]!
    handle.push({
      type: 'system', subtype: 'task_started', task_id: 'b9', tool_use_id: 'call_9',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.hasRunningBackgroundTasks(id)).toBe(true)
    db.db.prepare(`INSERT INTO team_member_releases (session_id, task_id, team_id, reason, requested_by_kind, requested_at)
      VALUES (?, 'task-1', 'team-1', 'task done', 'human', ?)`).run(id, new Date().toISOString())
    let notified = 0
    manager.dispatcher.notify = () => { notified += 1 }
    handle.push({
      type: 'system', subtype: 'task_notification', task_id: 'b9', tool_use_id: 'call_9',
      status: 'completed', summary: 'done (exit code 0)', uuid: 'u2', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(manager.hasRunningBackgroundTasks(id)).toBe(false)
    expect(notified).toBeGreaterThan(0)
    manager.shutdown()
  })

  test('a member spawned for an already-closed task is marked pending release by its creation (member-release D1)', async () => {
    const { manager } = await createHarness(db)
    const t = manager.tasks.store.create({ teamId: 'team-1', title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } })
    manager.tasks.store.setStatus(t.id, 'done')
    const created = manager.createSession({ projectPath: '/tmp/proj', spawned: true, taskId: t.id })
    if (!created.ok) throw new Error('create failed')
    // Same tick as the insert: no await sits between persisting the session and its mark.
    const row = db.db.prepare('SELECT task_id FROM team_member_releases WHERE session_id = ?').get(created.session.id)
    expect(row).toEqual({ task_id: t.id })
    manager.shutdown()
  })

  test('process end frees a pending member: the stopped roster re-checks readiness and the next pass archives it (member-release D3)', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', spawned: true })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'start a dev server')
    const handle = handles[0]!
    handle.push({
      type: 'system', subtype: 'task_started', task_id: 'b-end', tool_use_id: 'call_end',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    // The turn ends; the shell keeps running, so only D3's task condition holds the member.
    handle.push({ type: 'result', subtype: 'success', result: 'started', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await flush()
    db.db.prepare(`INSERT INTO team_member_releases (session_id, task_id, team_id, reason, requested_by_kind, requested_at)
      VALUES (?, 'task-1', 'team-1', 'task done', 'human', ?)`).run(id, new Date().toISOString())
    manager.dispatcher.release()
    manager.dispatcher.notify()
    await manager.dispatcher.settled()
    expect(manager.isArchived(id)).toBe(false)
    // The process ends (EOF): the driver settles the shell as stopped and
    // publishes that roster; nothing else asks the dispatcher to look again.
    handle.query.close()
    await waitForCondition(() => manager.getSnapshot(id)!.backgroundTasks[0]?.status === 'stopped')
    await manager.dispatcher.settled()
    await waitForCondition(() => manager.isArchived(id))
    manager.shutdown()
  })

  test('a turn ending while a shell is live leaves the session waiting (D7)', async () => {
    const { manager, handles, registry } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'start a dev server')
    const handle = handles[0]!
    handle.push({
      type: 'system', subtype: 'task_started', task_id: 'b3', tool_use_id: 'call_3',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    handle.push({
      type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b3' }], uuid: 'u4', session_id: 's',
    } as unknown as SDKMessage)
    // The turn completes; the shell keeps running.
    handle.push({
      type: 'result', subtype: 'success', result: 'started', uuid: 'u5', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(registry.get(id)?.status).toBe('waiting')
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b3', status: 'running', live: true },
    ])
  })

  test('an archived session keeps its last roster, settled as stopped', async () => {
    const { manager, handles } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run things')
    handles[0]!.push({
      type: 'system', subtype: 'task_started', task_id: 'b2', task_type: 'local_bash',
      description: 'sleep', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    await manager.archive(id)
    // Archived read-only: archiving ended the process, so the running task
    // settles as stopped, and the last roster still answers the snapshot.
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b2', status: 'stopped', live: false },
    ])
  })

  test('a process crash persists stopped tasks through archive and restore', async () => {
    const store = new ChatTaskStore({ dir: path.join(tempDir, 'chat-tasks-crash') })
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles), taskStore: store,
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'start a background task')
    handles[0]!.push({
      type: 'system', subtype: 'task_started', task_id: 'b-crash', tool_use_id: 'c1',
      task_type: 'local_bash', is_backgrounded: true, uuid: 'u1', session_id: 's',
    } as unknown as SDKMessage)
    await waitForCondition(() => store.read(id).some(task => task.status === 'running'))

    // An unexpected EOF marks the driver dead before it publishes process_end.
    handles[0]!.query.close()
    await waitForCondition(() => manager.getSnapshot(id)!.backgroundTasks[0]?.status === 'stopped')
    const stopped = manager.getSnapshot(id)!.backgroundTasks[0]!
    expect(stopped.live).toBe(false)
    expect(stopped.endedAtMs).toBeDefined()
    await waitForCondition(() => store.read(id)[0]?.status === 'stopped')
    expect(store.read(id)[0]?.endedAtMs).toBe(stopped.endedAtMs)

    // Recreating the driver must seed the stopped records, not the old running ones.
    expect(manager.archive(id)).toEqual({ ok: true })
    expect(manager.restore(id)).toEqual({ ok: true })
    await manager.send(id, 'continue after the crash')
    expect(manager.getSnapshot(id)!.backgroundTasks).toEqual([stopped])
    manager.shutdown()
  })

  test('restart keeps a settled outcome and recovers a running task as stopped', async () => {
    const taskDir = path.join(tempDir, 'chat-tasks')
    const store = () => new ChatTaskStore({ dir: taskDir })
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles), taskStore: store(),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run two tasks')
    const handle = handles[0]!
    // One task settles before the restart; the other is still running.
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-done', tool_use_id: 'c1', task_type: 'local_bash', description: 'quick', is_backgrounded: true, uuid: 'u1', session_id: 's' } as unknown as SDKMessage)
    handle.push({ type: 'system', subtype: 'task_notification', task_id: 'b-done', tool_use_id: 'c1', status: 'completed', summary: 'done (exit code 0)', output_file: '/tmp/claude-1000/x/tasks/b-done.output', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-live', tool_use_id: 'c2', task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u3', session_id: 's' } as unknown as SDKMessage)
    await waitForCondition(() => store().read(id).length === 2)
    // Abrupt stop, as a crash would leave things.
    const restored = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory([]), taskStore: store(),
    })
    expect(restored.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b-done', status: 'completed', summary: 'done (exit code 0)', live: false },
      { taskId: 'b-live', status: 'stopped', live: false },
    ])
    // The corrected roster is rewritten so the file and the rows agree, and
    // the recorded output path survives for the tail reader (D3).
    await waitForCondition(() => store().read(id).every(task => task.status !== 'running'))
    expect(store().read(id)).toMatchObject([
      { taskId: 'b-done', outputFile: '/tmp/claude-1000/x/tasks/b-done.output' },
      { taskId: 'b-live', status: 'stopped' },
    ])
    restored.shutdown()
  })

  test('kill removes the task sidecar with the session', async () => {
    const taskDir = path.join(tempDir, 'chat-tasks-kill')
    const store = () => new ChatTaskStore({ dir: taskDir })
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles), taskStore: store(),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run one task')
    handles[0]!.push({ type: 'system', subtype: 'task_started', task_id: 'b-kill', task_type: 'local_bash', is_backgrounded: true, uuid: 'u', session_id: 's' } as unknown as SDKMessage)
    await waitForCondition(() => store().read(id).length === 1)
    manager.kill(id)
    await waitForCondition(() => !fs.existsSync(path.join(taskDir, `${id}.json`)))
    expect(store().read(id)).toEqual([])
  })

  test('a resume keeps recovered output paths through later roster writes', async () => {
    const taskDir = path.join(tempDir, 'chat-tasks-resume')
    const store = () => new ChatTaskStore({ dir: taskDir })
    const first: FakeHandle[] = []
    const managerA = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(first), taskStore: store(),
    })
    const created = managerA.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await managerA.send(id, 'run a task')
    first[0]!.push({ type: 'system', subtype: 'task_started', task_id: 'b-old', tool_use_id: 'c1', task_type: 'local_bash', description: 'old task', is_backgrounded: true, uuid: 'u1', session_id: 's' } as unknown as SDKMessage)
    first[0]!.push({ type: 'system', subtype: 'task_notification', task_id: 'b-old', tool_use_id: 'c1', status: 'completed', summary: 'done before restart', output_file: '/tmp/claude-1000/x/tasks/b-old.output', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await waitForCondition(() => store().read(id).some(entry => entry.outputFile !== undefined))
    // Restart: the persisted row recovers at boot...
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles), taskStore: store(),
    })
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b-old', status: 'completed', summary: 'done before restart' },
    ])
    // ...and a resume spawns a driver seeded from the server-side records:
    // a new task's roster publish must not rewrite the old one without its
    // recorded output path.
    await manager.send(id, 'another turn')
    handles[0]!.push({ type: 'system', subtype: 'task_started', task_id: 'b-new', tool_use_id: 'c9', task_type: 'local_bash', description: 'new task', is_backgrounded: true, uuid: 'u9', session_id: 's' } as unknown as SDKMessage)
    await waitForCondition(() => store().read(id).some(entry => entry.taskId === 'b-new'))
    expect(store().read(id)).toMatchObject([
      { taskId: 'b-old', outputFile: '/tmp/claude-1000/x/tasks/b-old.output', summary: 'done before restart' },
      { taskId: 'b-new', description: 'new task' },
    ])
    manager.shutdown()
  })

  test('readTaskOutput prefers the live query and coalesces concurrent asks', async () => {
    const handles: FakeHandle[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory(handles),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'hi')
    // The fake query grows the undeclared control (runtime shape only).
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    ;(handles[0]!.query as unknown as {
      getTaskOutput?: (taskId: string) => Promise<{ output: string; total_bytes: number; truncated: boolean }>
    }).getTaskOutput = async (taskId: string) => {
      calls += 1
      await gate
      return { output: `tail of ${taskId}`, total_bytes: 42, truncated: false }
    }
    const first = manager.readTaskOutput(id, 'b1')
    const second = manager.readTaskOutput(id, 'b1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    release!()
    const [a, b] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(a).toEqual({ state: 'ok', output: 'tail of b1', totalBytes: 42, truncated: false })
    expect(b).toEqual(a)
    // A throwing control falls back (here: to unavailable — no file record).
    ;(handles[0]!.query as unknown as { getTaskOutput?: unknown }).getTaskOutput = async () => {
      throw new Error('control exploded')
    }
    await expect(manager.readTaskOutput(id, 'b2')).resolves.toEqual({ state: 'unavailable' })
  })

  test('readTaskOutput falls back to the recorded output file', async () => {
    const taskDir = path.join(tempDir, 'chat-tasks-fallback')
    fs.mkdirSync(path.join(taskDir, 'tasks'), { recursive: true })
    const file = path.join(taskDir, 'tasks', 'b-file.output')
    fs.writeFileSync(file, 'shell-a-done\n')
    const store = () => new ChatTaskStore({ dir: path.join(tempDir, 'chat-tasks-store') })
    await store().write('chat-fb', [{
      taskId: 'b-file', kind: 'shell', status: 'completed', summary: 'done',
      outputFile: file, startedAtMs: 1, endedAtMs: 2,
    }])
    // No session, no live driver: the sidecar record answers.
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: () => {}, queryFactory: fakeQueryFactory([]), taskStore: store(),
    })
    await expect(manager.readTaskOutput('chat-fb', 'b-file')).resolves.toEqual({
      state: 'ok', output: 'shell-a-done\n', totalBytes: 13, truncated: false,
    })
    // A record whose file is gone, and an unknown task: unavailable.
    await store().write('chat-fb', [{ taskId: 'b-gone', kind: 'shell', status: 'completed', startedAtMs: 1, outputFile: path.join(taskDir, 'tasks', 'b-gone.output') }])
    await expect(manager.readTaskOutput('chat-fb', 'b-gone')).resolves.toEqual({ state: 'unavailable' })
    await expect(manager.readTaskOutput('chat-fb', 'b-unknown')).resolves.toEqual({ state: 'unavailable' })
    // A path outside the recorded layout is never read, even if it exists.
    const outside = path.join(tempDir, 'outside.output')
    fs.writeFileSync(outside, 'secret')
    await store().write('chat-fb', [{ taskId: 'b-bad', kind: 'shell', status: 'completed', startedAtMs: 1, outputFile: outside }])
    await expect(manager.readTaskOutput('chat-fb', 'b-bad')).resolves.toEqual({ state: 'unavailable' })
  })

  test('stopBackgroundTask stops one live task; the settle rides the roster, the turn is untouched', async () => {
    const handles: FakeHandle[] = []
    const events: Array<{ sessionId: string; event: ChatEvent }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: (sessionId, event) => events.push({ sessionId, event }),
      queryFactory: fakeQueryFactory(handles),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    // A turn is in flight (no result yet) while two tasks run.
    await manager.send(id, 'run two')
    const handle = handles[0]!
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-stop', task_type: 'local_bash', is_backgrounded: true, uuid: 'u1', session_id: 's' } as unknown as SDKMessage)
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-keep', task_type: 'local_bash', is_backgrounded: true, uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await flush()
    const stopped: string[] = []
    ;(handle.query as unknown as { stopTask?: (taskId: string) => Promise<void> }).stopTask = async (taskId: string) => {
      stopped.push(taskId)
    }
    await manager.stopBackgroundTask(id, 'b-stop')
    expect(stopped).toEqual(['b-stop'])
    // The CLI's settle: one notification, only for the stopped task.
    handle.push({ type: 'system', subtype: 'task_notification', task_id: 'b-stop', status: 'stopped', summary: 'Sleep', uuid: 'u3', session_id: 's' } as unknown as SDKMessage)
    await flush()
    expect(manager.getSnapshot(id)!.backgroundTasks).toMatchObject([
      { taskId: 'b-stop', status: 'stopped', live: false },
      { taskId: 'b-keep', status: 'running', live: true },
    ])
    // No transcript error, and the in-flight turn never ended.
    expect(events.some(({ event }) => event.type === 'error')).toBe(false)
    expect(events.some(({ event }) => event.type === 'turn_completed')).toBe(false)
  })

  test('stopBackgroundTask refuses archived sessions and ended or unknown tasks, without a transcript error', async () => {
    const handles: FakeHandle[] = []
    const events: Array<{ sessionId: string; event: ChatEvent }> = []
    const manager = await managedManager({
      isDirectory: anyDirectory, db, registry: new SessionRegistry(),
      onEvent: (sessionId, event) => events.push({ sessionId, event }),
      queryFactory: fakeQueryFactory(handles),
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error('create failed')
    const id = created.session.id
    await manager.send(id, 'run one')
    const handle = handles[0]!
    handle.push({ type: 'system', subtype: 'task_started', task_id: 'b-done', task_type: 'local_bash', is_backgrounded: true, uuid: 'u1', session_id: 's' } as unknown as SDKMessage)
    handle.push({ type: 'system', subtype: 'task_notification', task_id: 'b-done', status: 'completed', summary: 'done', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await flush()
    const stopped: string[] = []
    ;(handle.query as unknown as { stopTask?: (taskId: string) => Promise<void> }).stopTask = async (taskId: string) => {
      stopped.push(taskId)
    }
    // Ended task, and one the roster never knew.
    await manager.stopBackgroundTask(id, 'b-done')
    await manager.stopBackgroundTask(id, 'b-unknown')
    expect(stopped).toEqual([])
    // Archive ends the process: even a row the roster still holds as live
    // (none here after settle) could not be stopped.
    await manager.archive(id)
    await manager.stopBackgroundTask(id, 'b-done')
    expect(stopped).toEqual([])
    expect(events.some(({ event }) => event.type === 'error')).toBe(false)
  })
})
