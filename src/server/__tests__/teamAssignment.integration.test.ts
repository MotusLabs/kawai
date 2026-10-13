// Task assignment end to end with fixture agents in one temporary repository
// with linked worktrees (task-assignment 4.4, E01/E03): a human
// create-and-assign reaches exactly one idle member through the real
// dispatcher under a stable request key (a replay never duplicates), a
// worktree-targeted group assignment skips idle main-checkout members and
// spawns one member per worktree within caps (never creating a worktree),
// and the parent lists both children.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { resolveTeam } from '../team/teamIdentity'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatEvent } from '../../shared/chat'

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

test('human dispatch reaches one idle member idempotently, and worktree assignments spawn matching members only', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-assignment-integration-')))
  const repo = path.join(root, 'repo')
  const featApi = path.join(root, 'feat-api')
  const featUi = path.join(root, 'feat-ui')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-api', featApi], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-ui', featUi], repo)
  const worktreesBefore = git(['worktree', 'list', '--porcelain'], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 5\n---\nBuild features')
  const dbPath = path.join(root, 'sessions.db')
  const events = new Map<string, ChatEvent[]>()
  const makeManager = () => new ChatSessionManager({
    db: initDatabase({ path: dbPath }), registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
    onEvent: (id, event) => events.set(id, [...(events.get(id) ?? []), event]),
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
  const manager = makeManager()
  try {
    const team = await resolveTeam(repo)
    const human = { kind: 'human' as const, team }
    // Two idle developers in the main checkout (E01's recipients).
    const members: string[] = []
    for (const name of ['dev-a', 'dev-b']) {
      const created = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
      if (!created.ok) throw new Error(created.error)
      members.push(created.session.id)
    }
    await manager.send(members[0]!, 'stream')
    await manager.send(members[1]!, 'stream')
    await waitFor(() => members.every(id => manager.getSnapshot(id)?.status === "waiting"), 'both members idle')

    // E01: create and assign under one request key, then replay both legs
    // (a reconnect resubmit / double click) — one task, one instruction.
    const createInput = { title: 'Export CSV', direction: 'CSV export of reports', requestKey: 'intent-e01' }
    const task = await manager.tasks.create(human, createInput)
    const replayed = await manager.tasks.create(human, createInput)
    expect(replayed.id).toBe(task.id)
    const dispatchInput = {
      taskId: task.id, target: { kind: 'group' as const, id: 'devs' },
      instruction: 'Please implement the CSV export', requestKey: 'intent-e01',
    }
    const first = await manager.assignments.dispatch(human, dispatchInput)
    const second = await manager.assignments.dispatch(human, dispatchInput)
    expect(second.replay).toBe(true)
    expect(second.assignment.id).toBe(first.assignment.id)
    expect(manager.mailbox.store.forTask(task.id)).toHaveLength(1)

    // Exactly one member takes it; the owner is visible after the claim and
    // its peer row carries the task context.
    await waitFor(() => manager.mailbox.store.get(first.message!.id)?.state === 'delivered', 'instruction delivery')
    const instruction = manager.mailbox.store.get(first.message!.id)!
    const owner = instruction.claimedBy!
    expect(members).toContain(owner)
    const assignment = manager.tasks.store.list(team.teamId).find(row => row.id === task.id)!.assignment
    expect(assignment).toMatchObject({ state: 'delivered', claimedBy: owner, role: 'devs' })
    const peers = (events.get(owner) ?? []).filter(event => event.type === 'peer_message')
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({ messageId: instruction.id, senderKind: 'human', senderSession: null, task: { id: task.id } })
    expect(manager.tasks.store.list(team.teamId)).toHaveLength(1)
    await waitFor(() => members.every(id => manager.getSnapshot(id)?.status === "waiting"), 'members idle again')

    // E03: parallel API/UI subtasks in two linked worktrees, both assigned to
    // the same group. No member lives in either worktree, so staffing spawns
    // one per worktree; the idle main-checkout developers take neither.
    const parent = await manager.tasks.create(human, { title: 'Reporting revamp', direction: 'Split work', requestKey: 'intent-parent' })
    const apiTask = await manager.tasks.create(human, {
      title: 'API endpoints', direction: 'Serve report data', parent_id: parent.id, worktree: featApi, requestKey: 'intent-api',
    })
    const uiTask = await manager.tasks.create(human, {
      title: 'Report UI', direction: 'Render report data', parent_id: parent.id, worktree: featUi, requestKey: 'intent-ui',
    })
    const apiDispatch = await manager.assignments.dispatch(human, {
      taskId: apiTask.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build the API in this worktree', requestKey: 'intent-api',
    })
    const uiDispatch = await manager.assignments.dispatch(human, {
      taskId: uiTask.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build the UI in this worktree', requestKey: 'intent-ui',
    })
    const db = () => (manager as unknown as { options: { db: ReturnType<typeof initDatabase> } }).options.db
    await waitFor(() => db().getChatSessions().filter(row => row.spawned).length === 2, 'two spawned members')
    await waitFor(() => manager.mailbox.store.get(apiDispatch.message!.id)?.state === 'delivered', 'API delivery')
    await waitFor(() => manager.mailbox.store.get(uiDispatch.message!.id)?.state === 'delivered', 'UI delivery')
    const spawned = db().getChatSessions().filter(row => row.spawned)
    const apiOwner = manager.mailbox.store.get(apiDispatch.message!.id)!.claimedBy!
    const uiOwner = manager.mailbox.store.get(uiDispatch.message!.id)!.claimedBy!
    expect(apiOwner).not.toBe(uiOwner)
    const apiMember = spawned.find(row => row.sessionId === apiOwner)!
    const uiMember = spawned.find(row => row.sessionId === uiOwner)!
    expect(apiMember).toMatchObject({ projectPath: featApi, groupId: 'devs', taskId: apiTask.id })
    expect(uiMember).toMatchObject({ projectPath: featUi, groupId: 'devs', taskId: uiTask.id })
    // The main-checkout developers took neither message.
    for (const id of members) {
      const taken = (events.get(id) ?? []).filter(event => event.type === 'peer_message')
        .filter(event => [apiDispatch.message!.id, uiDispatch.message!.id].includes(event.messageId))
      expect(taken).toHaveLength(0)
    }
    // The parent lists both children; no worktree was created by dispatch.
    const detail = manager.tasks.store.detail(parent.id)!
    expect(detail.subtasks.map(child => child.title)).toEqual(['API endpoints', 'Report UI'])
    expect(git(['worktree', 'list', '--porcelain'], repo)).toBe(worktreesBefore)
    // The spawned members received their instruction as the first turn under the task header.
    for (const [dispatch, taskId] of [[apiDispatch, apiTask.id], [uiDispatch, uiTask.id]] as const) {
      const peers = (events.get(manager.mailbox.store.get(dispatch.message!.id)!.claimedBy!) ?? [])
        .filter(event => event.type === 'peer_message' && event.messageId === dispatch.message!.id)
      expect(peers).toHaveLength(1)
      expect(peers[0]).toMatchObject({ senderKind: 'human', task: { id: taskId } })
    }
  } finally {
    manager.shutdown()
    ;(manager as unknown as { options: { db: ReturnType<typeof initDatabase> } }).options.db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
