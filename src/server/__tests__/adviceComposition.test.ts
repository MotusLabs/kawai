// Incident advice through the production composition (process-quota-history-
// and-incident-advice D6, tasks 4.3–4.5): a real ChatSessionManager whose
// limit store records a final limit for a started chat; the manager's
// ManagerAdvice freezes the routing facts, its queue publishes an assessment
// within the five-second target, the chat's own kawai-team server answers
// `process_recommendations_list`/`process_recommendation_get` with exactly
// the stored record, and the Metrics snapshot carries the same record (the
// human and the agent read one assessment). No provider is fetched.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ServerMessage } from '../../shared/types'
import type { ChatConnection } from '../chat/ChatConnections'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { MetricsConnections } from '../metrics/metricsConnections'
import { SessionRegistry } from '../SessionRegistry'
import type { LimitEventStore } from '../team/routing/limitEvents'

type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>

let root: string
let repo: string
let db: SessionDatabase
let manager: ChatSessionManager | null = null
const priorConfig = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-advice-wiring-')))
  repo = path.join(root, 'repo')
  const git = spawnSync('git', ['init', '--quiet', repo], { env: cleanGitEnv(), encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 2\n---\nBuild features')
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

const parse = (reply: { content: Array<{ text: string }> }) => JSON.parse(reply.content[0]!.text) as Record<string, unknown>

// @covers: process-recommendations › Recommendations share the existing Metrics and report surfaces › Agent reads advice
test('a final limit of a started chat publishes advice that its kawai-team tools and the Metrics snapshot read identically', async () => {
  let servers: Options['mcpServers'] | undefined
  let fetches = 0
  manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
    providerUsageFetch: (async () => { fetches += 1; throw new Error('no provider pulls') }) as unknown as typeof fetch,
    queryFactory: params => { servers = params.options.mcpServers; return fixtureQueryFactory(params) },
  })
  await manager.whenRestored()
  const dev = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
  if (!dev.ok) throw new Error(dev.error)
  expect((await manager.start(dev.session.id)).ok).toBe(true)
  const started = Date.now()
  while (!servers && Date.now() - started < 5000) await Bun.sleep(10)
  const registered = ((servers!['kawai-team'] as { instance: unknown }).instance as { _registeredTools: Registered })._registeredTools
  expect(Object.keys(registered)).toEqual(expect.arrayContaining(['process_recommendations_list', 'process_recommendation_get']))

  const limits = (manager as unknown as { teamMail: { limits: LimitEventStore } }).teamMail.limits
  const recordedAt = Date.now()
  limits.record({
    profileId: 'default', sessionId: dev.session.id, groupId: 'devs', kind: 'rate_limit', final: true, status: 429,
    message: 'rate limited', resetsAt: new Date(recordedAt + 3600_000).toISOString(), providerId: null, window: 'five_hour',
  })
  let listed: Array<{ id: string; current: unknown }> = []
  while (Date.now() - recordedAt < 5000) {
    listed = parse(await registered.process_recommendations_list!.handler({}, {})).recommendations as typeof listed
    if (listed[0]?.current) break
    await Bun.sleep(50)
  }
  // Published within the five-second target.
  expect(Date.now() - recordedAt).toBeLessThan(5000)
  expect(listed).toHaveLength(1)
  const got = parse(await registered.process_recommendation_get!.handler({ id: listed[0]!.id }, {}))
  expect(got).toMatchObject({ kind: 'quota', sessionId: dev.session.id, groupId: 'devs', versions: 1 })
  // The stored record and the agent's read are the same assessment.
  const team = manager.teams.teamOf(dev.session.id)!.teamId
  expect(got).toEqual(JSON.parse(JSON.stringify(manager.advice.store.get(team, listed[0]!.id))))
  const refused = await registered.process_recommendation_get!.handler({ id: 'rec-elsewhere' }, {})
  expect(refused.isError).toBe(true)

  // The human's Metrics snapshot carries the same record.
  const messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => messages.push(message) } as unknown as ChatConnection
  await new MetricsConnections(manager).handle(connection, { type: 'process-metrics-open', teamPath: repo, window: '7d', slice: null })
  const snapshot = messages.find((message): message is Extract<ServerMessage, { type: 'process-metrics-snapshot' }> => message.type === 'process-metrics-snapshot')
  expect(snapshot && JSON.parse(JSON.stringify(snapshot.recommendations))).toEqual([got])
  // A quota history write for the team re-evaluates its open advice (the manager wires history to advice).
  const retriggered: string[][] = []
  const historyWritten = manager.advice.historyWritten.bind(manager.advice)
  manager.advice.historyWritten = (teams) => { retriggered.push(teams); historyWritten(teams) }
  manager.quota.recordAgentReport(team, { providerId: 'default', baseUrl: null }, 'routed', {
    source: 'push', status: 'allowed', receivedAt: new Date().toISOString(), windows: [{ key: 'five_hour', label: '5h', percentUsed: 30, resetsAt: null }],
  } as never)
  expect(retriggered).toEqual([[team]])
  // Advice fetched nothing (I1, I4).
  expect(fetches).toBe(0)
})
