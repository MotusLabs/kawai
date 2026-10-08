import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatActivity,
  ChatApprovalPolicy,
  ChatEvent,
  ChatUsageReport,
} from '../../shared/chat'
import type { SessionStatus } from '../../shared/types'
import type { ChatWireRecorder } from '../chat/wireTap'
import {
  ChatSessionDriver,
  type ChatQueryFactory,
} from '../chat/ChatSessionDriver'

/**
 * Minimal scriptable Query stand-in. The test pushes SDK messages into the
 * stream and pulls prompt (user turn) messages out explicitly, so queue
 * semantics (fold, clear-on-stop) are observable.
 */
interface FakeQueryHandle {
  query: Query
  /** Captured query options (cwd, systemPrompt, canUseTool, ...). */
  options: Options
  /** Push an SDK message into the driver's stream. */
  push: (message: SDKMessage) => void
  /** Pull the next user turn the driver submitted (null when none waiting). */
  pullPrompt: () => Promise<SDKUserMessage | null>
  interrupts: number
  closed: boolean
  /** End the stream as the real process would on exit/crash. */
  exit: () => void
  /** Calls to the usage control (0 when the driver never pulled). */
  usageCalls: Array<{ skipBehaviors?: boolean }>
}

/** The usage control implementation a test injects into a fake query. */
export type FakeUsageControl = (opts: {
  skipBehaviors?: boolean
}) => Promise<unknown>

function createFakeQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: Options,
  usageImpl?: FakeUsageControl
): FakeQueryHandle {
  const messages: SDKMessage[] = []
  let resolveMessage: ((result: IteratorResult<SDKMessage>) => void) | null = null
  let ended = false
  const handle = {
    interrupts: 0,
    closed: false,
    usageCalls: [] as Array<{ skipBehaviors?: boolean }>,
  } as FakeQueryHandle

  const stream = async function* (): AsyncGenerator<SDKMessage, void> {
    while (true) {
      const next = await new Promise<IteratorResult<SDKMessage>>((resolve) => {
        if (messages.length > 0) {
          resolve({ value: messages.shift()!, done: false })
        } else if (ended) {
          resolve({ value: undefined, done: true })
        } else {
          resolveMessage = resolve
        }
      })
      if (next.done) return
      yield next.value
    }
  }

  const query = Object.assign(stream(), {
    interrupt: () => {
      handle.interrupts += 1
      return Promise.resolve(undefined)
    },
    close: () => {
      handle.closed = true
      ended = true
      resolveMessage?.({ value: undefined, done: true })
    },
    // The unstable usage control: attached only when a test provides one, so
    // the default fake exercises the driver's missing-method path.
    ...(usageImpl
      ? {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (
            opts: { skipBehaviors?: boolean }
          ) => {
            handle.usageCalls.push(opts)
            return usageImpl(opts)
          },
        }
      : {}),
  }) as unknown as Query

  handle.query = query
  handle.options = options
  handle.push = (message) => {
    if (resolveMessage) {
      const resolve = resolveMessage
      resolveMessage = null
      resolve({ value: message, done: false })
    } else {
      messages.push(message)
    }
  }
  handle.pullPrompt = async () => {
    const iterator = prompt[Symbol.asyncIterator]()
    const result = await Promise.race([
      iterator.next(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)),
    ])
    return result === null ? null : (result as IteratorResult<SDKUserMessage>).value ?? null
  }
  handle.exit = () => {
    ended = true
    resolveMessage?.({ value: undefined, done: true })
  }
  return handle
}

interface Harness {
  driver: ChatSessionDriver
  events: ChatEvent[]
  statuses: SessionStatus[]
  activities: Array<ChatActivity | null>
  rateLimits: ChatUsageReport[]
  usageReports: ChatUsageReport[]
  noData: number[]
  fakes: FakeQueryHandle[]
  sdkSessionIds: string[]
  factoryWires: Array<ChatWireRecorder | undefined>
}

function createHarness(
  overrides: {
    claudeProfileId?: string
    resumeSessionId?: string
    claudeExecutablePath?: string
    getProviderEnv?: () => Record<string, string>
    getApprovalPolicy?: () => ChatApprovalPolicy
    wire?: ChatWireRecorder
    /** Injected usage control on every spawned fake query. */
    usageImpl?: FakeUsageControl
    /** Gates the driver's usage pull; defaults to "never claim". */
    claimUsagePull?: () => boolean
  } = {}
): Harness {
  const events: ChatEvent[] = []
  const statuses: SessionStatus[] = []
  const activities: Array<ChatActivity | null> = []
  const rateLimits: ChatUsageReport[] = []
  const usageReports: ChatUsageReport[] = []
  const noData: number[] = []
  const fakes: FakeQueryHandle[] = []
  const sdkSessionIds: string[] = []
  const factoryWires: Array<ChatWireRecorder | undefined> = []
  const { usageImpl, claimUsagePull, ...driverOverrides } = overrides
  const factory: ChatQueryFactory = ({ prompt, options, wire }) => {
    factoryWires.push(wire)
    const handle = createFakeQuery(prompt, options, usageImpl)
    fakes.push(handle)
    return handle.query
  }
  const driver = new ChatSessionDriver({
    sessionId: 'chat-test',
    projectPath: '/tmp/project',
    queryFactory: factory,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onActivity: (activity) => activities.push(activity),
    onRateLimit: (report) => rateLimits.push(report),
    onUsageReport: (report) => usageReports.push(report),
    ...(claimUsagePull ? { claimUsagePull } : {}),
    onUsageNoData: () => noData.push(1),
    onSdkSessionId: (id) => sdkSessionIds.push(id),
    ...driverOverrides,
  })
  return {
    driver,
    events,
    statuses,
    activities,
    rateLimits,
    usageReports,
    noData,
    fakes,
    sdkSessionIds,
    factoryWires,
  }
}

/** Let the driver's stream loop drain pushed messages. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function sendApproval(
  fake: FakeQueryHandle,
  input: Record<string, unknown> = { command: 'rm -rf /tmp/x' },
  toolName = 'Bash'
): Promise<PermissionResult | null> {
  const controller = new AbortController()
  return fake.options.canUseTool!(toolName, input, {
    signal: controller.signal,
    toolUseID: 'toolu_1',
    requestId: 'sdk-req-1',
  })
}

function typesOf(events: ChatEvent[]): string[] {
  return events.map((event) => event.type)
}

function assistantText(text: string, id = 'msg_1'): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id,
      content: [{ type: 'text', text }],
      role: 'assistant',
    },
    parent_tool_use_id: null,
    uuid: 'a-uuid',
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

function userToolResult(toolUseId: string): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'done' },
      ],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function result(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    num_turns: 1,
    total_cost_usd: 0.01,
    result: 'all done',
    duration_ms: 100,
    duration_api_ms: 50,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    stop_reason: null,
    ...extra,
  } as unknown as SDKMessage
}

describe('ChatSessionDriver', () => {
  // Pin catalog reads to an empty temp home: the shipped default applies
  // deterministically, and a real ~/.kawai cannot leak into launch resolution.
  let tempHome: string
  const originalHome = process.env.HOME
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatdriver-'))
    process.env.HOME = tempHome
  })
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  test('passes the executable path when given and omits the option otherwise', async () => {
    const external = createHarness({ claudeExecutablePath: '/opt/claude/bin/claude' })
    external.driver.send('hello')
    expect(external.fakes[0]!.options.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude')

    const injected = createHarness()
    injected.driver.send('hello')
    expect('pathToClaudeCodeExecutable' in injected.fakes[0]!.options).toBe(false)

    external.driver.kill()
    injected.driver.kill()
  })

  test('concurrent profile drivers keep launch settings and approval bridges independent', async () => {
    const glm = createHarness({ claudeProfileId: 'glm' })
    const minimax = createHarness({ claudeProfileId: 'minimax' })
    glm.driver.send('glm turn')
    minimax.driver.send('minimax turn')
    const first = glm.fakes[0]!
    const other = minimax.fakes[0]!
    expect(first.options.model).toBe('sonnet')
    expect(other.options.model).toBe('MiniMax-M3')
    expect(first.options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000')
    expect(other.options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(first.options.settings).toMatchObject({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]' } })
    expect(first.options.permissionMode).toBe('default')
    expect(first.options.settingSources).toEqual(['user', 'project', 'local'])
    const approval = sendApproval(first)
    const request = glm.driver.getPendingRequests()[0]!
    expect(minimax.driver.getPendingRequests()).toEqual([])
    glm.driver.resolveApproval(request.requestId, 'allow')
    expect(await approval).toMatchObject({ behavior: 'allow' })
    first.exit()
    await flush()
    glm.driver.send('respawn')
    expect(glm.fakes[1]!.options.model).toBe('sonnet')
    expect(glm.fakes[1]!.options.env?.ANTHROPIC_BASE_URL).toBe(first.options.env?.ANTHROPIC_BASE_URL)
    glm.driver.kill()
    minimax.driver.kill()
  })

  test('executable-backed profiles spawn the wrapper with base env and no settings', async () => {
    fs.mkdirSync(path.join(tempHome, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(tempHome, '.kawai', 'profiles.json'), JSON.stringify({
      lan: {
        label: 'LAN',
        executable: '/usr/local/bin/claude-lan',
        env: { ANTHROPIC_BASE_URL: 'http://ai.lan:9292' },
      },
    }))
    const lan = createHarness({ claudeProfileId: 'lan', claudeExecutablePath: '/opt/claude/bin/claude' })
    lan.driver.send('lan turn')
    const options = lan.fakes[0]!.options
    // The wrapper replaces the checked Claude Code binary...
    expect(options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude-lan')
    // ...receives the entry environment pre-applied on the merged base...
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('http://ai.lan:9292')
    // ...and no inline controlled settings exist to override its exports.
    expect(options.settings).toBeUndefined()
    expect('executable' in options).toBe(false)
    lan.driver.kill()
  })

  test('a wire recorder taps every spawn, including the respawn after a crash', async () => {
    const wire: ChatWireRecorder = { record: () => {} }
    const harness = createHarness({ wire })
    harness.driver.send('hello')
    const first = harness.fakes[0]!
    expect(first.options.spawnClaudeCodeProcess).toBeTypeOf('function')
    expect(harness.factoryWires[0]).toBe(wire)

    first.exit()
    await flush()
    harness.driver.send('again')
    expect(harness.fakes).toHaveLength(2)
    expect(harness.fakes[1]!.options.spawnClaudeCodeProcess).toBeTypeOf('function')
    expect(harness.factoryWires[1]).toBe(wire)
    harness.driver.kill()
  })

  test('without a wire recorder the SDK spawns its own process', () => {
    const harness = createHarness()
    harness.driver.send('hello')
    expect('spawnClaudeCodeProcess' in harness.fakes[0]!.options).toBe(false)
    expect(harness.factoryWires[0]).toBeUndefined()
    harness.driver.kill()
  })

  test('provider env is merged over process.env and re-read on every spawn', async () => {
    let providerEnv: Record<string, string> = {
      ANTHROPIC_BASE_URL: 'https://gw.example/anthropic',
      ANTHROPIC_MODEL: 'gw-pro',
    }
    const harness = createHarness({ getProviderEnv: () => providerEnv })
    harness.driver.send('hello')
    const first = harness.fakes[0]!
    expect(first.options.env).toEqual({ ...process.env, ...providerEnv })

    // The query exits; the next send respawns under the updated provider.
    first.exit()
    await flush()
    providerEnv = { ANTHROPIC_MODEL: 'gw-flash' }
    harness.driver.send('again')
    expect(harness.fakes).toHaveLength(2)
    expect(harness.fakes[1]!.options.env?.ANTHROPIC_MODEL).toBe('gw-flash')
    expect(harness.fakes[1]!.options.env?.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL)
    harness.driver.kill()
  })

  test('turn lifecycle: lazy spawn, options parity, event mapping, session id capture', async () => {
    const harness = createHarness()
    expect(harness.fakes).toHaveLength(0) // no SDK spawn before first turn

    harness.driver.send('hello')
    expect(harness.fakes).toHaveLength(1)
    expect(harness.statuses.at(-1)).toBe('working') // applied synchronously

    const fake = harness.fakes[0]!
    expect(fake.options.cwd).toBe('/tmp/project')
    expect(fake.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    })
    expect(fake.options.settingSources).toEqual(['user', 'project', 'local'])
    expect(fake.options.permissionMode).toBe('default')
    expect(fake.options.includePartialMessages).toBe(true)
    expect(fake.options.canUseTool).toBeTypeOf('function')
    expect(fake.options.resume).toBeUndefined()
    // No provider overrides: env is omitted so the SDK inherits process.env.
    expect('env' in fake.options).toBe(false)

    fake.push({
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage)
    fake.push(assistantText('working on it'))
    fake.push({
      type: 'assistant',
      message: {
        id: 'msg_2',
        content: [
          { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } },
        ],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'b-uuid',
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage)
    fake.push(userToolResult('toolu_9'))
    fake.push(result('success'))
    await flush()

    expect(harness.sdkSessionIds).toEqual(['sdk-session-1'])
    expect(typesOf(harness.events)).toEqual([
      'turn_started',
      'user_message',
      'assistant_text',
      'tool_call',
      'tool_result',
      'turn_completed',
    ])
    const completed = harness.events.at(-1)
    expect(completed).toMatchObject({
      type: 'turn_completed',
      subtype: 'success',
      totalCostUsd: 0.01,
      numTurns: 1,
      finalText: 'all done',
    })
    expect(harness.statuses.at(-1)).toBe('waiting')

    // The queued user turn was delivered to the SDK prompt stream.
    const pulled = await fake.pullPrompt()
    expect(pulled?.message).toMatchObject({ role: 'user', content: 'hello' })
  })

  test('assistant deltas map from partial stream events', async () => {
    const harness = createHarness()
    harness.driver.send('hi')
    const fake = harness.fakes[0]!
    fake.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'part-' },
      },
      parent_tool_use_id: null,
      uuid: 'p-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    fake.push({
      type: 'stream_event',
      event: { type: 'message_start', message: {} },
      parent_tool_use_id: null,
      uuid: 'p-0',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()

    const deltas = harness.events.filter((e) => e.type === 'assistant_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ delta: 'part-', messageId: 'p-1' })
  })

  test('user echo from the SDK is suppressed, foreign user text is kept', async () => {
    const harness = createHarness()
    harness.driver.send('mine')
    const fake = harness.fakes[0]!
    fake.push({
      type: 'user',
      message: { role: 'user', content: 'mine' },
      parent_tool_use_id: null,
    } as unknown as SDKMessage)
    fake.push({
      type: 'user',
      message: { role: 'user', content: 'injected by agent' },
      parent_tool_use_id: null,
    } as unknown as SDKMessage)
    await flush()

    const userMessages = harness.events.filter((e) => e.type === 'user_message')
    expect(userMessages.map((e) => (e as { text: string }).text)).toEqual([
      'mine',
      'injected by agent',
    ])
  })

  test('interrupt: cancels pending approval, discards queued send, emits turn_interrupted', async () => {
    const harness = createHarness()
    harness.driver.send('first')
    const fake = harness.fakes[0]!
    await fake.pullPrompt() // consume the first send

    const approval = sendApproval(fake)
    await flush()
    const requestEvent = harness.events.find((e) => e.type === 'approval_request')
    expect(requestEvent).toBeDefined()
    expect(harness.statuses.at(-1)).toBe('permission')

    harness.driver.send('second') // queued behind the running turn
    harness.driver.interrupt()
    await flush()

    expect(fake.interrupts).toBe(1)
    expect(typesOf(harness.events)).toContain('turn_interrupted')
    expect(typesOf(harness.events)).toContain('request_resolved')
    const resolved = harness.events.find((e) => e.type === 'request_resolved')
    expect(resolved).toMatchObject({ outcome: 'cancelled' })
    expect(harness.statuses.at(-1)).toBe('waiting')

    // The queued unsent message was discarded.
    const pulled = await fake.pullPrompt()
    expect(pulled).toBeNull()

    // The cancelled approval settled as an interrupting denial.
    await expect(approval).resolves.toEqual({
      behavior: 'deny',
      message: 'The request was cancelled (interrupted)',
      interrupt: true,
    })
  })

  test('SDK abort signal cancels its pending request', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!

    const controller = new AbortController()
    const approval: Promise<PermissionResult | null> = fake.options.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: controller.signal, toolUseID: 't', requestId: 'r' }
    )
    await flush()
    expect(harness.statuses.at(-1)).toBe('permission')

    controller.abort()
    await flush()

    await expect(approval).resolves.toMatchObject({ behavior: 'deny', interrupt: true })
    expect(typesOf(harness.events)).toContain('request_resolved')
    expect(harness.statuses.at(-1)).toBe('working')
  })

  test('allow and deny settle the bridge and broadcast the outcome', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!

    const allow = sendApproval(fake, { command: 'echo hi' })
    await flush()
    const allowEvent = harness.events.find((e) => e.type === 'approval_request')
    const allowId = (allowEvent as { requestId: string }).requestId
    expect(harness.driver.resolveApproval(allowId, 'allow')).toEqual({ ok: true })
    await expect(allow).resolves.toEqual({ behavior: 'allow' })

    const deny = sendApproval(fake, { command: 'echo no' })
    await flush()
    const denyEvent = harness.events.filter((e) => e.type === 'approval_request').at(-1)
    const denyId = (denyEvent as { requestId: string }).requestId
    expect(harness.driver.resolveApproval(denyId, 'deny')).toEqual({ ok: true })
    await expect(deny).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('denied'),
    })

    const outcomes = harness.events
      .filter((e) => e.type === 'request_resolved')
      .map((e) => (e as { outcome: string }).outcome)
    expect(outcomes).toEqual(['allowed', 'denied'])
  })

  test('first answer wins; stale or duplicate answers are rejected', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const approval = sendApproval(fake)
    await flush()
    const event = harness.events.find((e) => e.type === 'approval_request')
    const requestId = (event as { requestId: string }).requestId

    expect(harness.driver.resolveApproval(requestId, 'allow')).toEqual({ ok: true })
    // Second client answers the same request afterwards.
    const stale = harness.driver.resolveApproval(requestId, 'deny')
    expect(stale).toMatchObject({ ok: false })
    expect((stale as { error: string }).error).toContain(requestId)

    // Unknown request ids are rejected, not created.
    expect(harness.driver.resolveApproval('req-does-not-exist', 'allow')).toMatchObject({
      ok: false,
    })
    await expect(approval).resolves.toEqual({ behavior: 'allow' })
  })

  test('kill settles pending callbacks, closes the query, and ignores later sends', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const approval = sendApproval(fake)
    await flush()

    harness.driver.kill()
    await flush()

    expect(fake.closed).toBe(true)
    await expect(approval).resolves.toMatchObject({ behavior: 'deny', interrupt: true })
    const resolved = harness.events.find((e) => e.type === 'request_resolved')
    expect(resolved).toMatchObject({ outcome: 'cancelled' })

    harness.driver.send('after kill')
    await flush()
    expect(harness.fakes).toHaveLength(1) // no respawn
  })

  test('AskUserQuestion: parses questions, validates answers, returns updated input', async () => {
    const harness = createHarness()
    harness.driver.send('choose')
    const fake = harness.fakes[0]!

    const question: Promise<PermissionResult | null> = fake.options.canUseTool!(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'date-fns', description: 'modern' },
              { label: 'dayjs', description: 'small' },
            ],
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: 'q1', requestId: 'r' }
    )
    await flush()

    const event = harness.events.find((e) => e.type === 'question_request')
    // Extract before toMatchObject: bun's asymmetric matchers overwrite the
    // matched property on the received object, corrupting later reads.
    const requestId = (event as { requestId: string }).requestId
    expect(requestId).toMatch(/^req-/)
    expect(event).toMatchObject({
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'modern' },
            { label: 'dayjs', description: 'small' },
          ],
        },
      ],
    })
    expect(typesOf(harness.events)).not.toContain('approval_request')

    // Invalid: not an offered choice.
    const bad = harness.driver.answerQuestion(requestId, {
      'Which library?': { options: ['luxon'] },
    })
    expect(bad).toMatchObject({ ok: false })
    // Invalid: missing answer.
    expect(
      harness.driver.answerQuestion(requestId, {})
    ).toMatchObject({ ok: false })

    const good = harness.driver.answerQuestion(requestId, {
      'Which library?': { options: ['date-fns'] },
    })
    expect(good).toEqual({ ok: true })
    await expect(question).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'date-fns', description: 'modern' },
              { label: 'dayjs', description: 'small' },
            ],
          },
        ],
        answers: { 'Which library?': 'date-fns' },
      },
    })

    // Stale second answer rejected.
    expect(harness.driver.answerQuestion(requestId, {
      'Which library?': { options: ['dayjs'] },
    })).toMatchObject({ ok: false })
  })

  test('free-text question answer becomes the answer string and response', async () => {
    const harness = createHarness()
    harness.driver.send('ask')
    const fake = harness.fakes[0]!
    const question: Promise<PermissionResult | null> = fake.options.canUseTool!(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Name?',
            header: 'Name',
            multiSelect: false,
            options: [{ label: 'a' }, { label: 'b' }],
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: 'q', requestId: 'r' }
    )
    await flush()
    const event = harness.events.find((e) => e.type === 'question_request')
    const requestId = (event as { requestId: string }).requestId

    expect(
      harness.driver.answerQuestion(requestId, { 'Name?': { text: '  Ada  ' } })
    ).toEqual({ ok: true })
    await expect(question).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: { 'Name?': 'Ada' },
        response: 'Ada',
      },
    })
  })

  test('multi-select questions join selections and reject two picks when single-select', async () => {
    const harness = createHarness()
    harness.driver.send('ask')
    const fake = harness.fakes[0]!

    const single: Promise<PermissionResult | null> = fake.options.canUseTool!(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Pick one?',
            header: 'One',
            multiSelect: false,
            options: [{ label: 'a' }, { label: 'b' }],
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: 'q1', requestId: 'r' }
    )
    await flush()
    let event = harness.events.find((e) => e.type === 'question_request')
    let requestId = (event as { requestId: string }).requestId
    expect(
      harness.driver.answerQuestion(requestId, {
        'Pick one?': { options: ['a', 'b'] },
      })
).toMatchObject({ ok: false })
    // The rejected answer leaves the question pending; kill settles it as a
    // cancellation so the bridge promise never dangles.
    harness.driver.kill()
    await expect(single).resolves.toMatchObject({ behavior: 'deny' })

    const multi: Promise<PermissionResult | null> = fake.options.canUseTool!(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Pick many?',
            header: 'Many',
            multiSelect: true,
            options: [{ label: 'x' }, { label: 'y' }],
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: 'q2', requestId: 'r' }
    )
    await flush()
    event = harness.events.filter((e) => e.type === 'question_request').at(-1)!
    requestId = (event as { requestId: string }).requestId
    expect(
      harness.driver.answerQuestion(requestId, {
        'Pick many?': { options: ['x', 'y'] },
      })
    ).toEqual({ ok: true })
    await expect(multi).resolves.toMatchObject({
      updatedInput: { answers: { 'Pick many?': 'x, y' } },
    })
  })

  test('two turns on one session: a result does not end the stream', async () => {
    const harness = createHarness()
    harness.driver.send('one')
    const fake = harness.fakes[0]!
    fake.push(assistantText('first answer', 'msg_1'))
    fake.push(result('success'))
    await flush()
    expect(harness.fakes).toHaveLength(1)
    expect(harness.driver.isDead).toBe(false)

    harness.driver.send('two')
    expect(harness.fakes).toHaveLength(1) // same query reused
    fake.push(assistantText('second answer', 'msg_2'))
    fake.push(result('success'))
    await flush()

    const started = harness.events.filter((e) => e.type === 'turn_started')
    const completed = harness.events.filter((e) => e.type === 'turn_completed')
    expect(started).toHaveLength(2)
    expect(completed).toHaveLength(2)
    expect(completed[1]).toMatchObject({ finalText: 'all done' })
    expect(harness.statuses).toEqual(['working', 'waiting', 'working', 'waiting'])
  })

  test('error result leaves the session usable and reports the failure', async () => {
    const harness = createHarness()
    harness.driver.send('explode')
    const fake = harness.fakes[0]!
    fake.push(
      result('error_max_turns', { errors: ['Turn limit reached'], is_error: true })
    )
    await flush()

    const completed = harness.events.find((e) => e.type === 'turn_completed')
    expect(completed).toMatchObject({ subtype: 'error_max_turns' })
    expect(completed && 'finalText' in completed).toBe(false)
    const error = harness.events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ message: 'Turn limit reached' })
    expect(harness.statuses.at(-1)).toBe('waiting')
    expect(harness.driver.isDead).toBe(false)

    // Still usable: a fresh turn runs on the same query.
    harness.driver.send('again')
    expect(harness.fakes).toHaveLength(1)
    expect(harness.statuses.at(-1)).toBe('working')
  })

  test('trailing events after result are tolerated without killing the session', async () => {
    const harness = createHarness()
    harness.driver.send('hi')
    const fake = harness.fakes[0]!
    fake.push(result('success'))
    fake.push({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 100 },
    } as unknown as SDKMessage)
    // Unknown message kind after the result.
    fake.push({ type: 'status', status: 'idle' } as unknown as SDKMessage)
    await flush()

    expect(harness.driver.isDead).toBe(false)
    expect(typesOf(harness.events)).toContain('turn_completed')
    expect(typesOf(harness.events)).toContain('notice')
    // The trailing result-less frame produced no extra turn events.
    expect(harness.events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
  })

  test('process crash marks the driver dead; next send respawns with resume', async () => {
    const harness = createHarness()
    harness.driver.send('one')
    const fake = harness.fakes[0]!
    fake.push({
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-crash-1',
    } as unknown as SDKMessage)
    await flush()
    expect(harness.sdkSessionIds).toEqual(['sdk-crash-1'])

    fake.exit()
    await flush()
    expect(harness.driver.isDead).toBe(true)
    expect(typesOf(harness.events)).toContain('error')

    harness.driver.send('two')
    expect(harness.fakes).toHaveLength(2)
    expect(harness.fakes[1]!.options.resume).toBe('sdk-crash-1')
    expect(harness.statuses.at(-1)).toBe('working')
  })

  test('resumeSessionId option is passed to the first query', () => {
    const harness = createHarness({ resumeSessionId: 'sdk-stored' })
    harness.driver.send('continue')
    expect(harness.fakes[0]!.options.resume).toBe('sdk-stored')
  })

  test('status: approval resolution with zero/one/multiple pending requests', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    expect(harness.statuses.at(-1)).toBe('working')

    const first = sendApproval(fake, { command: 'a' })
    const second = sendApproval(fake, { command: 'b' })
    await flush()
    expect(harness.statuses.at(-1)).toBe('permission')

    const ids = harness.events
      .filter((e) => e.type === 'approval_request')
      .map((e) => (e as { requestId: string }).requestId)
    expect(ids).toHaveLength(2)

    // Resolve one: the other still keeps the session in permission.
    harness.driver.resolveApproval(ids[0]!, 'allow')
    expect(harness.statuses.at(-1)).toBe('permission')
    harness.driver.resolveApproval(ids[1]!, 'deny')
    // Zero pending, turn continues: back to working.
    expect(harness.statuses.at(-1)).toBe('working')

    fake.push(result('success'))
    await flush()
    expect(harness.statuses.at(-1)).toBe('waiting')

    await first
    await second
  })

  test('auto policy grants tool approvals without a card or permission status', async () => {
    const harness = createHarness({ getApprovalPolicy: () => 'auto' })
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const approval = sendApproval(fake)
    await flush()

    await expect(approval).resolves.toEqual({ behavior: 'allow' })
    expect(typesOf(harness.events)).not.toContain('approval_request')
    const resolved = harness.events.find((e) => e.type === 'request_resolved') as
      | Extract<ChatEvent, { type: 'request_resolved' }>
      | undefined
    expect(resolved?.outcome).toBe('allowed')
    expect(resolved?.decidedBy).toBe('policy')
    expect(resolved?.tool).toBe('Bash')
    expect(harness.statuses).not.toContain('permission')
  })

  test('auto policy still routes AskUserQuestion to the user', async () => {
    const harness = createHarness({ getApprovalPolicy: () => 'auto' })
    harness.driver.send('choose')
    const fake = harness.fakes[0]!
    const question = sendApproval(
      fake,
      {
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'date-fns', description: 'modern' },
              { label: 'dayjs', description: 'small' },
            ],
          },
        ],
      },
      'AskUserQuestion'
    )
    await flush()

    const event = harness.events.find((e) => e.type === 'question_request')
    expect(event).toBeDefined()
    expect(harness.statuses.at(-1)).toBe('permission')
    const requestId = (event as { requestId: string }).requestId
    expect(
      harness.driver.answerQuestion(requestId, {
        'Which library?': { options: ['dayjs'] },
      })
    ).toMatchObject({ ok: true })
    await expect(question).resolves.toMatchObject({ behavior: 'allow' })
  })

  test('user decisions carry decidedBy user', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const approval = sendApproval(fake)
    await flush()
    const requestId = (harness.events.find((e) => e.type === 'approval_request') as {
      requestId: string
    }).requestId

    expect(harness.driver.resolveApproval(requestId, 'allow')).toEqual({ ok: true })
    await expect(approval).resolves.toEqual({ behavior: 'allow' })
    const resolved = harness.events.find((e) => e.type === 'request_resolved') as
      Extract<ChatEvent, { type: 'request_resolved' }>
    expect(resolved.decidedBy).toBe('user')
    expect(resolved.tool).toBeUndefined()
  })

  test('switching to auto grants pending approvals but not questions', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const approval = sendApproval(fake)
    await flush()
    const question = sendApproval(
      fake,
      {
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'date-fns', description: 'modern' },
              { label: 'dayjs', description: 'small' },
            ],
          },
        ],
      },
      'AskUserQuestion'
    )
    await flush()
    expect(harness.statuses.at(-1)).toBe('permission')

    harness.driver.onApprovalPolicyChanged('auto')
    await flush()

    await expect(approval).resolves.toEqual({ behavior: 'allow' })
    const policyGrant = harness.events
      .filter((e) => e.type === 'request_resolved')
      .find(
        (e) =>
          (e as Extract<ChatEvent, { type: 'request_resolved' }>).decidedBy ===
          'policy'
      )
    expect(policyGrant).toBeDefined()
    expect(
      (policyGrant as Extract<ChatEvent, { type: 'request_resolved' }>).tool
    ).toBe('Bash')
    // The question stays pending and user-answerable.
    const questionEvent = harness.events.find((e) => e.type === 'question_request') as {
      requestId: string
    }
    expect(
      harness.driver.answerQuestion(questionEvent.requestId, {
        'Which library?': { options: ['dayjs'] },
      })
    ).toMatchObject({ ok: true })
    await expect(question).resolves.toMatchObject({ behavior: 'allow' })
  })

  test('switching to manual leaves pending approvals with the user', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const approval = sendApproval(fake)
    await flush()

    harness.driver.onApprovalPolicyChanged('manual')
    await flush()

    const event = harness.events.find((e) => e.type === 'approval_request') as {
      requestId: string
    }
    expect(harness.driver.resolveApproval(event.requestId, 'deny')).toEqual({ ok: true })
    await expect(approval).resolves.toMatchObject({ behavior: 'deny' })
    const resolved = harness.events.find((e) => e.type === 'request_resolved') as
      Extract<ChatEvent, { type: 'request_resolved' }>
    expect(resolved.decidedBy).toBe('user')
  })
})

describe('ChatSessionDriver activity', () => {
  /** Phase bodies without elapsedMs, which is near-zero on live changes. */
  function bodies(activities: Array<ChatActivity | null>): unknown[] {
    return activities.map((activity) =>
      activity === null
        ? null
        : Object.fromEntries(
            Object.entries(activity).filter(([key]) => key !== 'elapsedMs')
          )
    )
  }

  function streamEvent(event: Record<string, unknown>, parent: string | null = null): SDKMessage {
    return {
      type: 'stream_event',
      event,
      parent_tool_use_id: parent,
      uuid: 'p-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage
  }

  function systemFrame(fields: Record<string, unknown>): SDKMessage {
    return { type: 'system', ...fields } as unknown as SDKMessage
  }

  test('a scripted turn walks the phases and ends with null', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(systemFrame({ subtype: 'status', status: 'requesting' }))
    fake.push(streamEvent({
      type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }))
    fake.push(streamEvent({
      type: 'content_block_start', index: 1,
      content_block: { type: 'text', text: '' },
    }))
    fake.push(streamEvent({
      type: 'content_block_start', index: 2,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} },
    }))
    fake.push({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'a-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    fake.push(userToolResult('toolu_1'))
    fake.push(systemFrame({
      subtype: 'api_retry', attempt: 1, max_retries: 10,
      retry_delay_ms: 567, error_status: 504, error: 'server_error',
    }))
    fake.push(systemFrame({ subtype: 'status', status: 'requesting' }))
    fake.push(result('success'))
    await flush()

    expect(bodies(harness.activities)).toEqual([
      { phase: 'requesting' },
      { phase: 'thinking' },
      { phase: 'responding' },
      { phase: 'preparing_tool', tool: 'Edit' },
      { phase: 'running_tools', tool: 'Edit', count: 1 },
      { phase: 'requesting' },
      { phase: 'retrying', attempt: 1, maxRetries: 10, errorStatus: 504 },
      { phase: 'requesting' },
      null,
    ])
    for (const activity of harness.activities) {
      if (activity) expect(activity.elapsedMs).toBeGreaterThanOrEqual(0)
    }
  })

  test('resolving an approval republishes the phase with a restarted clock', async () => {
    const harness = createHarness()
    harness.driver.send('run it')
    const fake = harness.fakes[0]!
    fake.push({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'a-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    const approval = sendApproval(fake)
    await flush()
    expect(bodies(harness.activities)).toEqual([
      { phase: 'requesting' },
      { phase: 'running_tools', tool: 'Bash', count: 1 },
    ])

    // However long the user stares at the card, the body never changes — so
    // the republish at resolution is what re-anchors clients; without it the
    // row would surface the card's whole wait as tool time (PR #34 review).
    const event = harness.events.find(
      (e) => e.type === 'approval_request'
    ) as { requestId: string }
    expect(harness.driver.resolveApproval(event.requestId, 'allow')).toEqual({
      ok: true,
    })
    await expect(approval).resolves.toMatchObject({ behavior: 'allow' })
    await flush()

    expect(harness.activities).toHaveLength(3)
    const republished = harness.activities.at(-1)!
    expect(bodies([republished])).toEqual([
      { phase: 'running_tools', tool: 'Bash', count: 1 },
    ])
    expect(republished.elapsedMs).toBeLessThanOrEqual(2)
  })

  test('subagent frames leave the parent phase untouched', async () => {
    const harness = createHarness()
    harness.driver.send('run a subagent')
    const fake = harness.fakes[0]!
    fake.push({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: {} }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'a-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(bodies(harness.activities)).toEqual([
      { phase: 'requesting' },
      { phase: 'running_tools', tool: 'Task', count: 1 },
    ])

    // The Task subagent's own requests, thinking, and tool traffic.
    fake.push(streamEvent({
      type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }, 'toolu_task'))
    fake.push({
      type: 'assistant',
      message: {
        id: 'msg_2',
        content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: {} }],
        role: 'assistant',
      },
      parent_tool_use_id: 'toolu_task',
      uuid: 'b-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    fake.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', content: 'done' }],
      },
      parent_tool_use_id: 'toolu_task',
    } as unknown as SDKMessage)
    fake.push(systemFrame({
      subtype: 'status', status: 'requesting', parent_tool_use_id: 'toolu_task',
    }))
    await flush()

    // Still "Running Task…" for the whole subagent run.
    expect(bodies(harness.activities)).toEqual([
      { phase: 'requesting' },
      { phase: 'running_tools', tool: 'Task', count: 1 },
    ])

    // The parent-level result ends the turn and the row.
    fake.push(result('success'))
    await flush()
    expect(harness.activities.at(-1)).toBeNull()
  })

  test('thinking deltas and token estimates produce no activity calls', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(streamEvent({
      type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }))
    await flush()
    expect(bodies(harness.activities)).toEqual([
      { phase: 'requesting' },
      { phase: 'thinking' },
    ])
    const before = harness.activities.length

    fake.push(streamEvent({
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'working' },
    }))
    fake.push(systemFrame({ subtype: 'thinking_tokens', estimated_tokens: 1, estimated_tokens_delta: 1 }))
    fake.push(streamEvent({ type: 'content_block_stop', index: 0 }))
    await flush()

    expect(harness.activities.length).toBe(before)
  })

  test('interrupt ends the activity after an approval resolution', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'a-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(bodies(harness.activities)).toEqual([
      { phase: 'requesting' },
      { phase: 'running_tools', tool: 'Bash', count: 1 },
    ])

    // The card's resolution republishes the same body with a restarted
    // clock (design D3's approval-wait handling; see the dedicated test).
    const approval = sendApproval(fake)
    await flush()
    const request = harness.events.find((e) => e.type === 'approval_request') as {
      requestId: string
    }
    expect(harness.driver.resolveApproval(request.requestId, 'allow')).toEqual({ ok: true })
    await flush()
    expect(bodies(harness.activities)).toEqual([
      { phase: 'requesting' },
      { phase: 'running_tools', tool: 'Bash', count: 1 },
      { phase: 'running_tools', tool: 'Bash', count: 1 },
    ])

    harness.driver.interrupt()
    await flush()
    expect(harness.activities.at(-1)).toBeNull()
    await approval
  })
})

describe('ChatSessionDriver usage', () => {
  /** A pushed rate_limit_event frame (2026-10-07 probe shape). */
  function rateLimitEvent(fields: Record<string, unknown>): SDKMessage {
    return {
      type: 'rate_limit_event',
      rate_limit_info: fields,
      uuid: 'rl-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage
  }

  /** An assistant message carrying the /usage twin on the wrapper level. */
  function usageReportMessage(limits: unknown): SDKMessage {
    return {
      type: 'assistant',
      message: {
        id: 'msg_usage',
        content: [{ type: 'text', text: 'Usage report' }],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      uuid: 'u-uuid',
      session_id: 'sdk-1',
      usage_report: { rate_limits: { limits } },
    } as unknown as SDKMessage
  }

  const FULL_PULL = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 22.37, resets_at: '2026-10-07T18:11:04.000Z' },
      seven_day: { utilization: 17.12, resets_at: '2026-10-12T09:00:00.000Z' },
    },
  }

  test('a rate_limit_event is parsed and forwarded, even outside a turn', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    harness.fakes[0]!.push(
      rateLimitEvent({
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.2237, resetsAt: Date.parse('2026-10-07T18:11:04.000Z') },
          seven_day: { utilization: 0.1712, resetsAt: Date.parse('2026-10-12T09:00:00.000Z') },
        },
      })
    )
    await flush()
    expect(harness.rateLimits).toHaveLength(1)
    expect(harness.rateLimits[0]).toMatchObject({
      status: 'allowed',
      windows: [
        { key: 'five_hour', percentUsed: 22.37 },
        { key: 'seven_day', percentUsed: 17.12 },
      ],
    })
    expect(harness.usageReports).toHaveLength(0)

    // A status-only push (the GLM shape) still reports, windowless.
    harness.fakes[0]!.push(rateLimitEvent({ status: 'allowed', isUsingOverage: false }))
    await flush()
    expect(harness.rateLimits[1]).toMatchObject({ status: 'allowed', windows: [] })
  })

  test('an assistant usage_report is parsed and forwarded', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    harness.fakes[0]!.push(
      usageReportMessage([
        { kind: 'session', percent: 22.4, resets_at: '2026-10-07T18:11:04.000Z', severity: 'normal' },
        { kind: 'weekly_scoped', percent: 42.5, scope: { model: { display_name: 'Opus' } }, severity: 'warning' },
      ])
    )
    await flush()
    expect(harness.usageReports).toHaveLength(1)
    expect(harness.usageReports[0]).toMatchObject({
      status: 'warning',
      windows: [
        { key: 'session', percentUsed: 22.4 },
        { key: 'weekly_scoped:Opus', label: 'Opus', percentUsed: 42.5 },
      ],
    })
    expect(harness.rateLimits).toHaveLength(0)

    // A report whose limits could not be fetched fires nothing.
    harness.fakes[0]!.push(usageReportMessage(null))
    await flush()
    expect(harness.usageReports).toHaveLength(1)
  })

  test('the usage pull runs after a spawn when claimed and reports windows', async () => {
    const harness = createHarness({
      claimUsagePull: () => true,
      usageImpl: async (opts) => ({ ...FULL_PULL, opts }),
    })
    harness.driver.send('hello')
    await flush()
    expect(harness.fakes[0]!.usageCalls).toEqual([{ skipBehaviors: true }])
    expect(harness.usageReports).toHaveLength(1)
    expect(harness.usageReports[0]).toMatchObject({
      status: 'allowed',
      windows: [
        { key: 'five_hour', percentUsed: 22.37 },
        { key: 'seven_day', percentUsed: 17.12 },
      ],
    })
    expect(harness.noData).toHaveLength(0)
  })

  test('a claim that returns false never touches the control', async () => {
    const harness = createHarness({
      claimUsagePull: () => false,
      usageImpl: async () => FULL_PULL,
    })
    harness.driver.send('hello')
    await flush()
    expect(harness.fakes[0]!.usageCalls).toEqual([])
    expect(harness.usageReports).toHaveLength(0)
  })

  test('rate_limits_available false and a thrown call record the no-data verdict', async () => {
    const unavailable = createHarness({
      claimUsagePull: () => true,
      usageImpl: async () => ({ rate_limits_available: false, rate_limits: null }),
    })
    unavailable.driver.send('hello')
    await flush()
    expect(unavailable.usageReports).toHaveLength(0)
    expect(unavailable.noData).toHaveLength(1)

    const throwing = createHarness({
      claimUsagePull: () => true,
      usageImpl: () => Promise.reject(new Error('unstable API changed')),
    })
    throwing.driver.send('hello')
    await flush()
    expect(throwing.noData).toHaveLength(1)
    expect(throwing.driver.isDead).toBe(false) // the failure never kills the session
  })

  test('a query without the control method records the verdict', async () => {
    // No usageImpl: the fake query omits the unstable method entirely.
    const harness = createHarness({ claimUsagePull: () => true })
    harness.driver.send('hello')
    await flush()
    expect(harness.noData).toHaveLength(1)
  })

  test('a pull yielding no windows records the verdict, not an empty report', async () => {
    const harness = createHarness({
      claimUsagePull: () => true,
      usageImpl: async () => ({ rate_limits_available: true, rate_limits: {} }),
    })
    harness.driver.send('hello')
    await flush()
    expect(harness.usageReports).toHaveLength(0)
    expect(harness.noData).toHaveLength(1)
  })

  test('a respawn does not re-pull once the claim was spent', async () => {
    let claims = 0
    const harness = createHarness({
      claimUsagePull: () => (claims += 1) === 1,
      usageImpl: async () => FULL_PULL,
    })
    harness.driver.send('first')
    await flush()
    expect(harness.fakes[0]!.usageCalls).toHaveLength(1)

    harness.fakes[0]!.exit()
    await flush()
    harness.driver.send('second')
    await flush()
    expect(harness.fakes).toHaveLength(2)
    expect(harness.fakes[1]!.usageCalls).toHaveLength(0)
    expect(claims).toBe(2)
  })
})
