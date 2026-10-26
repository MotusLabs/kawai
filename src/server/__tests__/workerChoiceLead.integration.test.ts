// dispatch-worker-choice 5.1 on a test team, through the production
// composition: a lead chat's own kawai-team server answers `team_capacity`,
// the lead's `send_message` names a worker of another provider on group task
// mail, and the real dispatcher, router, and staffing spawn the member on that
// provider's model in the task's worktree. With that provider cooling, the
// next such mail waits — never routed to the group's other provider — and the
// mailbox snapshot's waiting reason names the worker choice and its retry time.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatConnections } from '../chat/ChatConnections'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { cleanGitEnv } from '../git/gitCommand'
import { resolveTeam } from '../team/teamIdentity'
import type { ServerMessage } from '../../shared/types'

type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>

const waitFor = async (check: () => boolean, label: string) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

// @covers: team-waiting-reasons › Waiting reasons name the worker choice › Held by a cooling choice
// @covers: team-worktree-staffing › Spawns honor the worker choice › Spawn on the chosen provider
// @covers: agent-capacity-view › Agents can read their team's capacity › Lead reads the team's capacity
test('a lead reads team_capacity, sends group task mail naming another provider, a member spawns on it in the task worktree, and a cooling choice waits with its reason', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-worker-lead-')))
  const repo = path.join(root, 'repo')
  const feature = path.join(root, 'feature')
  const second = path.join(root, 'second')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  git(['worktree', 'add', '-q', '-b', 'second', second], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  // The shipped catalog (an empty home): sonnet is Claude, glm-flash is Z.AI.
  // The group prefers Claude, so only the choice can put the spawn on Z.AI.
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nprofiles: [sonnet, glm-flash]\nmax: 5\n---\nBuild features')
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), 'Coordinate work')
  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  const servers = new Map<string, Options['mcpServers']>()
  // The mailbox publication bootstrap wires: every change and every reasons change re-sends the snapshot.
  let connections: ChatConnections | null = null
  const manager = new ChatSessionManager({
    onMailboxChange: (teamId, message) => connections?.publishMailbox(teamId, message),
    onWaitingReasonsChange: teamId => connections?.publishMailbox(teamId),
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    queryFactory: params => {
      servers.set(params.options.cwd ?? '', params.options.mcpServers)
      const sdkId = params.options.resume ?? crypto.randomUUID()
      const file = path.join(transcriptDir, `${sdkId}.jsonl`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      // Delivery is confirmed by the recipient's transcript row carrying the id.
      const prompt = (async function* () {
        for await (const message of params.prompt) {
          fs.appendFileSync(file, JSON.stringify({ ...message, uuid: crypto.randomUUID() }) + '\n')
          yield message
        }
      })()
      const fixture = fixtureQueryFactory({ ...params, prompt })
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: sdkId } as SDKMessage
        yield* fixture
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  const pushed: ServerMessage[] = []
  connections = new ChatConnections(manager)
  const connection = { send: (message: ServerMessage) => { pushed.push(message) } }
  try {
    await manager.whenRestored()
    const team = await resolveTeam(repo)
    const first = await manager.tasks.create({ kind: 'human', team }, { title: 'Export CSV', direction: 'CSV export', worktree: feature })
    const later = await manager.tasks.create({ kind: 'human', team }, { title: 'Import CSV', direction: 'CSV import', worktree: second })

    // The lead chat, started through the manager: its own kawai-team server.
    const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    if (!lead.ok) throw new Error(lead.error)
    expect((await manager.start(lead.session.id)).ok).toBe(true)
    await waitFor(() => servers.has(repo), 'the lead\'s agent start')
    const tools = ((servers.get(repo)?.['kawai-team'] as { instance: unknown }).instance as { _registeredTools: Registered })._registeredTools
    const call = async (name: string, input: unknown) => {
      const reply = await tools[name]!.handler(input, {})
      if (reply.isError) throw new Error(`${name}: ${reply.content[0]!.text}`)
      return reply.content[0]!.text
    }

    // 1. The lead reads the team's capacity: devs on Claude first, then Z.AI.
    const capacity = JSON.parse(await call('team_capacity', { group: 'devs' }))
    expect(capacity.groups[0].workers.map((worker: { model: string; provider: string; cooldownUntil: string | null }) =>
      [worker.model, worker.provider, worker.cooldownUntil])).toEqual([['sonnet', 'claude', null], ['glm-flash', 'zai', null]])

    // 2. It sends group task mail naming the other provider.
    await call('send_message', { to_kind: 'group', to_id: 'devs', task_id: first.id, worker: 'zai', body: 'Build the export' })
    const [instruction] = manager.mailbox.store.forTask(first.id)
    expect([instruction!.fromSession, instruction!.toKind, instruction!.toId, instruction!.workerChoice]).toEqual([lead.session.id, 'group', 'devs', 'zai'])

    // 3. A member spawns on that provider's model in the task's worktree.
    await waitFor(() => manager.mailbox.store.get(instruction!.id)?.state === 'delivered', 'the first instruction delivered')
    const spawned = db.getChatSessions().filter(row => row.spawned)
    expect(spawned.map(row => [row.claudeProfileId, row.projectPath, row.groupId, row.taskId])).toEqual([['glm-flash', feature, 'devs', first.id]])
    expect(manager.mailbox.store.get(instruction!.id)!.claimedBy).toBe(spawned[0]!.sessionId)

    // 4. Z.AI cools (a provider-scoped final limit): the next choice of it waits.
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString()
    manager.limitEvents.record({
      profileId: 'glm-flash', sessionId: spawned[0]!.sessionId, groupId: 'devs', kind: 'rate_limit', final: true,
      status: 429, message: 'quota', resetsAt, providerId: 'zai', window: null,
    })
    const cooled = JSON.parse(await call('team_capacity', { group: 'devs' }))
    expect(cooled.providers.find((provider: { id: string }) => provider.id === 'zai').cooldownUntil).toBe(resetsAt)
    await connections!.handle(connection, { type: 'team-mailbox-open', teamPath: repo })
    await call('send_message', { to_kind: 'group', to_id: 'devs', task_id: later.id, worker: 'zai', body: 'Build the import' })
    const [held] = manager.mailbox.store.forTask(later.id)
    type Snapshot = Extract<ServerMessage, { type: 'team-mailbox-snapshot' }>
    const reasonOf = (snapshot: Snapshot) => {
      const reason = snapshot.waiting?.[held!.id]
      return reason ? [reason.blocker, ...reason.others].find(constraint => constraint.kind === 'worker-choice') : undefined
    }
    await waitFor(() => pushed.some(message => message.type === 'team-mailbox-snapshot' && reasonOf(message) !== undefined), 'the worker-choice waiting reason')
    const snapshot = pushed.filter((message): message is Snapshot => message.type === 'team-mailbox-snapshot' && reasonOf(message) !== undefined).at(-1)!
    // The Mailbox row carries the choice, and its reason names it with the retry time.
    expect(snapshot.messages.find(message => message.id === held!.id)).toMatchObject({ state: 'queued', workerChoice: 'zai' })
    const constraint = reasonOf(snapshot)!
    expect([constraint.detail, constraint.retryAt]).toEqual(['zai', resetsAt])
    expect(snapshot.waiting![held!.id]!.blocker.kind).toBe('worker-choice')
    // Never routed elsewhere: no Claude member was spawned for it.
    expect(db.getChatSessions().filter(row => row.spawned).map(row => row.claudeProfileId)).toEqual(['glm-flash'])
  } finally {
    manager.shutdown()
    db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
