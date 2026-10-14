// Replay of the 2026-10-14 incident (team-mailbox-management 6.2): a dev holds
// parked work after a provider limit and the lead's 90-minute-old follow-up
// waits in the group queue for its worktree. The lead lists the mailbox,
// cancels the follow-up and the parked work, and the dev is archived: nothing
// spawns a replacement and no resume is ever delivered.
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
import { managementHandlers } from '../team/mailboxTools'
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

test('the lead clears a limited dev’s parked work and a stale follow-up, so archiving the dev spawns nothing', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mgmt-integration-')))
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
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), '---\ncanCreateTasks: true\ncanManageMailbox: true\n---\nCoordinate work')
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nmax: 1\n---\nBuild features')
  const events = new Map<string, ChatEvent[]>()
  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
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
        let turnStarted = false
        for await (const message of fixture) {
          if (!turnStarted) {
            turnStarted = true
            yield { type: 'system', subtype: 'init', session_id: sdkId } as SDKMessage
          }
          yield message
        }
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  try {
    const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    const dev = await manager.createAvailableSession({ projectPath: featX, groupId: 'devs' })
    if (!lead.ok || !dev.ok) throw new Error('Fixture sessions failed to create')
    await manager.start(lead.session.id)
    const store = manager.mailbox.store
    const { teamId } = await resolveTeam(repo)
    const leadTasks = taskHandlers(manager.tasks, lead.session.id)
    const task = await leadTasks.task_create({ title: 'Review', direction: 'Review the change', worktree: featX })

    // The dev holds parked work whose resume is scheduled at the limit reset.
    const work = store.enqueue({ teamId, toKind: 'session', toId: dev.session.id, fromSession: lead.session.id, fromGroup: 'leads', originPath: repo, body: 'Review it', taskId: task.id })
    store.claim(work.id, dev.session.id); store.markPushed(work.id); store.markDelivered(work.id)
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString()
    const resume = store.enqueue({ teamId: teamId, toKind: 'session', toId: dev.session.id, fromSession: dev.session.id, fromGroup: 'devs', originPath: featX, body: 'Resume', deliverAt: until, taskId: task.id })
    store.park(work.id, until, resume.id)
    // The lead's stale follow-up waits for the same worktree: capacity holds it back.
    const followUp = await mailboxHandlers(manager.mailbox, lead.session.id).send_message({ to_kind: 'group', to_id: 'devs', body: 'Also check the docs', task_id: task.id })
    await manager.dispatcher.settled()
    expect(store.get(followUp.id)?.state).toBe('queued')

    const tools = managementHandlers(manager.management, lead.session.id)
    const listed = await tools.list_mailbox({}) as { scope: string; messages: Array<{ id: string; state: string; waiting: unknown }> }
    expect(listed.scope).toBe('team')
    expect(listed.messages.map(message => message.id)).toEqual(expect.arrayContaining([followUp.id, work.id, resume.id]))
    expect(listed.messages.find(message => message.id === followUp.id)?.waiting).not.toBeNull()
    await tools.cancel_message({ message_id: followUp.id, reason: 'dev is stuck on a provider limit; do not respawn for this' })
    await tools.cancel_message({ message_id: work.id, reason: 'redoing this elsewhere' })

    // Archiving the dev frees its worktree, but nothing remains to spawn for or resume.
    expect(manager.archive(dev.session.id).ok).toBe(true)
    await manager.dispatcher.settled()
    expect(db.getChatSessions().filter(row => row.spawned)).toHaveLength(0)
    expect(db.getChatSessions()).toHaveLength(2)
    expect(db.getChatSession(dev.session.id)?.archivedAt).toBeTruthy()
    for (const id of [followUp.id, work.id, resume.id]) expect(store.get(id)?.state).toBe('cancelled')
    expect(store.listForTeam(teamId)).toEqual([])
    expect(store.eventsFor(work.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'agent', actorSession: lead.session.id })
    const journal = manager.tasks.store.detail(task.id)!.journal
    expect(journal.filter(entry => entry.author.kind === 'agent' && entry.author.sessionId === lead.session.id).map(entry => entry.text))
      .toEqual([expect.stringContaining(`Cancelled message ${followUp.id}`), expect.stringContaining(`Cancelled message ${work.id}`)])
  } finally {
    manager.shutdown(); db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
})
