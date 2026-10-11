// Team tasks end to end with fixture agents in one temporary repository with
// a linked worktree: a permitted lead creates and amends a task, sends
// worktree-targeted group mail, a member is spawned there within caps with
// the group's settings and receives the current task context as its first
// turn (once), and its note and reply come back under the same task. The
// task survives killing its creator and a server restart.
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
import { mailboxHandlers } from '../team/mailboxTools'
import { taskHandlers } from '../team/taskTools'
import { resolveTeam } from '../team/teamIdentity'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatEvent } from '../../shared/chat'

const waitFor = async (check: () => boolean, label: string) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

test('a lead’s worktree task spawns a member there, delivers current context once, and the task outlives its creator', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-integration-')))
  const repo = path.join(root, 'repo')
  const featX = path.join(root, 'feat-x')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), '---\ncanCreateTasks: true\n---\nCoordinate work')
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 1\nprofile: glm\napproval: auto\n---\nBuild features')
  fs.mkdirSync(path.join(root, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(root, '.kawai/profiles.json'), JSON.stringify({ glm: { label: 'GLM' } }))
  const worktreesBefore = git(['worktree', 'list', '--porcelain'], repo)
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
  let manager = makeManager()
  try {
    const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    if (!lead.ok) throw new Error(lead.error)
    await manager.start(lead.session.id)
    const leadTasks = taskHandlers(manager.tasks, lead.session.id)
    const task = await leadTasks.task_create({ title: 'Export', direction: 'CSV export', worktree: featX })
    await leadTasks.task_amend({ task_id: task.id, direction: 'CSV and JSON export', acceptance: 'Both formats download' })
    const mail = await mailboxHandlers(manager.mailbox, lead.session.id).send_message({ to_kind: 'group', to_id: 'devs', body: 'Please build this', task_id: task.id })

    const db = () => (manager as unknown as { options: { db: ReturnType<typeof initDatabase> } }).options.db
    await waitFor(() => db().getChatSessions().some(row => row.spawned), 'a spawned member')
    const spawned = db().getChatSessions().find(row => row.spawned)!
    expect(spawned).toMatchObject({ projectPath: featX, groupId: 'devs', claudeProfileId: 'glm', approvalPolicy: 'auto', taskId: task.id, spawned: true })
    await waitFor(() => manager.mailbox.store.get(mail.id)?.state === 'delivered', 'first-turn delivery')
    expect(manager.mailbox.store.get(mail.id)?.claimedBy).toBe(spawned.sessionId)
    manager.dispatcher.notify()
    await manager.dispatcher.settled()
    const peers = (events.get(spawned.sessionId) ?? []).filter(event => event.type === 'peer_message')
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({ messageId: mail.id, task: { id: task.id, revision: 2, direction: 'CSV and JSON export', acceptance: 'Both formats download', worktree: featX } })
    // Only one spawned member for the worktree and the group (max 1).
    expect(db().getChatSessions().filter(row => row.spawned)).toHaveLength(1)

    const devTasks = taskHandlers(manager.tasks, spawned.sessionId)
    await devTasks.task_note({ task_id: task.id, text: 'JSON uses the report schema' })
    const reply = await mailboxHandlers(manager.mailbox, spawned.sessionId).reply({ message_id: mail.id, body: 'Done' })
    expect(reply.taskId).toBe(task.id)
    await waitFor(() => manager.mailbox.store.get(reply.id)?.state === 'delivered', 'reply delivery')
    const replyEvent = events.get(lead.session.id)?.find(event => event.type === 'peer_message' && event.messageId === reply.id)
    expect(replyEvent).toMatchObject({ task: { id: task.id, journal: [{ author: spawned.sessionId, text: 'JSON uses the report schema' }] } })

    manager.kill(lead.session.id)
    manager.shutdown()
    db().close()
    manager = makeManager()
    const team = await resolveTeam(repo)
    const human = { kind: 'human' as const, team }
    const detail = await manager.tasks.get(human, task.id)
    expect(detail.task).toMatchObject({ creator: { kind: 'agent', sessionId: lead.session.id }, revision: 2 })
    expect(detail.revisions.map(revision => revision.direction)).toEqual(['CSV export', 'CSV and JSON export'])
    expect(detail.journal.map(entry => entry.text)).toEqual(['JSON uses the report schema'])
    expect(detail.messages.map(row => row.id)).toEqual([mail.id, reply.id])
    expect((await manager.tasks.setStatus(human, task.id, 'done')).status).toBe('done')
    expect(git(['worktree', 'list', '--porcelain'], repo)).toBe(worktreesBefore)
  } finally {
    manager.shutdown()
    ;(manager as unknown as { options: { db: ReturnType<typeof initDatabase> } }).options.db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
})
