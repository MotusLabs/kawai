// Boot restore catch-up (bounded-boot-restore D1/D3/D4, Table B;
// chat-session-naming D4, worktree tracking D3): live rows adopt their
// transcript's title and cwd before whenRestored resolves; archived rows
// register at once with their stored name and adopt the same facts in the
// deferred pass after it, unless the row changed meanwhile; a user-set name
// is never replaced; rows without an indexed transcript keep their stored
// values; and the start blocker's transcript check stops walking the
// projects tree once a path is known.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatNameSource } from '../../shared/types'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

const transcript = (title: string, cwd: string) => [
  JSON.stringify({ type: 'ai-title', aiTitle: title }),
  JSON.stringify({
    type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-10-12T10:00:00.000Z',
    cwd, message: { role: 'user', content: 'hello' },
  }),
].join('\n')

describe('boot restore catch-up', () => {
  let tempDir: string
  let db: SessionDatabase
  let registry: SessionRegistry
  const managers: ChatSessionManager[] = []
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-boot-catch-up-')))
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude')
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    registry = new SessionRegistry()
  })
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.shutdown()
    db.close()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const createManager = () => {
    const manager = new ChatSessionManager({
      db, registry, onEvent: () => {}, profileCatalogHome: tempDir, authCheck: () => true,
      queryFactory: fixtureQueryFactory, isDirectory: () => true,
    })
    managers.push(manager)
    return manager
  }
  const writeTranscript = (sdkSessionId: string, content: string) => {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${sdkSessionId}.jsonl`)
    fs.writeFileSync(file, content)
    return file
  }
  /** Holds every open of `file` until the returned release is called. */
  const holdOpen = (file: string) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = fsp.open.bind(fsp)
    const opened: string[] = []
    const spy = spyOn(fsp, 'open').mockImplementation((async (target: Parameters<typeof fsp.open>[0], ...rest: unknown[]) => {
      opened.push(String(target))
      if (String(target) === file) await gate
      return (original as (...args: unknown[]) => ReturnType<typeof fsp.open>)(target, ...rest)
    }) as typeof fsp.open)
    holds.push(spy)
    return { release, opened }
  }
  const holds: Array<{ mockRestore(): void }> = []
  afterEach(() => { for (const spy of holds.splice(0)) spy.mockRestore() })
  const seed = (sdkSessionId: string | null, options: { archived?: boolean; nameSource?: ChatNameSource } = {}) => {
    const sessionId = `chat-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId, name: 'stored', projectPath: '/tmp/proj', sdkSessionId,
      status: 'waiting', createdAt: now, lastActivityAt: now,
      nameSource: options.nameSource ?? 'auto',
    })
    if (options.archived) db.updateChatSession(sessionId, { archivedAt: now })
    return sessionId
  }
  const eventually = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i += 1) await Bun.sleep(10)
    expect(check()).toBe(true)
  }

  // @covers: chat-sessions › Live chats adopt transcript facts before restore completes › A live chat shows its newest title and path at once
  test('B1 a live row adopts its title and cwd before whenRestored resolves', async () => {
    writeTranscript('sdk-live', transcript('Live title', '/tmp/proj/wt'))
    const live = seed('sdk-live')
    const manager = createManager()
    await manager.whenRestored()
    expect(registry.get(live)?.name).toBe('Live title')
    expect(registry.get(live)?.projectPath).toBe('/tmp/proj/wt')
    expect(db.getChatSession(live)?.projectPath).toBe('/tmp/proj/wt')
  })

  // @covers: chat-sessions › Archived chats catch up on transcript facts after restore › An archived chat catches up after startup
  // @covers: chat-sessions › The server stays responsive while persisted chats restore › A very large archived transcript does not stall startup
  test('B2 an archived row registers with its stored name and catches up after restore', async () => {
    const file = writeTranscript('sdk-arch', transcript('Archived title', '/tmp/proj/old-wt'))
    const archived = seed('sdk-arch', { archived: true })
    // The archived scan is held: restore must complete without it.
    const hold = holdOpen(file)
    const manager = createManager()
    await manager.whenRestored()
    expect(manager.has(archived)).toBe(true)
    expect(registry.get(archived)?.name).toBe('stored')
    expect(registry.get(archived)?.projectPath).toBe('/tmp/proj')
    hold.release()
    await eventually(() => registry.get(archived)?.name === 'Archived title')
    expect(registry.get(archived)?.projectPath).toBe('/tmp/proj/old-wt')
    expect(db.getChatSession(archived)?.projectPath).toBe('/tmp/proj/old-wt')
    expect(db.getChatSession(archived)?.archivedAt).not.toBeNull()
  })

  // @covers: chat-sessions › Archived chats catch up on transcript facts after restore › A user-set name survives the catch-up
  test('B3 a user-set name survives both passes', async () => {
    writeTranscript('sdk-a', transcript('Generated', '/tmp/proj'))
    writeTranscript('sdk-b', transcript('Generated', '/tmp/proj/moved'))
    const live = seed('sdk-a', { nameSource: 'manual' })
    const archived = seed('sdk-b', { nameSource: 'manual', archived: true })
    const manager = createManager()
    await manager.whenRestored()
    await eventually(() => registry.get(archived)?.projectPath === '/tmp/proj/moved')
    expect(registry.get(live)?.name).toBe('stored')
    expect(registry.get(archived)?.name).toBe('stored')
  })

  test('B4 an archived row changed before its catch-up keeps the change', async () => {
    const file = writeTranscript('sdk-arch', transcript('Archived title', '/tmp/proj/old-wt'))
    const changed = seed('sdk-arch', { archived: true })
    const other = seed('sdk-next', { archived: true })
    writeTranscript('sdk-next', transcript('Next title', '/tmp/proj/next'))
    const hold = holdOpen(file)
    const manager = createManager()
    await manager.whenRestored()
    expect(manager.rename(changed, 'renamed meanwhile').ok).toBe(true)
    hold.release()
    // The pass reaches the row after it, so it has passed the changed one.
    await eventually(() => registry.get(other)?.name === 'Next title')
    expect(registry.get(changed)?.name).toBe('renamed meanwhile')
    expect(registry.get(changed)?.projectPath).toBe('/tmp/proj')
    expect(db.getChatSession(changed)?.projectPath).toBe('/tmp/proj')
  })

  // @covers: chat-sessions › The server stays responsive while persisted chats restore › Every session is listed after restore
  test('B6 rows without an SDK id or an indexed transcript keep their stored values', async () => {
    writeTranscript('sdk-other', transcript('Unrelated', '/tmp/proj/other'))
    const noSdk = seed(null)
    const liveMissing = seed('sdk-missing')
    const archivedMissing = seed('sdk-gone', { archived: true })
    const manager = createManager()
    await manager.whenRestored()
    for (const id of [noSdk, liveMissing, archivedMissing]) {
      expect(manager.has(id)).toBe(true)
      expect(registry.get(id)?.name).toBe('stored')
      expect(registry.get(id)?.projectPath).toBe('/tmp/proj')
    }
  })

  // @covers: chat-sessions › Transcript-missing checks see the transcript's current presence › A deleted transcript is reported missing
  test('B5 the start blocker checks a known transcript without another walk', async () => {
    writeTranscript('sdk-live', transcript('t', '/tmp/proj'))
    const live = seed('sdk-live')
    const manager = createManager()
    await manager.whenRestored()
    const internals = manager as unknown as {
      startBlocker(record: unknown): string | null
      records: Map<string, unknown>
    }
    const record = internals.records.get(live)
    // Boot seeded the cache from its index: the check reads no directory.
    const readdir = spyOn(fs, 'readdirSync')
    let dirReads: number
    try {
      expect(internals.startBlocker(record)).toBeNull()
      expect(internals.startBlocker(record)).toBeNull()
      dirReads = readdir.mock.calls.length
    } finally { readdir.mockRestore() }
    expect(dirReads).toBe(0)
    fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-tmp-proj', 'sdk-live.jsonl'))
    expect(internals.startBlocker(record)).toContain('transcript is missing')
  })
})
