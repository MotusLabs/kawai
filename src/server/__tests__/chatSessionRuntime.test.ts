// §3.3 (ruling R1): a chat's runtime facts are fixed at creation — creation
// stamps them, a profile edited to another runtime or another Codex home
// refuses to start without naming a home, a predecessor row (no runtime at
// all) resumes as a Claude chat, and a profile that no longer resolves keeps
// its existing error path instead of inventing a runtime refusal.
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
let codexHome: string
let db: SessionDatabase
const originalCodexHome = process.env.CODEX_HOME
const originalApiKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-chat-runtime-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  codexHome = path.join(tempDir, 'server-codex-home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  // The home resolution reads the server environment; pin it so the expected
  // home is this test's directory, never the host's.
  process.env.CODEX_HOME = codexHome
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
})

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const createManager = () => new ChatSessionManager({
  db, registry: new SessionRegistry(), onEvent: () => {},
  profileCatalogHome: home, availabilityProbe: async () => {},
})

const writeProfiles = (json: unknown) => {
  const file = path.join(home, '.kawai', 'profiles.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(json))
}

test('creation stamps the profile\'s runtime facts', async () => {
  writeProfiles({ codex: { label: 'Codex', runtime: 'codex' } })
  const manager = createManager()
  try {
    const claude = await manager.createAvailableSession({ projectPath: project })
    const codex = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    if (!claude.ok) throw new Error(claude.error)
    if (!codex.ok) throw new Error(codex.error)
    expect(db.getChatSession(claude.session.id)).toMatchObject({ runtime: 'claude', codexHome: null })
    expect(db.getChatSession(codex.session.id)).toMatchObject({ runtime: 'codex', codexHome })
  } finally { manager.shutdown() }
})

test('a profile edited to another runtime refuses to start and says which way', async () => {
  writeProfiles({ gem: { label: 'Gem' } })
  const manager = createManager()
  try {
    const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'gem' })
    if (!created.ok) throw new Error(created.error)
    expect(db.getChatSession(created.session.id)?.runtime).toBe('claude')
    // The profile is redefined as a Codex entry; the chat does not move.
    writeProfiles({ gem: { label: 'Gem', runtime: 'codex' } })
    const refusal = manager.startBlockerFor(db.getChatSession(created.session.id)!)
    expect(refusal).toContain('changed runtime (claude → codex)')
    expect(refusal).toContain('Create a new chat session')
  } finally { manager.shutdown() }
})

test('a profile edited to another Codex home refuses to start without naming either home', async () => {
  writeProfiles({ codex: { label: 'Codex', runtime: 'codex', codexHome: '~/codex-a' } })
  const manager = createManager()
  try {
    const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    if (!created.ok) throw new Error(created.error)
    // The stored home is the resolved absolute path from creation time.
    expect(db.getChatSession(created.session.id)?.codexHome).toBe(path.join(home, 'codex-a'))
    writeProfiles({ codex: { label: 'Codex', runtime: 'codex', codexHome: '~/codex-b' } })
    const refusal = manager.startBlockerFor(db.getChatSession(created.session.id)!)
    expect(refusal).toContain('Codex home changed')
    expect(refusal).not.toContain('codex-a')
    expect(refusal).not.toContain('codex-b')
  } finally { manager.shutdown() }
})

test('a predecessor row with no runtime resumes as a Claude chat', async () => {
  const manager = createManager()
  try {
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId: 'chat-legacy', name: 'Legacy', projectPath: project, sdkSessionId: null,
      status: 'waiting', createdAt: now, lastActivityAt: now,
    })
    const record = db.getChatSession('chat-legacy')!
    expect(record.runtime).toBe('claude')
    expect(manager.startBlockerFor(record)).toBeNull()
  } finally { manager.shutdown() }
})

test('a profile that no longer resolves does not invent a runtime refusal', async () => {
  writeProfiles({ gem: { label: 'Gem', runtime: 'codex' } })
  const manager = createManager()
  try {
    const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'gem' })
    if (!created.ok) throw new Error(created.error)
    writeProfiles({})
    const refusal = manager.startBlockerFor(db.getChatSession(created.session.id)!)
    expect(refusal).toBeNull()
  } finally { manager.shutdown() }
})
