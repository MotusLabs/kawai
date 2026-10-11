// Task association and spawned identity on chat sessions (team-tasks 6.3):
// persisted on the row, published on the session (with the task title),
// kept through restart and archive/restore, and visible together with the
// permission status that marks a spawned session as needing attention.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { resolveTeam } from '../team/teamIdentity'

describe('chat session tasks', () => {
  let tempDir: string
  let project: string
  let db: SessionDatabase
  let registry: SessionRegistry

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-chat-tasks-')))
    project = path.join(tempDir, 'project')
    fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), 'Build.')
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    registry = new SessionRegistry()
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const createManager = () => new ChatSessionManager({
    db, registry, onEvent: () => {}, profileCatalogHome: tempDir, authCheck: () => true,
    queryFactory: fixtureQueryFactory,
  })
  const waitFor = async (check: () => boolean, label: string) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > 5000) throw new Error(`Timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  const spawnedSession = async (manager: ChatSessionManager) => {
    const team = await resolveTeam(project)
    const task = await manager.tasks.create({ kind: 'human', team }, { title: 'Export', direction: 'CSV' })
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', taskId: task.id, spawned: true })
    if (!result.ok) throw new Error(result.error)
    return { task, session: result.session }
  }

  test('a spawned session carries its task and flag on the row and the published session', async () => {
    const manager = createManager()
    const { task, session } = await spawnedSession(manager)
    expect(session).toMatchObject({ spawned: true, taskId: task.id, taskTitle: 'Export', groupId: 'devs' })
    expect(db.getChatSession(session.id)).toMatchObject({ spawned: true, taskId: task.id })
    const ordinary = await manager.createAvailableSession({ projectPath: project })
    expect(ordinary.ok && ordinary.session.spawned).toBeUndefined()
    expect(ordinary.ok && ordinary.session.taskId).toBeUndefined()
    manager.shutdown()
  })

  test('task and spawned identity survive restart and archive/restore', async () => {
    const first = createManager()
    const { task, session } = await spawnedSession(first)
    first.shutdown()
    registry = new SessionRegistry()
    const second = createManager()
    expect(registry.get(session.id)).toMatchObject({ spawned: true, taskId: task.id, taskTitle: 'Export' })
    expect(second.archive(session.id).ok).toBe(true)
    expect(second.restore(session.id).ok).toBe(true)
    expect(registry.get(session.id)).toMatchObject({ spawned: true, taskId: task.id })
    expect(db.getChatSession(session.id)).toMatchObject({ spawned: true, taskId: task.id, archivedAt: null })
    second.shutdown()
  })

  test('receiving task mail associates an ordinary member with the task and publishes its title', async () => {
    const manager = createManager()
    const team = await resolveTeam(project)
    const task = await manager.tasks.create({ kind: 'human', team }, { title: 'Import', direction: 'd' })
    const dev = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    if (!dev.ok) throw new Error(dev.error)
    expect(registry.get(dev.session.id)?.taskId).toBeUndefined()
    manager.mailbox.store.enqueue({ teamId: team.teamId, toKind: 'session', toId: dev.session.id, fromSession: 'lead', fromGroup: null, originPath: project, body: 'go', taskId: task.id })
    await waitFor(() => registry.get(dev.session.id)?.taskId === task.id, 'task association')
    expect(registry.get(dev.session.id)?.taskTitle).toBe('Import')
    expect(db.getChatSession(dev.session.id)?.taskId).toBe(task.id)
    manager.shutdown()
  })

  for (const prompt of ['approval', 'question'] as const) {
    test(`a spawned session awaiting ${prompt} shows permission status until it is resolved`, async () => {
      const manager = createManager()
      const { session } = await spawnedSession(manager)
      await manager.send(session.id, `please ${prompt}`)
      await waitFor(() => registry.get(session.id)?.status === 'permission', 'permission status')
      expect(registry.get(session.id)).toMatchObject({ spawned: true, status: 'permission' })
      const request = manager.getPendingRequests(session.id)[0]!
      const resolved = prompt === 'approval'
        ? manager.resolveApproval(session.id, request.requestId, 'allow')
        : manager.answerQuestion(session.id, request.requestId, { 'Which color?': { options: ['Blue'] } })
      expect(resolved.ok).toBe(true)
      await waitFor(() => registry.get(session.id)?.status !== 'permission', 'resolution')
      manager.shutdown()
    })
  }
})
