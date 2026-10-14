// The session-record lifecycle hook (team-workspace review item 6): a chat
// session's creation, archive, restore, and kill each reach
// `onSessionRecordChange`, which bootstrap wires to the team workspace's
// live-membership push — so Members moves without waiting for unrelated
// task or mail activity.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

let tempDir: string
let project: string
let home: string
let db: SessionDatabase
const originalApiKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-chat-workspace-hooks-')))
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

interface Harness {
  manager: ChatSessionManager
  changed: string[]
}

const createManager = (): Harness => {
  const changed: string[] = []
  const manager = new ChatSessionManager({
    db,
    registry: new SessionRegistry(),
    onEvent: () => {},
    profileCatalogHome: home,
    availabilityProbe: async () => {},
    onSessionRecordChange: sessionId => changed.push(sessionId),
  })
  return { manager, changed }
}

test('a session created with a group reaches the hook once its team resolves', async () => {
  const { manager, changed } = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    expect(result.ok).toBe(true)
    // onResolved fires from the track promise; let it land.
    await Bun.sleep(1)
    if (result.ok) expect(changed).toContain(result.session.id)
  } finally { manager.shutdown() }
})

test('archive, restore, and kill each reach the hook', async () => {
  const { manager, changed } = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { id } = result.session
    await Bun.sleep(1)
    changed.length = 0
    expect(manager.archive(id).ok).toBe(true)
    expect(changed).toEqual([id])
    changed.length = 0
    expect(manager.restore(id).ok).toBe(true)
    expect(changed).toEqual([id])
    changed.length = 0
    expect(manager.kill(id)).toBe(true)
    expect(changed).toEqual([id])
  } finally { manager.shutdown() }
})

test('a status move reaches the hook; usage and activity stamps do not', async () => {
  const { manager, changed } = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { id } = result.session
    await Bun.sleep(1)
    changed.length = 0
    const patcher = manager as unknown as {
      applyPatch(sessionId: string, patch: Partial<{ status: string; lastActivityAt: string }>): void
    }
    patcher.applyPatch(id, { lastActivityAt: '2026-10-14T02:00:00Z' })
    expect(changed).toEqual([])
    patcher.applyPatch(id, { status: 'working' })
    expect(changed).toEqual([id])
  } finally { manager.shutdown() }
})
