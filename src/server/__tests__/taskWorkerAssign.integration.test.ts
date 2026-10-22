// The human's assign with a worker, end to end through the production
// composition (dispatch-worker-choice 4.1/4.2, CP2): the chat connection's
// `team-task-preview` and `team-task-assign` reach TaskConnections and the
// manager's own AssignmentService; the assignment row and its instruction
// mail carry the normalized choice; the real dispatcher, router, and
// staffing spawn the member on the chosen provider's model in the task's
// worktree — never on the group's first worker; and the same request key
// with another worker is refused naming it, while a normalized-equal one replays.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatConnections } from '../chat/ChatConnections'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { cleanGitEnv } from '../git/gitCommand'
import { resolveTeam } from '../team/teamIdentity'
import { WORKER_GROUP_TARGET_ONLY } from '../team/workerChoiceCheck'
import type { ClientMessage, ServerMessage } from '../../shared/types'

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

test('a human assign naming a worker spawns on that provider in the task worktree; another worker under the key is refused', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-worker-assign-')))
  const repo = path.join(root, 'repo')
  const feature = path.join(root, 'feature')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  // The shipped catalog (an empty home): sonnet is Claude, glm-flash is Z.AI.
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nprofiles: [sonnet, glm-flash]\nmax: 5\n---\nBuild features')
  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
    queryFactory: params => {
      const sdkId = params.options.resume ?? crypto.randomUUID()
      const file = path.join(transcriptDir, `${sdkId}.jsonl`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
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
  const messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => { messages.push(message) } }
  const connections = new ChatConnections(manager)
  const send = (message: ClientMessage) => connections.handle(connection, message)
  const answer = <T extends ServerMessage['type']>(type: T, requestId: string) =>
    messages.find(message => message.type === type && (message as { requestId?: string }).requestId === requestId) as Extract<ServerMessage, { type: T }>
  try {
    const team = await resolveTeam(repo)
    const task = await manager.tasks.create({ kind: 'human', team }, { title: 'Export CSV', direction: 'CSV export', worktree: feature })
    // A main-checkout member makes the repository a known team; it never takes worktree mail.
    const created = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
    if (!created.ok) throw new Error(created.error)

    // The preview through the composition's own recipient view and eligibility
    // check (I1): an idle Claude member in the worktree is listed without a
    // choice, and dropped by a Z.AI choice, which spawns on glm-flash instead.
    const sonnet = await manager.createAvailableSession({ projectPath: feature, groupId: 'devs', claudeProfileId: 'sonnet' })
    if (!sonnet.ok) throw new Error(sonnet.error)
    await manager.send(sonnet.session.id, 'stream')
    await waitFor(() => manager.getSnapshot(sonnet.session.id)?.status === 'waiting', 'the worktree member idle')
    const target = { kind: 'group' as const, id: 'devs' }
    await send({ type: 'team-task-preview', teamPath: repo, requestId: 'p0', taskId: task.id, target })
    expect(answer('team-task-preview-result', 'p0').error).toBeUndefined()
    expect(answer('team-task-preview-result', 'p0').preview).toMatchObject({ profile: 'sonnet', idleMembers: [sonnet.session.id] })
    await send({ type: 'team-task-preview', teamPath: repo, requestId: 'p1', taskId: task.id, target, worker: 'zai' })
    expect(answer('team-task-preview-result', 'p1').preview).toMatchObject({
      profile: 'glm-flash', idleMembers: [], worker: { selector: 'zai', profiles: ['glm-flash'] },
    })
    // The worktree member leaves, so the choice's spawn can take the writer slot.
    expect(manager.archive(sonnet.session.id).ok).toBe(true)

    // A session target naming a worker is refused with nothing written (I3).
    const assign = (requestId: string, extra: Partial<Extract<ClientMessage, { type: 'team-task-assign' }>>) => send({
      type: 'team-task-assign', teamPath: repo, requestId, taskId: task.id, target, instruction: 'Build the export', requestKey: 'assign-1', ...extra,
    })
    await assign('s1', { target: { kind: 'session', id: created.session.id }, worker: 'zai' })
    expect(answer('team-task-result', 's1').error).toBe(WORKER_GROUP_TARGET_ONLY)
    expect(manager.mailbox.store.forTask(task.id)).toEqual([])
    expect(manager.tasks.store.assignmentsOf(task.id)).toEqual([])

    // The assign: the row and its instruction mail carry the normalized choice.
    await assign('a1', { worker: 'glm-flash' })
    const assigned = answer('team-task-result', 'a1')
    expect(assigned.error).toBeUndefined()
    expect(assigned.assignment).toMatchObject({ targetKind: 'group', targetId: 'devs', workerChoice: 'zai/glm-flash' })
    const instruction = manager.mailbox.store.forTask(task.id)
    expect(instruction.map(message => [message.toKind, message.toId, message.workerChoice])).toEqual([['group', 'devs', 'zai/glm-flash']])

    // Routing: staffing spawns one member, on the chosen provider's model, in the task's worktree.
    await waitFor(() => manager.mailbox.store.get(instruction[0]!.id)?.state === 'delivered', 'instruction delivery')
    const spawned = db.getChatSessions().filter(row => row.spawned)
    expect(spawned.map(row => [row.claudeProfileId, row.projectPath, row.groupId])).toEqual([['glm-flash', feature, 'devs']])
    expect(manager.mailbox.store.get(instruction[0]!.id)!.claimedBy).toBe(spawned[0]!.sessionId)

    // The same key: another worker is refused naming it; a normalized-equal one replays (I2).
    await assign('a2', { worker: 'claude' })
    expect(answer('team-task-result', 'a2').error).toBe('Request key already used with a different worker')
    await assign('a3', { worker: 'zai/glm-flash' })
    expect(answer('team-task-result', 'a3').error).toBeUndefined()
    expect(answer('team-task-result', 'a3').assignment!.id).toBe(assigned.assignment!.id)
    expect(manager.mailbox.store.forTask(task.id)).toHaveLength(1)
    expect(manager.tasks.store.assignmentsOf(task.id)).toHaveLength(1)
  } finally {
    manager.shutdown()
    db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
