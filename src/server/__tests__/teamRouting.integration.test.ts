// Profile routing end to end with the real manager, mailbox, router, and
// limit outcomes: a mixed glm/default group, where the glm member's mail turn
// runs a tool and then hits a final rate limit that resets in five hours. Its
// work is forwarded with a handoff package to the default member, and later
// group mail skips the cooling glm member.
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
import { ENVELOPE_TAG } from '../team/teamPrompt'
import type { ChatEvent } from '../../shared/chat'

const waitFor = async (check: () => boolean, label: string) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 8000) throw new Error(`Routing integration timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const frame = (fields: Record<string, unknown>) => ({ uuid: crypto.randomUUID(), session_id: 'fixture', ...fields }) as SDKMessage

test('a glm limit forwards progressed work to the default member, and later mail skips the cooling profile', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-routing-integration-'))
  const repo = path.join(root, 'repo')
  const git = spawnSync('git', ['init', '--quiet', repo], { env: cleanGitEnv(), encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const priorHold = process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
  // The fixture keys glm detection on the launch env's opus mapping; an
  // ambient one (an agent dev shell carries GLM values) would mark the
  // default-profile member as glm and its turns would never succeed.
  const priorOpus = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  // The handoff header mentions tool calls, which plays the fixture's tool turn.
  process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = '0'
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\nprofiles: [glm, default]\nmax: 3\n---\nBuild features')
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), 'Coordinate work')
  const resetsAt = Math.floor(Date.now() / 1000) + 5 * 3600
  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  const events = new Map<string, ChatEvent[]>()
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
    onEvent: (id, event) => events.set(id, [...(events.get(id) ?? []), event]),
    queryFactory: params => {
      // The shipped glm profile routes to GLM models: its mail turns fail.
      const glm = String(params.options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '').startsWith('glm')
      const sdkId = params.options.resume ?? crypto.randomUUID()
      const file = path.join(transcriptDir, `${sdkId}.jsonl`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      let mailTurn = false
      const prompt = (async function* () {
        for await (const message of params.prompt) {
          fs.appendFileSync(file, JSON.stringify({ ...message, uuid: crypto.randomUUID() }) + '\n')
          const content = message.message.content
          mailTurn = typeof content === 'string' && content.startsWith(`<${ENVELOPE_TAG}`)
          yield message
        }
      })()
      const fixture = fixtureQueryFactory({ ...params, prompt })
      const stream = (async function* () {
        yield frame({ type: 'system', subtype: 'init', session_id: sdkId })
        for await (const message of fixture) {
          if (glm && mailTurn && message.type === 'result') {
            const toolId = crypto.randomUUID()
            yield frame({ type: 'assistant', parent_tool_use_id: null, message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Edit', input: { file_path: 'src/export.ts' } }] } })
            yield frame({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] } })
            yield frame({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } })
            yield frame({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'API Error: 429 quota exhausted' }] } })
          }
          yield message
        }
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  try {
    const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    const glmDev = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs', claudeProfileId: 'glm' })
    if (!lead.ok || !glmDev.ok) throw new Error('Fixture sessions failed to create')
    await manager.start(lead.session.id)
    await manager.send(glmDev.session.id, 'hello')
    const store = manager.mailbox.store
    const first = await mailboxHandlers(manager.mailbox, lead.session.id).send_message({ to_kind: 'group', to_id: 'devs', body: 'Build the CSV export' })
    await waitFor(() => store.get(first.id)?.state === 'forwarded', 'first message forwarded')

    // The limit was recorded for glm, which now cools; the work moved on.
    expect(manager.limitEvents.forProfile('glm').filter(event => event.final)).toHaveLength(1)
    expect(manager.limitEvents.cooldownFor('glm').until).toBe(new Date(resetsAt * 1000).toISOString())
    const forwardedId = store.get(first.id)!.reason!.replace('forwarded: ', '')
    expect(store.get(forwardedId)).toMatchObject({
      state: 'queued', toKind: 'group', toId: 'devs', excludedProfile: 'glm', threadId: first.threadId,
      handoff: { fromSession: glmDev.session.id, fromProfile: 'glm', lastError: 'API Error: 429 quota exhausted',
        progress: { toolCalls: 1, tools: ['Edit'], filesTouched: ['src/export.ts'] } },
    })

    // A default-profile member joins and takes the handoff.
    const defaultDev = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
    if (!defaultDev.ok) throw new Error('Default member failed to create')
    await manager.send(defaultDev.session.id, 'hello')
    await waitFor(() => store.get(forwardedId)?.state === 'delivered', 'handoff delivered')
    expect(store.get(forwardedId)?.claimedBy).toBe(defaultDev.session.id)
    const peer = events.get(defaultDev.session.id)?.find(event => event.type === 'peer_message' && event.messageId === forwardedId)
    expect(peer).toMatchObject({ handoff: { fromProfile: 'glm', claimCommit: null } })

    // New group mail skips the idle, longest-waiting glm member (held while
    // the default member is busy, routed to it once idle).
    const second = await mailboxHandlers(manager.mailbox, lead.session.id).send_message({ to_kind: 'group', to_id: 'devs', body: 'Add a column' })
    await waitFor(() => store.get(second.id)?.state === 'delivered', 'second message delivered')
    expect(store.get(second.id)?.claimedBy).toBe(defaultDev.session.id)
    expect(manager.routingState(first.teamId).decisions.some(entry => entry.decision === `member:${defaultDev.session.id}`)).toBe(true)
  } finally {
    manager.shutdown(); db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    if (priorHold === undefined) delete process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
    else process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = priorHold
    if (priorOpus === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = priorOpus
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 20_000)

test('a glm limit keeps juniors mail off glm-flash while its provider cools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-routing-provider-'))
  const repo = path.join(root, 'repo')
  const git = spawnSync('git', ['init', '--quiet', repo], { env: cleanGitEnv(), encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const priorHold = process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
  process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = '0'
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/juniors.md'), '---\nprofiles: [glm-flash, haiku]\nmax: 3\n---\nTriage work')
  fs.writeFileSync(path.join(repo, '.kawai/groups/leads.md'), 'Coordinate work')
  const db = initDatabase({ path: path.join(root, 'sessions.db') })
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
    onEvent: () => {},
    queryFactory: params => {
      // Receipts confirm from the CLI transcript: every prompt line lands in it.
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
        yield frame({ type: 'system', subtype: 'init', session_id: sdkId })
        for await (const message of fixture) yield message
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  try {
    const lead = await manager.createAvailableSession({ projectPath: repo, groupId: 'leads' })
    const flashDev = await manager.createAvailableSession({ projectPath: repo, groupId: 'juniors', claudeProfileId: 'glm-flash' })
    const haikuDev = await manager.createAvailableSession({ projectPath: repo, groupId: 'juniors', claudeProfileId: 'haiku' })
    if (!lead.ok || !flashDev.ok || !haikuDev.ok) throw new Error('Fixture sessions failed to create')
    await manager.start(lead.session.id)
    await manager.send(flashDev.session.id, 'hello')
    await manager.send(haikuDev.session.id, 'hello')
    const store = manager.mailbox.store

    // A final limit on glm — the sibling model of glm-flash's provider zai —
    // cools glm-flash for the provider's window, and haiku (another
    // provider) not at all.
    const resetsAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3 * 3600_000).toISOString()
    manager.limitEvents.record({
      profileId: 'glm', sessionId: flashDev.session.id, groupId: 'juniors', kind: 'rate_limit', final: true,
      status: 429, message: 'quota', resetsAt, providerId: 'zai', window: null,
    })
    expect(manager.limitEvents.cooldownFor('glm-flash', 'zai'))
      .toEqual({ until: resetsAt, provider: true, providerId: 'zai' })
    expect(manager.limitEvents.cooldownFor('haiku', 'claude').until).toBeNull()

    const first = await mailboxHandlers(manager.mailbox, lead.session.id).send_message({ to_kind: 'group', to_id: 'juniors', body: 'Triage the queue' })
    await waitFor(() => store.get(first.id)?.state === 'delivered', 'juniors mail delivered')
    expect(store.get(first.id)?.claimedBy).toBe(haikuDev.session.id)
    expect(manager.routingState(first.teamId).decisions.some(entry => entry.decision === `member:${haikuDev.session.id}`)).toBe(true)
  } finally {
    manager.shutdown(); db.close()
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    if (priorHold === undefined) delete process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
    else process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = priorHold
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
