// Codex compatibility through Kawai's production composition (task-752c9e4c):
// createChatDriver → codexRuntime.ts → the public package factory, which
// launches the replaying fake (tests/fixtures/fake-codex-app-server.ts) as its
// own default-owned child over stdio. Expected values come from the script
// this test writes and the in-tree driver's original oracles (C1:
// codexSessionDriver.test.ts 'a turn streams text…'; C3: codexApprovals.test.ts
// 'a protocol question with options null…'), never from the adapter.
// - C1: the activity trace the in-tree driver published — requesting, then
//   responding on text, thinking on reasoning, running_tools for a call,
//   requesting after its result, retrying on a retrying error, null at the
//   turn's end — and nothing a settled turn's late frame or an exit revives.
// - C3: a question offering no choices takes a typed answer (the masked
//   card, the exact reply); an offered-only question still refuses other text
//   and stays pending.
// Teardown kills the driver and joins settled() before removing the temp root.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import type { ChatActivity, ChatEvent } from '../../shared/chat'
import type { CodexSessionDriverOptions } from '../chat/provider/codexDriverTypes'
import { createChatDriver } from '../chat/provider/createChatDriver'
import type { ChatAgentDriver } from '../chat/provider/driver'
import { FAKE_CODEX, Script, THREAD_ID, until } from './codexDriverHarness'

type Adapter = ChatAgentDriver & { settled(): Promise<void> }
interface Run {
  driver: Adapter
  events: ChatEvent[]
  wire: Array<{ dir: string; raw: string }>
  sent(): Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }>
}

const roots: Array<{ dir: string; driver: Adapter }> = []
afterEach(async () => {
  for (const { dir, driver } of roots.splice(0)) {
    try {
      driver.kill()
      await driver.settled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function run(script: Script, overrides: Partial<CodexSessionDriverOptions> = {}, env: Record<string, string> = {}): Run {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-compat-')))
  const project = path.join(dir, 'project')
  const home = path.join(dir, 'codex-home')
  fs.mkdirSync(project)
  fs.mkdirSync(home)
  const transcript = script.write(dir)
  const events: ChatEvent[] = []
  const wire: Run['wire'] = []
  const driver = createChatDriver({
    runtime: 'codex',
    options: {
      sessionId: 'chat-codex-compat',
      projectPath: project,
      executable: FAKE_CODEX,
      codexHome: home,
      network: true,
      wire: { record: (direction, raw) => wire.push({ dir: direction, raw }) },
      withheldCredentials: () => new Set(),
      serverEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, FAKE_TRANSCRIPT: transcript, ...env },
      claimRateLimitsRead: () => false,
      onEvent: event => events.push(event),
      onStatus: () => {},
      ...overrides,
    },
  }) as Adapter
  roots.push({ dir, driver })
  return { driver, events, wire, sent: () => wire.filter(entry => entry.dir === 'out').map(entry => JSON.parse(entry.raw)) }
}

const completed = (r: Run) => r.events.filter(event => event.type === 'turn_completed').length
const ofType = <T extends ChatEvent['type']>(r: Run, type: T) => r.events.filter((event): event is Extract<ChatEvent, { type: T }> => event.type === type)
const reply = (r: Run, id: number) => r.sent().find(message => message.id === id && message.method === undefined)?.result
const heard = (r: Run, text: string) => r.wire.some(entry => entry.dir === 'in' && entry.raw.includes(text))
const settle = () => new Promise(resolve => setTimeout(resolve, 100))

function phases(): { trace: Array<string | null>; onActivity: (activity: ChatActivity | null) => void } {
  const trace: Array<string | null> = []
  return { trace, onActivity: activity => void trace.push(activity?.phase ?? null) }
}

const command = (id: string, status: string) => ({ type: 'commandExecution', id, command: 'true', cwd: '/w', status, aggregatedOutput: status === 'completed' ? '' : null, exitCode: status === 'completed' ? 0 : null })
const delta = (turn: string, item: string, text: string) => ({ threadId: THREAD_ID, turnId: turn, itemId: item, delta: text })

test('C1: a streamed Codex turn reports requesting, responding, then no activity through the package', async () => {
  const total = { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 }
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: '', questions: null })
    .notify('item/agentMessage/delta', delta('ct-1', 'msg-1', 'hel'))
    .notify('item/agentMessage/delta', delta('ct-1', 'msg-1', 'lo'))
    .item('completed', 'ct-1', { type: 'agentMessage', id: 'msg-1', text: 'hello', questions: null })
    .notify('thread/tokenUsage/updated', { threadId: THREAD_ID, turnId: 'ct-1', tokenUsage: { total, last: total, modelContextWindow: 10_000 } })
    .completed('ct-1', 'completed', [{ type: 'agentMessage', id: 'msg-1', text: 'hello' }])
  const activity = phases()
  const r = run(script, { onActivity: activity.onActivity })
  r.driver.send('hi')
  await until(() => completed(r) === 1)
  expect(activity.trace).toEqual(['requesting', 'responding', null])
})

test('C1: reasoning, a tool call and its result, and a retrying error move the activity in order; the turn end clears it', async () => {
  const retrying = { error: { message: 'slow down', codexErrorInfo: 'rateLimitExceeded', additionalDetails: null, misalignment: null }, willRetry: true, threadId: THREAD_ID, turnId: 'ct-1' }
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', { type: 'reasoning', id: 'rs-1', summary: [], content: [] })
    .item('started', 'ct-1', command('cmd-1', 'inProgress'))
    .item('completed', 'ct-1', command('cmd-1', 'completed'))
    .notify('error', retrying)
    .notify('item/agentMessage/delta', delta('ct-1', 'msg-1', 'done'))
    .completed('ct-1')
  const activity = phases()
  const r = run(script, { onActivity: activity.onActivity })
  r.driver.send('go')
  await until(() => completed(r) === 1)
  expect(activity.trace).toEqual(['requesting', 'thinking', 'running_tools', 'requesting', 'retrying', 'responding', null])
})

test('C1: a settled turn\'s late frames revive no activity, even during the next turn, and an exit mid-turn clears it', async () => {
  const late = new Script().boot().turn('ct-1')
    .notify('item/agentMessage/delta', delta('ct-1', 'msg-1', 'on time'))
    .completed('ct-1')
    .notify('item/agentMessage/delta', delta('ct-1', 'msg-1', 'too late'))
    .notify('item/reasoning/textDelta', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'rs-1', delta: 'late thought' })
    .turn('ct-2')
    .notify('item/reasoning/textDelta', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'rs-1', delta: 'stale thought' })
    .notify('error', { error: { message: 'old', codexErrorInfo: null, additionalDetails: null, misalignment: null }, willRetry: true, threadId: THREAD_ID, turnId: 'ct-1' })
    .notify('item/agentMessage/delta', delta('ct-2', 'msg-2', 'fresh'))
    .completed('ct-2')
  const first = phases()
  const a = run(late, { onActivity: first.onActivity })
  a.driver.send('one')
  await until(() => completed(a) === 1 && heard(a, 'late thought'))
  await settle()
  expect(first.trace).toEqual(['requesting', 'responding', null])
  // The next turn's own frames move it; the settled turn's reasoning and retry do not.
  a.driver.send('two')
  await until(() => completed(a) === 2)
  expect(first.trace).toEqual(['requesting', 'responding', null, 'requesting', 'responding', null])

  const exiting = new Script().boot().turn('ct-1').notify('item/agentMessage/delta', delta('ct-1', 'msg-1', 'partial'))
  const second = phases()
  const b = run(exiting, { onActivity: second.onActivity }, { FAKE_EXIT_AFTER_REPLAY: '1' })
  b.driver.send('two')
  await until(() => b.driver.isDead)
  expect(second.trace).toEqual(['requesting', 'responding', null])
})

test('C3: a no-option masked question takes a text answer and replies with it exactly', async () => {
  const script = new Script().boot().turn('ct-1')
    .serverRequest(110, 'item/tool/requestUserInput', {
      threadId: THREAD_ID, turnId: 'ct-1', itemId: 'q-item',
      questions: [{ id: 'q1', header: 'Token', question: 'Paste the token?', isOther: false, isSecret: true, options: null }],
    })
    .completed('ct-1')
  const r = run(script, { getApprovalPolicy: () => 'manual' })
  r.driver.send('ask me')
  await until(() => r.driver.getPendingRequests().length === 1)
  expect(ofType(r, 'question_request')[0]!.questions[0]).toEqual({
    question: 'Paste the token?', header: 'Token', multiSelect: false, options: [], isOther: false, isSecret: true,
  })
  expect(r.driver.answerQuestion(ofType(r, 'question_request')[0]!.requestId, { 'Paste the token?': { text: 'sk-test' } })).toEqual({ ok: true })
  await until(() => completed(r) === 1)
  expect(reply(r, 110)).toEqual({ answers: { q1: { answers: ['sk-test'] } } })
})

test('C3: an offered-only question still refuses other text and stays pending until a choice', async () => {
  const script = new Script().boot().turn('ct-1')
    .serverRequest(111, 'item/tool/requestUserInput', {
      threadId: THREAD_ID, turnId: 'ct-1', itemId: 'q-item',
      questions: [{ id: 'q1', header: 'Mode', question: 'Which mode?', isOther: false, isSecret: false, options: [{ label: 'fast' }] }],
    })
    .completed('ct-1')
  const r = run(script, { getApprovalPolicy: () => 'manual' })
  r.driver.send('ask me')
  await until(() => r.driver.getPendingRequests().length === 1)
  const requestId = ofType(r, 'question_request')[0]!.requestId
  expect(r.driver.answerQuestion(requestId, { 'Which mode?': { text: 'slow' } })).toEqual({ ok: false, error: '"Which mode?" accepts only an offered choice' })
  expect(r.driver.getPendingRequests().map(request => request.requestId)).toEqual([requestId])
  expect(reply(r, 111)).toBeUndefined()
  expect(r.driver.answerQuestion(requestId, { 'Which mode?': { options: ['fast'] } })).toEqual({ ok: true })
  await until(() => completed(r) === 1)
  expect(reply(r, 111)).toEqual({ answers: { q1: { answers: ['fast'] } } })
})
