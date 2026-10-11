// Group membership of chat sessions (agent-teams): creation validates the
// group against the project's team catalog, stores it, and the group stays
// fixed through restart and archive/restore.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

describe('chat session groups', () => {
  let tempDir: string
  let project: string
  let home: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-chat-groups-')))
    project = path.join(tempDir, 'project')
    home = path.join(tempDir, 'home')
    fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), 'Build.')
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  })

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalApiKey
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const createManager = () => new ChatSessionManager({
    db,
    registry: new SessionRegistry(),
    onEvent: () => {},
    profileCatalogHome: home,
    availabilityProbe: async () => {},
  })

  test('a session created with a team group stores and lists it', async () => {
    const manager = createManager()
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.groupId).toBe('devs')
    expect(db.getChatSession(result.session.id)?.groupId).toBe('devs')
    manager.shutdown()
  })

  test('a session created without a group has none', async () => {
    const manager = createManager()
    const result = await manager.createAvailableSession({ projectPath: project })
    expect(result.ok && result.session.groupId).toBeUndefined()
    manager.shutdown()
  })

  test('an unknown group is refused and nothing is created', async () => {
    const manager = createManager()
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'qa' })
    expect(result).toEqual({ ok: false, error: 'Unknown group "qa" for this project\'s team' })
    expect(db.getChatSessions()).toHaveLength(0)
    manager.shutdown()
  })

  test('the group survives archive, restore, and a restart', async () => {
    const manager = createManager()
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    if (!result.ok) throw new Error(result.error)
    expect(manager.archive(result.session.id).ok).toBe(true)
    expect(manager.restore(result.session.id).ok).toBe(true)
    manager.shutdown()

    const registry = new SessionRegistry()
    const restarted = new ChatSessionManager({
      db, registry, onEvent: () => {}, profileCatalogHome: home,
    })
    expect(registry.get(result.session.id)?.groupId).toBe('devs')
    restarted.shutdown()
  })

  test('the listed session carries the group label, and a removed file marks it missing', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild.')
    const registry = new SessionRegistry()
    const manager = new ChatSessionManager({
      db, registry, onEvent: () => {}, profileCatalogHome: home, availabilityProbe: async () => {},
    })
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    if (!result.ok) throw new Error(result.error)
    const id = result.session.id
    await manager.teams.track(id, project)
    expect(registry.get(id)).toMatchObject({ groupId: 'devs', groupLabel: 'Developers', groupMissing: false })

    // The file goes away; the next published status change shows it missing
    // while the session keeps its stored group.
    fs.rmSync(path.join(project, '.kawai', 'groups', 'devs.md'))
    manager.archive(id)
    expect(registry.get(id)).toMatchObject({ groupId: 'devs', groupLabel: 'devs', groupMissing: true })
    expect(db.getChatSession(id)?.groupId).toBe('devs')
    manager.shutdown()
  })

  test('a member spawns with its role prompt and the team groups', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'qa.md'), '---\ndescription: Tests releases\n---\nYou test.')
    const spawned: Options[] = []
    const manager = new ChatSessionManager({
      db, registry: new SessionRegistry(), onEvent: () => {}, profileCatalogHome: home,
      availabilityProbe: async () => {},
      queryFactory: (args) => { spawned.push(args.options); return fixtureQueryFactory(args) },
    })
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    if (!result.ok) throw new Error(result.error)
    expect(await manager.start(result.session.id)).toEqual({ ok: true })
    const systemPrompt = spawned[0]?.systemPrompt as { append?: string }
    expect(systemPrompt.append).toContain('# Your role: devs\n\nBuild.')
    expect(systemPrompt.append).toContain('- `qa` (qa): Tests releases')
    manager.shutdown()
  })
})
