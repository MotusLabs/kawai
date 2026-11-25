// The production composition checkpoint of bounded-metrics-reads (design
// "Production composition checkpoint"): `team_metrics_drill` reached through
// chats the real ChatSessionManager starts — a Claude chat's kawai-team MCP
// server (its tools/call path, input validation included) and a Codex chat's
// kawai-team dynamic tools against the fake app-server — both built from the
// manager's own teamServices() and MetricsReader over its database. Each
// runtime pages `mail_share` messages at a fixed end (page 1, then page 2 by
// page 1's cursor) and has a cursor of another team refused with no entries.
// Dropping the metrics services from the manager's composition fails both.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { SessionRegistry } from '../SessionRegistry'
import { FAKE_CODEX, Script, THREAD_ID, until } from './codexDriverHarness'

const ENV_KEYS = ['CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'] as const
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const HOUR = 3600_000
const MESSAGES = 5
const LIMIT = 3

type ToolResult = { isError?: boolean; content: Array<{ text: string }> }
type CallHandler = (request: { method: 'tools/call'; params: { name: string; arguments: unknown } }, extra: unknown) => Promise<ToolResult>

let root: string
let repo: string
let home: string
let codexHome: string
let rollout: string
let db: SessionDatabase
let manager: ChatSessionManager | null = null
// A whole second before now, so the drill's end is never later than the manager's clock.
const END = Math.floor((Date.now() - 60_000) / 1000) * 1000
const endIso = new Date(END).toISOString()

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-metrics-drill-manager-')))
  repo = path.join(root, 'repo')
  home = path.join(root, 'home')
  codexHome = path.join(root, 'codex-home')
  rollout = path.join(codexHome, 'sessions', '2026', '10', '20', `rollout-2026-10-20T00-00-00-${THREAD_ID}.jsonl`)
  const git = spawnSync('git', ['init', '--quiet', repo], { env: cleanGitEnv(), encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  fs.mkdirSync(path.dirname(rollout), { recursive: true })
  // A temp home's fake login — the real ~/.codex is never touched.
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ codex: { label: 'Codex', runtime: 'codex' } }))
  db = initDatabase({ path: path.join(root, 'sessions.db') })
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = FAKE_CODEX
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  process.env.FAKE_RUN = '1'
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  resetCodexExecutableCache()
})

afterEach(() => {
  manager?.shutdown()
  manager = null
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  resetCodexExecutableCache()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

type Wire = Array<{ dir: string; raw: string }>

function createManager(wire: Wire, servers?: { value: Options['mcpServers'] | undefined }): ChatSessionManager {
  const wireLogs = { get: () => ({ record: (dir: string, raw: string) => wire.push({ dir, raw }) }), pruneOrphans: async () => {}, delete: async () => {} }
  return new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: () => {}, authCheck: () => true,
    profileCatalogHome: home, availabilityProbe: async () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    wireLogs: wireLogs as unknown as ChatWireLogs,
    ...(servers ? { queryFactory: params => { servers.value = params.options.mcpServers; return fixtureQueryFactory(params) } } : {}),
  })
}

/** The repository's team (its git common dir), with MESSAGES of its mail inside the 7d window ending at END. */
function seedTeamMail(): string {
  const teamId = path.join(repo, '.git')
  const insert = db.db.prepare(`INSERT INTO team_messages (id, team_id, to_kind, to_id, from_session, from_kind, from_group, origin_path,
    priority, tags, thread_id, hop, body, state, claimed_by, deliver_at, created_at, delivered_at, possible_duplicate,
    attach_thread, task_id, park_count) VALUES (?, ?, 'group', 'devs', NULL, 'agent', 'lead', ?, 'normal', '[]', ?, 0, 'b', 'queued', NULL, NULL, ?, NULL, 0, 0, NULL, 0)`)
  for (let i = 0; i < MESSAGES; i++) insert.run(`msg-${i}`, teamId, repo, `msg-${i}`, new Date(END - (i + 1) * HOUR).toISOString())
  return teamId
}

const first = { window: '7d', end: endIso, metric: 'mail_share', list: 'messages', limit: LIMIT }
/** A live cursor as the drill mints it, independently built (field order included). */
const cursor = (team: string, after: string) => Buffer.from(JSON.stringify({
  v: 1, team, src: { kind: 'live', window: '7d', slice: null, end: endIso }, metric: 'mail_share', list: 'messages', limit: LIMIT, after,
})).toString('base64url')
const page = (ids: string[], next: string | null) => ({
  metric: 'mail_share', list: 'messages', total: MESSAGES, entries: ids.map(id => ({ id, threadId: id })), next,
  source: { kind: 'live', window: '7d', end: endIso },
})

test('checkpoint: a Claude chat the manager starts pages mail_share messages at a fixed end and refuses another team\'s cursor', async () => {
  const servers: { value: Options['mcpServers'] | undefined } = { value: undefined }
  manager = createManager([], servers)
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: repo, name: 'Claude dev' })
  if (!created.ok) throw new Error(created.error)
  const team = seedTeamMail()
  expect((await manager.start(created.session.id)).ok).toBe(true)
  await until(() => servers.value !== undefined, 5000)
  const server = servers.value?.['kawai-team'] as { instance: { server: { _requestHandlers: Map<string, CallHandler> } } } | undefined
  if (!server) throw new Error('The chat started without a kawai-team server')
  const call = async (args: unknown) => {
    const result = await server.instance.server._requestHandlers.get('tools/call')!({ method: 'tools/call', params: { name: 'team_metrics_drill', arguments: args } }, {})
    const text = result.content[0]!.text
    return result.isError ? { error: text, value: null } : { error: null, value: JSON.parse(text) }
  }

  const one = await call(first)
  expect(one).toEqual({ error: null, value: page(['msg-0', 'msg-1', 'msg-2'], cursor(team, 'msg-2')) })
  const two = await call({ cursor: one.value.next })
  expect(two).toEqual({ error: null, value: page(['msg-3', 'msg-4'], null) })
  const foreign = await call({ cursor: cursor('/foreign/.git', 'msg-2') })
  expect(foreign.value).toBeNull()
  expect(foreign.error).toContain('team mismatch')
})

test('checkpoint: a Codex chat the manager starts pages mail_share messages at a fixed end and refuses another team\'s cursor', async () => {
  const wire: Wire = []
  manager = createManager(wire)
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: repo, claudeProfileId: 'codex', name: 'Codex dev' })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id
  const team = seedTeamMail()
  const drill = (callId: string, args: unknown) => ({
    threadId: THREAD_ID, turnId: 'ct-1', callId, namespace: 'kawai-team', tool: 'team_metrics_drill', arguments: args,
  })
  // The fake's calls are scripted ahead, so page 2 carries the cursor page 1
  // must mint; the test then requires page 1's next to be exactly that.
  const script = new Script().boot('thread/start', 'gpt-test', rollout)
    .request('account/rateLimits/read', {})
    .turn('ct-1')
    .serverRequest(900, 'item/tool/call', drill('call-1', first))
    .serverRequest(901, 'item/tool/call', drill('call-2', { cursor: cursor(team, 'msg-2') }))
    .serverRequest(902, 'item/tool/call', drill('call-3', { cursor: cursor('/foreign/.git', 'msg-2') }))
    .completed('ct-1')
  process.env.FAKE_TRANSCRIPT = script.write(root)

  expect((await manager.start(id)).ok).toBe(true)
  expect((await manager.send(id, 'go')).ok).toBe(true)
  const replyTo = (n: number) => wire.filter(entry => entry.dir === 'out').map(entry => JSON.parse(entry.raw))
    .find(message => message.id === n && message.method === undefined)
  await until(() => replyTo(902) !== undefined, 10_000)
  const answer = (n: number) => {
    const { success, contentItems } = replyTo(n).result as { success: boolean; contentItems: Array<{ text: string }> }
    return success ? { error: null, value: JSON.parse(contentItems[0]!.text) } : { error: contentItems[0]!.text, value: null }
  }
  expect(answer(900)).toEqual({ error: null, value: page(['msg-0', 'msg-1', 'msg-2'], cursor(team, 'msg-2')) })
  expect(answer(901)).toEqual({ error: null, value: page(['msg-3', 'msg-4'], null) })
  const foreign = answer(902)
  expect(foreign.value).toBeNull()
  expect(foreign.error).toContain('team mismatch')
})
