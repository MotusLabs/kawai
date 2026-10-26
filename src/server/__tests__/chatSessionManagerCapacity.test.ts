// team_capacity's production wiring (dispatch-worker-choice D6): a Claude chat
// started through the real ChatSessionManager receives a kawai-team MCP server
// whose team_capacity answers for the chat's own team from the manager's
// routing objects. (The Codex surface is covered by the namespace assertion
// in codexTeamPath.integration.test.ts; both build from one teamServices().)
// Its sharesLoginWith resolves each worker's launch through the manager's own
// catalog and provider environment (3.3a). The human's worker picker reads the
// same TeamCapacity over `team-task-capacity` (4.3).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ChatConnection } from '../chat/ChatConnections'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { SessionRegistry } from '../SessionRegistry'
import { TaskConnections } from '../team/taskConnections'

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

async function startedTools(options: Partial<ConstructorParameters<typeof ChatSessionManager>[0]> = {}): Promise<Registered> {
  let servers: Options['mcpServers'] | undefined
  manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    queryFactory: params => { servers = params.options.mcpServers; return fixtureQueryFactory(params) },
    ...options,
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
  return (server.instance as { _registeredTools: Registered })._registeredTools
}

// @covers: agent-capacity-view › Agents can read their team's capacity › Lead reads the team's capacity
test('a started Claude chat\'s kawai-team server carries team_capacity, answering for its team from the manager\'s routing objects', async () => {
  const registered = await startedTools()
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

// @covers: agent-capacity-view › Capacity flags providers that share a login › Two Claude profiles on one claude.ai account
// @covers: agent-capacity-view › Capacity flags providers that share a login › Unknown credentials are never assumed shared
test('sharesLoginWith marks two stored-login providers on the manager\'s one config dir, never a credentialed one', async () => {
  fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(root, '.kawai/providers.json'), JSON.stringify({
    first: { label: 'First', models: { 'first-opus': { model: 'opus' } } },
    second: { label: 'Second', models: { 'second-sonnet': { model: 'sonnet' } } },
    keyed: { label: 'Keyed', authTokenEnv: 'EXAMPLE_KEYED_TOKEN', env: { ANTHROPIC_BASE_URL: 'https://keyed.example.internal/api' }, models: { 'keyed-opus': { model: 'opus' } } },
  }))
  fs.writeFileSync(path.join(root, '.kawai/profiles.json'), '{}')
  fs.writeFileSync(path.join(repo, '.kawai/groups/pair.md'), '---\nprofiles: [first-opus, second-sonnet, keyed-opus]\n---\nPair up')
  // The manager's provider environment, with any host credential blanked out.
  const providerEnv = {
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), EXAMPLE_KEYED_TOKEN: ['example-', 'token'].join(''),
    ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
  } as unknown as Record<string, string>
  const registered = await startedTools({ getProviderEnv: () => providerEnv })
  const reply = await registered.team_capacity!.handler({ group: 'pair' }, {})
  expect(reply.isError).toBeUndefined()
  const shares = Object.fromEntries((JSON.parse(reply.content[0]!.text).providers as Array<{ id: string; sharesLoginWith: string[] }>)
    .map(provider => [provider.id, provider.sharesLoginWith]))
  // The leads group's default worker is on the same stored login: sharing is
  // judged over every group, so the filtered answer names it too.
  expect(shares).toEqual({ first: ['default', 'second'], second: ['default', 'first'], keyed: [] })
  expect(reply.content[0]!.text).not.toContain(path.join(root, 'claude'))
})

test('a launch that cannot be resolved marks nothing: the capacity answer stands, with no sharing detected', async () => {
  fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(root, '.kawai/providers.json'), JSON.stringify({
    first: { label: 'First', models: { 'first-opus': { model: 'opus' } } },
    second: { label: 'Second', models: { 'second-sonnet': { model: 'sonnet' } } },
  }))
  fs.writeFileSync(path.join(root, '.kawai/profiles.json'), '{}')
  fs.writeFileSync(path.join(repo, '.kawai/groups/pair.md'), '---\nprofiles: [first-opus, second-sonnet]\n---\nPair up')
  // The same stored login as above would mark first and second; once the
  // chat runs, resolving a worker's launch throws instead.
  let unreadable = false
  const providerEnv = {
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
  } as unknown as Record<string, string>
  const registered = await startedTools({
    getProviderEnv: () => {
      if (unreadable) throw new Error('provider environment unreadable')
      return providerEnv
    },
  })
  const before = JSON.parse((await registered.team_capacity!.handler({ group: 'pair' }, {})).content[0]!.text)
  expect(before.providers.map((provider: { sharesLoginWith: string[] }) => provider.sharesLoginWith)).toEqual([['default', 'second'], ['default', 'first']])
  unreadable = true
  const reply = await registered.team_capacity!.handler({ group: 'pair' }, {})
  expect(reply.isError).toBeUndefined()
  const answer = JSON.parse(reply.content[0]!.text)
  expect(answer.groups[0].workers.map((worker: { model: string }) => worker.model)).toEqual(['first-opus', 'second-sonnet'])
  expect(answer.providers.map((provider: { id: string; sharesLoginWith: string[] }) => [provider.id, provider.sharesLoginWith]))
    .toEqual([['first', []], ['second', []]])
})

test('the worker picker\'s team-task-capacity reads the same TeamCapacity as the tool, with no credential-adjacent string (I5)', async () => {
  fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(root, '.kawai/providers.json'), JSON.stringify({
    keyed: {
      label: 'Keyed', authTokenEnv: 'EXAMPLE_KEYED_TOKEN',
      env: { ANTHROPIC_BASE_URL: 'https://keyed.example.internal/api' },
      models: { 'keyed-opus': { model: 'opus' } },
    },
  }))
  fs.writeFileSync(path.join(root, '.kawai/profiles.json'), '{}')
  fs.writeFileSync(path.join(repo, '.kawai/groups/pair.md'), '---\nprofiles: [default, keyed-opus]\n---\nPair up')
  const providerEnv = {
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), EXAMPLE_KEYED_TOKEN: ['example-', 'token'].join(''),
    ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
  } as unknown as Record<string, string>
  const registered = await startedTools({ getProviderEnv: () => providerEnv })
  const sent: Array<Record<string, unknown>> = []
  const connections = new TaskConnections(manager!)
  const connection = { send: (message: Record<string, unknown>) => sent.push(message) } as unknown as ChatConnection
  await connections.handle(connection, { type: 'team-task-capacity', teamPath: repo, requestId: 'c1', group: 'pair' })
  const reply = sent.at(-1) as { type: string; requestId: string; capacity: { computedAt: string } }
  expect([reply.type, reply.requestId]).toEqual(['team-task-capacity-result', 'c1'])
  // One source: the tool's answer for the same group, computedAt aside.
  const tool = JSON.parse((await registered.team_capacity!.handler({ group: 'pair' }, {})).content[0]!.text)
  const { computedAt: _wire, ...wire } = reply.capacity
  const { computedAt: _tool, ...fromTool } = tool
  expect(wire).toEqual(fromTool)
  expect((wire as { groups: Array<{ workers: Array<{ model: string }> }> }).groups[0]!.workers.map(worker => worker.model)).toEqual(['default', 'keyed-opus'])
  // The provider's label differs from each credential-adjacent fact — its base
  // URL, key variable and value, and the manager's config dir — none of which is sent.
  const text = JSON.stringify(reply)
  expect(text).toContain('Keyed')
  for (const secret of ['keyed.example.internal', 'EXAMPLE_KEYED_TOKEN', 'example-token', path.join(root, 'claude')]) {
    expect(text).not.toContain(secret)
  }
  // The whole team without a group; an unknown group and an unknown team are refused.
  await connections.handle(connection, { type: 'team-task-capacity', teamPath: repo, requestId: 'c2' })
  expect((sent.at(-1) as { capacity: { groups: Array<{ id: string }> } }).capacity.groups.map(group => group.id).sort()).toEqual(['devs', 'leads', 'pair'])
  await connections.handle(connection, { type: 'team-task-capacity', teamPath: repo, requestId: 'c3', group: 'nobody' })
  expect(sent.at(-1)).toEqual({ type: 'team-task-capacity-result', teamPath: repo, requestId: 'c3', error: 'Unknown group "nobody" in your team.' })
  await connections.handle(connection, { type: 'team-task-capacity', teamPath: path.join(root, 'elsewhere'), requestId: 'c4' })
  expect(sent.at(-1)).toMatchObject({ type: 'team-task-capacity-result', requestId: 'c4' })
  expect(String((sent.at(-1) as { error?: string }).error)).toContain('unknown-team')
})
