// @reads: packages/agent-runtime/__tests__/fixtures/**
// AnswerOptions.response (task-7811b455 R5, owner decision 14c44aa7; design
// §2's fifth exception) and the Claude background task's outputFile
// (contract D). Expected values are the answers and response the test gave
// and what the SDK boundary, the fake CLI (through the real SDK) or the fake
// Codex app-server received, never the driver's own report.
// - A Claude question takes a non-blank response unchanged, after its answers
//   validated, in place of the derived one; omission changes nothing.
// - A blank, null or non-string response, or a response beside invalid
//   answers, reports invalid and settles nothing: a later valid answer wins.
// - A response on a Claude approval, a Codex question or a Codex approval is
//   unsupported: invalid, nothing consumed, stale/stopped outcomes unchanged.
// - A Claude background task reports its native output file when the SDK
//   names one, and omits it otherwise.
import { afterEach, describe, expect, test } from 'bun:test'
import type { PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BackgroundTask } from '../src/activity.js'
import { createClaudeDriver } from '../src/claude/index.js'
import type { ClaudeAgentDriver } from '../src/contract.js'
import type { AgentEvent } from '../src/events.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'
import { codexDriver, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const silent = () => {}
const logger = { debug: silent, info: silent, warn: silent, error: silent }
const NOTE = 'No answer from the user within 5 minutes; the recommended option was selected automatically.'
const QUESTION = { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }
const COMMAND = { command: 'ls' }

const live: Array<{ kill(): Promise<unknown> }> = []
afterEach(async () => {
  for (const d of live.splice(0)) await d.kill().catch(() => {})
  await stopDrivers()
})

async function idle(hooks: DriverHooks = {}): Promise<Driver> {
  const f = driver({ unansweredRequests: 'wait', ...hooks })
  live.push(f.d)
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

function ask(f: Driver, tool: string, input: Record<string, unknown>): Promise<PermissionResult | null> {
  return f.q().options.canUseTool!(tool, input, { signal: new AbortController().signal, suggestions: [], toolUseID: 'toolu_1' } as never)
}

const resolved = (f: Driver) => f.events.filter((e): e is Extract<AgentEvent, { type: 'request_resolved' }> => e.type === 'request_resolved')

describe('AnswerOptions.response on a Claude question (public factory, fake CLI)', () => {
  // @covers: agent-runtime › Requests can be answered immediately › Explanatory response on a Claude question
  test('the CLI receives the chosen answer and the response unchanged; omitted, no response', async () => {
    const home = fakeClaudeHome()
    let response: string | undefined = NOTE
    const d: ClaudeAgentDriver = createClaudeDriver({
      launch: home.launch(), logger, permissions: { mode: 'default', enabledTools: ['AskUserQuestion'], disallowedTools: [] },
      callbacks: {
        onEvent: silent,
        onRequest: (request) => {
          if (request.kind === 'question') d.answerQuestion(request.requestId, { 'Which colour?': { options: ['Blue'] } }, { decidedBy: 'timeout', ...(response !== undefined ? { response } : {}) })
        },
      },
    })
    live.push(d)
    await d.start()
    const answered = async () => JSON.parse((await (await d.send(`ask AskUserQuestion ${JSON.stringify(QUESTION)}`)).result).finalText!.replace(/^allowed AskUserQuestion /, '')) as Record<string, unknown>
    const first = await answered()
    response = undefined
    const second = await answered()
    expect([first.answers, first.response]).toEqual([{ 'Which colour?': 'Blue' }, NOTE])
    expect([second.answers, 'response' in second]).toEqual([{ 'Which colour?': 'Blue' }, false])
  })
})

describe('AnswerOptions.response on the production Claude session', () => {
  test('a valid response replaces the derived one; omission keeps the derived text', async () => {
    const free = { questions: [{ question: 'Name?', header: 'Name', multiSelect: false, options: [{ label: 'A' }] }] }
    const f = await idle()
    const explicit = ask(f, 'AskUserQuestion', free)
    const [first] = f.d.pendingRequests()
    expect(f.d.answerQuestion(first!.requestId, { 'Name?': { text: 'typed' } }, { response: '  kept as given  ' })).toEqual({ ok: true })
    expect(await explicit).toEqual({ behavior: 'allow', updatedInput: { ...free, answers: { 'Name?': 'typed' }, response: '  kept as given  ' } })
    const derived = ask(f, 'AskUserQuestion', free)
    const [second] = f.d.pendingRequests()
    expect(f.d.answerQuestion(second!.requestId, { 'Name?': { text: 'typed' } })).toEqual({ ok: true })
    expect(await derived).toEqual({ behavior: 'allow', updatedInput: { ...free, answers: { 'Name?': 'typed' }, response: 'typed' } })
  })

  test('an invalid response or invalid answers settle nothing, and a later valid answer wins', async () => {
    const f = await idle()
    const answer = ask(f, 'AskUserQuestion', QUESTION)
    const [pending] = f.d.pendingRequests()
    const id = pending!.requestId
    const refusals = [
      f.d.answerQuestion(id, { 'Which colour?': { options: ['Red'] } }, { response: '' }),
      f.d.answerQuestion(id, { 'Which colour?': { options: ['Red'] } }, { response: '   ' }),
      f.d.answerQuestion(id, { 'Which colour?': { options: ['Red'] } }, { response: null as never }),
      f.d.answerQuestion(id, { 'Which colour?': { options: ['Red'] } }, { response: 5 as never }),
      f.d.answerQuestion(id, { 'Which colour?': { options: ['Green'] } }, { response: NOTE }),
      f.d.answerQuestion(id, { 'Which colour?': { options: ['Red', 'Blue'] } }, { response: NOTE }),
      f.d.answerQuestion(id, {}, { response: NOTE }),
      f.d.resolveApproval(id, 'allow', { response: NOTE }),
    ]
    expect(refusals.map((r) => r.ok === false && r.reason)).toEqual(Array(8).fill('invalid'))
    expect([f.d.pendingRequests().length, resolved(f)]).toEqual([1, []])
    expect(f.d.answerQuestion(id, { 'Which colour?': { options: ['Red'] } }, { response: NOTE, decidedBy: 'timeout' })).toEqual({ ok: true })
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Red' }, response: NOTE } })
    expect(resolved(f).map((e) => [e.outcome, e.decidedBy])).toEqual([['answered', 'timeout']])
  })

  test('a response on a Claude approval is invalid and leaves it pending; stale and stopped outcomes are unchanged', async () => {
    const f = await idle()
    const answer = ask(f, 'Bash', COMMAND)
    const [pending] = f.d.pendingRequests()
    const id = pending!.requestId
    expect(f.d.resolveApproval(id, 'deny', { response: NOTE })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(f.d.resolveApproval(id, 'allow', { response: NOTE })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(f.d.pendingRequests()).toHaveLength(1)
    expect(f.d.resolveApproval(id, 'allow')).toEqual({ ok: true })
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: COMMAND })
    expect(f.d.resolveApproval(id, 'allow', { response: NOTE })).toMatchObject({ ok: false, reason: 'not-pending' })
    await f.d.kill()
    expect(f.d.answerQuestion(id, {}, { response: NOTE })).toMatchObject({ ok: false, reason: 'stopped' })
  })
})

describe('AnswerOptions.response on Codex (public factory, owned app-server)', () => {
  test('a response on a Codex question or approval is invalid and consumes nothing', async () => {
    const h = codexDriver({ unansweredRequests: 'wait' })
    await h.driver.start()
    const ask = (method: string, params: unknown) => `/ask ${method} ${JSON.stringify(params)}`
    const question = { questions: [{ id: 'q1', question: 'Color?', header: 'Pick', options: [{ label: 'red' }, { label: 'blue' }], isOther: false }] }
    const turn = await h.driver.send(ask('item/tool/requestUserInput', question))
    const [q] = (await waitFor(() => (h.driver.pendingRequests().length ? h.driver.pendingRequests() : null)))!
    expect(h.driver.answerQuestion(q!.requestId, { 'Color?': { options: ['red'] } }, { response: NOTE })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.driver.pendingRequests()).toHaveLength(1)
    expect(h.driver.answerQuestion(q!.requestId, { 'Color?': { options: ['red'] } })).toEqual({ ok: true })
    expect(JSON.parse((await turn.result).finalText!)).toEqual({ answers: { q1: { answers: ['red'] } } })

    const approval = await h.driver.send(ask('item/commandExecution/requestApproval', { command: 'ls' }))
    const [a] = (await waitFor(() => (h.driver.pendingRequests().length ? h.driver.pendingRequests() : null)))!
    expect(h.driver.resolveApproval(a!.requestId, 'deny', { response: NOTE })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.driver.pendingRequests()).toHaveLength(1)
    expect(h.driver.resolveApproval(a!.requestId, 'deny')).toEqual({ ok: true })
    expect(JSON.parse((await approval.result).finalText!)).toEqual({ decision: 'decline' })
  })
})

describe('Claude background task outputFile (contract D)', () => {
  test('the native output file is reported when the SDK names one, and omitted otherwise', async () => {
    const reports: BackgroundTask[][] = []
    const f = await idle({ observers: { onBackgroundTasks: (tasks) => void reports.push(tasks) } })
    const handle = await f.d.send('run in background')
    const started = (taskId: string, toolUseId: string) => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, task_type: 'local_bash', is_backgrounded: true, description: `task ${taskId}`, uuid: `ts-${taskId}`, session_id: 'sess-1' }) as unknown as SDKMessage
    const ended = (taskId: string, outputFile?: unknown) => ({ ...(frames.taskNotification(taskId) as object), ...(outputFile !== undefined ? { output_file: outputFile } : {}) }) as unknown as SDKMessage
    const tool = (id: string) => ({ type: 'assistant', uuid: `a-${id}`, session_id: 'sess-1', parent_tool_use_id: null, message: { id: `m-${id}`, role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 1', run_in_background: true } }] } }) as unknown as SDKMessage
    f.q().push(tool('tu-1'), tool('tu-2'), tool('tu-3'), started('t1', 'tu-1'), started('t2', 'tu-2'), started('t3', 'tu-3'))
    f.q().push(ended('t1', '/tmp/claude/tasks/t1.output'), ended('t2'), ended('t3', ''))
    await tick()
    f.q().push(frames.result([handle.messageUuid], 'ok'))
    await handle.result
    const last = reports.at(-1)!
    expect(last.map((t) => [t.taskId, t.outputFile])).toEqual([['t1', '/tmp/claude/tasks/t1.output'], ['t2', undefined], ['t3', undefined]])
    expect(last.filter((t) => 'outputFile' in t).map((t) => t.taskId)).toEqual(['t1'])
  })
})
