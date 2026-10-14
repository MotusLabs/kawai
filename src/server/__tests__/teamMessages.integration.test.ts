// Messages end to end with fixture agents in one temporary repository with a
// linked worktree (team-message-threads 6.1): task-linked mail and replies
// through different sessions build one thread whose rows carry the task
// revision they were sent under; an uncertain hold and its retry keep both
// events; a human send reaches its target and the reply back reaches the
// human, settled on send; and killing a sender leaves it named in the
// directory.
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
import { reconcileMailbox } from '../team/receipt'
import { resolveTeam } from '../team/teamIdentity'
import { cleanGitEnv } from '../git/gitCommand'
import { resolveParticipant, participantName } from '../../shared/participants'
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

test('task mail threads across sessions, a killed sender stays named, and human mail round-trips', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-message-integration-')))
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
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), 'Build features')
  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  const events = new Map<string, ChatEvent[]>()
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
        // A real CLI emits `init` when a turn starts, never at spawn (and
        // agent-started turns open on it — background tasks D5), so the
        // frame must lead the first streamed turn, not the stream itself.
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
    // The recipient lives in the linked worktree the task targets, so the
    // worktree-scoped group mail has someone to reach.
    const dev = await manager.createAvailableSession({ projectPath: featX, groupId: 'devs' })
    if (!lead.ok || !dev.ok) throw new Error('Fixture sessions failed to create')
    await manager.start(lead.session.id)
    await manager.start(dev.session.id)
    const team = await resolveTeam(repo)
    const leadTasks = taskHandlers(manager.tasks, lead.session.id)
    const task = await leadTasks.task_create({ title: 'Export', direction: 'CSV export', worktree: featX })
    const leadMail = mailboxHandlers(manager.mailbox, lead.session.id)
    const devMail = mailboxHandlers(manager.mailbox, dev.session.id)

    // Task-linked mail and replies through different sessions build a thread.
    const first = await leadMail.send_message({ to_kind: 'group', to_id: 'devs', body: 'Please build this', task_id: task.id })
    await manager.dispatcher.settled()
    await waitFor(() => manager.mailbox.store.get(first.id)?.state === 'delivered', 'first delivery')
    expect(manager.mailbox.store.get(first.id)?.claimedBy).toBe(dev.session.id)
    await leadTasks.task_amend({ task_id: task.id, direction: 'CSV and JSON export' })
    const reply = await devMail.reply({ message_id: first.id, body: 'On it' })
    await waitFor(() => manager.mailbox.store.get(reply.id)?.state === 'delivered', 'reply delivery')
    expect(reply.threadId).toBe(first.threadId)
    expect(reply.inReplyTo).toBe(first.id)
    expect(reply.taskId).toBe(task.id)

    const entries = manager.messages.thread(team.teamId, first.threadId)
    expect(entries.map(entry => entry.message.id)).toEqual([first.id, reply.id])
    // Each row keeps the task revision its own delivery carried, not whatever
    // the task says now (D6): the first was delivered at revision 1 and is not
    // rewritten by the amendment, the reply was delivered after it at 2.
    expect(entries.map(entry => entry.message.taskRevision)).toEqual([1, 2])
    expect(entries.every(entry => entry.events.length > 0)).toBe(true)

    // An uncertain hold and its retry keep both events, and the retry is
    // marked a possible duplicate for the same recipient.
    const held = manager.mailbox.store.enqueue({
      teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: lead.session.id,
      fromGroup: 'leads', originPath: repo, body: 'Receipt evidence missing',
    })
    manager.mailbox.store.claim(held.id, dev.session.id)
    manager.mailbox.store.markPushed(held.id)
    reconcileMailbox(manager.mailbox.store, () => null)
    expect(manager.mailbox.store.get(held.id)).toMatchObject({ state: 'uncertain', claimedBy: dev.session.id })
    expect(manager.mailbox.store.retry(held.id)).toBe(true)
    // The retry is addressed back to the same recipient, marked a possible
    // duplicate so the second push is never mistaken for the first.
    expect(manager.mailbox.store.get(held.id)).toMatchObject({
      state: 'queued', toKind: 'session', toId: dev.session.id, possibleDuplicate: true,
    })
    const kinds = manager.mailbox.store.eventsFor(held.id).map(event => event.kind)
    expect(kinds).toContain('held-uncertain')
    expect(kinds).toContain('retried')

    // A human send reaches its target; the reply back reaches the human and
    // is settled on send, with no claim or push of its own.
    const fromHuman = await manager.mailbox.send({ kind: 'human', team }, {
      to_kind: 'group', to_id: 'devs', body: 'Status?', task_id: task.id,
    })
    await manager.dispatcher.settled()
    await waitFor(() => manager.mailbox.store.get(fromHuman.id)?.state === 'delivered', 'human mail delivery')
    const back = await devMail.reply({ message_id: fromHuman.id, body: 'Still building' })
    expect(back).toMatchObject({ toKind: 'human', toId: null, fromKind: 'agent', state: 'delivered', claimedBy: null })
    const backThread = manager.messages.thread(team.teamId, fromHuman.threadId)
    expect(backThread.map(entry => entry.message.id)).toEqual([fromHuman.id, back.id])
    // Neither agent nor human may start new mail to the human.
    let refused = ''
    try {
      await mailboxHandlers(manager.mailbox, lead.session.id).send_message({ to_kind: 'human', body: 'Hello' })
    } catch (error) { refused = error instanceof Error ? error.message : String(error) }
    expect(refused).toMatch(/Reply to a message they sent instead/)

    // A kill leaves the sender named in the directory, marked gone.
    const senderName = manager.directory.list(team.teamId).find(row => row.sessionId === lead.session.id)
    expect(senderName).toMatchObject({ group: 'leads' })
    expect(senderName?.name).toBeTruthy()
    manager.kill(lead.session.id)
    expect(manager.directory.list(team.teamId).find(row => row.sessionId === lead.session.id)).toMatchObject({
      name: senderName!.name, group: 'leads',
    })
    const label = resolveParticipant(lead.session.id, [], manager.directory.list(team.teamId))
    expect(participantName(label)).toBe(`${senderName!.name} (gone)`)
    expect(git(['worktree', 'list', '--porcelain'], repo).trim().split('\n')).toContain(`worktree ${featX}`)
  } finally {
    manager.shutdown()
    db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30000)
