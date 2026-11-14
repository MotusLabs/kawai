// @reads: packages/agent-runtime/__tests__/fixtures/**
// Claude composePrompt (task-7811b455 R4, owner decision 88485165; design
// §2's fourth exception). Expected values are what the test's own composer
// returned and what the CLI (the fake, through the real SDK) or the
// controlled query received, never the driver's own report.
// - An accepted send's prompt carries the composer's pasted content and peer
//   origin beside its literal text and minted UUID; omitted or undefined
//   leaves the prompt byte-identical.
// - The composer runs once, synchronously, after beforeSubmit accepted, with
//   the same identities; a refused beforeSubmit skips it.
// - A throw, a thenable or any other shape refuses the send with category
//   context: no prompt, no event, no turn. A thenable's rejection is the
//   stop's raw cause.
// - A stop or interrupt from inside the composer is decided before commit.
// - Each prompt has its own copy; a queued prompt never borrows another's.
// - The echo of an enriched prompt is suppressed by its UUID, and a later
//   foreign message with the same literal text is still shown.
import { afterEach, describe, expect, test } from 'bun:test'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeDriver } from '../src/claude/index.js'
import type { ClaudeAgentDriver } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { AgentEvent } from '../src/events.js'
import type { ComposePrompt, SubmitContext } from '../src/options.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const silent = () => {}
const logger = { debug: silent, info: silent, warn: silent, error: silent }
const WORKSPACE = '<workspace_context>\nplan p-1\n</workspace_context>'

async function refusal(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AgentRuntimeError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

const live: Array<{ kill(): Promise<unknown> }> = []
afterEach(async () => {
  for (const d of live.splice(0)) await d.kill().catch(() => {})
})

async function idle(hooks: DriverHooks = {}): Promise<Driver> {
  const f = driver(hooks)
  live.push(f.d)
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

const prompts = (f: Driver) => f.q().prompts as Array<SDKUserMessage & Record<string, unknown>>
const userFrame = (text: string, uuid?: string): SDKUserMessage =>
  ({ type: 'user', session_id: 'sess-1', parent_tool_use_id: null, ...(uuid ? { uuid } : {}), message: { role: 'user', content: text } }) as SDKUserMessage

describe('Claude composePrompt through the public factory and the fake CLI', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Claude prompt composition
  test('an accepted send carries pasted content and peer origin beside its literal text and UUID; a throw sends nothing', async () => {
    const home = fakeClaudeHome()
    const seen: SubmitContext[] = []
    let mode: 'enrich' | 'throw' | 'none' = 'enrich'
    const boom = new Error('composer down')
    const events: AgentEvent[] = []
    const d: ClaudeAgentDriver = createClaudeDriver({
      launch: home.launch(), logger, permissions: { mode: 'default', enabledTools: [], disallowedTools: [] },
      callbacks: { onEvent: (event) => void events.push(event) },
      beforeSubmit: () => ({ accepted: true }),
      composePrompt: (submission) => {
        seen.push({ ...submission })
        if (mode === 'throw') throw boom
        return mode === 'enrich' ? { pastedContent: [WORKSPACE], origin: { kind: 'peer', from: 'chat-peer-1' } } : undefined
      },
    })
    live.push(d)
    await d.start()
    const handle = await d.send('/plan literal text', { messageUuid: '00000000-0000-4000-8000-0000000000a1', context: { plan: 'p-1' } })
    expect((await handle.result).outcome).toBe('success')
    mode = 'throw'
    const before = events.length
    const threw = await refusal(d.send('never sent'))
    expect([threw.category, threw.causes]).toEqual(['context', [boom]])
    expect(events.slice(before)).toEqual([])
    mode = 'none'
    const plain = await d.send('plain text')
    await plain.result
    const users = home.received().filter((frame) => frame.type === 'user')
    expect(users.map((u) => [u.uuid, (u.message as { content: unknown }).content, u.pasted_content, u.origin])).toEqual([
      ['00000000-0000-4000-8000-0000000000a1', '/plan literal text', [WORKSPACE], { kind: 'peer', from: 'chat-peer-1' }],
      [plain.messageUuid, 'plain text', undefined, undefined],
    ])
    expect(seen.map((s) => [s.text, s.context])).toEqual([['/plan literal text', { plan: 'p-1' }], ['never sent', undefined], ['plain text', undefined]])
    expect([seen[0]!.messageUuid, seen[0]!.turnId]).toEqual([handle.messageUuid, handle.turnId])
  })
})

describe('Claude composePrompt on the production session (controlled query)', () => {
  test('omitted and undefined leave the prompt byte-identical', async () => {
    const shape = async (composePrompt?: ComposePrompt) => {
      const f = await idle(composePrompt ? { session: { composePrompt } } : {})
      const handle = await f.d.send('same text', { messageUuid: '00000000-0000-4000-8000-0000000000b1' })
      f.q().push(frames.result([handle.messageUuid], 'ok'))
      await handle.result
      return JSON.stringify(prompts(f)[0])
    }
    const omitted = await shape()
    expect(await shape(() => undefined)).toBe(omitted)
    expect(Object.keys(JSON.parse(omitted) as object)).toEqual(['type', 'message', 'parent_tool_use_id', 'uuid', 'session_id'])
  })

  test('the composer runs once after an accepted beforeSubmit on the same identities; a refusal skips it', async () => {
    const order: string[] = []
    let accept = false
    const recorded: SubmitContext[] = []
    const f = await idle({
      beforeSubmit: (submission) => {
        order.push(`before ${submission.text}`)
        recorded.push({ ...submission })
        return accept ? { accepted: true } : { accepted: false, reason: 'not persisted' }
      },
      session: { composePrompt: (submission) => (order.push(`compose ${submission.text}`), recorded.push({ ...submission }), { pastedContent: ['ctx'] }) },
    })
    expect((await refusal(f.d.send('refused'))).category).toBe('context')
    accept = true
    const handle = await f.d.send('accepted', { context: { n: 1 } })
    await tick()
    expect(order).toEqual(['before refused', 'before accepted', 'compose accepted'])
    expect(recorded.slice(1)).toEqual([recorded[1]!, recorded[1]!])
    expect([recorded[1]!.messageUuid, recorded[1]!.turnId, recorded[1]!.context]).toEqual([handle.messageUuid, handle.turnId, { n: 1 }])
    expect(prompts(f).map((p) => [p.uuid, p.message.content, p.pasted_content])).toEqual([[handle.messageUuid, 'accepted', ['ctx']]])
  })

  test('a malformed or asynchronous result refuses before any prompt, event or turn', async () => {
    class Envelope {
      pastedContent = ['x']
    }
    const cases: Array<[string, unknown]> = [
      ['null', null], ['string', 'ctx'], ['array', [['ctx']]], ['class', new Envelope()],
      ['pasted string', { pastedContent: 'ctx' }], ['pasted number', { pastedContent: [1] }],
      ['human origin', { origin: { kind: 'human' } }], ['numeric from', { origin: { kind: 'peer', from: 1 } }],
      ['origin extra', { origin: { kind: 'peer', from: 'a', server: 'x' } }],
      ['client_composed', { pastedContent: ['ctx'], client_composed: true }], ['uuid override', { uuid: 'other' }],
      ['content override', { message: { role: 'user', content: 'other' } }], ['promise', Promise.resolve({ pastedContent: ['ctx'] })],
    ]
    let current: unknown
    const f = await idle({ session: { composePrompt: () => current as never } })
    const before = f.events.length
    const messages: string[] = []
    for (const [name, value] of cases) {
      current = value
      const error = await refusal(f.d.send(`case ${name}`))
      expect([name, error.category]).toEqual([name, 'context'])
      messages.push(error.message)
    }
    await tick()
    expect(prompts(f)).toEqual([])
    expect(f.events.slice(before)).toEqual([])
    expect(f.d.state).toBe('idle')
    expect(messages.at(-1)).toBe('the prompt composition callback returned a promise; it must answer synchronously')
    expect(messages[9]).toBe('the prompt composition callback returned unsupported fields: client_composed')
  })

  test('a rejected thenable is owned: the send is refused and the stop reports the raw cause', async () => {
    const boom = new Error('async composer')
    const f = await idle({ session: { composePrompt: () => Promise.reject(boom) as never } })
    expect((await refusal(f.d.send('async'))).category).toBe('context')
    const stop = await f.d.shutdown().then(() => 'resolved', (error: unknown) => error)
    expect([(stop as AgentRuntimeError).category, (stop as AgentRuntimeError).causes]).toEqual(['stop', [boom]])
  })

  test('a stop or interrupt from inside the composer is decided before anything is enqueued', async () => {
    const reentry: { kill?: Promise<unknown> } = {}
    const killing = await idle({ session: { composePrompt: () => ((reentry.kill = killing.d.kill()), { pastedContent: ['ctx'] }) } })
    expect((await refusal(killing.d.send('killed'))).category).toBe('stopped')
    await reentry.kill
    await tick()
    expect(prompts(killing)).toEqual([])

    let interrupting: Driver | null = null
    interrupting = await idle({ session: { composePrompt: () => (void interrupting!.d.interrupt(), { pastedContent: ['ctx'] }) } })
    const before = interrupting.events.length
    // As when beforeSubmit interrupts (B01): the waiting send is cancelled, not-ready/interrupted.
    const cancelled = await refusal(interrupting.d.send('interrupted'))
    expect([cancelled.category, cancelled.code]).toEqual(['not-ready', 'interrupted'])
    await tick()
    expect(prompts(interrupting)).toEqual([])
    expect(interrupting.events.slice(before).filter((e) => e.type === 'turn_started' || e.type === 'user_message')).toEqual([])
  })

  test('each prompt has its own copy, and a queued prompt never borrows another’s', async () => {
    const pasted = ['first ctx']
    const results = [{ pastedContent: pasted }, { origin: { kind: 'peer' as const, from: 'chat-peer-2' } }, undefined]
    let index = 0
    const f = await idle({ session: { composePrompt: () => results[index++] } })
    const a = await f.d.send('first')
    pasted.push('late mutation')
    const b = await f.d.send('second', { continuation: 'queue' })
    const c = await f.d.send('third', { continuation: 'queue' })
    await tick()
    expect(prompts(f).map((p) => [p.uuid, p.message.content, p.pasted_content, p.origin])).toEqual([
      [a.messageUuid, 'first', ['first ctx'], undefined],
      [b.messageUuid, 'second', undefined, { kind: 'peer', from: 'chat-peer-2' }],
      [c.messageUuid, 'third', undefined, undefined],
    ])
    expect(prompts(f)[0]!.pasted_content).not.toBe(pasted)
  })

  test('the enriched prompt’s echo is suppressed by UUID; a later foreign same-text message still shows', async () => {
    const f = await idle({ session: { composePrompt: () => ({ pastedContent: [WORKSPACE] }) } })
    const handle = await f.d.send('hello')
    f.q().push(userFrame(`hello\n\n${WORKSPACE}`, handle.messageUuid), userFrame('hello'))
    await tick()
    f.q().push(frames.result([handle.messageUuid], 'ok'))
    await handle.result
    const users = f.events.filter((e): e is Extract<AgentEvent, { type: 'user_message' }> => e.type === 'user_message')
    expect(users.map((u) => [u.text, u.messageUuid === handle.messageUuid])).toEqual([['hello', true], ['hello', false]])
  })

  test('a supplied non-function refuses construction', () => {
    let error: unknown
    try {
      createClaudeDriver({ launch: fakeClaudeHome().launch(), logger, permissions: { mode: 'default', enabledTools: [], disallowedTools: [] }, callbacks: { onEvent: silent }, composePrompt: 'yes' as never })
    } catch (caught) {
      error = caught
    }
    expect([(error as AgentRuntimeError).category, (error as Error).message]).toEqual(['configuration', 'composePrompt must be a function'])
  })
})
