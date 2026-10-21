import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { createHarness, flush, waitForCondition, initMessage, writeTranscript } from './helpers/chatSessionManagerHarness'

/**
 * Last-known identity (team-message-threads D3): creation and every rename
 * path keep `team_session_directory` current, and kill or archive never write
 * there — the row is what still names a participant after the session is gone.
 */
describe('ChatSessionManager team session directory', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatdir-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
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
  })

  /** The durable row, including the write timestamp a no-op must not move. */
  function directoryRow(sessionId: string) {
    return db.db.prepare(
      'SELECT name, group_id, updated_at FROM team_session_directory WHERE session_id = ?'
    ).get(sessionId) as { name: string; group_id: string | null; updated_at: string } | null
  }

  test('create records the session name and group once its team is known', async () => {
    const { manager } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', name: 'Export button', groupId: 'devs' })
    if (!created.ok) throw new Error(created.error)
    await waitForCondition(() => directoryRow(created.session.id) !== null)
    expect(directoryRow(created.session.id)).toMatchObject({
      name: 'Export button', group_id: 'devs',
    })
    manager.shutdown()
  })

  test('a generated title rename re-records the name', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)
    expect(directoryRow(id)!.name).toBe(created.session.name)

    writeTranscript(
      'dir-title',
      JSON.stringify({ type: 'ai-title', aiTitle: 'adopted title', sessionId: 'dir-title' }) + '\n'
    )
    await harness.manager.send(id, 'hello')
    harness.handles[0]!.push(initMessage('dir-title'))
    await waitForCondition(() => directoryRow(id)?.name === 'adopted title')
    expect(directoryRow(id)!.group_id).toBeNull()
    harness.manager.shutdown()
  })

  test('a manual rename re-records the name and pins it against later titles', async () => {
    const harness = await createHarness(db)
    const created = harness.manager.createSession({ projectPath: '/tmp/proj', name: 'Placeholder' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)

    expect(harness.manager.rename(id, 'My own name').ok).toBe(true)
    expect(directoryRow(id)!.name).toBe('My own name')

    writeTranscript(
      'dir-manual',
      JSON.stringify({ type: 'ai-title', aiTitle: 'too late', sessionId: 'dir-manual' }) + '\n'
    )
    await harness.manager.send(id, 'hello')
    harness.handles[0]!.push(initMessage('dir-manual'))
    await flush(10)
    expect(directoryRow(id)!.name).toBe('My own name')
    harness.manager.shutdown()
  })

  test('repeated renames overwrite the recorded entry rather than adding rows', async () => {
    const { manager } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', name: 'First' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)
    for (const name of ['Second', 'Third']) {
      expect(manager.rename(id, name).ok).toBe(true)
    }
    expect(directoryRow(id)!.name).toBe('Third')
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_session_directory').get()).toEqual({ n: 1 })
    manager.shutdown()
  })

  test('kill leaves the last known identity in place and writes nothing new', async () => {
    const { manager } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', name: 'Doomed helper', groupId: 'devs' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)
    expect(manager.rename(id, 'Renamed helper').ok).toBe(true)
    const before = directoryRow(id)!
    expect(before.name).toBe('Renamed helper')

    expect(manager.kill(id)).toBe(true)
    await flush(6)
    expect(directoryRow(id)).toEqual(before)
    manager.shutdown()
  })

  test('archive leaves the last known identity in place and writes nothing new', async () => {
    const { manager } = await createHarness(db)
    const created = manager.createSession({ projectPath: '/tmp/proj', name: 'Parked work', groupId: 'qa' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    await waitForCondition(() => directoryRow(id) !== null)
    const before = directoryRow(id)!

    expect(manager.archive(id).ok).toBe(true)
    await flush(6)
    expect(directoryRow(id)).toEqual(before)
    manager.shutdown()
  })
})
