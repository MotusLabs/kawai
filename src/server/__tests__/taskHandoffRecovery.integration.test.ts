// owner-publication-handoff CP3 (task 7.2) through the production
// composition: a database left by an earlier process holds DF3's fixture (an
// `open` handoff whose task moved past its base) beside a healthy `open`
// handoff, a `published` wakeup committed and queued before the crash,
// DF5o with an archived requester and DF2 with a context-exhausted one in
// the worktree-scoped `leads` group. Booting ChatSessionManager (which
// starts teamMail after the chat records are restored) sweeps before the
// first dispatch: DF3 reads stale with one wakeup delivered, the healthy one
// stays open with no mail, the queued wakeup is delivered once by its
// original message id to its original recipient, DF5o reads published with
// one group wakeup to a live member and none to the archived session, and
// DF2 reads closed with its group wakeup delivered despite the task-close
// filtering, no task assignment and the requester left exhausted. A third
// boot sends nothing more.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase, type ChatSessionRecord } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { cleanGitEnv } from '../git/gitCommand'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { HANDOFF_WAKEUP_TAG } from '../team/taskHandoffWakeups'
import { resolveTeam } from '../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../shared/team'
import { preparedKey } from '../../shared/taskHandoffs'

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
}

// @covers: task-publication-handoffs › Handoffs survive restart and reconcile once › A queued message is sent once after restart
// @covers: task-publication-handoffs › Each disposition wakes the next actor once › Closure reaches the requester's group
// @covers: task-publication-handoffs › Handoffs survive restart and reconcile once › A crash after publication
test('CP3: a boot sweeps before dispatch — DF3 stale with one wakeup, the healthy handoff untouched, the queued wakeup sent once by its id, DF5o and DF2 to a live group member — and a later boot sends nothing', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-recovery-')))
  const repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), '---\ncanCreateTasks: true\n---\nCoordinate work')
  const file = path.join(root, 'sessions.db')
  const boot = () => {
    const db = initDatabase({ path: file })
    const manager = new ChatSessionManager({
      db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root, onEvent: () => {},
      providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
      queryFactory: params => {
        const sdkId = params.options.resume ?? crypto.randomUUID()
        const transcript = path.join(transcriptDir, `${sdkId}.jsonl`)
        if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '')
        const prompt = (async function* () {
          for await (const message of params.prompt) {
            fs.appendFileSync(transcript, JSON.stringify({ ...message, uuid: crypto.randomUUID() }) + '\n')
            yield message
          }
        })()
        const fixture = fixtureQueryFactory({ ...params, prompt } as Parameters<typeof fixtureQueryFactory>[0])
        const stream = (async function* () {
          yield { type: 'system', subtype: 'init', session_id: sdkId } as SDKMessage
          yield* fixture
        })()
        return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
      },
    })
    return { db, manager, close: () => { manager.shutdown(); db.close() } }
  }
  const sessions: Record<string, ChatSessionRecord> = {}
  try {
    // Process 1: the team's chat sessions exist (records only).
    const first = boot()
    await first.manager.whenRestored()
    for (const name of ['lead', 'lead2', 'archived', 'exhausted']) {
      const created = await first.manager.createAvailableSession({ projectPath: repo, groupId: 'leads', name })
      if (!created.ok) throw new Error(created.error)
      sessions[name] = first.db.getChatSession(created.session.id)!
    }
    first.close()

    // The state an earlier process left: seeded through the stores, without a dispatcher.
    const seedDb = initDatabase({ path: file })
    const team = await resolveTeam(repo)
    const mail = new MailboxStore(seedDb.db)
    const tasks = new TaskService(new TaskStore(seedDb.db, mail, new AssignmentStore(seedDb.db, mail)), { getSession: id => seedDb.getChatSession(id) ?? undefined, homeDir: root })
    const sql = (text: string, ...params: Array<string | number | null>) => seedDb.db.prepare(text).run(...params)
    const handoffOn = (title: string, requester: string, base = 1, closed = false, revisions = 1) => {
      const task = tasks.store.create({ teamId: team.teamId, title, direction: 'v1', creator: SYSTEM_ACTOR })
      for (let revision = 2; revision <= revisions; revision++) sql("INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at) VALUES (?, ?, 'older build', 'human', 'now')", task.id, revision)
      sql('UPDATE team_tasks SET revision = ?, status = ? WHERE id = ?', revisions, closed ? 'cancelled' : 'open', task.id)
      const handoff = tasks.store.atomically(() => tasks.handoffs.store.insert({
        teamId: team.teamId, taskId: task.id, baseRevision: base, baseContractHash: null, direction: `Prepared ${title}`, acceptance: null, contract: null,
        rationale: 'why', notify: false, baseCommit: null, evidenceRefs: [], requesterSession: sessions[requester]!.sessionId, requesterGroup: 'leads', requestKey: 'k1',
      }, '2026-11-22T00:00:00.000Z'))
      return { task, handoff }
    }
    const df3 = handoffOn('DF3', 'lead', 1, false, 3)
    const healthy = handoffOn('healthy', 'lead')
    const queued = handoffOn('queued', 'lead')
    await tasks.handoffs.publish({ kind: 'human', team }, queued.task.id, queued.handoff.id, [])
    const queuedWake = seedDb.db.prepare('SELECT message_id FROM team_task_handoff_wakeups WHERE handoff_id = ?').get(queued.handoff.id) as { message_id: string }
    expect(mail.get(queuedWake.message_id)).toMatchObject({ state: 'queued', toKind: 'session', toId: sessions.lead!.sessionId })
    const df5o = handoffOn('DF5o', 'archived', 1, true, 3)
    sql("UPDATE team_task_revisions SET handoff_id = ?, request_key = 'edited' WHERE task_id = ? AND revision = 2", df5o.handoff.id, df5o.task.id)
    sql('UPDATE team_task_revisions SET request_key = ? WHERE task_id = ? AND revision = 3', preparedKey(df5o.handoff.id), df5o.task.id)
    const df2 = handoffOn('DF2', 'exhausted', 1, true)
    seedDb.updateChatSession(sessions.archived!.sessionId, { archivedAt: '2026-11-22T00:00:00.000Z' })
    seedDb.updateChatSession(sessions.exhausted!.sessionId, { contextExhausted: { at: '2026-11-22T00:00:00.000Z', reason: 'prompt_too_long' } })
    seedDb.close()

    // Process 2: the boot.
    const second = boot()
    let messageCount = 0
    try {
      await second.manager.whenRestored()
      const store = second.manager.mailbox.store
      const handoff = (id: string) => second.manager.tasks.handoffs.store.get(id)!
      const wakeups = (id: string) => second.db.db.prepare('SELECT transition, message_id FROM team_task_handoff_wakeups WHERE handoff_id = ? ORDER BY rowid').all(id) as Array<{ transition: string; message_id: string }>
      const mailAbout = (id: string) => (second.db.db.prepare('SELECT id FROM team_messages WHERE tags LIKE ? AND body LIKE ?').all(`%${HANDOFF_WAKEUP_TAG}%`, `%${id}%`) as Array<{ id: string }>).map(row => store.get(row.id)!)
      const delivered = (id: string) => store.get(id)?.state === 'delivered'

      // DF3: stale naming revision 3, one wakeup, delivered to the live requester.
      expect(handoff(df3.handoff.id)).toMatchObject({ state: 'stale', stateReason: 'revision 3 was published' })
      const [staleWake] = wakeups(df3.handoff.id)
      expect(wakeups(df3.handoff.id)).toEqual([{ transition: 'stale', message_id: staleWake!.message_id }])
      // The healthy handoff (H29): unchanged, no mail.
      expect(handoff(healthy.handoff.id)).toEqual(healthy.handoff)
      expect([wakeups(healthy.handoff.id), mailAbout(healthy.handoff.id)]).toEqual([[], []])
      // The queued wakeup: once, by its original id, to its original recipient.
      expect(mailAbout(queued.handoff.id).map(message => message.id)).toEqual([queuedWake.message_id])
      // DF5o: published with the associated revision; the orphan kept; group mail, none to the archived session.
      expect(handoff(df5o.handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
      expect(second.db.db.prepare('SELECT request_key, handoff_id FROM team_task_revisions WHERE task_id = ? AND revision = 3').get(df5o.task.id))
        .toEqual({ request_key: preparedKey(df5o.handoff.id), handoff_id: null })
      expect(mailAbout(df5o.handoff.id).map(message => [message.toKind, message.toId, message.taskId ?? null])).toEqual([['group', 'leads', null]])
      // DF2: closed; group mail, no task attachment.
      expect(handoff(df2.handoff.id).state).toBe('closed')
      expect(mailAbout(df2.handoff.id).map(message => [message.toKind, message.toId, message.taskId ?? null])).toEqual([['group', 'leads', null]])

      const live = [sessions.lead!.sessionId, sessions.lead2!.sessionId]
      const ids = [staleWake!.message_id, queuedWake.message_id, mailAbout(df5o.handoff.id)[0]!.id, mailAbout(df2.handoff.id)[0]!.id]
      await waitFor(() => ids.every(delivered), 'every wakeup delivered')
      expect(store.get(staleWake!.message_id)!.claimedBy).toBe(sessions.lead!.sessionId)
      expect(store.get(queuedWake.message_id)).toMatchObject({ toKind: 'session', toId: sessions.lead!.sessionId, claimedBy: sessions.lead!.sessionId })
      for (const id of ids.slice(2)) expect(live).toContain(store.get(id)!.claimedBy!)
      // No assignment was created, and the exhausted requester was not restored.
      expect(second.db.db.prepare('SELECT COUNT(*) AS n FROM team_task_assignments WHERE task_id IN (?, ?)').get(df2.task.id, df5o.task.id)).toEqual({ n: 0 })
      expect(second.db.getChatSession(sessions.exhausted!.sessionId)!.contextExhausted).toMatchObject({ reason: 'prompt_too_long' })
      expect(second.db.getChatSession(sessions.archived!.sessionId)!.archivedAt).toBeTruthy()
      messageCount = (second.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n
    } finally {
      second.close()
    }

    // Process 3: a later boot writes and sends nothing more.
    const third = boot()
    try {
      await third.manager.whenRestored()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect((third.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n).toBe(messageCount)
      expect((third.db.db.prepare('SELECT COUNT(*) AS n FROM team_task_handoff_wakeups').get() as { n: number }).n).toBe(4)
    } finally {
      third.close()
    }
  } finally {
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
