// @reads: packages/agent-runtime/__tests__/fixtures/**
// Host integration oracles (task 3.4, P09-P15/I8). Host tools bind to one
// session: the real SDK serves them as an in-process MCP server that the
// fake CLI calls, and the Codex dispatcher serves them as dynamic tools. The
// pre-submit context callback decides before anything is enqueued. Tool
// observation sees names only and never decides anything.
//
// Controls that must fail here:
// - dropping the schema check (a refined schema still reaches the handler);
// - moving the context check after the enqueue;
// - an observation hook that answers `allow`.
import { describe, expect, test } from 'bun:test'
import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { claudeIntegrationOptions } from '../src/claude/integrations.js'
import { RESTRICTED_CLAUDE_PERMISSIONS, composeClaudePermissions } from '../src/claude/permissions.js'
import { ClaudeSession } from '../src/claude/session.js'
import { codexDynamicTools, dispatchCodexToolCall } from '../src/codex/tools.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { AgentEvent } from '../src/events.js'
import type { SubmitContext, ToolCallContext, ToolObservation, ToolSet } from '../src/options.js'
import { bindToolSet } from '../src/tools/toolSet.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const SECRET = 'AR_SECRET_TOOL_INPUT_MARKER'

function hostTools() {
  const calls: Array<{ input: unknown; context: ToolCallContext }> = []
  const set: ToolSet = {
    namespace: 'host',
    tools: [
      {
        name: 'echo',
        description: 'Echo the text back.',
        // The refinement is invisible to the SDK's shape check: only the full schema refuses it.
        inputSchema: z.object({ text: z.string().min(1) }).refine((value) => value.text !== 'forbidden', 'forbidden text'),
        handler: async (input, context) => {
          calls.push({ input, context })
          return { content: `echoed ${(input as { text: string }).text}` }
        },
      },
      {
        name: 'strict',
        description: 'Strict object.',
        inputSchema: z.strictObject({ text: z.string() }),
        handler: async (input, context) => {
          calls.push({ input, context })
          return { content: `strict ${(input as { text: string }).text}` }
        },
      },
      {
        name: 'count',
        description: 'Adds one to a numeric string.',
        inputSchema: z.object({ n: z.string().transform((value) => Number(value)) }),
        handler: async (input, context) => {
          calls.push({ input, context })
          const n = (input as { n: unknown }).n
          return typeof n === 'number' ? { content: String(n + 1) } : { content: `not a number: ${typeof n}`, isError: true }
        },
      },
      {
        name: 'fail',
        description: 'Always throws.',
        inputSchema: z.object({}),
        handler: async () => {
          throw new Error('handler exploded')
        },
      },
    ],
  }
  return { set, calls }
}

async function rejection(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    return error as AgentRuntimeError
  }
  throw new Error('expected a rejection')
}

function session(options: Partial<ConstructorParameters<typeof ClaudeSession>[0]> = {}) {
  const home = fakeClaudeHome()
  const events: AgentEvent[] = []
  const s = new ClaudeSession({ launch: home.launch(), callbacks: { onEvent: (event) => events.push(event) }, terminate: { graceMs: 300, killMs: 3000 }, ...options })
  const ask = async (text: string) => (await (await s.send(text)).result).finalText
  const initialize = () => home.received().find((frame) => (frame.request as { subtype?: string } | undefined)?.subtype === 'initialize')!.request as Record<string, unknown>
  return { home, events, s, ask, initialize }
}

describe('tool sets (pure)', () => {
  test('P09/P10: an absent or empty set binds nothing; malformed definitions are configuration errors', () => {
    expect(bindToolSet(undefined)).toBeNull()
    expect(bindToolSet({ namespace: 'host', tools: [] })).toBeNull()
    expect(codexDynamicTools(null)).toBeUndefined()
    const tool = { name: 'a', description: 'd', inputSchema: z.object({}), handler: async () => ({ content: '' }) }
    const bad: unknown[] = [
      { namespace: 'bad name', tools: [tool] },
      { namespace: 'a__b', tools: [tool] },
      { namespace: 'host', tools: [tool, tool] },
      { namespace: 'host', tools: [{ ...tool, name: 'mcp*' }] },
      { namespace: 'host', tools: [{ ...tool, inputSchema: z.string() }] },
      { namespace: 'host', tools: [{ ...tool, handler: undefined }] },
      { namespace: 'host', tools: 'a' },
    ]
    for (const set of bad) expect(() => bindToolSet(set as ToolSet)).toThrow(AgentRuntimeError)
  })

  // @covers: agent-runtime-policy › Tools are injected and can be absent › Wrong identity or schema
  test('P10/P11: Codex calls for another thread, namespace, tool or schema are refused without running the handler', async () => {
    const { set, calls } = hostTools()
    const tools = bindToolSet(set)
    const call = { threadId: 'thread-a', turnId: 'turn-1', callId: 'call-1', namespace: 'host', tool: 'echo', arguments: { text: 'hi' } }
    const refused = [
      await dispatchCodexToolCall(tools, null, call),
      await dispatchCodexToolCall(tools, 'thread-a', { ...call, threadId: 'thread-b' }),
      await dispatchCodexToolCall(tools, 'thread-a', { ...call, namespace: 'kawai-team' }),
      await dispatchCodexToolCall(tools, 'thread-a', { ...call, tool: 'nope' }),
      await dispatchCodexToolCall(tools, 'thread-a', { ...call, arguments: { text: '' } }),
      await dispatchCodexToolCall(tools, 'thread-a', { ...call, arguments: { text: 'forbidden' } }),
      await dispatchCodexToolCall(tools, 'thread-a', null),
      await dispatchCodexToolCall(null, 'thread-a', call),
    ]
    for (const response of refused) {
      expect(response.success).toBe(false)
      expect(response.contentItems[0]!.text).toStartWith('Refused: ')
    }
    expect(calls).toHaveLength(0)
    expect(await dispatchCodexToolCall(tools, 'thread-a', call)).toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'echoed hi' }] })
    expect(calls).toEqual([{ input: { text: 'hi' }, context: { toolCallId: 'call-1', turnId: 'turn-1', runtimeSessionId: 'thread-a' } }])
    expect((await dispatchCodexToolCall(tools, 'thread-a', { ...call, tool: 'strict', arguments: { text: 'x', extra: 1 } })).success).toBe(false)
    expect(await dispatchCodexToolCall(tools, 'thread-a', { ...call, tool: 'count', arguments: { n: '41' } })).toEqual({ success: true, contentItems: [{ type: 'inputText', text: '42' }] })
    expect(calls).toHaveLength(2)
    expect(await dispatchCodexToolCall(tools, 'thread-a', { ...call, tool: 'fail', arguments: {} })).toEqual({ success: false, contentItems: [{ type: 'inputText', text: 'handler exploded' }] })
    expect(codexDynamicTools(tools)).toMatchObject([{ type: 'namespace', name: 'host', tools: [{ type: 'function', name: 'echo' }, { type: 'function', name: 'strict' }, { type: 'function', name: 'count' }, { type: 'function', name: 'fail' }] }])
  })
})

describe('Claude host tools through the real SDK', () => {
  // @covers: agent-runtime-policy › Tools are injected and can be absent › No tools
  // @covers: agent-runtime-policy › Host integrations are optional injected seams › No workspace context
  test('P09: with only a prompt append, a turn runs and nothing else is registered', async () => {
    const h = session({ systemPromptAppend: 'Answer briefly.' })
    try {
      await h.s.start()
      expect(await h.ask('hello')).toBe('echo: hello')
      expect(JSON.parse((await h.ask('mcp-list host'))!)).toEqual({ servers: [], tools: null })
      const init = h.initialize()
      expect(init.appendSystemPrompt).toBe('Answer briefly.')
      expect(init.sdkMcpServers).toBeUndefined()
      expect(init.hooks ?? {}).toEqual({})
    } finally {
      await h.s.kill()
    }
  })

  test('P10/P11: the bound tool runs once with its identity; schema, unknown and unlisted calls never reach a handler', async () => {
    const { set, calls } = hostTools()
    const h = session({ tools: set, permissions: RESTRICTED_CLAUDE_PERMISSIONS })
    try {
      await h.s.start()
      expect(JSON.parse((await h.ask('mcp-list host'))!)).toEqual({ servers: ['host'], tools: ['echo', 'strict', 'count', 'fail'] })
      const handle = await h.s.send('mcp host echo {"text":"hi"}')
      expect((await handle.result).finalText).toBe('mcp ok: echoed hi')
      expect(calls).toHaveLength(1)
      expect(calls[0]!.context).toMatchObject({ turnId: handle.turnId, runtimeSessionId: 'fake-session-0001' })
      expect(calls[0]!.context.toolCallId).toStartWith('mcp-request:')
      expect(await h.ask('mcp host echo {"text":""}')).toStartWith('mcp error')
      expect(await h.ask('mcp host echo {"text":"forbidden"}')).toStartWith('mcp error: MCP error -32602: Input validation error')
      // Strict keys survive to the host schema: the SDK must not strip the extra key first.
      expect(await h.ask('mcp host strict {"text":"hi","extra":1}')).toStartWith('mcp error: MCP error -32602: Input validation error')
      expect(await h.ask('mcp host strict {"text":"hi"}')).toBe('mcp ok: strict hi')
      // A field transform applies exactly once.
      expect(await h.ask('mcp host count {"n":"41"}')).toBe('mcp ok: 42')
      expect(await h.ask('mcp host nope {}')).toStartWith('denied mcp__host__nope (hook:')
      expect(await h.ask('mcp other echo {"text":"hi"}')).toStartWith('denied mcp__other__echo (hook:')
      expect(await h.ask('mcp host fail {}')).toBe('mcp error: handler exploded')
      expect(calls).toHaveLength(3)
      // The respawned generation gets a fresh server bound to the same set.
      await (await h.s.send('crash')).result
      await h.s.start()
      expect(await h.ask('mcp host echo {"text":"again"}')).toBe('mcp ok: echoed again')
      expect(calls).toHaveLength(4)
    } finally {
      await h.s.kill()
    }
  })
})

describe('host tool ownership across stop', () => {
  test('L11/I1: kill joins a handler still running and refuses calls admitted after stop began', async () => {
    let entered!: () => void
    const entry = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const writes: string[] = []
    let ran = 0
    const set: ToolSet = {
      namespace: 'host',
      tools: [
        {
          name: 'hold',
          description: 'Waits for the test, then writes.',
          inputSchema: z.object({}),
          handler: async () => {
            ran += 1
            entered()
            await gate
            writes.push('after release')
            return { content: 'held' }
          },
        },
      ],
    }
    const h = session({ tools: set })
    await h.s.start()
    void h.s.send('mcp host hold {}')
    await entry
    let killed = false
    const kill = h.s.kill().then((receipt) => {
      killed = true
      return receipt
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(killed).toBe(false)
    expect(h.s.lifecycle.jobs.size).toBeGreaterThan(0)
    // A call the CLI starts once stop has begun never reaches a handler.
    const late = (h.s as unknown as { runOwned(label: string, body: () => Promise<unknown>): Promise<unknown> | null }).runOwned('tool:hold', async () => {
      ran += 1
    })
    expect(late).toBeNull()
    release()
    await kill
    expect([killed, writes, ran, h.s.lifecycle.jobs.size]).toEqual([true, ['after release'], 1, 0])
  })
})

describe('pre-submit context', () => {
  // @covers: agent-runtime-policy › Host integrations are optional injected seams › Context persistence refuses
  test('P12: a refusing or throwing callback rejects the send before any enqueue or event; the session stays usable', async () => {
    let mode: 'refuse' | 'throw' | 'accept' = 'refuse'
    const thrown = new Error('store offline')
    const h = session({
      beforeSubmit: () => {
        if (mode === 'throw') throw thrown
        return mode === 'refuse' ? { accepted: false, reason: 'not persisted' } : { accepted: true }
      },
    })
    try {
      await h.s.start()
      const before = h.events.length
      const refused = await rejection(h.s.send('refused text', { context: { task: 1 } }))
      expect([refused.category, refused.message]).toEqual(['context', 'the pre-submit context callback refused: not persisted'])
      mode = 'throw'
      const threw = await rejection(h.s.send('thrown text'))
      expect([threw.category, threw.causes]).toEqual(['context', [thrown]])
      expect(h.events.slice(before)).toEqual([])
      expect(h.s.state).toBe('idle')
      const users = h.home.received().filter((frame) => frame.type === 'user')
      expect(users).toHaveLength(0)
      mode = 'accept'
      expect(await h.ask('accepted')).toBe('echo: accepted')
    } finally {
      await h.s.kill()
    }
  })

  // @covers: agent-runtime-policy › Host integrations are optional injected seams › Context persistence accepts
  test('P13: an accepted submission carries the message UUID and turn id the callback recorded', async () => {
    const recorded: SubmitContext[] = []
    const h = session({
      beforeSubmit: (submission) => {
        recorded.push({ ...submission })
        return { accepted: true }
      },
    })
    try {
      await h.s.start()
      const handle = await h.s.send('with context', { context: { plan: 'p-1' }, messageUuid: '00000000-0000-4000-8000-00000000c0de' })
      const result = await handle.result
      expect(recorded).toEqual([{ messageUuid: '00000000-0000-4000-8000-00000000c0de', turnId: handle.turnId, text: 'with context', context: { plan: 'p-1' } }])
      expect([handle.messageUuid, result.messageUuid, result.turnId]).toEqual([recorded[0]!.messageUuid, recorded[0]!.messageUuid, recorded[0]!.turnId])
      const userEvent = h.events.find((event) => event.type === 'user_message') as { turnId: string; messageUuid: string }
      expect([userEvent.turnId, userEvent.messageUuid]).toEqual([recorded[0]!.turnId, recorded[0]!.messageUuid])
      expect(h.home.received().find((frame) => frame.type === 'user')!.uuid).toBe(recorded[0]!.messageUuid)
    } finally {
      await h.s.kill()
    }
  })
})

describe('tool observation', () => {
  // @covers: agent-runtime-policy › Observation does not grant permissions or leak inputs by default › Names-only observer
  test('P14: the observer sees names and identities, never the arguments', async () => {
    const { set, calls } = hostTools()
    const seen: ToolObservation[] = []
    const h = session({ tools: set, onToolObservation: (observation) => seen.push(observation) })
    try {
      await h.s.start()
      const handle = await h.s.send(`mcp host echo {"text":"${SECRET}"}`)
      expect((await handle.result).finalText).toBe(`mcp ok: echoed ${SECRET}`)
      expect(calls).toHaveLength(1)
      expect(seen.map(({ phase, tool, turnId, isError }) => ({ phase, tool, turnId, isError }))).toEqual([
        { phase: 'call', tool: 'mcp__host__echo', turnId: handle.turnId, isError: undefined },
        { phase: 'result', tool: 'mcp__host__echo', turnId: handle.turnId, isError: false },
      ])
      expect(seen[0]!.toolCallId).toStartWith('toolu_')
      expect(seen[1]!.toolCallId).toBe(seen[0]!.toolCallId)
      expect(JSON.stringify(seen)).not.toContain(SECRET)
      for (const observation of seen) expect(Object.keys(observation).sort()).toEqual(observation.phase === 'call' ? ['phase', 'toolCallId', 'tool', 'turnId'].sort() : ['isError', 'phase', 'toolCallId', 'tool', 'turnId'].sort())
    } finally {
      await h.s.kill()
    }
  })

  test('P15: every integration hook answers with no decision, whatever the tool', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const options = claudeIntegrationOptions(sdk, {
      tools: null,
      onToolObservation: () => {},
      auditHooks: { preToolUse: () => {}, postToolUse: () => {} },
      turnId: () => null,
      sessionId: () => null,
      observe: (_name, callback) => callback(),
      run: (_label, body) => body(),
    })
    const matchers = Object.values(options.hooks).flat() as HookCallbackMatcher[]
    expect(matchers).toHaveLength(3)
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      for (const tool of ['Bash', 'Write', 'mcp__host__echo']) {
        const input = { hook_event_name: event, tool_name: tool, tool_input: { secret: SECRET }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/' } as unknown as HookInput
        for (const matcher of matchers) for (const hook of matcher.hooks) expect(await hook(input, 't', { signal: new AbortController().signal })).toEqual({})
      }
    }
  })

  // @covers: agent-runtime-policy › Observation does not grant permissions or leak inputs by default › Observer throws
  test('P15/I8: throwing observers leave every tool decision and execution unchanged, run once, and are reported at stop', async () => {
    const script = ['mcp host echo {"text":"a"}', 'tool Write /dev/null', 'mcp host nope {}', 'tool Read /etc/hostname', 'mcp host fail {}']
    const run = async (variant: 'absent' | 'present' | 'throwing') => {
      const { set, calls } = hostTools()
      const thrown = new Error(`observer ${variant}`)
      const observe = variant === 'absent' ? {} : {
        onToolObservation: () => {
          if (variant === 'throwing') throw thrown
        },
        auditHooks: {
          preToolUse: () => {
            if (variant === 'throwing') throw thrown
          },
        },
      }
      const h = session({ tools: set, permissions: RESTRICTED_CLAUDE_PERMISSIONS, ...observe })
      const answers: Array<string | null> = []
      await h.s.start()
      for (const line of script) answers.push(await h.ask(line))
      const stop = h.s.kill()
      if (variant === 'throwing') {
        const error = await rejection(stop)
        expect(error.category).toBe('stop')
        expect(error.causes.every((cause) => cause === thrown)).toBe(true)
        expect(error.causes.length).toBeGreaterThan(0)
      } else await stop
      return { answers, calls: calls.length }
    }
    const absent = await run('absent')
    expect(absent.answers[0]).toBe('mcp ok: echoed a')
    expect(absent.answers[1]).toStartWith('denied Write (hook:')
    expect(absent.calls).toBe(1)
    expect(await run('present')).toEqual(absent)
    expect(await run('throwing')).toEqual(absent)
  })

  test('I8: over 128 seeded traces, observation hooks absent, present or throwing never change the policy decision', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const policy = composeClaudePermissions(RESTRICTED_CLAUDE_PERMISSIONS, ['mcp__host__echo'])
    const tools = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'AskUserQuestion', 'mcp__host__echo', 'mcp__host__nope', 'WebFetch']
    let seed = 0xa608
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0)
    const resolve = async (matchers: HookCallbackMatcher[], tool: string) => {
      const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { secret: SECRET }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/' } as unknown as HookInput
      let deny = false
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          const output = (await hook(input, 't', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } }
          const decision = output.hookSpecificOutput?.permissionDecision
          expect(decision === undefined || decision === 'deny').toBe(true)
          if (decision === 'deny') deny = true
        }
      }
      return deny
    }
    const variant = (kind: 'absent' | 'present' | 'throwing') => {
      if (kind === 'absent') return [policy.preToolUse]
      const fail = () => {
        if (kind === 'throwing') throw new Error('observer')
      }
      const integration = claudeIntegrationOptions(sdk, {
        tools: null,
        onToolObservation: fail,
        auditHooks: { preToolUse: fail },
        turnId: () => null,
        sessionId: () => null,
        run: (_label, body) => body(),
        observe: (_name, callback) => {
          try {
            callback()
          } catch {
            // Retained by the session; it changes no decision.
          }
        },
      })
      return [policy.preToolUse, ...(integration.hooks.PreToolUse ?? [])]
    }
    for (let trace = 0; trace < 128; trace++) {
      const sequence = Array.from({ length: 6 }, () => tools[next() % tools.length]!)
      const decisions = async (kind: 'absent' | 'present' | 'throwing') => Promise.all(sequence.map((tool) => resolve(variant(kind), tool)))
      const absent = await decisions('absent')
      expect(absent).toEqual(sequence.map((tool) => policy.decide(tool) !== null))
      expect(await decisions('present')).toEqual(absent)
      expect(await decisions('throwing')).toEqual(absent)
    }
  })
})
