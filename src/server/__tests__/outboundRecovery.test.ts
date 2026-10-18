// Outbound audit across a restart (execution-safety-recovery 7.2, R19 style;
// spec execution-recovery "An unknown outcome survives restart as unknown"):
// a send is recorded through the manager's registered PreToolUse hook, the
// server stops before its outcome arrives, and a second manager starts over
// the same database file through the production startup path —
// `initDatabase` (schema versions, backups off for a plain path? no: a file
// path takes its startup snapshot) then `new ChatSessionManager(...)` and
// `whenRestored()`. The call reads outcome unknown, the restart constructs no
// agent query and writes no row, and the resumed session's next push is a
// new row with its own outcome while the earlier call stays unknown.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionManager, type ChatQueryFactory } from '../chat/ChatSessionManager'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

let tempDir: string
let dbPath: string
let projectPath: string
const open: Array<{ manager: ChatSessionManager; db: SessionDatabase }> = []
const originalApiKey = process.env.ANTHROPIC_API_KEY
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-outbound-recovery-')))
  dbPath = path.join(tempDir, 'agentboard.db')
  projectPath = path.join(tempDir, 'proj')
  fs.mkdirSync(projectPath)
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  // The resumed conversation's transcript, in an isolated Claude config.
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude')
  fs.mkdirSync(path.join(tempDir, 'claude', 'projects', 'proj'), { recursive: true })
  fs.writeFileSync(path.join(tempDir, 'claude', 'projects', 'proj', 'sdk-recovery.jsonl'), '')
})
afterEach(() => {
  for (const { manager, db } of open.splice(0)) {
    manager.shutdown()
    db.close()
  }
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

type Spawn = { options: Options; push: (message: SDKMessage) => void }

/** One scripted query per spawn: pushed messages stream out; the options (and hooks) are kept. */
function scriptedQueries(spawns: Spawn[]): ChatQueryFactory {
  return ({ options }) => {
    const queue: SDKMessage[] = []
    let wake: (() => void) | null = null
    let ended = false
    const stream = async function* () {
      while (!ended) {
        if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
        while (queue.length > 0) yield queue.shift()!
      }
    }
    const end = () => { ended = true; wake?.() }
    spawns.push({ options, push: message => { queue.push(message); wake?.() } })
    return Object.assign(stream(), { interrupt: () => Promise.resolve(undefined), close: end }) as unknown as Query
  }
}

const settle = async () => { for (let i = 0; i < 6; i++) await Bun.sleep(1) }

/** The production startup path over the shared file: open the database, construct the manager, await its restore. */
async function startServer(spawns: Spawn[]) {
  const db = initDatabase({ path: dbPath })
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: () => {}, isDirectory: () => true,
    profileCatalogHome: tempDir,
    queryFactory: scriptedQueries(spawns),
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
  })
  open.push({ manager, db })
  await manager.whenRestored()
  return { manager, db }
}

/** Stop the server the way it stops: the manager shuts down and the database closes. */
function stopServer(server: { manager: ChatSessionManager; db: SessionDatabase }) {
  const index = open.findIndex(entry => entry.manager === server.manager)
  open.splice(index, 1)
  server.manager.shutdown()
  server.db.close()
}

const hookInput = (event: string, toolUseId: string, command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: event, tool_name: 'Bash', tool_use_id: toolUseId, tool_input: { command }, ...extra,
}) as never

async function runHook(spawn: Spawn, event: 'PreToolUse' | 'PostToolUse', input: never) {
  const hook = spawn.options.hooks?.[event]?.[0]?.hooks[0]
  if (!hook) throw new Error(`${event} audit hook not registered`)
  expect(await hook(input, undefined, { signal: new AbortController().signal })).toEqual({ continue: true })
  await settle()
}

const calls = (db: SessionDatabase) => db.db.prepare('SELECT * FROM outbound_calls ORDER BY created_at, id').all() as Array<Record<string, unknown>>
const outcomes = (db: SessionDatabase) => db.db.prepare('SELECT session_id, tool_use_id, outcome FROM outbound_outcomes ORDER BY rowid').all()

/** The audit view's derived outcome per tool use, joined to the raw rows by call id. */
function states(server: { manager: ChatSessionManager; db: SessionDatabase }): Record<string, string> {
  const toolUse = new Map(calls(server.db).map(row => [row.id as string, row.tool_use_id as string]))
  return Object.fromEntries(server.manager.outboundAudit.page(projectPath, {}).rows.map(row => [toolUse.get(row.id), row.outcome.state]))
}

const SEND = 'curl -d x https://example.internal/hook'

test('a send recorded before a stop reads outcome unknown after the restart; nothing re-runs; the resumed push is a new row', async () => {
  // Before the stop: one send's PreToolUse lands, its outcome never does.
  const firstSpawns: Spawn[] = []
  const first = await startServer(firstSpawns)
  const created = first.manager.createSession({ projectPath, name: 'Sender' })
  if (!created.ok) throw new Error(created.error)
  const sessionId = created.session.id
  expect((await first.manager.send(sessionId, 'push it')).ok).toBe(true)
  firstSpawns[0]!.push({ type: 'system', subtype: 'init', session_id: 'sdk-recovery' } as unknown as SDKMessage)
  await settle()
  await runHook(firstSpawns[0]!, 'PreToolUse', hookInput('PreToolUse', 'tu-before', SEND))
  const recorded = calls(first.db)
  expect(states(first)).toEqual({ 'tu-before': 'pending' })
  expect(recorded).toHaveLength(1)
  expect(outcomes(first.db)).toEqual([])
  stopServer(first)

  // The restart: the same file, the production startup path.
  const secondSpawns: Spawn[] = []
  const second = await startServer(secondSpawns)
  await settle()
  // Nothing re-runs: no agent query is constructed, and no row is written or changed.
  expect(secondSpawns).toHaveLength(0)
  expect(calls(second.db)).toEqual(recorded)
  expect(outcomes(second.db)).toEqual([])
  expect(states(second)).toEqual({ 'tu-before': 'outcome-unknown' })

  // The session resumes its conversation and pushes again: a new row with its own outcome.
  expect(await second.manager.send(sessionId, 'push again')).toEqual({ ok: true })
  expect(secondSpawns).toHaveLength(1)
  expect(secondSpawns[0]!.options.resume).toBe('sdk-recovery')
  secondSpawns[0]!.push({ type: 'system', subtype: 'init', session_id: 'sdk-recovery' } as unknown as SDKMessage)
  await settle()
  await runHook(secondSpawns[0]!, 'PreToolUse', hookInput('PreToolUse', 'tu-after', SEND))
  await runHook(secondSpawns[0]!, 'PostToolUse', hookInput('PostToolUse', 'tu-after', SEND, { tool_response: 'ok' }))

  const after = calls(second.db)
  expect(after.map(row => row.tool_use_id)).toEqual(['tu-before', 'tu-after'])
  expect(after[0]).toEqual(recorded[0]!)
  expect(after[1]!.id).not.toBe(recorded[0]!.id)
  expect(after[1]!.spawn_id).not.toBe(recorded[0]!.spawn_id)
  expect(outcomes(second.db)).toEqual([{ session_id: sessionId, tool_use_id: 'tu-after', outcome: 'completed' }])
  expect(states(second)).toEqual({ 'tu-before': 'outcome-unknown', 'tu-after': 'completed' })
})
