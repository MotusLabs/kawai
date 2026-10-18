// §4.2 (codex-chat-sessions): creation and start gate on the Codex
// executable (version-checked, cached) and the resolved home's login —
// refused without persisting a session, with the spec's actionable errors —
// while a missing Codex install never affects Claude chats.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatQueryFactory } from '../chat/ChatSessionDriver'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

let tempDir: string
let project: string
let home: string
let codexHome: string
let codexExe: string
let db: SessionDatabase
const original: Record<string, string | undefined> = {
  CODEX_HOME: process.env.CODEX_HOME,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  KAWAI_CODEX_PATH: process.env.KAWAI_CODEX_PATH,
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-gates-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  codexHome = path.join(tempDir, 'server-codex-home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  // A fixture executable at the exact baseline: hermetic, never the host's
  // codex; resolution is absolute so the per-test path keys the cache.
  codexExe = path.join(tempDir, 'codex')
  fs.writeFileSync(codexExe, '#!/bin/sh\necho "codex-cli 0.163.0"\n')
  fs.chmodSync(codexExe, 0o755)
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = codexExe
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  writeAuth({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } })
})

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
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

const writeAuth = (json: unknown) => {
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(json))
}

const CODEX_PROFILES = { codex: { label: 'Codex', runtime: 'codex' } }

test('a missing Codex executable refuses creation without persisting a session', async () => {
  writeProfiles(CODEX_PROFILES)
  process.env.KAWAI_CODEX_PATH = path.join(tempDir, 'absent-codex')
  const manager = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    expect(result.ok).toBeFalse()
    if (result.ok) throw new Error('expected the refusal')
    expect(result.error).toContain('KAWAI_CODEX_PATH')
    expect(db.getChatSessions()).toHaveLength(0)
  } finally { manager.shutdown() }
})

test('a Codex executable below the baseline refuses creation naming both versions', async () => {
  writeProfiles(CODEX_PROFILES)
  const old = path.join(tempDir, 'old-codex')
  fs.writeFileSync(old, '#!/bin/sh\necho "codex-cli 0.150.0"\n')
  fs.chmodSync(old, 0o755)
  process.env.KAWAI_CODEX_PATH = old
  const manager = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    expect(result.ok).toBeFalse()
    if (result.ok) throw new Error('expected the refusal')
    expect(result.error).toContain('0.150.0')
    expect(result.error).toContain('0.163.0')
    expect(result.error).toContain(old)
    expect(db.getChatSessions()).toHaveLength(0)
  } finally { manager.shutdown() }
})

test('a Codex home without a login refuses creation naming the home and sign-in', async () => {
  writeProfiles(CODEX_PROFILES)
  fs.rmSync(path.join(codexHome, 'auth.json'))
  const manager = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    expect(result.ok).toBeFalse()
    if (result.ok) throw new Error('expected the refusal')
    expect(result.error).toContain(codexHome)
    expect(result.error).toContain('codex login')
    expect(db.getChatSessions()).toHaveLength(0)
  } finally { manager.shutdown() }
})

test('a logged-in Codex chat is created with its runtime facts', async () => {
  writeProfiles(CODEX_PROFILES)
  const manager = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    if (!result.ok) throw new Error(result.error)
    expect(db.getChatSession(result.session.id)).toMatchObject({ runtime: 'codex', codexHome })
  } finally { manager.shutdown() }
})

test('a Claude chat is unaffected while the Codex executable is missing', async () => {
  process.env.KAWAI_CODEX_PATH = path.join(tempDir, 'absent-codex')
  const manager = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project })
    if (!result.ok) throw new Error(result.error)
    expect(db.getChatSession(result.session.id)?.runtime).toBe('claude')
  } finally { manager.shutdown() }
})

test('losing the login after creation blocks send, attach, and the start guard', async () => {
  writeProfiles(CODEX_PROFILES)
  const manager = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    if (!result.ok) throw new Error(result.error)
    fs.rmSync(path.join(codexHome, 'auth.json'))
    const record = db.getChatSession(result.session.id)
    if (!record) throw new Error('session missing')
    const blocker = manager.startBlockerFor(record)
    expect(blocker).toContain(codexHome)
    expect(blocker).toContain('codex login')
    const sent = await manager.send(result.session.id, 'kawai smoke')
    expect(sent.ok).toBeFalse()
    if (sent.ok) throw new Error('expected the refusal')
    expect(sent.error).toContain('codex login')
    const started = await manager.start(result.session.id)
    expect(started.ok).toBeFalse()
    if (started.ok) throw new Error('expected the refusal')
    expect(started.error).toContain('codex login')
  } finally { manager.shutdown() }
})

test('restoring the login clears the start blocker', async () => {
  writeProfiles(CODEX_PROFILES)
  const manager = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    if (!result.ok) throw new Error(result.error)
    fs.rmSync(path.join(codexHome, 'auth.json'))
    const record = db.getChatSession(result.session.id)
    if (!record) throw new Error('session missing')
    expect(manager.startBlockerFor(record)).toContain('codex login')
    writeAuth({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } })
    expect(manager.startBlockerFor(record)).toBeNull()
  } finally { manager.shutdown() }
})

test('the fixture seam creates a Codex chat without an executable or login', async () => {
  writeProfiles(CODEX_PROFILES)
  process.env.KAWAI_CODEX_PATH = path.join(tempDir, 'absent-codex')
  fs.rmSync(path.join(codexHome, 'auth.json'))
  // The factory is never called here — creation only. The seam treats an
  // injected factory as the development fixture: no Codex child starts, so
  // no real gate applies (the same rule checkExecutable applies to Claude).
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: () => {},
    profileCatalogHome: home, availabilityProbe: async () => {},
    queryFactory: (() => { throw new Error('not reached') }) as unknown as ChatQueryFactory,
  })
  try {
    const result = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex' })
    if (!result.ok) throw new Error(result.error)
    expect(db.getChatSession(result.session.id)).toMatchObject({ runtime: 'codex', codexHome })
  } finally { manager.shutdown() }
})
