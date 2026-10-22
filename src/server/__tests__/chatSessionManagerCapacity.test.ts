// team_capacity's production wiring (dispatch-worker-choice D6): a Claude chat
// started through the real ChatSessionManager receives a kawai-team MCP server
// whose team_capacity answers for the chat's own team from the manager's
// routing objects. (The Codex surface is covered by the namespace assertion
// in codexTeamPath.integration.test.ts; both build from one teamServices().)
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { SessionRegistry } from '../SessionRegistry'

type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>

let root: string
let repo: string
let db: SessionDatabase
let manager: ChatSessionManager | null = null
const priorConfig = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-capacity-wiring-')))
  repo = path.join(root, 'repo')
  const git = spawnSync('git', ['init', '--quiet', repo], { env: cleanGitEnv(), encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 2\n---\nBuild features')
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), 'Coordinate work')
  db = initDatabase({ path: path.join(root, 'sessions.db') })
})
afterEach(() => {
  manager?.shutdown()
  manager = null
  db.close()
  if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = priorConfig
  fs.rmSync(root, { recursive: true, force: true })
})

test('a started Claude chat\'s kawai-team server carries team_capacity, answering for its team from the manager\'s routing objects', async () => {
  let servers: Options['mcpServers'] | undefined
  manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    queryFactory: params => { servers = params.options.mcpServers; return fixtureQueryFactory(params) },
  })
  await manager.whenRestored()
  const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
  const dev = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
  if (!lead.ok || !dev.ok) throw new Error('Fixture sessions failed to create')
  expect((await manager.start(lead.session.id)).ok).toBe(true)
  const start = Date.now()
  while (!servers && Date.now() - start < 5000) await Bun.sleep(10)
  const server = servers?.['kawai-team'] as { instance: unknown } | undefined
  if (!server) throw new Error('The chat started without a kawai-team server')
  const registered = (server.instance as { _registeredTools: Registered })._registeredTools
  expect(Object.keys(registered)).toContain('team_capacity')

  const reply = await registered.team_capacity!.handler({ group: 'devs' }, {})
  expect(reply.isError).toBeUndefined()
  const answer = JSON.parse(reply.content[0]!.text)
  expect(answer.groups).toEqual([{
    id: 'devs', max: 2, live: 1, strategy: 'first-available',
    workers: [{ model: 'default', provider: 'claude', cap: null, live: 1, cooldownUntil: null }],
  }])
  // The shipped default profile is the claude provider's; no report is held yet.
  const [provider] = answer.providers
  expect([answer.providers.length, provider.id, provider.usage, provider.cooldownUntil, provider.sharesLoginWith]).toEqual([1, 'claude', null, null, []])
  const refused = await registered.team_capacity!.handler({ group: 'nobody' }, {})
  expect(refused.isError).toBe(true)
  expect(refused.content[0]!.text).toBe('Unknown group "nobody" in your team.')
})
