// codex-chat-sessions §6 production path (the pilot's checkpoint 2): a Codex
// chat through the real ChatSessionManager composition against the fake
// app-server. The thread starts with the kawai-team dynamic-tool namespace;
// a `send_message` call on the session's own thread is served by the team
// tool table (mail recorded with the Codex session as sender, no card); the
// same call for a foreign thread is refused with nothing written; and the
// mail, delivered back to the chat as a turn, settles delivered from its
// rollout row while that turn still runs. The fake's `append` record plays
// Codex's rollout writer: this shows that the tail settles a row once it
// is on disk, never when Codex writes it (F1).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatWireLogs } from '../chat/ChatWireLogs'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { formatEnvelope, messageEnvelope } from '../team/envelope'
import { FAKE_CODEX, Script, THREAD_ID, until } from './codexDriverHarness'

const ENV_KEYS = [
  'CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN', 'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY',
] as const
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let tempDir: string
let project: string
let home: string
let codexHome: string
let rollout: string
let gate: string
let db: SessionDatabase
let manager: ChatSessionManager | null = null

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-team-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  codexHome = path.join(tempDir, 'codex-home')
  rollout = path.join(codexHome, 'sessions', '2026', '10', '20', `rollout-2026-10-20T00-00-00-${THREAD_ID}.jsonl`)
  gate = path.join(tempDir, 'gate')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.dirname(rollout), { recursive: true })
  // A temp home's fake login — the real ~/.codex is never touched.
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({ codex: { label: 'Codex', runtime: 'codex' } }))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.CODEX_HOME = codexHome
  process.env.KAWAI_CODEX_PATH = FAKE_CODEX
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  process.env.FAKE_RUN = '1'
  resetCodexExecutableCache()
})

afterEach(() => {
  manager?.shutdown()
  manager = null
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  resetCodexExecutableCache()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

type Wire = Array<{ dir: string; raw: string }>

function createManager(events: ChatEvent[], wire: Wire): ChatSessionManager {
  const wireLogs = { get: () => ({ record: (dir: string, raw: string) => wire.push({ dir, raw }) }), pruneOrphans: async () => {}, delete: async () => {} }
  return new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: (_id, event) => events.push(event),
    profileCatalogHome: home, availabilityProbe: async () => {},
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
    wireLogs: wireLogs as unknown as ChatWireLogs,
  })
}

const outbound = (wire: Wire) => wire.filter(entry => entry.dir === 'out').map(entry => JSON.parse(entry.raw))
/** The driver's reply to the fake's server request `id`. */
const replyTo = (wire: Wire, id: number) => outbound(wire).find(message => message.id === id && message.method === undefined)

const call = (threadId: string, body: string, to: string) => ({
  threadId, turnId: 'ct-1', callId: `call-${body}`, namespace: 'kawai-team', tool: 'send_message',
  arguments: { to_kind: 'session', to_id: to, body },
})

/**
 * Run 1: boot, a user turn whose agent calls send_message on its own thread
 * (to itself, a reminder) and again for a foreign thread, then the delivery
 * turn of that mail: its rollout row is appended while the turn is held
 * open behind the gate.
 */
function writeTranscript(sessionId: string): void {
  const script = new Script().boot('thread/start', 'gpt-test', rollout)
    .turn('ct-1')
    .serverRequest(900, 'item/tool/call', call(THREAD_ID, 'note to self', sessionId))
    .serverRequest(901, 'item/tool/call', call('thread-other', 'smuggled', sessionId))
    .completed('ct-1')
    .turn('ct-2')
    .append(rollout)
    .gate(gate)
    .completed('ct-2')
  process.env.FAKE_TRANSCRIPT = script.write(tempDir)
}

test('a Codex chat serves kawai-team send_message on its thread, refuses a foreign thread, and settles delivered mail from its rollout mid-turn', async () => {
  const events: ChatEvent[] = []
  const wire: Wire = []
  manager = createManager(events, wire)
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex dev' })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id
  writeTranscript(id)

  expect((await manager.start(id)).ok).toBe(true)
  await until(() => db.getChatSession(id)?.transcriptPath === rollout)
  // The thread registered the team table as one kawai-team namespace (D6).
  const [threadStart] = outbound(wire).filter(message => message.method === 'thread/start')
  const namespace = threadStart.params.dynamicTools?.[0]
  expect(namespace).toMatchObject({ type: 'namespace', name: 'kawai-team' })
  expect(namespace.tools.map((tool: { name: string }) => tool.name)).toContain('send_message')

  expect((await manager.send(id, 'go')).ok).toBe(true)
  await until(() => replyTo(wire, 901) !== undefined)

  // The own-thread call ran the handler: mail from the Codex session.
  const served = replyTo(wire, 900).result
  expect(served.success).toBe(true)
  const messageId = JSON.parse(served.contentItems[0].text).id as string
  expect(manager.mailbox.store.get(messageId)).toMatchObject({ fromSession: id, toKind: 'session', toId: id, body: 'note to self' })
  // The foreign-thread call was answered as a refusal, not a JSON-RPC
  // error, and wrote nothing.
  const refused = replyTo(wire, 901)
  expect(refused.error).toBeUndefined()
  expect(refused.result).toEqual({ success: false, contentItems: [{ type: 'inputText', text: expect.stringContaining('thread') }] })
  expect(manager.mailbox.store.listForTeam(manager.mailbox.store.get(messageId)!.teamId).map(mail => mail.body)).toEqual(['note to self'])
  // No approval card for either call, under the manual policy.
  expect(events.some(event => event.type === 'approval_request')).toBe(false)

  // The mail comes back as the next turn; its rollout row settles it
  // while that turn is still held open.
  await until(() => manager!.mailbox.store.get(messageId)?.state === 'delivered')
  expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1)
  expect(db.getChatSession(id)?.status).toBe('working')
  const mailTurn = outbound(wire).filter(message => message.method === 'turn/start')[1]
  expect(mailTurn.params.input[0].text).toContain(messageId)

  fs.writeFileSync(gate, '')
  await until(() => events.filter(event => event.type === 'turn_completed').length === 2)
})

test('a receipt written to an older rollout of the thread settles at turn end, not from the tail of the newest', async () => {
  const events: ChatEvent[] = []
  const wire: Wire = []
  manager = createManager(events, wire)
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex dev' })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id
  // As after a resume that moved the rollout: transcript_path names the
  // newest file, and the delivery row lands in the thread's older one.
  const older = path.join(codexHome, 'sessions', '2026', '10', '19', `rollout-2026-10-19T00-00-00-${THREAD_ID}.jsonl`)
  fs.mkdirSync(path.dirname(older), { recursive: true })
  const script = new Script().boot('thread/start', 'gpt-test', rollout)
    .turn('ct-1')
    .serverRequest(900, 'item/tool/call', call(THREAD_ID, 'note to self', id))
    .completed('ct-1')
    .turn('ct-2')
    .append(older)
    .gate(gate)
    .completed('ct-2')
  process.env.FAKE_TRANSCRIPT = script.write(tempDir)

  expect((await manager.start(id)).ok).toBe(true)
  expect((await manager.send(id, 'go')).ok).toBe(true)
  await until(() => replyTo(wire, 900) !== undefined)
  const messageId = JSON.parse(replyTo(wire, 900).result.contentItems[0].text).id as string
  await until(() => fs.existsSync(older) && fs.readFileSync(older, 'utf8').includes(messageId))
  // The tail follows the newest file only: the turn is open and the mail
  // still reads pushed.
  await Bun.sleep(150)
  expect(manager.mailbox.store.get(messageId)?.state).toBe('claimed')
  expect(db.getChatSession(id)?.transcriptPath).toBe(rollout)

  fs.writeFileSync(gate, '')
  await until(() => events.filter(event => event.type === 'turn_completed').length === 2)
  await until(() => manager!.mailbox.store.get(messageId)?.state === 'delivered')
})

// Pins applyPatch's re-watch branch (ChatSessionManager: a transcriptPath
// patch that differs from the stored one releases the tail and re-arms it —
// ~:3428–3432): a resume that MOVES the rollout must point the receipt tail
// at the new file, or pushed mail waits for the turn-end settle and the
// spec's "receipt while the turn runs" is lost for every resumed chat.
test('a resume that moves transcript_path re-arms the receipt tail — mail settles from the new rollout mid-turn', async () => {
  const events: ChatEvent[] = []
  const wire: Wire = []
  manager = createManager(events, wire)
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex dev' })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id
  // Run 1 boots the thread on the first rollout; run 2 resumes the same
  // thread onto a NEW rollout (same thread id, newer file) and holds its
  // turn behind the gate.
  const moved = path.join(codexHome, 'sessions', '2026', '10', '20', `rollout-2026-10-20T01-00-00-${THREAD_ID}.jsonl`)
  const script = new Script().boot('thread/start', 'gpt-test', rollout)
  const second = new Script().boot('thread/resume', 'gpt-test', moved)
    .turn('ct-1')
    .gate(gate)
    .completed('ct-1')
  script.lines.push(...second.lines)
  process.env.FAKE_TRANSCRIPT = script.write(tempDir)
  expect((await manager.start(id)).ok).toBe(true)
  await until(() => db.getChatSession(id)?.transcriptPath === rollout)
  // Both files exist before the resume reports the move, so the restored
  // tail binds the old file at once and the re-armed one binds the new file
  // at once (neither via the locate-retry timer).
  fs.writeFileSync(rollout, `${JSON.stringify({ timestamp: '2026-10-20T00:00:00.000Z', type: 'session_meta', payload: { id: THREAD_ID } })}\n`)
  fs.writeFileSync(moved, '')
  manager.shutdown()

  const restartEvents: ChatEvent[] = []
  manager = createManager(restartEvents, [])
  await manager.whenRestored()
  process.env.FAKE_RUN = '2'
  expect((await manager.send(id, 'go')).ok).toBe(true)
  await until(() => db.getChatSession(id)?.transcriptPath === moved)

  // Mail pushed while the gated turn runs, its envelope row appended to the
  // NEW rollout: the re-armed tail settles it delivered before the gate
  // opens (the turn-end settle reads every rollout of the thread and would
  // only reach it after the turn).
  const store = manager.mailbox.store
  const mail = store.enqueue({ teamId: 'team-x', toKind: 'group', toId: 'nobody', fromSession: 'lead', fromGroup: null, originPath: project, body: 'receipt on the moved rollout' })
  store.claim(mail.id, id); store.markPushed(mail.id)
  fs.appendFileSync(moved, `${JSON.stringify({ timestamp: '2026-10-20T01:05:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: formatEnvelope(messageEnvelope(mail)) }] } })}\n`)
  await until(() => store.get(mail.id)?.state === 'delivered')
  expect(db.getChatSession(id)?.status).toBe('working')

  fs.writeFileSync(gate, '')
  await until(() => restartEvents.filter(event => event.type === 'turn_completed').length === 1)
})

test('startup reconciliation settles a Codex chat\'s pushed mail from its rollouts with no agent running', async () => {
  const wire: Wire = []
  manager = createManager([], wire)
  await manager.whenRestored()
  const created = await manager.createAvailableSession({ projectPath: project, claudeProfileId: 'codex', name: 'Codex dev' })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id
  process.env.FAKE_TRANSCRIPT = new Script().boot('thread/start', 'gpt-test', rollout).write(tempDir)
  expect((await manager.start(id)).ok).toBe(true)
  await until(() => db.getChatSession(id)?.transcriptPath === rollout)
  const store = manager.mailbox.store
  const pushed = (body: string) => {
    const mail = store.enqueue({ teamId: 'team-x', toKind: 'group', toId: 'nobody', fromSession: 'lead', fromGroup: null, originPath: project, body })
    store.claim(mail.id, id); store.markPushed(mail.id)
    return store.get(mail.id)!
  }
  const found = pushed('found')
  const absent = pushed('absent')
  fs.appendFileSync(rollout, `${JSON.stringify({ timestamp: '2026-10-20T00:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: formatEnvelope(messageEnvelope(found)) }] } })}\n`)
  manager.shutdown()

  const restartWire: Wire = []
  manager = createManager([], restartWire)
  await manager.whenRestored()
  expect(manager.mailbox.store.get(found.id)?.state).toBe('delivered')
  // The rollout proves the reader, so the complete-but-absent mail requeues.
  expect(manager.mailbox.store.get(absent.id)?.state).toBe('queued')
  // No agent was started to settle them.
  expect(restartWire).toEqual([])
})
