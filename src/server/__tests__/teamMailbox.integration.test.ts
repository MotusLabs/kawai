// Two fixture agents in a temporary repository exercise the real manager,
// mailbox handlers, idle dispatcher, transcript receipts, replies and replay.
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
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatEvent } from '../../shared/chat'

const waitFor = async (check: () => boolean) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error('Mailbox integration timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('two agents deliver group mail once idle, confirm receipt and reply in the same thread', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mail-integration-'))
  const repo = path.join(root, 'repo')
  const git = spawnSync('git', ['init', '--quiet', repo], { env: cleanGitEnv(), encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), 'Build features')
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), 'Coordinate work')
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
        yield { type: 'system', subtype: 'init', session_id: sdkId } as SDKMessage
        yield* fixture
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  try {
    const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    const dev = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
    if (!lead.ok || !dev.ok) throw new Error('Fixture sessions failed to create')
    await manager.start(lead.session.id)
    await manager.send(dev.session.id, 'stream')
    const mail = await mailboxHandlers(manager.mailbox, lead.session.id).send_message({ to_kind: 'group', to_id: 'devs', body: 'Build the feature' })
    await manager.dispatcher.settled()
    expect(manager.mailbox.store.get(mail.id)?.state).toBe('queued')
    await waitFor(() => manager.mailbox.store.get(mail.id)?.state === 'delivered')
    expect(events.get(dev.session.id)?.filter(event => event.type === 'peer_message')).toHaveLength(1)
    expect(manager.getSnapshot(dev.session.id)?.events.filter(event => event.type === 'peer_message')).toHaveLength(1)
    manager.archive(lead.session.id)
    const reply = await mailboxHandlers(manager.mailbox, dev.session.id).reply({ message_id: mail.id, body: 'Feature done' })
    await waitFor(() => manager.mailbox.store.get(reply.id)?.state === 'delivered')
    expect(db.getChatSession(lead.session.id)?.archivedAt).toBeNull()
    expect(reply.threadId).toBe(mail.threadId)
    expect(events.get(lead.session.id)?.some(event => event.type === 'peer_message' && event.messageId === reply.id)).toBe(true)
    const undeliverable = await mailboxHandlers(manager.mailbox, dev.session.id).schedule_message({ to_kind: 'session', to_id: lead.session.id, body: 'Later', delay_seconds: 60 })
    // Keep the direct message queued so kill exercises the permanent-removal path.
    manager.kill(lead.session.id)
    expect(manager.mailbox.store.get(undeliverable.id)?.state).toBe('dead')
  } finally {
    manager.shutdown(); db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
})
