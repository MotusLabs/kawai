// E09 headless (task-revision-publication 6.1): a task assigned to a busy
// fixture developer through the real dispatcher. Save draft writes nothing;
// Publish and notify increments the revision once and queues one notice that
// is delivered only after the developer's turn, carrying the latest revision
// while earlier peer rows keep revision 1; delivery is not acknowledgement
// until the developer acknowledges; a dead-lettered notice is retried with
// no new revision; and a reassigned task starts unacknowledged.
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
import { taskHandlers } from '../team/taskTools'
import { resolveTeam } from '../team/teamIdentity'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatEvent } from '../../shared/chat'

const waitFor = async (check: () => boolean, label: string) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 15_000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** A manager whose fixture agents write every pushed prompt to their transcript (the receipt). */
function fixtureManager(root: string, events: Map<string, ChatEvent[]>) {
  const transcriptDir = path.join(root, 'claude', 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  return new ChatSessionManager({
    db: initDatabase({ path: path.join(root, 'sessions.db') }), registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
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
}

test('E09: draft, publish and notify a busy developer, delayed acknowledgement, retry, and reassignment', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-e09-')))
  const repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 5\n---\nBuild features')
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const priorHold = process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  // A "thinking" turn holds twice this long: busy enough to queue behind, short enough for a test.
  process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = '1200'
  const events = new Map<string, ChatEvent[]>()
  const manager = fixtureManager(root, events)
  try {
    const team = await resolveTeam(repo)
    const human = { kind: 'human' as const, team }
    const store = manager.tasks.store
    const mail = manager.mailbox.store
    const members: string[] = []
    for (let index = 0; index < 2; index++) {
      const created = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
      if (!created.ok) throw new Error(created.error)
      members.push(created.session.id)
      await manager.send(created.session.id, 'stream')
    }
    await waitFor(() => members.every(id => manager.getSnapshot(id)?.status === 'waiting'), 'members idle')

    // Assign the task; the instruction keeps its developer thinking (busy).
    const task = await manager.tasks.create(human, { title: 'Export', direction: 'CSV export', requestKey: 'e09-create' })
    const dispatched = await manager.assignments.dispatch(human, {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Start thinking about the CSV export', requestKey: 'e09-assign',
    })
    const instructionId = dispatched.message!.id
    await waitFor(() => mail.get(instructionId)?.state === 'delivered', 'instruction delivered')
    const owner = mail.get(instructionId)!.claimedBy!
    const other = members.find(id => id !== owner)!
    await waitFor(() => manager.getSnapshot(owner)?.status === 'working', 'developer busy')
    const notices = () => mail.forTask(task.id).filter(message => message.tags.includes('task-revision'))
    const recipient = (revision: number) => store.detail(task.id)!.publications!.find(row => row.revision === revision)!.recipients[0]!

    // Save draft: no mail, no revision, no acknowledgement state.
    await manager.tasks.saveDraft(human, task.id, { direction: 'CSV and JSON export', rationale: 'Customer asked for JSON' })
    expect(store.get(task.id)?.revision).toBe(1)
    expect(mail.forTask(task.id)).toHaveLength(1)
    expect(store.detail(task.id)).toMatchObject({ publications: [], acknowledgements: [] })

    // Publish and notify, then the same command again (a reconnect resend): one revision, one notice.
    const publishInput = { direction: 'CSV and JSON export', rationale: 'Customer asked for JSON', baseRevision: 1, requestKey: 'e09-publish', notify: true, fromDraft: true }
    expect((await manager.tasks.publish(human, task.id, publishInput)).replay).toBe(false)
    expect((await manager.tasks.publish(human, task.id, publishInput)).replay).toBe(true)
    expect(store.revisions(task.id)).toHaveLength(2)
    expect('draft' in store.detail(task.id)!).toBe(false)
    expect(store.humanDetail(task.id)!.draft).toBeNull()
    expect(notices()).toHaveLength(1)
    // The developer is mid-turn: the normal-priority notice waits for the turn to end.
    expect(manager.getSnapshot(owner)?.status).toBe('working')
    expect(notices()[0]).toMatchObject({ state: 'queued', priority: 'normal', toKind: 'session', toId: owner })

    // Delivered after the turn, with the latest revision; the earlier peer row keeps revision 1.
    const noticeId = notices()[0]!.id
    await waitFor(() => mail.get(noticeId)?.state === 'delivered', 'notice delivered')
    expect(mail.get(noticeId)?.taskRevision).toBe(2)
    expect(mail.get(instructionId)?.taskRevision).toBe(1)
    const peers = (events.get(owner) ?? []).filter((event): event is Extract<ChatEvent, { type: 'peer_message' }> => event.type === 'peer_message')
    expect(peers.map(peer => [peer.messageId, peer.task?.revision, peer.revisionNotice?.revision ?? null])).toEqual([
      [instructionId, 1, null],
      [noticeId, 2, 2],
    ])

    // Delivered is not acknowledged — until the developer says so.
    expect(recipient(2)).toMatchObject({ sessionId: owner, noticeState: 'delivered', deliveredRevision: 2, acknowledgedRevision: null })
    await taskHandlers(manager.tasks, owner).task_acknowledge({ task_id: task.id, revision: 2 })
    expect(recipient(2)).toMatchObject({ deliveredRevision: 2, acknowledgedRevision: 2 })

    // A dead-lettered notice is retried: one new notice, no new revision.
    await waitFor(() => manager.getSnapshot(owner)?.status === 'waiting', 'developer idle')
    await manager.send(owner, 'thinking again')
    await waitFor(() => manager.getSnapshot(owner)?.status === 'working', 'developer busy again')
    await manager.tasks.publish(human, task.id, { direction: 'CSV, JSON, and XML', rationale: 'XML too', baseRevision: 2, requestKey: 'e09-publish-3', notify: true })
    const failed = notices().find(message => message.revisionNotice?.revision === 3)!
    mail.deadLetter(failed.id, 'hop-limit')
    expect(recipient(3)).toMatchObject({ noticeState: 'failed', reason: 'hop-limit' })
    await manager.tasks.notify(human, task.id, 3, 'e09-retry')
    await manager.tasks.notify(human, task.id, 3, 'e09-retry')
    expect(notices().filter(message => message.revisionNotice?.revision === 3).map(message => message.state)).toEqual(['dead', 'queued'])
    expect(store.revisions(task.id)).toHaveLength(3)

    // Reassignment: the replacement starts unacknowledged; the old acknowledgement stays in history.
    await waitFor(() => manager.getSnapshot(owner)?.status === 'waiting', 'developer idle before reassignment')
    const reassigned = await manager.assignments.dispatch(human, {
      taskId: task.id, target: { kind: 'session', id: other }, instruction: 'Take over the export', requestKey: 'e09-reassign', handling: 'notify',
    })
    await waitFor(() => mail.get(reassigned.message!.id)?.state === 'delivered', 'reassigned instruction delivered')
    expect(recipient(3)).toMatchObject({ sessionId: other, acknowledgedRevision: null })
    expect(store.detail(task.id)!.acknowledgements).toMatchObject([{ sessionId: owner, revision: 2 }])
  } finally {
    manager.shutdown()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    if (priorHold === undefined) delete process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
    else process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = priorHold
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
