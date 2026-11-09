// Immediate Claude request handling (design §5, Q01-Q04, task 4.3 Claude
// portion): the production ClaudeSession on a controlled query. Each test
// calls the canUseTool the session passed in its SDK options, answers through
// the public driver methods, and asserts the exact PermissionResult the SDK
// receives plus the ordered request and request_resolved events.
import { describe, expect, test } from 'bun:test'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { AgentRuntimeError } from '../src/errors.js'
import type { AgentEvent, PendingRequest } from '../src/events.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function idle(hooks: DriverHooks = {}): Promise<Driver> {
  const f = driver(hooks)
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

/** Calls the SDK boundary exactly as the CLI bridge does. */
function ask(f: Driver, tool: string, input: Record<string, unknown>, signal = new AbortController().signal): Promise<PermissionResult | null> {
  const canUseTool = f.q().options.canUseTool
  if (!canUseTool) throw new Error('the session did not wire canUseTool')
  return canUseTool(tool, input, { signal, suggestions: [], toolUseID: 'toolu_1' } as never)
}

const QUESTION = { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }
const COMMAND = { command: 'ls', nested: { path: '/tmp/safe', args: ['-l'] } }

type RequestEvent = Extract<AgentEvent, { type: 'question_request' | 'approval_request' }>
const isRequest = (e: AgentEvent): e is RequestEvent => e.type === 'question_request' || e.type === 'approval_request'
/** The request and resolved events, with what the order oracle needs. */
const trail = (f: Driver) =>
  f.events.flatMap((e) =>
    isRequest(e) ? [`${e.type}:${e.requestId}`] : e.type === 'request_resolved' ? [`resolved:${e.requestId}:${e.outcome}:${e.decidedBy ?? '-'}`] : [],
  )
const seqOf = (f: Driver, type: string) => f.events.filter((e) => e.type === type).map((e) => e.sequence)

describe('Claude requests: inline responses (Q01, Q02)', () => {
  // @covers: agent-runtime › Requests can be answered immediately › Inline response
  test('Q01: a question answered inside onRequest reaches the SDK once, after its request event', async () => {
    let outcomes: unknown[] = []
    let seen: PendingRequest | null = null
    const f = await idle({
      onRequest: (request) => {
        seen = request
        outcomes = [f.d.answerQuestion(request.requestId, { 'Which colour?': { options: ['Blue'] } }), f.d.answerQuestion(request.requestId, { 'Which colour?': { options: ['Red'] } })]
      },
    })
    const result = await ask(f, 'AskUserQuestion', QUESTION)
    expect(result).toEqual({ behavior: 'allow', updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Blue' } } })
    const id = (seen as PendingRequest | null)?.requestId
    expect(outcomes).toEqual([{ ok: true }, { ok: false, reason: 'not-pending', message: expect.any(String) }])
    expect(trail(f)).toEqual([`question_request:${id}`, `resolved:${id}:answered:caller`])
    expect(seqOf(f, 'question_request')[0]!).toBeLessThan(seqOf(f, 'request_resolved')[0]!)
    expect(f.d.pendingRequests()).toEqual([])
  })

  // @covers: agent-runtime › Requests can be answered immediately › Inline response
  test('Q02: an approval denied from its request event is one non-interrupting denial', async () => {
    let outcome: unknown = null
    const f = await idle({
      unansweredRequests: 'wait',
      onEvent: (e) => {
        if (e.type === 'approval_request') outcome = f.d.resolveApproval(e.requestId, 'deny')
      },
    })
    const result = ask(f, 'Bash', COMMAND)
    // Settled inside the call: asserted before awaiting, so a miss is a wrong value, not a hang.
    expect(outcome).toEqual({ ok: true })
    const id = f.events.find(isRequest)!.requestId
    expect(trail(f)).toEqual([`approval_request:${id}`, `resolved:${id}:denied:caller`])
    expect(f.d.pendingRequests()).toEqual([])
    expect(await result).toEqual({ behavior: 'deny', message: 'The tool use was denied' })
  })
})

describe('Claude requests: cancellation against an inline answer (Q03, G2)', () => {
  test('Q03: an abort inside onRequest wins over the allow that follows it', async () => {
    const controller = new AbortController()
    let outcome: unknown = null
    const f = await idle({
      onRequest: (request) => {
        controller.abort()
        outcome = f.d.resolveApproval(request.requestId, 'allow')
      },
    })
    const result = await ask(f, 'Bash', COMMAND, controller.signal)
    expect(result).toEqual({ behavior: 'deny', message: 'The request was cancelled (cancelled)', interrupt: true })
    expect(outcome).toEqual({ ok: false, reason: 'not-pending', message: expect.any(String) })
    const id = f.events.find(isRequest)!.requestId
    expect(trail(f)).toEqual([`approval_request:${id}`, `resolved:${id}:cancelled:-`])
  })

  test('Q03: an abort inside the request event wins over the answer that follows it', async () => {
    const controller = new AbortController()
    let outcome: unknown = null
    const f = await idle({
      unansweredRequests: 'wait',
      onEvent: (e) => {
        if (e.type !== 'question_request') return
        controller.abort()
        outcome = f.d.answerQuestion(e.requestId, { 'Which colour?': { options: ['Red'] } })
      },
    })
    const result = ask(f, 'AskUserQuestion', QUESTION, controller.signal)
    expect(outcome).toMatchObject({ ok: false, reason: 'not-pending' })
    const id = f.events.find(isRequest)!.requestId
    expect(trail(f)).toEqual([`question_request:${id}`, `resolved:${id}:cancelled:-`])
    expect(await result).toEqual({ behavior: 'deny', message: 'The request was cancelled (cancelled)', interrupt: true })
  })

  test('Q03: an answer before the abort is kept and the abort settles nothing more', async () => {
    const controller = new AbortController()
    const f = await idle({
      onRequest: (request) => {
        f.d.resolveApproval(request.requestId, 'allow')
        controller.abort()
      },
    })
    const result = await ask(f, 'Bash', COMMAND, controller.signal)
    expect(result).toEqual({ behavior: 'allow', updatedInput: COMMAND })
    const id = f.events.find(isRequest)!.requestId
    expect(trail(f)).toEqual([`approval_request:${id}`, `resolved:${id}:allowed:caller`])
  })

  test('Q03: a signal already aborted at entry is an interrupting denial with no request published', async () => {
    const controller = new AbortController()
    controller.abort()
    const calls: PendingRequest[] = []
    const f = await idle({ onRequest: (request) => calls.push(request) })
    const before = f.events.length
    const result = await ask(f, 'Bash', COMMAND, controller.signal)
    expect(result).toEqual({ behavior: 'deny', message: 'The request was cancelled (cancelled)', interrupt: true })
    expect([calls.length, f.events.length - before, f.d.pendingRequests().length]).toEqual([0, 0, 0])
  })
})

describe('Claude requests: private original facts (G1)', () => {
  test('mutating every public view of an approval, and the SDK caller\'s input, never changes what allow executes', async () => {
    const f = await idle({
      unansweredRequests: 'wait',
      onEvent: (e) => {
        if (e.type === 'approval_request') ((e.input as { nested: { path: string } }).nested.path = '/etc/event')
      },
      onRequest: (request) => {
        if (request.kind === 'approval') ((request.input as { nested: { args: string[] } }).nested.args.push('-rf'))
      },
    })
    const callerInput = structuredClone(COMMAND)
    const answer = ask(f, 'Bash', callerInput)
    callerInput.nested.path = '/etc/caller'
    const [listed] = f.d.pendingRequests()
    if (listed?.kind !== 'approval') throw new Error('expected one pending approval')
    ;(listed.input as { command: string }).command = 'rm'
    expect(f.d.pendingRequests()[0]).toMatchObject({ kind: 'approval', tool: 'Bash', input: COMMAND })
    expect(f.d.resolveApproval(listed.requestId, 'allow')).toEqual({ ok: true })
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: COMMAND })
  })

  test('mutating published question options never changes validation; the original answer then settles once', async () => {
    const f = await idle({
      unansweredRequests: 'wait',
      onEvent: (e) => {
        if (e.type === 'question_request') e.questions[0]!.options.push({ label: 'Green' })
      },
      onRequest: (request) => {
        if (request.kind === 'question') request.questions[0]!.multiSelect = true
      },
    })
    const answer = ask(f, 'AskUserQuestion', QUESTION)
    const [listed] = f.d.pendingRequests()
    if (listed?.kind !== 'question') throw new Error('expected one pending question')
    listed.questions[0]!.options.push({ label: 'Purple' })
    const id = listed.requestId
    expect(f.d.answerQuestion(id, { 'Which colour?': { options: ['Green'] } })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(f.d.answerQuestion(id, { 'Which colour?': { options: ['Purple'] } })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(f.d.answerQuestion(id, { 'Which colour?': { options: ['Red', 'Blue'] } })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(f.d.answerQuestion(id, { 'Which colour?': { options: ['Red'] } })).toEqual({ ok: true })
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Red' } } })
    expect(trail(f)).toEqual([`question_request:${id}`, `resolved:${id}:answered:caller`])
  })
})

describe('Claude requests: headless defaults (Q04)', () => {
  test('Q04: with no handler, or a throwing one, the default denies at once; wait keeps the request for the host', async () => {
    const none = await idle()
    expect(await ask(none, 'Bash', COMMAND)).toEqual({ behavior: 'deny', message: 'No answer was given; the request is denied' })
    const throwing = await idle({ onRequest: () => { throw new Error('host bug') } })
    expect(await ask(throwing, 'Bash', COMMAND)).toEqual({ behavior: 'deny', message: 'No answer was given; the request is denied' })
    for (const f of [none, throwing]) {
      const id = f.events.find(isRequest)!.requestId
      expect(trail(f)).toEqual([`approval_request:${id}`, `resolved:${id}:denied:policy`])
      expect(f.d.pendingRequests()).toEqual([])
    }
    const waiting = await idle({ unansweredRequests: 'wait', onRequest: () => {} })
    let settled = false
    const answer = ask(waiting, 'Bash', COMMAND).then((r) => ((settled = true), r))
    await tick(5)
    expect([settled, waiting.d.pendingRequests().length]).toEqual([false, 1])
    waiting.d.resolveApproval(waiting.d.pendingRequests()[0]!.requestId, 'allow')
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: COMMAND })
  })
})

describe('Claude requests: interrupt, stop and process end (Q03)', () => {
  const cancelledBy = (reason: string): PermissionResult => ({ behavior: 'deny', message: `The request was cancelled (${reason})`, interrupt: true })

  test('Q03: interrupt cancels a pending request once and a later answer is refused', async () => {
    const f = await idle({ unansweredRequests: 'wait' })
    const result = ask(f, 'AskUserQuestion', QUESTION)
    const id = f.d.pendingRequests()[0]!.requestId
    await f.d.interrupt()
    expect(f.d.answerQuestion(id, { 'Which colour?': { options: ['Red'] } })).toMatchObject({ ok: false, reason: 'not-pending' })
    expect(await result).toEqual(cancelledBy('interrupted'))
    expect(trail(f)).toEqual([`question_request:${id}`, `resolved:${id}:cancelled:-`])
  })

  test('Q03: an interrupt inside onRequest wins over the default denial', async () => {
    let id = ''
    const f = await idle({
      onRequest: (request) => {
        id = request.requestId
        void f.d.interrupt()
      },
    })
    expect(await ask(f, 'Bash', COMMAND)).toEqual(cancelledBy('interrupted'))
    expect(trail(f)).toEqual([`approval_request:${id}`, `resolved:${id}:cancelled:-`])
  })

  // @covers: agent-runtime › Requests can be answered immediately › Response races stop
  test('Q03: stop settles a pending request once; later answers report stopped and later requests publish nothing', async () => {
    const f = await idle({ unansweredRequests: 'wait' })
    const result = ask(f, 'Bash', COMMAND)
    const id = f.d.pendingRequests()[0]!.requestId
    const stop = f.d.kill()
    expect(f.d.resolveApproval(id, 'allow')).toMatchObject({ ok: false, reason: 'stopped' })
    expect(await result).toEqual(cancelledBy('stopped'))
    const before = f.events.length
    expect(await ask(f, 'Bash', COMMAND)).toEqual({ behavior: 'deny', message: 'The session is stopping', interrupt: true })
    expect(f.events.length).toBe(before)
    expect(await stop).toMatchObject({ scope: 'agent-processes', mode: 'kill', js: 'settled' })
    expect(trail(f)).toEqual([`approval_request:${id}`, `resolved:${id}:cancelled:-`])
  })

  // @covers: agent-runtime › Requests can be answered immediately › Response races stop
  test('Q03: an answer given before stop is kept and stop settles nothing more', async () => {
    let id = ''
    const f = await idle({
      unansweredRequests: 'wait',
      onRequest: (request) => {
        id = request.requestId
        f.d.resolveApproval(id, 'deny')
      },
    })
    const result = ask(f, 'Bash', COMMAND)
    await f.d.kill()
    expect(await result).toEqual({ behavior: 'deny', message: 'The tool use was denied' })
    expect(trail(f)).toEqual([`approval_request:${id}`, `resolved:${id}:denied:caller`])
  })

  test('Q03: a stop requested inside onRequest cancels the request and completes without joining the callback', async () => {
    let stop: Promise<unknown> | null = null
    const f = await idle({ onRequest: () => void (stop = f.d.kill()) })
    expect(await ask(f, 'Bash', COMMAND)).toEqual(cancelledBy('stopped'))
    expect(await stop).toMatchObject({ mode: 'kill', js: 'settled' })
    expect(trail(f).at(-1)).toMatch(/:cancelled:-$/)
  })

  test('Q03: an unexpected process end cancels a pending request', async () => {
    const f = await idle({ unansweredRequests: 'wait' })
    const result = ask(f, 'Bash', COMMAND)
    f.q().exit()
    expect(await result).toEqual(cancelledBy('process ended'))
    expect(f.d.pendingRequests()).toEqual([])
  })
})

describe('Claude requests: refusals and reentrant observation (Q03)', () => {
  test('Q03: invalid, wrong-kind, unknown and stale answers are refused without settling; the first valid answer wins', async () => {
    const f = await idle({ unansweredRequests: 'wait' })
    const first = ask(f, 'Bash', COMMAND)
    const stale = f.d.pendingRequests()[0]!.requestId
    f.d.resolveApproval(stale, 'allow')
    await first
    const result = ask(f, 'AskUserQuestion', QUESTION)
    const id = f.d.pendingRequests()[0]!.requestId
    const refused = [
      f.d.answerQuestion(id, { 'Which colour?': { options: ['Green'] } }),
      f.d.answerQuestion(id, { 'Another question?': { text: 'x' } }),
      f.d.resolveApproval(id, 'allow'),
      f.d.answerQuestion('req-unknown', { 'Which colour?': { options: ['Red'] } }),
      f.d.answerQuestion(stale, { 'Which colour?': { options: ['Red'] } }),
    ].map((o) => (o.ok ? 'ok' : o.reason))
    expect(refused).toEqual(['invalid', 'invalid', 'invalid', 'not-pending', 'not-pending'])
    expect(f.d.pendingRequests().map((r) => r.requestId)).toEqual([id])
    expect(f.d.answerQuestion(id, { 'Which colour?': { text: 'Teal' } })).toEqual({ ok: true })
    expect(f.d.answerQuestion(id, { 'Which colour?': { options: ['Red'] } })).toMatchObject({ ok: false, reason: 'not-pending' })
    expect(await result).toEqual({ behavior: 'allow', updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Teal' }, response: 'Teal' } })
    expect(trail(f).filter((t) => t.includes(id))).toEqual([`question_request:${id}`, `resolved:${id}:answered:caller`])
  })

  test('Q03: onRequest still sees a request its event already answered, and neither its answer nor the default overrides it', async () => {
    const seen: string[] = []
    const f = await idle({
      onEvent: (e) => {
        if (e.type === 'approval_request') f.d.resolveApproval(e.requestId, 'allow', { decidedBy: 'rules' })
      },
      onRequest: (request) => {
        const o = f.d.resolveApproval(request.requestId, 'deny')
        seen.push(o.ok ? 'ok' : o.reason)
      },
    })
    expect(await ask(f, 'Bash', COMMAND)).toEqual({ behavior: 'allow', updatedInput: COMMAND })
    const id = f.events.find(isRequest)!.requestId
    expect(seen).toEqual(['not-pending'])
    expect(trail(f)).toEqual([`approval_request:${id}`, `resolved:${id}:allowed:rules`])
  })

  test('a settled request removes the abort listener it added', async () => {
    const controller = new AbortController()
    const added: unknown[] = []
    const removed: unknown[] = []
    const signal = controller.signal
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => (added.push(listener), add(type, listener, options))) as typeof signal.addEventListener
    signal.removeEventListener = ((type: string, listener: EventListener) => (removed.push(listener), remove(type, listener))) as typeof signal.removeEventListener
    const f = await idle({ onRequest: (request) => f.d.resolveApproval(request.requestId, 'allow') })
    await ask(f, 'Bash', COMMAND, signal)
    expect(added).toHaveLength(1)
    expect(removed).toEqual(added)
  })
})

describe('Claude requests: a throwing handler (Q04)', () => {
  test('Q04: a throwing onRequest denies by default and its raw error is retained as the later stop cause', async () => {
    const thrown = new Error('host bug')
    const f = await idle({ onRequest: () => { throw thrown } })
    expect(await ask(f, 'Bash', COMMAND)).toEqual({ behavior: 'deny', message: 'No answer was given; the request is denied' })
    let failure: unknown = null
    try {
      await f.d.kill()
    } catch (error) {
      failure = error
    }
    expect([(failure as AgentRuntimeError | null)?.category, (failure as AgentRuntimeError | null)?.causes]).toEqual(['stop', [thrown]])
  })
})
