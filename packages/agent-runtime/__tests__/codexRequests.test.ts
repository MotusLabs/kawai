// Codex server requests through the public driver and the owned fake
// app-server (Q01-Q04, P07-P15): onRequest answers inline, headless denial,
// explicit wait, answer races with interrupt and stop, fixed answers for
// disabled input and `never`, unknown methods, elicitation modes, host tools
// over dynamic tools, the pre-submit decision and the observers. Each case
// reads what the app-server actually received as the reply.
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { CodexAgentDriver } from '../src/contract.js'
import type { PendingRequest } from '../src/events.js'
import type { CodexPermissions, ToolSet } from '../src/options.js'
import { codexDriver, PERMISSIONS, refusal, sent, stopDrivers, waitFor, type HarnessOptions } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

const QUESTION = { questions: [{ id: 'q1', question: 'Color?', header: 'Pick', options: [{ label: 'red' }, { label: 'blue' }], isOther: false }] }
const ask = (method: string, params: unknown = {}) => `/ask ${method} ${JSON.stringify(params)}`

const parsed = (text: string | null): unknown => {
  try {
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

type Answer = (driver: CodexAgentDriver, request: PendingRequest) => void

/** One started driver and one turn; `answer` runs as onRequest with the driver. */
async function run(text: string, options: HarnessOptions = {}, answer?: Answer) {
  let driver: CodexAgentDriver | null = null
  const h = codexDriver(answer ? { ...options, callbacks: { ...options.callbacks, onRequest: (request) => answer(driver!, request) } } : options)
  driver = h.driver
  await h.driver.start()
  const result = await (await h.driver.send(text)).result
  return { h, result, reply: parsed(result.finalText) }
}

describe('Codex requests: inline answers (Q01/Q02)', () => {
  // @covers: agent-runtime › Requests can be answered immediately › Inline response
  test('Q01: a question answered from onRequest replies keyed by question id; the request event precedes its resolution', async () => {
    let seen: PendingRequest | null = null
    const outcomes: unknown[] = []
    const { h, reply } = await run(ask('item/tool/requestUserInput', QUESTION), {}, (driver, request) => {
      seen = request
      outcomes.push(driver.answerQuestion(request.requestId, { 'Color?': { options: ['red'] } }))
      outcomes.push(driver.answerQuestion(request.requestId, { 'Color?': { options: ['blue'] } }))
    })
    expect(outcomes).toEqual([{ ok: true }, expect.objectContaining({ ok: false, reason: 'not-pending' })])
    expect(reply).toEqual({ answers: { q1: { answers: ['red'] } } })
    expect(seen).toMatchObject({ kind: 'question', questions: [{ question: 'Color?', isOther: false }] })
    const types = h.types()
    expect(types.indexOf('question_request')).toBeLessThan(types.indexOf('request_resolved'))
    expect(h.events.find((e) => e.type === 'request_resolved')).toMatchObject({ outcome: 'answered', decidedBy: 'caller' })
  })

  test('Q02: an approval denied inline replies decline once and the command is not accepted', async () => {
    const { h, reply } = await run(ask('item/commandExecution/requestApproval', { command: 'rm -rf /' }), {}, (driver, request) => void driver.resolveApproval(request.requestId, 'deny'))
    expect(reply).toEqual({ decision: 'decline' })
    expect(h.events.filter((e) => e.type === 'request_resolved')).toEqual([expect.objectContaining({ outcome: 'denied', tool: 'Bash' })])
  })

  const allows: Array<[string, unknown, unknown]> = [
    ['item/fileChange/requestApproval', {}, { decision: 'accept' }],
    ['execCommandApproval', { command: ['ls'] }, { decision: 'approved' }],
    ['applyPatchApproval', {}, { decision: 'approved' }],
    ['item/permissions/requestApproval', { permissions: { network: { enabled: true }, other: 1 } }, { permissions: { network: { enabled: true } }, scope: 'turn' }],
    ['mcpServer/elicitation/request', { mode: 'url', serverName: 's', message: 'm', url: 'https://x', elicitationId: 'e', _meta: null }, { action: 'accept', content: null, _meta: null }],
    ['mcpServer/elicitation/request', { mode: 'openai/userVerification', serverName: 's', title: 't', description: 'd', challenge: 'c', _meta: null }, { action: 'accept', content: null, _meta: null }],
  ]
  for (const [method, params, expected] of allows) {
    test(`Q01: allow on ${method}${(params as { mode?: string }).mode ? ` (${(params as { mode: string }).mode})` : ''} replies its protocol acceptance`, async () => {
      const { reply } = await run(ask(method, params), {}, (driver, request) => void driver.resolveApproval(request.requestId, 'allow'))
      expect(reply).toEqual(expected)
    })
  }
})

describe('Codex requests: headless and waiting (Q03/Q04)', () => {
  test('Q04: with no onRequest the request is denied at once by policy', async () => {
    const { h, reply } = await run(ask('item/commandExecution/requestApproval', { command: 'ls' }))
    expect(reply).toEqual({ decision: 'decline' })
    expect(h.events.find((e) => e.type === 'request_resolved')).toMatchObject({ outcome: 'denied', decidedBy: 'policy' })
    expect(h.driver.pendingRequests()).toEqual([])
  })

  test('Q04/R11: a throwing onRequest still denies safely; the throw stays owned and fails the stop', async () => {
    const boom = new Error('host callback failed')
    const { h, reply } = await run(ask('item/commandExecution/requestApproval', {}), { callbacks: { onRequest: () => { throw boom } } })
    expect(reply).toEqual({ decision: 'decline' })
    expect((await refusal(h.driver.kill())).causes).toContain(boom)
  })

  test('Q03: under wait an invalid answer stays pending, the first valid answer wins, a duplicate is refused', async () => {
    const h = codexDriver({ unansweredRequests: 'wait' })
    await h.driver.start()
    const handle = await h.driver.send(ask('item/tool/requestUserInput', QUESTION))
    const [pending] = (await waitFor(() => (h.driver.pendingRequests().length ? h.driver.pendingRequests() : null)))!
    expect(h.driver.answerQuestion(pending!.requestId, { 'Color?': { options: ['green'] } })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.driver.answerQuestion(pending!.requestId, { 'Color?': { text: 'free' } })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.driver.resolveApproval(pending!.requestId, 'allow')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.driver.pendingRequests()).toHaveLength(1)
    expect(h.driver.answerQuestion(pending!.requestId, { 'Color?': { options: ['blue'] } })).toEqual({ ok: true })
    expect(h.driver.answerQuestion(pending!.requestId, { 'Color?': { options: ['red'] } })).toMatchObject({ ok: false, reason: 'not-pending' })
    expect(JSON.parse((await handle.result).finalText!)).toEqual({ answers: { q1: { answers: ['blue'] } } })
  })

  test('Q03: interrupt cancels a pending request (Codex hears cancel) and a late answer is refused', async () => {
    const h = codexDriver({ unansweredRequests: 'wait' })
    await h.driver.start()
    const handle = await h.driver.send(ask('item/commandExecution/requestApproval', {}))
    const [pending] = (await waitFor(() => (h.driver.pendingRequests().length ? h.driver.pendingRequests() : null)))!
    await h.driver.interrupt()
    expect((await handle.result).outcome).toBe('interrupted')
    expect(h.driver.resolveApproval(pending!.requestId, 'allow')).toMatchObject({ ok: false, reason: 'not-pending' })
    await waitFor(() => h.root.received().some((m) => m.id === 1000 && m.result))
    expect(h.root.received().find((m) => m.id === 1000)!.result).toEqual({ decision: 'cancel' })
    expect(h.events.find((e) => e.type === 'request_resolved')).toMatchObject({ outcome: 'cancelled' })
  })

  // @covers: agent-runtime › Requests can be answered immediately › Response races stop
  test('Q03: stop cancels a pending request, joins its handler, and an answer after stop is refused stopped', async () => {
    const h = codexDriver({ unansweredRequests: 'wait' })
    await h.driver.start()
    const handle = await h.driver.send(ask('item/commandExecution/requestApproval', {}))
    const [pending] = (await waitFor(() => (h.driver.pendingRequests().length ? h.driver.pendingRequests() : null)))!
    await h.driver.kill()
    expect(h.driver.resolveApproval(pending!.requestId, 'allow')).toMatchObject({ ok: false, reason: 'stopped' })
    expect((await handle.result).error?.category).toBe('stopped')
  })
})

describe('Codex requests: fixed answers (Q04/P07)', () => {
  const restricted: CodexPermissions = { ...PERMISSIONS, approvalPolicy: 'never', userInput: 'disabled', elicitation: 'disabled' }
  const fixed: Array<[string, unknown, unknown]> = [
    ['item/tool/requestUserInput', QUESTION, { answers: {} }],
    ['item/commandExecution/requestApproval', {}, { decision: 'decline' }],
    ['execCommandApproval', {}, { decision: { denied: { rejection: 'approval policy is never' } } }],
    ['item/permissions/requestApproval', { permissions: { network: {} } }, { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { mode: 'url' }, { action: 'decline', content: null, _meta: null }],
  ]
  for (const [method, params, expected] of fixed) {
    test(`Q04: ${method} under never/disabled is answered at once with no request published`, async () => {
      let requested = 0
      const { h, reply } = await run(ask(method, params), { permissions: restricted, callbacks: { onRequest: () => void requested++ } })
      expect(reply).toEqual(expected)
      expect(requested).toBe(0)
      expect(h.types().filter((t) => t.endsWith('_request'))).toEqual([])
    })
  }

  test('Q04: an unknown server method fails closed with an error reply, and the stop does not fail for it', async () => {
    const { h, reply } = await run(ask('item/unknown/request', {}))
    expect(reply).toMatchObject({ code: -32601 })
    await h.driver.kill()
  })
})

describe('Codex host tools and submission seams (P09-P15)', () => {
  const calls: unknown[] = []
  const tools: ToolSet = {
    namespace: 'host',
    tools: [{ name: 'echo', description: 'Echo a value', inputSchema: z.object({ value: z.string() }), handler: async (input) => (calls.push(input), { content: `echo:${(input as { value: string }).value}` }) }],
  }

  test('P11: a valid bound tool runs once and its result is the dynamic-tool reply; thread/start registered the namespace', async () => {
    calls.length = 0
    const { h, reply } = await run(`/tool ${JSON.stringify({ namespace: 'host', tool: 'echo', arguments: { value: 'x' } })}`, { tools })
    expect(reply).toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'echo:x' }] })
    expect(calls).toEqual([{ value: 'x' }])
    expect(sent(h.root, 'thread/start')[0]!.params.dynamicTools).toEqual([expect.objectContaining({ type: 'namespace', name: 'host' })])
  })

  const wrong: Array<[string, Record<string, unknown>]> = [
    ['another thread', { threadId: 'thr-other', namespace: 'host', tool: 'echo', arguments: { value: 'x' } }],
    ['another namespace', { namespace: 'other', tool: 'echo', arguments: { value: 'x' } }],
    ['an unknown tool', { namespace: 'host', tool: 'missing', arguments: {} }],
    ['an invalid schema', { namespace: 'host', tool: 'echo', arguments: { value: 1 } }],
  ]
  for (const [name, params] of wrong) {
    test(`P10: a call naming ${name} is refused with zero handler invocations`, async () => {
      calls.length = 0
      const { reply } = await run(`/tool ${JSON.stringify(params)}`, { tools })
      expect(reply).toMatchObject({ success: false })
      expect(calls).toEqual([])
    })
  }

  test('P09: with no tools nothing is registered and a call is refused', async () => {
    const { h, reply } = await run(`/tool ${JSON.stringify({ namespace: 'host', tool: 'echo', arguments: { value: 'x' } })}`)
    expect(sent(h.root, 'thread/start')[0]!.params).not.toHaveProperty('dynamicTools')
    expect(reply).toMatchObject({ success: false })
  })

  test('P12: a refusing beforeSubmit rejects with category context before anything is written or emitted', async () => {
    const h = codexDriver({ beforeSubmit: () => ({ accepted: false, reason: 'no context' }) })
    await h.driver.start()
    expect((await refusal(h.driver.send('x'))).category).toBe('context')
    expect(sent(h.root, 'turn/start')).toEqual([])
    expect(h.events).toEqual([])
  })

  test('P13: an accepted submission keeps the identity beforeSubmit recorded on the wire, the events and the handle', async () => {
    const recorded: Array<{ messageUuid: string; turnId: string }> = []
    const h = codexDriver({ beforeSubmit: (s) => (recorded.push({ messageUuid: s.messageUuid, turnId: s.turnId }), { accepted: true }) })
    await h.driver.start()
    const handle = await h.driver.send('ctx', { messageUuid: 'caller-uuid' })
    await handle.result
    expect(recorded).toEqual([{ messageUuid: 'caller-uuid', turnId: handle.turnId }])
    expect(sent(h.root, 'turn/start')[0]!.params.clientUserMessageId).toBe('caller-uuid')
    expect(h.events.find((e) => e.type === 'user_message')).toMatchObject({ messageUuid: 'caller-uuid', turnId: handle.turnId })
  })

  // @covers: agent-runtime-policy › Observation does not grant permissions or leak inputs by default › Names-only observer
  test('P14/R03: the names-only observer sees tool names and ids, never inputs; repeated item ids count and publish once', async () => {
    const observations: unknown[] = []
    const items: string[] = []
    const { result } = await run('/facts', { onToolObservation: (o) => void observations.push(o), auditHooks: { onItem: (item) => void items.push(`${item.kind}:${item.itemId}`) } })
    expect(observations).toEqual([
      { phase: 'call', tool: 'Bash', toolCallId: 'cmd-1', turnId: result.turnId },
      { phase: 'result', tool: 'Bash', toolCallId: 'cmd-1', turnId: result.turnId, isError: false },
      { phase: 'call', tool: 'WebSearch', toolCallId: 'web-1', turnId: result.turnId },
    ])
    expect(JSON.stringify(observations)).not.toContain('SECRET')
    expect(result.toolCallCount).toBe(2)
    expect(result.compactionCount).toBe(1)
    expect(items).toContain('commandExecution:cmd-1')
  })

  // @covers: agent-runtime-policy › Observation does not grant permissions or leak inputs by default › Observer throws
  test('P15/R11: a throwing observer and event callback change no outcome; the throws stay owned', async () => {
    const boom = new Error('observer failed')
    const { h, result } = await run('/facts', { onToolObservation: () => { throw boom } })
    expect(result).toMatchObject({ outcome: 'success', toolCallCount: 2 })
    expect((await refusal(h.driver.kill())).causes).toContain(boom)
  })
})
