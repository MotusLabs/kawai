// Group membership of chat sessions (agent-teams): creation validates the
// group against the project's team catalog, stores it, and the group stays
// fixed through restart and archive/restore.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
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

  test('a trusted clone keeps a removed group while ordinary creation stays strict', async () => {
    const manager = createManager()
    try {
      const original = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
      if (!original.ok) throw new Error(original.error)
      fs.rmSync(path.join(project, '.kawai/groups/devs.md'))
      const clone = await manager.createAvailableSession({ projectPath: project, groupId: 'forged', cloneFromSessionId: original.session.id })
      expect(clone.ok && clone.session.groupId).toBe('devs')
      expect((await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })).ok).toBe(false)
      expect((await manager.createAvailableSession({ projectPath: project, groupId: 'devs', cloneFromSessionId: 'missing' })).ok).toBe(false)
    } finally { manager.shutdown() }
  })

  test('transcript identity changes wake mail delivery without waking for activity metadata', async () => {
    const manager = createManager()
    try {
      const result = await manager.createAvailableSession({ projectPath: project })
      if (!result.ok) throw new Error(result.error)
      await manager.teams.track(result.session.id, project)
      await manager.dispatcher.settled()
      const notify = spyOn(manager.dispatcher, 'notify')
      // Exercise the patch boundary used by the driver's onSessionId callback.
      const patcher = manager as unknown as {
        applyPatch(id: string, patch: { sdkSessionId?: string; lastActivityAt?: string }): void
      }
      try {
        patcher.applyPatch(result.session.id, { sdkSessionId: 'missing-transcript' })
        expect(notify).toHaveBeenCalledTimes(1)
        patcher.applyPatch(result.session.id, { sdkSessionId: 'missing-transcript' })
        patcher.applyPatch(result.session.id, { lastActivityAt: new Date().toISOString() })
        expect(notify).toHaveBeenCalledTimes(1)
      } finally { notify.mockRestore() }
    } finally { manager.shutdown() }
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
    await restarted.whenRestored()
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

  test('a member launches with its group effort; a session without a group gets none', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'lead.md'), '---\neffort: max\n---\nLead.')
    const spawned: Options[] = []
    const manager = new ChatSessionManager({
      db, registry: new SessionRegistry(), onEvent: () => {}, profileCatalogHome: home,
      availabilityProbe: async () => {},
      queryFactory: (args) => { spawned.push(args.options); return fixtureQueryFactory(args) },
    })
    try {
      const lead = await manager.createAvailableSession({ projectPath: project, groupId: 'lead' })
      if (!lead.ok) throw new Error(lead.error)
      expect(await manager.start(lead.session.id)).toEqual({ ok: true })
      expect(spawned[0]?.effort).toBe('max')

      const loose = await manager.createAvailableSession({ projectPath: project })
      if (!loose.ok) throw new Error(loose.error)
      expect(await manager.start(loose.session.id)).toEqual({ ok: true })
      expect(spawned).toHaveLength(2)
      expect('effort' in spawned[1]!).toBe(false)
    } finally {
      manager.shutdown()
    }
  })

  test('per-profile effort: spawned and human-created members launch by their profile, re-read at each start', async () => {
    fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      haiku: { label: 'Haiku' }, 'glm-flash': { label: 'GLM Flash' },
    }))
    const juniors = path.join(project, '.kawai', 'groups', 'juniors.md')
    fs.writeFileSync(juniors, '---\neffort: low\nprofileEffort: { haiku: xhigh }\n---\nJunior.')
    const spawned: Options[] = []
    const manager = new ChatSessionManager({
      db, registry: new SessionRegistry(), onEvent: () => {}, profileCatalogHome: home,
      availabilityProbe: async () => {},
      queryFactory: (args) => { spawned.push(args.options); return fixtureQueryFactory(args) },
    })
    try {
      const launch = async (input: { claudeProfileId?: string; spawned?: boolean }) => {
        const created = await manager.createAvailableSession({ projectPath: project, groupId: 'juniors', ...input })
        if (!created.ok) throw new Error(created.error)
        expect(await manager.start(created.session.id)).toEqual({ ok: true })
        return created.session.id
      }
      const human = await launch({ claudeProfileId: 'haiku' })
      await launch({ claudeProfileId: 'haiku', spawned: true })
      await launch({ claudeProfileId: 'glm-flash', spawned: true })
      await launch({})
      expect(spawned.map(options => options.effort)).toEqual(['xhigh', 'xhigh', 'low', 'low'])

      // An edit reaches only the next start of the same member.
      fs.writeFileSync(juniors, '---\neffort: low\nprofileEffort: { haiku: high }\n---\nJunior.')
      expect(spawned[0]?.effort).toBe('xhigh')
      manager.kill(human)
      expect(await launch({ claudeProfileId: 'haiku' })).not.toBe(human)
      expect(spawned[4]?.effort).toBe('high')
    } finally {
      manager.shutdown()
    }
  })
})
