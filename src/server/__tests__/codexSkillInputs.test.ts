// @reads: packages/agent-runtime/__tests__/fixtures/**
// Submission table S: assertions inspect actual turn/start inputs through
// Kawai's production Codex composition and the scripted app-server as a real
// child (task-5906f19c); P2 exercises, through the same adapter over the
// package's in-process protocol model, every send's input. P2's direct
// resolver checks moved to the package with the resolver (task-ce05430a R2):
// packages/agent-runtime/__tests__/codexSkillCatalog.test.ts.
import { afterEach, expect, test } from 'bun:test'
import { Script, startHarness, tempDirs, THREAD_ID, until, type Harness } from './codexDriverHarness'
import { formatEnvelope } from '../team/envelope'
import type { ChatEvent, ChatPeerMessage } from '../../shared/chat'
import fs from 'node:fs'
import path from 'node:path'
import { createCodexChatDriver } from '../chat/provider/codexRuntime'
import { createCodexDriverWith } from '../../../packages/agent-runtime/src/codex/driver'
import { codexRoot } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'
import { inProcessSpawn } from '../../../packages/agent-runtime/__tests__/helpers/inProcessCodex'

// Table S verbatim: [Id, Origin / catalog / text, Observable Codex input].
export const submissionOracles = [
  ['S1', 'Peer or internal continuation / * / contains slash references', 'Text only; no skill inputs'],
  ['S2', 'Human / loading or unavailable / *', 'Text only, request does not await discovery'],
  ['S3', 'Human / ready / exact eligible slash word anywhere', 'Original text then skill with server-reported name/path'],
  ['S4', 'Human / ready / unknown, removed, ambiguous, disabled, reserved name', 'No skill for that word'],
  ['S5', 'Human / ready / path, URL, case mismatch, punctuation suffix, partial name', 'No skill for that word'],
  ['S6', 'Human / ready / repeated and multiple exact eligible references', 'One skill input per name, first-reference order'],
  ['S7', 'Human accepted in ready state; catalog changes before turn/start', 'Skill identities captured at send remain fixed'],
] as const

const skill = (name: string, extra = {}) => ({ name, path: `/skills/${name}/SKILL.md`, enabled: true, scope: 'repo', description: name, ...extra })
const skills = [skill('explore'), skill('review'), skill('off', { enabled: false }),
  skill('ambiguous'), skill('ambiguous', { path: '/elsewhere/SKILL.md' }), skill('clear')]
const response = (cwd: string) => ({ data: [{ cwd, skills, errors: [] }] })
const textInput = (text: string) => ({ type: 'text', text, text_elements: [] })
const native = (name: string) => ({ type: 'skill' as const, name, path: `/skills/${name}/SKILL.md` })
let harness: Harness | null = null
afterEach(async () => {
  const done = harness?.cleanup()
  harness = null
  await done
})

for (const [id, text, expected] of [
  ['S3', 'please /explore this', ['explore']],
  ['S4', '/missing /off /ambiguous /clear', []],
  ['S5', 'x/explore https://explore /explore/more /explore, /Explore /exp', []],
  ['S6', '/review\n/explore /review', ['review', 'explore']],
] as const) {
  // @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Invoke a completed or manually typed skill
  // @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Repeated and multiple skills
  // @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Exact reference boundaries
  test(`${id}: ${submissionOracles.find(row => row[0] === id)![1]} on an actual Codex turn`, async () => {
    const dirs = tempDirs()
    const script = new Script().boot().request('skills/list', response(dirs.project)).turn('ct-1')
    harness = startHarness(script, {}, dirs)
    harness.driver.start(); await until(() => harness!.driver.getCommandState().status === 'ready')
    harness.driver.send(text)
    await until(() => harness!.sent.some(message => message.method === 'turn/start'))
    expect(harness.sent.find(message => message.method === 'turn/start')!.params!.input)
      .toEqual([textInput(text), ...expected.map(native)])
    expect(harness.events.find(event => event.type === 'user_message')).toMatchObject({ text })
  })
}

// @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › A reference no longer resolves
test('S2: a send accepted before discovery stays plain text even when boot discovers the skill', async () => {
  const dirs = tempDirs()
  harness = startHarness(new Script().boot().request('skills/list', response(dirs.project)).turn('ct-1'), {}, dirs)
  harness.driver.send('/explore')
  await until(() => harness!.sent.some(message => message.method === 'turn/start'))
  expect(harness.sent.find(message => message.method === 'turn/start')!.params!.input).toEqual([textInput('/explore')])
})

// @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Peer mail and history
test('S1/S7: peer text never attaches skills; active-turn human inputs keep their send-time identities', async () => {
  const dirs = tempDirs()
  const script = new Script().boot().request('skills/list', response(dirs.project)).turn('ct-1').completed('ct-1')
    .turn('ct-2').request('turn/steer', { turnId: 'ct-2' })
  harness = startHarness(script, {}, dirs)
  harness.driver.start(); await until(() => harness!.driver.getCommandState().status === 'ready')
  const peer: ChatPeerMessage = {
    messageId: 'mail-1', senderSession: 'sender', senderGroup: null, priority: 'normal', possibleDuplicate: false,
    originPath: '/project', threadId: 'thread-1', tags: [], body: '/explore',
  }
  harness.driver.deliver(peer)
  await until(() => harness!.events.some(event => event.type === 'turn_completed'))
  expect(harness.sent.filter(message => message.method === 'turn/start')[0]!.params!.input).toEqual([textInput(formatEnvelope(peer))])
  harness.driver.send('/explore')
  // Invalidate synchronously before ready.then executes; the accepted input
  // must retain the ready catalog captured by send, not a fresh empty one.
  harness.driver.setProjectPath('/different')
  await until(() => harness!.sent.filter(message => message.method === 'turn/start').length === 2)
  expect(harness.sent.filter(message => message.method === 'turn/start')[1]!.params!.input).toEqual([textInput('/explore'), native('explore')])
  // The second input steers the active turn; after invalidation it is plain.
  // It joins ct-2 by turn/steer (task-5906f19c: the accepted 6.1 steering
  // protocol in place of the legacy driver's third turn/start).
  harness.driver.send('/review')
  await until(() => harness!.sent.some(message => message.method === 'turn/steer'))
  const review = harness.events.find((event): event is Extract<ChatEvent, { type: 'user_message' }> => event.type === 'user_message' && event.text === '/review')
  expect(harness.sent.find(message => message.method === 'turn/steer')!.params).toEqual({
    threadId: THREAD_ID, input: [textInput('/review')], expectedTurnId: 'ct-2', clientUserMessageId: review!.messageUuid,
  })
  expect(harness.sent.filter(message => message.method === 'turn/start')).toHaveLength(2)
})

test('P2: 1000 seeded messages preserve text and attach only exact accepted identities', async () => {
  let state = 0xC0DE02
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
  const words = ['/explore', '/review', '/off', '/missing', '/explore,', 'x/explore', '/Explore', '/explore/more']
  // Kawai's Codex adapter (codexRuntime.ts) over the package core and its real
  // JSON-RPC client, with the package's asynchronous protocol model behind
  // createCodexDriverWith's private spawn seam (task-5906f19c A4): model
  // evidence, not a native process. Its catalog is this test's own skills
  // file; each turn's input is what the model received, read once the turn
  // completed (actual causal settlement, no microtask count).
  const root = codexRoot()
  fs.writeFileSync(path.join(root.home, 'skills.json'), JSON.stringify({ skills }))
  let completed = 0
  let waiting: { target: number; resolve: () => void } | null = null
  const driver = createCodexChatDriver({
    sessionId: 'property', projectPath: root.launch().cwd, executable: root.wrapper, codexHome: root.home, network: true,
    serverEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root.root },
    withheldCredentials: () => new Set(), wire: { record() {} }, claimRateLimitsRead: () => false, onStatus() {},
    onEvent: event => {
      if (event.type !== 'turn_completed') return
      completed += 1
      if (waiting && completed >= waiting.target) waiting.resolve()
    },
  }, options => createCodexDriverWith({ ...options, wire: undefined }, { spawn: inProcessSpawn }))
  const turnCompleted = (target: number) => new Promise<void>(resolve => {
    waiting = { target, resolve }
    if (completed >= target) resolve()
  })
  // The model's received.jsonl, read forward from the last offset.
  const received = path.join(root.home, 'received.jsonl')
  let offset = 0
  let lastInput: unknown
  const readTurnStarts = () => {
    const text = fs.readFileSync(received).subarray(offset).toString('utf8')
    const end = text.lastIndexOf('\n') + 1
    offset += Buffer.byteLength(text.slice(0, end))
    for (const line of text.slice(0, end).split('\n').filter(Boolean)) {
      const message = JSON.parse(line) as { method?: string; params?: { input?: unknown } }
      if (message.method === 'turn/start') lastInput = message.params!.input
    }
  }
  try {
    driver.start(); await until(() => driver.getCommandState().status === 'ready')
    for (let i = 0; i < 1000; i++) {
      const message = Array.from({ length: 1 + random() % 12 }, () => words[random() % words.length]!).join(i % 2 ? '\n' : ' ')
      const expected = [...new Set(message.split(/\s+/).filter(word => word === '/explore' || word === '/review'))].map(word => native(word.slice(1)))
      const peer: ChatPeerMessage = { messageId: `mail-${i}`, senderSession: 'sender', senderGroup: null,
        priority: 'normal', possibleDuplicate: false, originPath: '/project', threadId: 'peer-thread', tags: [], body: message }
      const isPeer = i % 3 === 0
      if (isPeer) driver.deliver(peer)
      else driver.send(message)
      await turnCompleted(i + 1)
      lastInput = undefined
      readTurnStarts()
      expect({ i, input: lastInput }).toEqual({ i, input: [textInput(isPeer ? formatEnvelope(peer) : message), ...(isPeer ? [] : expected)] })
    }
  } finally {
    driver.kill()
    try {
      await driver.settled()
    } finally {
      fs.rmSync(root.root, { recursive: true, force: true })
    }
  }
})
