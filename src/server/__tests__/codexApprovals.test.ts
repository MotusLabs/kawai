// §5.4 (codex-chat-sessions D5): Codex approvals and questions against the
// fake app-server — manual cards, auto grants, a live switch to auto, a
// question still asked under auto (blocking and async), interrupt
// cancelling a card, and `approvalsReviewer: "user"` sent at start and
// resume even when the home's config selects the auto reviewer.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatApprovalPolicy, ChatEvent } from '../../shared/chat'
import { Script, sentRequest, startHarness, tempDirs, THREAD_ID, until, type Harness } from './codexDriverHarness'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

const COMMAND = { type: 'commandExecution', id: 'cmd-1', command: 'git push origin', cwd: '/w', status: 'inProgress', aggregatedOutput: null, exitCode: null }
const approvalScript = (decisionStatus: string) => new Script().boot().turn('ct-1')
  .item('started', 'ct-1', COMMAND)
  .serverRequest(100, 'item/commandExecution/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'cmd-1', command: 'git push origin', reason: 'network' })
  .item('completed', 'ct-1', { ...COMMAND, status: decisionStatus, exitCode: decisionStatus === 'completed' ? 0 : null })
  .completed('ct-1')

const reply = (h: Harness, id: number) => h.sent.find(message => message.id === id && message.method === undefined)?.result
const ofType = <T extends ChatEvent['type']>(h: Harness, type: T) => h.events.filter((event): event is Extract<ChatEvent, { type: T }> => event.type === type)
const turnDone = (h: Harness) => ofType(h, 'turn_completed').length === 1

test('manual: a command approval shows a card, holds permission, and allow replies accept', async () => {
  harness = startHarness(approvalScript('completed'), { getApprovalPolicy: () => 'manual' })
  harness.driver.send('push it')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  const [card] = ofType(harness, 'approval_request')
  expect(card).toMatchObject({ tool: 'Bash', input: { command: 'git push origin', reason: 'network' } })
  expect(harness.statuses.at(-1)).toBe('permission')
  expect(harness.driver.resolveApproval(card!.requestId, 'allow')).toEqual({ ok: true })
  await until(() => turnDone(harness!))
  expect(reply(harness, 100)).toEqual({ decision: 'accept' })
  expect(ofType(harness, 'request_resolved')).toEqual([expect.objectContaining({ requestId: card!.requestId, outcome: 'allowed', decidedBy: 'user' })])
  expect(harness.statuses).toEqual(['working', 'permission', 'working', 'waiting'])
})

test('manual: deny replies decline and the first answer wins', async () => {
  harness = startHarness(approvalScript('declined'))
  harness.driver.send('push it')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  const requestId = ofType(harness, 'approval_request')[0]!.requestId
  expect(harness.driver.resolveApproval(requestId, 'deny')).toEqual({ ok: true })
  expect(harness.driver.resolveApproval(requestId, 'allow').ok).toBe(false)
  await until(() => turnDone(harness!))
  expect(reply(harness, 100)).toEqual({ decision: 'decline' })
})

test('auto: Kawai accepts at once with a policy grant and shows no card', async () => {
  harness = startHarness(approvalScript('completed'), { getApprovalPolicy: () => 'auto' })
  harness.driver.send('push it')
  await until(() => turnDone(harness!))
  expect(ofType(harness, 'approval_request')).toEqual([])
  expect(reply(harness, 100)).toEqual({ decision: 'accept' })
  expect(ofType(harness, 'request_resolved')).toEqual([expect.objectContaining({ outcome: 'allowed', decidedBy: 'policy', tool: 'Bash' })])
  expect(harness.statuses).not.toContain('permission')
})

test('a live switch to auto grants the pending card; later requests read the new policy', async () => {
  let policy: ChatApprovalPolicy = 'manual'
  harness = startHarness(approvalScript('completed'), { getApprovalPolicy: () => policy })
  harness.driver.send('push it')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  policy = 'auto'
  harness.driver.onApprovalPolicyChanged('auto')
  await until(() => turnDone(harness!))
  expect(reply(harness, 100)).toEqual({ decision: 'accept' })
  expect(harness.driver.getPendingRequests()).toEqual([])
  expect(ofType(harness, 'request_resolved').at(-1)).toMatchObject({ outcome: 'allowed', decidedBy: 'policy' })
})

test('a file-change approval card names every changed path', async () => {
  const change = { type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [{ path: '/w/a.ts', kind: { type: 'update' }, diff: '' }, { path: '/w/b.ts', kind: { type: 'add' }, diff: '' }] }
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', change)
    .serverRequest(101, 'item/fileChange/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'fc-1' })
    .item('completed', 'ct-1', { ...change, status: 'completed' })
    .completed('ct-1')
  harness = startHarness(script)
  harness.driver.send('edit')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  const card = ofType(harness, 'approval_request')[0]!
  expect(card).toMatchObject({ tool: 'Edit', input: { file_path: '/w/a.ts', paths: ['/w/a.ts', '/w/b.ts'] } })
  harness.driver.resolveApproval(card.requestId, 'allow')
  await until(() => turnDone(harness!))
  expect(reply(harness, 101)).toEqual({ decision: 'accept' })
})

test('a permissions request grants the requested profile for the turn on allow, nothing on deny', async () => {
  const permissions = { network: { enabled: true }, fileSystem: null }
  const script = new Script().boot().turn('ct-1')
    .serverRequest(102, 'item/permissions/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'p-1', permissions })
    .serverRequest(103, 'item/permissions/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'p-2', permissions })
    .completed('ct-1')
  harness = startHarness(script)
  harness.driver.send('fetch')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  harness.driver.resolveApproval(ofType(harness, 'approval_request')[0]!.requestId, 'allow')
  await until(() => ofType(harness!, 'approval_request').length === 2)
  harness.driver.resolveApproval(ofType(harness, 'approval_request')[1]!.requestId, 'deny')
  await until(() => turnDone(harness!))
  expect(reply(harness, 102)).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' })
  expect(reply(harness, 103)).toEqual({ permissions: {}, scope: 'turn' })
})

test('under auto a blocking question still asks, and the answer returns keyed by question id', async () => {
  const script = new Script().boot().turn('ct-1')
    .serverRequest(104, 'item/tool/requestUserInput', {
      threadId: THREAD_ID, turnId: 'ct-1', itemId: 'q-item',
      questions: [{ id: 'q1', header: 'Branch', question: 'Which branch?', options: [{ label: 'main', description: 'default' }, { label: 'dev' }] }],
    })
    .completed('ct-1')
  harness = startHarness(script, { getApprovalPolicy: () => 'auto' })
  harness.driver.send('ask me')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  const question = ofType(harness, 'question_request')[0]!
  expect(question.questions[0]).toMatchObject({ question: 'Which branch?', header: 'Branch', options: [{ label: 'main', description: 'default' }, { label: 'dev' }] })
  expect(harness.statuses.at(-1)).toBe('permission')
  expect(harness.driver.answerQuestion(question.requestId, { 'Which branch?': { options: ['nope'] } }).ok).toBe(false)
  expect(harness.driver.answerQuestion(question.requestId, { 'Which branch?': { options: ['dev'] } })).toEqual({ ok: true })
  await until(() => turnDone(harness!))
  expect(reply(harness, 104)).toEqual({ answers: { q1: { answers: ['dev'] } } })
})

test('under auto an async question still asks; its answer is input to the active turn', async () => {
  const asking = { type: 'agentMessage', id: 'ask-1', text: 'Proceed?\n- yes\n- no', delivery: 'async', questions: [{ title: 'Proceed?', options: ['yes', 'no'] }] }
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', asking)
    .request('turn/start', { turn: { id: 'ct-1', status: 'inProgress', items: [], error: null } })
    .item('completed', 'ct-1', asking)
    .item('completed', 'ct-1', { type: 'agentMessage', id: 'msg-2', text: 'answered', questions: null })
    .completed('ct-1')
  harness = startHarness(script, { getApprovalPolicy: () => 'auto' })
  harness.driver.send('ask me')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  const question = ofType(harness, 'question_request')[0]!
  expect(question.questions).toEqual([{ question: 'Proceed?', header: '', multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] }])
  harness.driver.answerQuestion(question.requestId, { 'Proceed?': { options: ['yes'] } })
  await until(() => turnDone(harness!))
  expect(sentRequest(harness, 'turn/start', 1)).toEqual({ threadId: THREAD_ID, input: [{ type: 'text', text: 'Proceed?: yes', text_elements: [] }] })
  // One Kawai turn throughout; the completed item does not ask again.
  expect(ofType(harness, 'turn_started')).toHaveLength(1)
  expect(ofType(harness, 'question_request')).toHaveLength(1)
})

test('interrupt cancels a pending card and Codex hears cancel', async () => {
  const script = new Script().boot().turn('ct-1')
    .item('started', 'ct-1', COMMAND)
    .serverRequest(105, 'item/commandExecution/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'cmd-1', command: 'git push origin' })
    .request('turn/interrupt', {})
    .completed('ct-1', 'interrupted')
  harness = startHarness(script)
  harness.driver.send('push it')
  await until(() => harness!.driver.getPendingRequests().length === 1)
  await harness.driver.interrupt()
  expect(reply(harness, 105)).toEqual({ decision: 'cancel' })
  expect(ofType(harness, 'request_resolved').at(-1)).toMatchObject({ outcome: 'cancelled' })
  expect(harness.driver.getPendingRequests()).toEqual([])
  expect(harness.statuses.at(-1)).toBe('waiting')
})

test('approvalsReviewer is "user" at start and resume under both policies even when the home selects auto_review', async () => {
  for (const policy of ['manual', 'auto'] as const) {
    for (const method of ['thread/start', 'thread/resume'] as const) {
      const dirs = tempDirs()
      // A temp home only — the real ~/.codex is never read or written.
      fs.writeFileSync(path.join(dirs.home, 'config.toml'), 'approvals_reviewer = "auto_review"\n')
      const script = new Script().boot(method).turn('ct-1')
        .item('started', 'ct-1', COMMAND)
        .serverRequest(106, 'item/commandExecution/requestApproval', { threadId: THREAD_ID, turnId: 'ct-1', itemId: 'cmd-1', command: 'git push origin' })
        .completed('ct-1')
      harness = startHarness(script, { getApprovalPolicy: () => policy, ...(method === 'thread/resume' ? { resumeThreadId: THREAD_ID } : {}) }, dirs)
      harness.driver.send('push it')
      expect(sentRequest(harness, method)).toBeUndefined()
      await until(() => harness!.sent.some(message => message.method === method))
      expect(sentRequest(harness, method)).toMatchObject({ approvalsReviewer: 'user', approvalPolicy: 'on-request' })
      // The escalation reached Kawai, and Kawai's policy decided it.
      if (policy === 'manual') {
        await until(() => harness!.driver.getPendingRequests().length === 1)
        harness.driver.resolveApproval(harness.driver.getPendingRequests()[0]!.requestId, 'deny')
      }
      await until(() => turnDone(harness!))
      expect(reply(harness, 106)).toEqual({ decision: policy === 'manual' ? 'decline' : 'accept' })
      expect(ofType(harness, 'request_resolved')[0]).toMatchObject({ decidedBy: policy === 'manual' ? 'user' : 'policy' })
      harness.cleanup()
      harness = null
    }
  }
})
