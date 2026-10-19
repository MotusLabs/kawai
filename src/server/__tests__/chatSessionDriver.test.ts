import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CwdChangedHookInput,
  HookJSONOutput,
  Options,
  PermissionResult,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatActivity,
  ChatEvent,
  ChatWorker,
} from '../../shared/chat'
import { turnSucceeded } from '../../shared/chat'
import type { ChatWireRecorder } from '../chat/wireTap'
import type { ChatLimitSignal } from '../chat/limitSignals'
import type { OutboundAuditSink } from '../outbound/observer'
import { outboundFile } from '../outbound/destinations'
import { applyChatEvents, emptyTranscript } from '../../client/stores/chatStore'
import { SessionTeams } from '../team/sessionTeams'
import { consumerMessages } from './fixtures/backgroundTasks'
import type { ChatSpawnInfo } from '../chat/ChatSessionDriver'
import {
  assistantText,
  createHarness,
  flush,
  result,
  typesOf,
  userToolResult,
  type FakeQueryHandle,
  type Harness,
} from './fixtures/chatDriverHarness'

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


/** Top-level (or subagent, with a parent id) stream event for usage tests. */
function streamEvent(event: Record<string, unknown>, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: parentToolUseId,
    uuid: `se-${Math.random()}`,
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

/**
 * Assistant frame carrying per-request usage (design D1): input + cache_read
 * + cache_creation + output is the next request's cost, never a total. A
 * non-null parentToolUseId marks the frame as a Task subagent's (design D6).
 */
function assistantUsage(
  usage: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens?: number
  },
  id = 'msg_usage',
  parentToolUseId: string | null = null
): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id,
      content: [],
      role: 'assistant',
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
      },
    },
    parent_tool_use_id: parentToolUseId,
    uuid: `uuid-${id}`,
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

/**
 * A context-usage control response (SDKControlGetContextUsageResponse) with
 * test-safe defaults; override rawMaxTokens, autoCompactThreshold, and
 * categories. Buffer rows are the autocompact reserve (design D2).
 */
function contextReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    categories: [],
    totalTokens: 0,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 0,
    gridRows: [],
    model: 'claude-sonnet-4-5',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
    ...overrides,
  }
}

/** A modelUsage map whose every model runs the given context window. */
function modelUsageWith(contextWindow: number): Record<string, unknown> {
  return {
    'claude-sonnet-4-5': {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 1,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow,
      maxOutputTokens: 8_192,
    },
  }
}

/**
 * A compact_boundary frame; postTokens omitted leaves post_tokens unset —
 * compact_metadata is required but post_tokens is optional (design D3).
 */
function compactBoundary(
  trigger: 'auto' | 'manual',
  preTokens: number,
  postTokens?: number
): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger,
      pre_tokens: preTokens,
      ...(postTokens !== undefined ? { post_tokens: postTokens } : {}),
    },
    uuid: 'compact-uuid',
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

/**
 * A system/notification frame (notification strip design D4): the CLI's
 * notification queue on the SDK channel.
 */
function notificationFrame(
  overrides: Record<string, unknown> = {}
): SDKMessage {
  return {
    type: 'system',
    subtype: 'notification',
    key: 'model-context-window',
    text: 'Context left: less than 20%',
    priority: 'high',
    color: 'warning',
    timeout_ms: 15_000,
    uuid: 'notification-uuid',
    session_id: 'sdk-1',
    ...overrides,
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
    expect(first.options.model).toBe('opus')
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
    expect(glm.fakes[1]!.options.model).toBe('opus')
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
        env: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:9292' },
      },
    }))
    const lan = createHarness({ claudeProfileId: 'lan', claudeExecutablePath: '/opt/claude/bin/claude' })
    lan.driver.send('lan turn')
    const options = lan.fakes[0]!.options
    // The wrapper replaces the checked Claude Code binary...
    expect(options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude-lan')
    // ...receives the entry environment pre-applied on the merged base...
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('http://192.0.2.10:9292')
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

  test('the team prompt is appended to the preset and re-read only at the next spawn', async () => {
    let prompt = '# Your role: QA\n\nTest it.'
    let reads = 0
    const harness = createHarness({ getSystemPromptAppend: () => { reads++; return prompt } })
    harness.driver.send('hello')
    expect(harness.fakes[0]!.options.systemPrompt).toEqual({
      type: 'preset', preset: 'claude_code', append: '# Your role: QA\n\nTest it.',
    })
    // An edit while the process runs changes nothing for it.
    prompt = '# Your role: QA\n\nTest it twice.'
    harness.driver.send('again')
    expect(reads).toBe(1)
    harness.fakes[0]!.exit()
    await flush()
    harness.driver.send('after exit')
    expect(harness.fakes[1]!.options.systemPrompt).toMatchObject({ append: '# Your role: QA\n\nTest it twice.' })
    expect(reads).toBe(2)
    harness.driver.kill()
  })

  test('audit hooks (execution-safety-recovery D3): registered for the audited tools, observational only', () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const hooks = harness.fakes[0]!.options.hooks as Record<string, Array<{ matcher?: string; hooks: Array<(input: unknown) => Promise<unknown>> }>>
    expect(hooks.CwdChanged).toHaveLength(1)
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
      expect(hooks[event]).toHaveLength(1)
      expect(hooks[event]![0]!.matcher).toBe('^(Bash|Monitor|mcp__.+)$')
    }
    harness.driver.kill()
  })

  test('the no-decision test: every event and tool returns exactly { continue: true }, observer included', async () => {
    const throws: OutboundAuditSink = {
      onPreToolUse: () => { throw new Error('sink down') },
      onPostToolUse: () => { throw new Error('sink down') },
      onPostToolUseFailure: () => { throw new Error('sink down') },
      onPermissionDenied: () => { throw new Error('sink down') },
      onDeniedCard: () => { throw new Error('sink down') },
      onSpawnEnd: () => { throw new Error('sink down') },
    }
    const harness = createHarness({ outbound: throws })
    harness.driver.send('hello')
    const hooks = harness.fakes[0]!.options.hooks as Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>
    const inputs = [
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'tu-1', agent_id: 'agent-1' },
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__web-lookup__fetch', tool_input: { url: 'https://example.com' }, tool_use_id: 'tu-2' },
      { hook_event_name: 'PostToolUse', tool_name: 'Monitor', tool_input: { command: 'x' }, tool_response: '', tool_use_id: 'tu-3', duration_ms: 5 },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'tu-4', error: 'boom', is_interrupt: true },
      { hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'tu-5', reason: 'policy' },
    ]
    for (const [event, uses] of [
      ['PreToolUse', inputs.slice(0, 2)],
      ['PostToolUse', [inputs[2]]],
      ['PostToolUseFailure', [inputs[3]]],
      ['PermissionDenied', [inputs[4]]],
    ] as const) {
      for (const input of uses) {
        const result = await hooks[event]![0]!.hooks[0]!(input)
        expect(result).toEqual({ continue: true })
      }
    }
    harness.driver.kill()
  })

  test('the hook returns before the store write: an async sink cannot delay it', async () => {
    // A sink that writes off the microtask queue (as the observer does): if
    // the driver ever awaited the sink, or the observer wrote inline, the
    // push would land before the hook's promise resolved and this fails.
    const seen: string[] = []
    const defer = (line: string): void => { setImmediate(() => seen.push(line)) }
    const sink: OutboundAuditSink = {
      onPreToolUse: use => defer(`pre:${use.toolName}`),
      onPostToolUse: use => defer(`post:${use.toolName}`),
      onPostToolUseFailure: use => defer(`fail:${use.toolName}`),
      onPermissionDenied: use => defer(`denied:${use.toolName}`),
      onDeniedCard: use => defer(`card:${use.toolUseId}`),
      onSpawnEnd: () => defer('spawn-end'),
    }
    const harness = createHarness({ outbound: sink })
    harness.driver.send('hello')
    const hooks = harness.fakes[0]!.options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'tu-9' }
    await hooks.PreToolUse[0]!.hooks[0]!(input)
    // The hook resolved before the sink's deferred write ran.
    expect(seen).toEqual([])
    await flush()
    expect(seen).toEqual(['pre:Bash'])
    harness.driver.kill()
  })

  test('a declined card reports one denied outcome (D3)', async () => {
    const denied: Array<{ toolUseId: string; reason?: string }> = []
    const sink: OutboundAuditSink = {
      onPreToolUse: () => {},
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
      onPermissionDenied: () => {},
      onDeniedCard: use => { denied.push({ toolUseId: use.toolUseId, ...(use.reason === undefined ? {} : { reason: use.reason }) }) },
      onSpawnEnd: () => {},
    }
    const harness = createHarness({ outbound: sink })
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const approval = sendApproval(fake, { command: 'git push' })
    await flush()
    const event = harness.events.find(e => e.type === 'approval_request') as { requestId: string }
    harness.driver.resolveApproval(event.requestId, 'deny')
    await expect(approval).resolves.toMatchObject({ behavior: 'deny' })
    await flush()
    expect(denied).toHaveLength(1)
    // A declined card carries no interrupt reason.
    expect(denied[0]?.reason).toBeUndefined()
    harness.driver.kill()
  })

  test('an interrupt-cancelled card stays denied, with detail interrupted (CC round 3)', async () => {
    const denied: Array<{ toolUseId: string; reason?: string }> = []
    const sink: OutboundAuditSink = {
      onPreToolUse: () => {},
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
      onPermissionDenied: () => {},
      onDeniedCard: use => { denied.push({ toolUseId: use.toolUseId, reason: use.reason }) },
      onSpawnEnd: () => {},
    }
    const harness = createHarness({ outbound: sink })
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const controller = new AbortController()
    const cancelled = fake.options.canUseTool!('Bash', { command: 'git push' }, {
      signal: controller.signal,
      toolUseID: 'toolu_cancel',
      requestId: 'sdk-req-cancel',
    })
    await flush()
    controller.abort()
    const result = await cancelled
    expect(result).toMatchObject({ behavior: 'deny', interrupt: true })
    await flush()
    expect(denied).toEqual([{ toolUseId: 'toolu_cancel', reason: 'interrupted' }])
    harness.driver.kill()
  })

  test('a foreground Bash the harness moved to the background records started-background (CC round 3, round 4 F)', async () => {
    const backgrounds: boolean[] = []
    const sink: OutboundAuditSink = {
      onPreToolUse: () => {},
      onPostToolUse: use => { backgrounds.push(use.background) },
      onPostToolUseFailure: () => {},
      onPermissionDenied: () => {},
      onDeniedCard: () => {},
      onSpawnEnd: () => {},
    }
    const harness = createHarness({ outbound: sink })
    harness.driver.send('hello')
    const hooks = harness.fakes[0]!.options.hooks as { PostToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }
    const post = (response: unknown, id: string): Promise<unknown> =>
      hooks.PostToolUse[0]!.hooks[0]!({ tool_name: 'Bash', tool_input: { command: 'bun run test' }, tool_response: response, tool_use_id: id })
    // The SDK's typed shape (BashOutput): a backgroundTaskId, a user move,
    // and a timeout move all mark the call backgrounded.
    await post({ type: 'text', backgroundTaskId: 'bash_1' }, 'tu-bg-1')
    await post({ type: 'text', backgroundedByUser: true }, 'tu-bg-2')
    await post({ type: 'text', timedOutAfterMs: 120_000 }, 'tu-bg-3')
    // A plain structured output and a plain string stay foreground.
    await post({ type: 'text', text: 'done' }, 'tu-fg-1')
    await post('done', 'tu-fg-2')
    // The older text marker stays as a fallback for older builds.
    await post('Command did not complete within its 120s timeout and was moved to the background (ID: b0usjmoay).', 'tu-bg-4')
    expect(backgrounds).toEqual([true, true, true, false, false, true])
    harness.driver.kill()
  })

  test('the outbound facts reach the append, re-read only at the next spawn', async () => {
    // A real SessionTeams over a temporary home: promptFor reads the loader
    // at each call (execution-safety-recovery D1/D2), and the driver reads
    // the append only at spawn, so an edit reaches the next start alone.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-outbound-spawn-'))
    try {
      fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
      fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['one.example.internal'] }))
      const teams = new SessionTeams({ homeDir: home })
      const harness = createHarness({ getSystemPromptAppend: () => teams.promptFor('chat-test', null) })
      const appendOf = (index: number): string =>
        (harness.fakes[index]!.options.systemPrompt as { append?: string }).append ?? ''
      harness.driver.send('hello')
      expect(appendOf(0)).toContain(
        'Internal destinations the owner configured: one.example.internal.'
      )
      // An edit while the process runs changes nothing for it.
      const earlier = new Date('2026-01-01T00:00:00Z')
      fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['two.example.internal'] }))
      fs.utimesSync(outboundFile(home), earlier, earlier)
      harness.fakes[0]!.exit()
      await flush()
      harness.driver.send('after exit')
      // The first process kept the append it was spawned with.
      expect(appendOf(0)).toContain('one.example.internal')
      expect(appendOf(0)).not.toContain('two.example.internal')
      // The respawn rendered the edited destinations.
      expect(appendOf(1)).toContain(
        'Internal destinations the owner configured: two.example.internal.'
      )
      harness.driver.kill()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test('onSpawn reports each constructed query: first start, resume, and the respawn after a crash', async () => {
    const spawns: ChatSpawnInfo[] = []
    const harness = createHarness({
      resumeSessionId: 'sdk-prev',
      getSystemPromptAppend: () => 'role text',
      getEffort: () => 'high',
      onSpawn: info => spawns.push(info),
    })
    harness.driver.send('hello')
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ cwd: '/tmp/project', systemPromptAppend: 'role text', effort: 'high', model: null, resumed: true })
    expect(spawns[0]!.env).toBeDefined()
    harness.driver.send('again')
    expect(spawns).toHaveLength(1)
    harness.fakes[0]!.exit()
    await flush()
    harness.driver.send('after crash')
    expect(spawns).toHaveLength(2)
  })

  test('a throwing onSpawn never fails the spawn', async () => {
    const harness = createHarness({ onSpawn: () => { throw new Error('recorder broke') } })
    harness.driver.send('hello')
    expect(harness.fakes).toHaveLength(1)
    expect(harness.driver.isDead).toBe(false)
    expect(harness.statuses.at(-1)).toBe('working')
  })

  test('the group effort is a launch option, re-read only at the next spawn', async () => {
    let effort: Options['effort'] = 'medium'
    let reads = 0
    const harness = createHarness({ getEffort: () => { reads++; return effort } })
    harness.driver.send('hello')
    expect(harness.fakes[0]!.options.effort).toBe('medium')
    // An edit while the process runs changes nothing for it.
    effort = 'max'
    harness.driver.send('again')
    expect(reads).toBe(1)
    harness.fakes[0]!.exit()
    await flush()
    harness.driver.send('after exit')
    expect(harness.fakes[1]!.options.effort).toBe('max')
    // Removing it leaves Claude Code's settings in force: no effort key.
    effort = undefined
    harness.fakes[1]!.exit()
    await flush()
    harness.driver.send('after removal')
    expect('effort' in harness.fakes[2]!.options).toBe(false)
    expect(reads).toBe(3)
    harness.driver.kill()
  })

  test('without a getter no effort option is passed', () => {
    const harness = createHarness()
    harness.driver.send('hello')
    expect('effort' in harness.fakes[0]!.options).toBe(false)
    harness.driver.kill()
  })

  test('without a team prompt the preset is unchanged', () => {
    const harness = createHarness({ getSystemPromptAppend: () => '' })
    harness.driver.send('hello')
    expect(harness.fakes[0]!.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
    harness.driver.kill()
  })

  test('start spawns the query without a turn; a later send reuses the same query', async () => {
    const harness = createHarness()
    harness.driver.start()
    expect(harness.fakes).toHaveLength(1)
    // No turn, no user message: only the spawn happened.
    expect(typesOf(harness.events)).toEqual([])
    expect(harness.statuses).toEqual([])

    // While the query runs, start is a no-op (no second spawn).
    harness.driver.start()
    expect(harness.fakes).toHaveLength(1)

    // A later send reuses the same query for its turn and reaches its prompt.
    harness.driver.send('hello')
    expect(harness.fakes).toHaveLength(1)
    expect(typesOf(harness.events)).toEqual(['turn_started', 'user_message'])
    const pulled = await harness.fakes[0]!.pullPrompt()
    expect(pulled?.message).toMatchObject({ role: 'user', content: 'hello' })
  })

  test('start respawns a dead driver with resume', async () => {
    const harness = createHarness()
    harness.driver.start()
    const first = harness.fakes[0]!
    first.push({
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-start-resume',
    } as unknown as SDKMessage)
    await flush()
    first.exit()
    await flush()
    expect(harness.driver.isDead).toBe(true)

    harness.driver.start()
    expect(harness.fakes).toHaveLength(2)
    expect(harness.fakes[1]!.options.resume).toBe('sdk-start-resume')
    harness.driver.kill()
  })

  describe('command state', () => {
    test('spawn publishes loading, the initialize response publishes ready', async () => {
      const harness = createHarness({
        initializationCommands: [
          { name: 'clear', description: 'new session', argumentHint: '[name]', aliases: ['reset'], builtin: true },
          { name: 'openspec-explore', description: 'explore (project)' },
        ],
      })
      harness.driver.start()
      await flush()
      expect(harness.commandStates.map((state) => state.status)).toEqual([
        'loading',
        'ready',
      ])
      const ready = harness.commandStates.at(-1)!
      expect(ready.commands).toEqual([
        { name: 'clear', description: 'new session', argumentHint: '[name]', aliases: ['reset'], source: 'builtin' },
        { name: 'openspec-explore', description: 'explore', aliases: [], source: 'project' },
      ])
      harness.driver.kill()
    })

    test('commands_changed replaces the list', async () => {
      const harness = createHarness({
        initializationCommands: [{ name: 'usage', description: 'costs', builtin: true }],
      })
      harness.driver.start()
      await flush()
      harness.fakes[0]!.push({
        type: 'system',
        subtype: 'commands_changed',
        commands: [{ name: 'fresh', description: 'newly discovered' }],
      } as unknown as SDKMessage)
      await flush()
      const ready = harness.commandStates.at(-1)!
      expect(ready.status).toBe('ready')
      expect(ready.commands.map((command) => command.name)).toEqual(['fresh'])
      harness.driver.kill()
    })

    test('init replaces the terminal set and re-publishes without init payload it stays', async () => {
      const harness = createHarness({
        initializationCommands: [
          { name: 'statusline', description: 'prompt', builtin: true },
          { name: 'doctor', description: 'health', builtin: true },
        ],
      })
      harness.driver.start()
      await flush()
      // doctor is hidden by the fallback terminal set until init speaks.
      expect(harness.commandStates.at(-1)!.commands.map((c) => c.name)).toEqual(['statusline'])

      // init without terminal_slash_commands (pre-field CLI): unchanged.
      harness.fakes[0]!.push({
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-c1',
      } as unknown as SDKMessage)
      await flush()
      expect(harness.commandStates).toHaveLength(2)

      // init naming statusline terminal-bound hides it and re-publishes.
      harness.fakes[0]!.push({
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-c1',
        terminal_slash_commands: ['statusline'],
      } as unknown as SDKMessage)
      await flush()
      expect(harness.commandStates.at(-1)!.commands.map((c) => c.name)).toEqual(['doctor'])
      harness.driver.kill()
    })

    test('death and kill mark unavailable; a respawn publishes loading again', async () => {
      const harness = createHarness({
        initializationCommands: [{ name: 'usage', description: 'costs', builtin: true }],
      })
      harness.driver.start()
      await flush()
      expect(harness.commandStates.at(-1)!.status).toBe('ready')

      harness.fakes[0]!.exit()
      await flush()
      expect(harness.driver.getCommandState().status).toBe('unavailable')

      harness.driver.start() // respawn
      expect(harness.driver.getCommandState().status).toBe('loading')
      harness.driver.kill()
      expect(harness.driver.getCommandState().status).toBe('unavailable')
    })

    test('local command output maps to a command_output event in the active turn', async () => {
      const harness = createHarness()
      harness.driver.send('/context')
      const fake = harness.fakes[0]!
      fake.push({
        type: 'system',
        subtype: 'local_command_output',
        content: 'Context usage: 12%',
      } as unknown as SDKMessage)
      await flush()
      // Output after the turn ended has no turn to attach to: dropped.
      harness.driver.interrupt()
      fake.push({
        type: 'system',
        subtype: 'local_command_output',
        content: 'orphan output',
      } as unknown as SDKMessage)
      await flush()
      const outputs = harness.events.filter((e) => e.type === 'command_output')
      expect(outputs).toHaveLength(1)
      expect(outputs[0]).toMatchObject({ text: 'Context usage: 12%', turnId: 'turn-1' })
      harness.driver.kill()
    })
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
    // No provider overrides: the server env, minus the variables the shipped
    // catalog names as credentials (openrouter-provider D3).
    expect((fake.options.env as Record<string, string | undefined>).PATH).toBe(process.env.PATH)
    expect(fake.options.env).not.toHaveProperty('OPENROUTER_API_KEY')

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

  test('turn_completed carries the result usage: full, partial (missing fields read 0), and absent', async () => {
    const harness = createHarness()
    const fake = () => harness.fakes.at(-1)!
    const completions = () => harness.events.filter(event => event.type === 'turn_completed')
    harness.driver.send('one')
    fake().push(result('success', { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } }))
    await flush()
    harness.driver.send('two')
    fake().push(result('success', { usage: { output_tokens: 5 } }))
    await flush()
    harness.driver.send('three')
    fake().push(result('success', { usage: undefined }))
    await flush()
    expect(completions().map(event => (event as { usage?: unknown }).usage)).toEqual([
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 40 },
      { inputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      undefined,
    ])
    expect('usage' in completions()[2]!).toBe(false)
  })

  test("turn_completed carries the provider-reported cost summed over the turn's stream, beside the SDK estimate", async () => {
    const harness = createHarness()
    const fake = () => harness.fakes.at(-1)!
    const completions = () => harness.events.filter(event => event.type === 'turn_completed') as Array<{ totalCostUsd?: number; providerCostUsd?: number }>
    // The spike's OpenRouter turn: one streamed call charged $0.001064075
    // while the SDK estimated $0.042563 from list prices.
    harness.driver.send('one')
    fake().push(streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 12, cost: 0.001064075 } }))
    fake().push(result('success', { total_cost_usd: 0.042563 }))
    await flush()
    // Several calls, a subagent's streamed one included, add up.
    harness.driver.send('two')
    fake().push(streamEvent({ type: 'message_delta', delta: {}, usage: { output_tokens: 1, cost: 0.002 } }))
    fake().push(streamEvent({ type: 'message_delta', delta: {}, usage: { output_tokens: 1, cost: 0.001 } }, 'toolu_task'))
    fake().push(result('success'))
    await flush()
    // No cost field (or an unusable one): no provider cost, nothing carried over.
    harness.driver.send('three')
    fake().push(streamEvent({ type: 'message_delta', delta: {}, usage: { output_tokens: 1 } }))
    fake().push(streamEvent({ type: 'message_delta', delta: {}, usage: { output_tokens: 1, cost: -1 } }))
    fake().push(streamEvent({ type: 'message_delta', delta: {}, usage: { output_tokens: 1, cost: 'free' } }))
    fake().push(result('success'))
    await flush()
    const [first, second, third] = completions()
    expect(first).toMatchObject({ totalCostUsd: 0.042563, providerCostUsd: 0.001064075 })
    expect(second!.providerCostUsd).toBeCloseTo(0.003, 12)
    expect(third).toMatchObject({ totalCostUsd: 0.01 })
    expect('providerCostUsd' in third!).toBe(false)
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

  test('text, tool, text of one SDK message apply as three ordered entries (chat-transcript-layout D5)', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    const stream = (uuid: string, event: unknown) => fake.push({
      type: 'stream_event', event, parent_tool_use_id: null, uuid, session_id: 'sdk-1',
    } as unknown as SDKMessage)
    // The CLI emits one assistant frame per content block, all with one id.
    const block = (uuid: string, content: unknown) => fake.push({
      type: 'assistant', message: { id: 'msg_split', role: 'assistant', content: [content] },
      parent_tool_use_id: null, uuid, session_id: 'sdk-1',
    } as unknown as SDKMessage)
    stream('s-0', { type: 'message_start', message: { id: 'msg_split' } })
    stream('s-1', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Look' } })
    block('b-1', { type: 'text', text: 'Looking' })
    block('b-2', { type: 'tool_use', id: 'toolu_split', name: 'Read', input: {} })
    stream('s-2', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Do' } })
    block('b-3', { type: 'text', text: 'Done' })
    await flush()

    const applied = applyChatEvents(emptyTranscript(), harness.events)
    const shape = applied.events
      .filter((event) => event.type === 'assistant_text' || event.type === 'tool_call')
      .map((event) => event.type === 'assistant_text' ? event.text : event.type)
    expect(shape).toEqual(['Looking', 'tool_call', 'Done'])
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

  test('own text with options: refused for single-select, appended for multi-select', async () => {
    const harness = createHarness()
    harness.driver.send('ask')
    const fake = harness.fakes[0]!
    const ask = (question: string, multiSelect: boolean, id: string) => fake.options.canUseTool!(
      'AskUserQuestion',
      { questions: [{ question, header: id, multiSelect, options: [{ label: 'x' }, { label: 'y' }] }] },
      { signal: new AbortController().signal, toolUseID: id, requestId: 'r' }
    )
    const latestRequestId = () =>
      (harness.events.filter((e) => e.type === 'question_request').at(-1) as { requestId: string }).requestId

    const single: Promise<PermissionResult | null> = ask('One?', false, 'q1')
    await flush()
    const singleId = latestRequestId()
    const both = harness.driver.answerQuestion(singleId, { 'One?': { options: ['x'], text: 'mine' } })
    expect(both).toMatchObject({ ok: false })
    expect((both as { error: string }).error).toContain('not both')
    expect(harness.driver.answerQuestion(singleId, { 'One?': { options: ['x'], text: '   ' } })).toEqual({ ok: true })
    await expect(single).resolves.toMatchObject({ updatedInput: { answers: { 'One?': 'x' } } })

    const multi: Promise<PermissionResult | null> = ask('Many?', true, 'q2')
    await flush()
    expect(harness.driver.answerQuestion(latestRequestId(), {
      'Many?': { options: ['x', 'y'], text: ' and z ' },
    })).toEqual({ ok: true })
    await expect(multi).resolves.toMatchObject({
      updatedInput: { answers: { 'Many?': 'x, y, and z' }, response: 'and z' },
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

  test('a success result with is_error completes the turn as failed (the 2026-10-18 incident frames)', async () => {
    const harness = createHarness()
    harness.driver.send('go')
    const fake = harness.fakes[0]!
    // The CLI's blocking-limit refusal: a <synthetic> reply with zero usage,
    // then subtype success with is_error and the terminal reason.
    fake.push({
      type: 'assistant',
      message: {
        id: 'msg_synthetic',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'Prompt is too long' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: 'synthetic-uuid',
      session_id: 'sdk-1',
      error: 'invalid_request',
    } as unknown as SDKMessage)
    fake.push(
      result('success', {
        is_error: true,
        result: 'Prompt is too long',
        terminal_reason: 'blocking_limit',
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    )
    await flush()

    const completed = harness.events.find((e) => e.type === 'turn_completed')
    expect(completed).toMatchObject({ subtype: 'success', isError: true, terminalReason: 'blocking_limit' })
    expect(completed && 'finalText' in completed).toBe(false)
    expect(completed && turnSucceeded(completed as never)).toBe(false)
    const error = harness.events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ message: 'Prompt is too long (blocking_limit)' })
    expect(harness.statuses.at(-1)).toBe('waiting')
    expect(harness.driver.isDead).toBe(false)
  })

  test('a plain success result carries isError false and no error event', async () => {
    const harness = createHarness()
    harness.driver.send('hi')
    harness.fakes[0]!.push(result('success'))
    await flush()
    const completed = harness.events.find((e) => e.type === 'turn_completed')
    expect(completed).toMatchObject({ isError: false, finalText: 'all done' })
    expect(completed && 'terminalReason' in completed).toBe(false)
    expect(harness.events.some((e) => e.type === 'error')).toBe(false)
  })

  test('turn identities stay unique when the same managed session constructs a fresh driver', () => {
    const first=createHarness({deterministicTurnIds:false})
    const restarted=createHarness({deterministicTurnIds:false})
    first.driver.send('first');restarted.driver.send('after restart')
    const a=first.events.find(event=>event.type==='turn_started')!.turnId
    const b=restarted.events.find(event=>event.type==='turn_started')!.turnId
    expect(a).not.toBe(b)
    expect(a).toMatch(/^turn-[0-9a-f-]{36}$/)
    first.driver.kill();restarted.driver.kill()
  })

  test('structured compaction preserves metadata, measures only an observed start and isolates callback failure', async () => {
    const observations: import('../../shared/processObservations').Measurement[] = []
    const h = createHarness({onCompaction:data=>observations.push(data)})
    h.driver.send('hi')
    h.fakes[0]!.push(compactBoundary('auto', 100))
    await flush()
    expect(observations[0]).toMatchObject({trigger:'auto',preTokens:100,postTokens:null,startedAt:null,durationSeconds:null,outcome:'completed'})
    h.fakes[0]!.push({type:'system',subtype:'status',status:'compacting'} as unknown as SDKMessage)
    h.fakes[0]!.push(compactBoundary('manual', 200, 50))
    await flush()
    expect(observations[1]).toMatchObject({outcome:'started',endedAt:null})
    expect(observations[2]).toMatchObject({trigger:'manual',preTokens:200,postTokens:50,outcome:'completed'})
    expect(typeof observations[2]!.durationSeconds).toBe('number')
    h.driver.kill()
    const failing=createHarness({onCompaction:()=>{throw Error('recorder failure')}})
    failing.driver.send('hi');failing.fakes[0]!.push(compactBoundary('auto',100,40))
    failing.fakes[0]!.push(result('success'));await flush()
    expect(typesOf(failing.events)).toContain('turn_completed')
    failing.driver.kill()
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

describe('ChatSessionDriver notifications', () => {
  test('a warning notification maps to a warning-severity ChatNotification with its timeout', async () => {
    const harness = createHarness()
    await harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(notificationFrame())
    await flush()
    const [notification, timeoutMs] = harness.notifications[0]!
    expect(notification).toMatchObject({
      key: 'model-context-window',
      source: 'agent',
      severity: 'warning',
      priority: 'high',
      text: 'Context left: less than 20%',
    })
    expect(typeof notification.receivedAt).toBe('string')
    expect(timeoutMs).toBe(15_000)
    // The frame never becomes a transcript event.
    expect(typesOf(harness.events)).not.toContain('notice')
  })

  test('an error color maps to error severity; a missing color maps to info', async () => {
    const harness = createHarness()
    await harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(notificationFrame({ key: 'error-compacting-conversation', text: 'Error compacting conversation', color: 'error' }))
    fake.push(notificationFrame({ key: 'memory-paused', text: 'Memory is paused', color: undefined, priority: 'medium', timeout_ms: undefined }))
    await flush()
    expect(harness.notifications.map(([notification]) => notification.severity)).toEqual(['error', 'info'])
    expect(harness.notifications.map(([, timeoutMs]) => timeoutMs)).toEqual([15_000, undefined])
    expect(harness.notifications[1]![0]).toMatchObject({ key: 'memory-paused', priority: 'medium' })
  })

  test('malformed frames without a key or text are ignored', async () => {
    const harness = createHarness()
    await harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(notificationFrame({ key: '', text: 'no key' }))
    fake.push(notificationFrame({ key: 'has-key', text: '' }))
    fake.push(notificationFrame({ key: undefined, text: undefined }))
    await flush()
    expect(harness.notifications).toEqual([])
  })

  test('an unknown priority degrades to low instead of leaking through', async () => {
    const harness = createHarness()
    await harness.driver.send('hello')
    harness.fakes[0]!.push(notificationFrame({ priority: 'whenever' as unknown as 'high' }))
    await flush()
    expect(harness.notifications[0]![0].priority).toBe('low')
  })

  test('notifications arrive outside a turn as well, like rate-limit frames', async () => {
    const harness = createHarness()
    harness.driver.start()
    await flush()
    harness.fakes[0]!.push(notificationFrame())
    await flush()
    expect(harness.notifications).toHaveLength(1)
  })

  test('an unexpected process exit fires onProcessEnd once; the respawn does not', async () => {
    const harness = createHarness()
    await harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(notificationFrame({ timeout_ms: undefined }))
    await flush()
    expect(harness.notifications).toHaveLength(1)

    // The process dies on its own: the holder of the notices must hear it,
    // because the same driver object respawns without a new construction.
    fake.exit()
    await flush()
    expect(harness.processEnds).toHaveLength(1)
    expect(harness.driver.isDead).toBe(true)

    harness.driver.send('again')
    await flush()
    expect(harness.fakes).toHaveLength(2)
    expect(harness.processEnds).toHaveLength(1)
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
          five_hour: { utilization: 0.2237, resetsAt: Date.parse('2026-10-07T18:11:04.000Z') / 1000 },
          seven_day: { utilization: 0.1712, resetsAt: Date.parse('2026-10-12T09:00:00.000Z') / 1000 },
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

describe('ChatSessionDriver context usage', () => {
  // Same pinned-home isolation as the main describe: launch resolution must
  // not see a real ~/.kawai — and neither may an operator-level auto-compact
  // window (an agent dev shell carries one), or the profile-window fallback
  // would outrank the report thresholds these tests assert.
  let tempHome: string
  const originalHome = process.env.HOME
  const originalAutoCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatdriver-'))
    process.env.HOME = tempHome
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  })
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalAutoCompact !== undefined) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = originalAutoCompact
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  test('the reading tracks the latest request, never the session total', async () => {
    const harness = createHarness()
    harness.driver.send('turn one')
    const fake = harness.fakes[0]!
    // First request: 60k of a window the result frame then reveals as 200k.
    fake.push(assistantUsage({ input_tokens: 10_000, cache_read_input_tokens: 45_000, cache_creation_input_tokens: 4_000, output_tokens: 1_000 }, 'msg_1'))
    fake.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    expect(harness.contextUsage).toHaveLength(1)
    expect(harness.contextUsage[0]).toMatchObject({ usedTokens: 60_000, thresholdTokens: 200_000, percentage: 30 })

    // Second request: a bigger single request replaces — never adds to — the
    // previous reading, even after turns of traffic whose session totals far
    // exceed the window.
    harness.driver.send('turn two')
    fake.push(assistantUsage({ input_tokens: 20_000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 8_000, output_tokens: 2_000 }, 'msg_2'))
    await flush()
    expect(harness.contextUsage).toHaveLength(2)
    expect(harness.contextUsage[1]).toMatchObject({ usedTokens: 120_000, thresholdTokens: 200_000, percentage: 60 })
  })

  test("a Task subagent's usage does not move the meter", async () => {
    const harness = createHarness()
    harness.driver.send('run a task')
    const fake = harness.fakes[0]!
    const parent = { input_tokens: 10_000, cache_read_input_tokens: 45_000, cache_creation_input_tokens: 4_000, output_tokens: 1_000 }
    fake.push(assistantUsage(parent, 'msg_1'))
    fake.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    expect(harness.contextUsage).toHaveLength(1)

    // The subagent's own giant request is invisible to the parent's meter.
    fake.push(assistantUsage({ input_tokens: 150_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 6_000, output_tokens: 4_000 }, 'msg_sub', 'toolu_task_1'))
    await flush()
    expect(harness.contextUsage).toHaveLength(1)

    // The next parent frame still publishes normally.
    fake.push(assistantUsage({ input_tokens: 12_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 4_000, output_tokens: 1_000 }, 'msg_2'))
    await flush()
    expect(harness.contextUsage).toHaveLength(2)
    expect(harness.contextUsage[1]).toMatchObject({ usedTokens: 67_000 })
  })

  test('no reading exists before the first model request, however rich the thresholds', async () => {
    // Every threshold source can answer at attach; without a used count
    // there is no reading at all — null, never a placeholder (design D7).
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 167_000 }),
      getProviderEnv: () => ({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }),
    })
    harness.driver.start()
    await flush()
    harness.fakes[0]!.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    expect(harness.contextUsage).toHaveLength(0)
    harness.driver.kill()
  })

  test('the report threshold wins over the profile window and the model limit', async () => {
    const harness = createHarness({
      contextImpl: async () =>
        // autoCompactThreshold present: rawMaxTokens − buffer (167000) must
        // NOT be derived over the observed 120000 (design D2 step 1).
        contextReport({ autoCompactThreshold: 120_000, rawMaxTokens: 200_000, categories: [{ name: 'buffer', tokens: 33_000, color: '#fff', kind: 'buffer' }] }),
      getProviderEnv: () => ({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }),
    })
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(assistantUsage({ input_tokens: 60_000 }, 'msg_1'))
    fake.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 60_000, thresholdTokens: 120_000 })
    // The control fired on attach and again at the turn boundary.
    expect(fake.contextCalls.map((call) => call.detail)).toEqual(['summary', 'summary'])
  })

  test('interrupting a turn re-resolves the threshold', async () => {
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 167_000 }),
    })
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(assistantUsage({ input_tokens: 100_000 }, 'msg_1'))
    await flush()
    expect(fake.contextCalls).toHaveLength(1) // attach only, mid-turn
    harness.driver.interrupt()
    await flush()
    expect(fake.contextCalls).toHaveLength(2) // the interrupted boundary
  })

  test('without autoCompactThreshold the threshold is the window minus the buffer', async () => {
    const harness = createHarness({
      contextImpl: async () =>
        contextReport({
          rawMaxTokens: 200_000,
          categories: [
            { name: 'tools', tokens: 120_000, color: '#fff', kind: 'used' },
            { name: 'compaction buffer', tokens: 33_000, color: '#fff', kind: 'buffer' },
          ],
        }),
    })
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    // The pinned real-report fixture (task 4.2): 157900 used of a 200000
    // window with a 33000 buffer. The meter must read 167000 — ~94.6%, near
    // 95 — not the 78.95% the full window would give.
    fake.push(assistantUsage({ input_tokens: 25_000, cache_read_input_tokens: 125_000, cache_creation_input_tokens: 5_900, output_tokens: 2_000 }, 'msg_1'))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({
      usedTokens: 157_900,
      thresholdTokens: 167_000,
      percentage: 94.6,
    })
  })

  test('a profile window is the denominator, and an override above the model limit stands', async () => {
    const small = createHarness({
      getProviderEnv: () => ({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }),
    })
    small.driver.send('hello')
    small.fakes[0]!.push(assistantUsage({ input_tokens: 100_000 }, 'msg_1'))
    small.fakes[0]!.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    // 100000 used at the 100000 profile threshold reads 100%, not the 50%
    // the model's 200000 limit would give.
    expect(small.contextUsage.at(-1)).toMatchObject({ usedTokens: 100_000, thresholdTokens: 100_000, percentage: 100 })

    const large = createHarness({
      getProviderEnv: () => ({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' }),
    })
    large.driver.send('hello')
    large.fakes[0]!.push(assistantUsage({ input_tokens: 150_000 }, 'msg_1'))
    large.fakes[0]!.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    // A 1000000 override on a 200000 model must not fall through to the
    // model's limit.
    expect(large.contextUsage.at(-1)).toMatchObject({ usedTokens: 150_000, thresholdTokens: 1_000_000, percentage: 15 })
  })

  test('a known reserve shrinks the profile window when the report yields no threshold', async () => {
    // The buffer rows still teach the reserve even when the report carries no
    // usable threshold (rawMaxTokens 0); the profile window is then reduced by
    // it (design D2 step 2).
    const harness = createHarness({
      contextImpl: async () =>
        contextReport({ rawMaxTokens: 0, categories: [{ name: 'compaction buffer', tokens: 20_000, color: '#fff', kind: 'buffer' }] }),
      getProviderEnv: () => ({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }),
    })
    harness.driver.send('hello')
    harness.fakes[0]!.push(assistantUsage({ input_tokens: 80_000 }, 'msg_1'))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 80_000, thresholdTokens: 80_000, percentage: 100 })
  })

  test('the model context window is the last resort', async () => {
    // No control method on the fake, no profile window: the result's
    // modelUsage answers.
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(assistantUsage({ input_tokens: 50_000 }, 'msg_1'))
    fake.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 50_000, thresholdTokens: 200_000, percentage: 25 })
    // Attach without the control is a no-op, not an error.
    expect(fake.contextCalls).toHaveLength(0)
  })

  test('compact_boundary drops the meter to the post-compaction size, auto or manual', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(assistantUsage({ input_tokens: 157_900 }, 'msg_1'))
    fake.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 157_900 })

    fake.push(compactBoundary('auto', 157_900, 8_200))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 8_200, thresholdTokens: 200_000 })
    // The transcript notice survives the adoption (design D3).
    expect(harness.events.some((event) => event.type === 'notice')).toBe(true)

    fake.push(compactBoundary('manual', 8_200, 6_500))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 6_500, percentage: 3.3 })
  })

  test('a boundary without a usable post_tokens keeps the last reading', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(assistantUsage({ input_tokens: 157_900 }, 'msg_1'))
    fake.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    const before = harness.contextUsage.length
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 157_900 })

    // Metadata present but no post_tokens — the case that matters, since
    // compact_metadata is required while post_tokens is optional.
    fake.push(compactBoundary('auto', 157_900))
    await flush()
    expect(harness.contextUsage).toHaveLength(before)
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 157_900 })

    // A non-finite post_tokens is equally unusable: no NaN reading, ever.
    fake.push(compactBoundary('manual', 157_900, Number.NaN))
    await flush()
    expect(harness.contextUsage).toHaveLength(before)
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 157_900 })

    // Metadata absent entirely: the notice still lands, the meter still holds.
    fake.push({ type: 'system', subtype: 'compact_boundary', uuid: 'u', session_id: 'sdk-1' } as unknown as SDKMessage)
    await flush()
    expect(harness.contextUsage).toHaveLength(before)
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 157_900 })
    expect(harness.events.filter((event) => event.type === 'notice')).toHaveLength(3)
  })

  test("a respawn drops the old process's report threshold when the new probe fails", async () => {
    // The old process observed a 167k report threshold over a 200k profile
    // window; the operator then narrows the window to 100k and the process
    // crashes. The respawn must not inherit the dead process's reading.
    const window = { env: '200000' }
    let probes = 0
    const harness = createHarness({
      getProviderEnv: () => ({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: window.env }),
      contextImpl: async () => {
        probes += 1
        return probes === 1
          ? contextReport({ autoCompactThreshold: 167_000 })
          : Promise.reject(new Error('probe failed'))
      },
    })
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(assistantUsage({ input_tokens: 157_900 }, 'msg_1'))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ thresholdTokens: 167_000 })

    fake.exit()
    await flush()
    expect(harness.driver.isDead).toBe(true)
    window.env = '100000'
    harness.driver.send('again')
    expect(harness.fakes).toHaveLength(2)
    // The spawn itself re-anchors the retained reading on the new window —
    // flagged as a correction — before any frame arrives.
    const spawnRepublish = harness.contextUsage.at(-1)!
    expect(spawnRepublish).toMatchObject({ usedTokens: 157_900, thresholdTokens: 100_000 })
    expect(harness.contextCorrections.at(-1)).toBe(true)

    // The respawn's attach probe failed, so the profile window keeps ruling.
    const respawned = harness.fakes[1]!
    respawned.push(assistantUsage({ input_tokens: 80_000 }, 'msg_2'))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 80_000, thresholdTokens: 100_000, percentage: 80 })
    expect(harness.contextCorrections.at(-1)).toBe(false)
  })

  test('a report landing after the turn boundary republishes as a correction', async () => {
    let threshold = 200_000
    let calls = 0
    const harness = createHarness({
      contextImpl: () => {
        // The attach probe answers at once; every boundary probe resolves
        // late — after turn_completed has already published the reading.
        calls += 1
        if (calls === 1) return Promise.resolve(contextReport({ autoCompactThreshold: threshold }))
        return new Promise((resolve) => {
          setTimeout(() => resolve(contextReport({ autoCompactThreshold: threshold })), 25)
        })
      },
    })
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(assistantUsage({ input_tokens: 157_900 }, 'msg_1'))
    fake.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    // The boundary published a plain reading of the then-known threshold.
    expect(harness.contextUsage.at(-1)).toMatchObject({ thresholdTokens: 200_000 })
    expect(harness.contextCorrections.at(-1)).toBe(false)

    threshold = 100_000
    await new Promise((resolve) => setTimeout(resolve, 40))
    // The late report re-scales the same used count as a correction, so the
    // manager can persist the new denominator without another boundary.
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 157_900, thresholdTokens: 100_000, percentage: 157.9 })
    expect(harness.contextCorrections.at(-1)).toBe(true)
  })

  test('a conversation reset clears the meter back to no reading', async () => {
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 167_000 }),
    })
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(assistantUsage({ input_tokens: 157_900 }, 'msg_1'))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 157_900 })

    // Plan-mode clear-context / fresh_session / onboarding: the conversation
    // is gone, so nothing is measured — not the old window's occupancy.
    fake.push({
      type: 'conversation_reset',
      trigger: 'plan_mode_exit',
      new_conversation_id: 'fresh',
      uuid: 'reset-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(harness.contextUsage.at(-1)).toBeNull()

    // The next request starts a fresh reading; the threshold survives — it
    // describes the process/profile, not the conversation.
    fake.push(assistantUsage({ input_tokens: 8_200 }, 'msg_2'))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({
      usedTokens: 8_200,
      thresholdTokens: 167_000,
    })
  })

  test('GLM: zero start and assistant usage, real counts only in the final delta', async () => {
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 967_000 }),
    })
    harness.driver.send('hi')
    const fake = harness.fakes[0]!
    fake.push(streamEvent({ type: 'message_start', message: { id: 'msg_g', usage: { input_tokens: 0, output_tokens: 0 } } }))
    fake.push(assistantUsage({}, 'msg_g'))
    await flush()
    expect(harness.contextUsage.filter(Boolean)).toHaveLength(0)

    fake.push(streamEvent({ type: 'message_delta', delta: {}, usage: { input_tokens: 46_500, output_tokens: 118, cache_read_input_tokens: 0 } }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 46_618, thresholdTokens: 967_000 })

    // A trailing zero-usage assistant frame does not lower the reading.
    fake.push(assistantUsage({}, 'msg_g'))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 46_618 })
  })

  test('an output-only final delta keeps the start input and cache counts', async () => {
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 167_000 }),
    })
    harness.driver.send('hi')
    const fake = harness.fakes[0]!
    fake.push(streamEvent({ type: 'message_start', message: { id: 'msg_a', usage: { input_tokens: 2, cache_creation_input_tokens: 22_456, cache_read_input_tokens: 12_059, output_tokens: 8 } } }))
    fake.push(streamEvent({ type: 'message_delta', delta: {}, usage: { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: 300 } }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 2 + 22_456 + 12_059 + 300 })
  })

  test("a subagent's stream usage does not move the meter", async () => {
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 200_000 }),
    })
    harness.driver.send('run a task')
    const fake = harness.fakes[0]!
    fake.push(streamEvent({ type: 'message_start', message: { id: 'msg_p', usage: { input_tokens: 0, output_tokens: 0 } } }))
    fake.push(streamEvent({ type: 'message_delta', delta: {}, usage: { input_tokens: 40_000, output_tokens: 100 } }))
    await flush()
    const before = harness.contextUsage.length
    fake.push(streamEvent({ type: 'message_start', message: { id: 'msg_s', usage: { input_tokens: 150_000, output_tokens: 0 } } }, 'toolu_task_1'))
    fake.push(streamEvent({ type: 'message_delta', delta: {}, usage: { input_tokens: 150_000, output_tokens: 4_000 } }, 'toolu_task_1'))
    await flush()
    expect(harness.contextUsage).toHaveLength(before)
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 40_100 })
  })

  test('a final delta after the turn ended still updates the reading', async () => {
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 200_000 }),
    })
    harness.driver.send('hi')
    const fake = harness.fakes[0]!
    fake.push(streamEvent({ type: 'message_start', message: { id: 'msg_t', usage: { input_tokens: 0, output_tokens: 0 } } }))
    fake.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    fake.push(streamEvent({ type: 'message_delta', delta: {}, usage: { input_tokens: 30_000, output_tokens: 50 } }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 30_050 })
  })

  test('a reset drops the request usage: a late delta publishes nothing', async () => {
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 167_000 }),
    })
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(streamEvent({ type: 'message_start', message: { id: 'msg_old', usage: { input_tokens: 0, output_tokens: 0 } } }))
    fake.push(streamEvent({ type: 'message_delta', delta: {}, usage: { input_tokens: 100_000, output_tokens: 10 } }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 100_010 })

    fake.push({
      type: 'conversation_reset',
      trigger: 'plan_mode_exit',
      new_conversation_id: 'fresh',
      uuid: 'reset-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(harness.contextUsage.at(-1)).toBeNull()
    const count = harness.contextUsage.length

    fake.push(streamEvent({ type: 'message_delta', delta: {}, usage: { input_tokens: 100_000, output_tokens: 20 } }))
    await flush()
    expect(harness.contextUsage).toHaveLength(count)

    fake.push(streamEvent({ type: 'message_start', message: { id: 'msg_new', usage: { input_tokens: 0, output_tokens: 0 } } }))
    fake.push(streamEvent({ type: 'message_delta', delta: {}, usage: { input_tokens: 8_200, output_tokens: 5 } }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({ usedTokens: 8_205, thresholdTokens: 167_000 })
  })

  test('the model-window fallback is labelled as an approximation', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    harness.fakes[0]!.push(assistantUsage({ input_tokens: 157_900 }, 'msg_1'))
    harness.fakes[0]!.push(result('success', { modelUsage: modelUsageWith(200_000) }))
    await flush()
    expect(harness.contextUsage.at(-1)).toMatchObject({
      thresholdTokens: 200_000,
      thresholdApproximate: true,
    })
  })

  test('a report threshold is never labelled approximate', async () => {
    const harness = createHarness({
      contextImpl: async () => contextReport({ autoCompactThreshold: 167_000 }),
    })
    harness.driver.send('hello')
    harness.fakes[0]!.push(assistantUsage({ input_tokens: 157_900 }, 'msg_1'))
    await flush()
    const reading = harness.contextUsage.at(-1)
    expect(reading).toMatchObject({ thresholdTokens: 167_000 })
    expect(reading?.thresholdApproximate).toBeUndefined()
  })
})

describe('ChatSessionDriver model', () => {
  /** An init frame carrying a model, in the shape the SDK delivers it. */
  function initFrame(model?: string): SDKMessage {
    return {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-model-1',
      ...(model !== undefined ? { model } : {}),
    } as unknown as SDKMessage
  }

  test('the first init fires once with its model', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    harness.fakes[0]!.push(initFrame('claude-sonnet-5-5'))
    await flush()
    expect(harness.models).toEqual(['claude-sonnet-5-5'])
    harness.driver.kill()
  })

  test('an unchanged model on the next turn does not re-fire', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(initFrame('claude-sonnet-5-5'))
    fake.push(result('success'))
    await flush()
    // The next turn's init names the same model: no second firing.
    harness.driver.send('again')
    fake.push(initFrame('claude-sonnet-5-5'))
    fake.push(result('success'))
    await flush()
    expect(harness.models).toEqual(['claude-sonnet-5-5'])
    harness.driver.kill()
  })

  test('a changed model re-fires with the new value', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(initFrame('claude-sonnet-5-5'))
    fake.push(result('success'))
    await flush()
    // A mid-session /model switch: the next turn's init carries the alias.
    harness.driver.send('switched')
    fake.push(initFrame('sonnet'))
    fake.push(result('success'))
    await flush()
    expect(harness.models).toEqual(['claude-sonnet-5-5', 'sonnet'])
    harness.driver.kill()
  })

  test('an empty or missing model never fires', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    fake.push(initFrame())
    fake.push(initFrame(''))
    await flush()
    expect(harness.models).toEqual([])
    harness.driver.kill()
  })
})

describe('ChatSessionDriver cwd tracking', () => {
  // Same pinned-home isolation as the main describe: launch resolution must
  // not see a real ~/.kawai.
  let tempHome: string
  const originalHome = process.env.HOME
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatdriver-cwd-'))
    process.env.HOME = tempHome
  })
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  /** Invoke the driver's registered CwdChanged hook with a real-shaped input. */
  const fireCwdChanged = async (
    fake: FakeQueryHandle,
    fields: Partial<CwdChangedHookInput>
  ): Promise<HookJSONOutput> => {
    const hook = fake.options.hooks?.CwdChanged?.[0]?.hooks[0]
    if (!hook) throw new Error('CwdChanged hook not registered')
    const input = {
      session_id: 'sdk-cwd-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/project',
      hook_event_name: 'CwdChanged',
      old_cwd: '/tmp/project',
      new_cwd: '/tmp/project',
      ...fields,
    } as CwdChangedHookInput
    return hook(input, undefined, { signal: new AbortController().signal })
  }

  test('CwdChanged reports the new cwd and never blocks the agent', async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    const verdict = await fireCwdChanged(fake, {
      old_cwd: '/tmp/project',
      new_cwd: '/tmp/project/.claude/worktrees/add-feature',
    })
    // Observational: the hook always lets the agent continue.
    expect(verdict).toEqual({ continue: true })
    expect(harness.cwds).toEqual(['/tmp/project/.claude/worktrees/add-feature'])
    harness.driver.kill()
  })

  test('a throwing observer still lets the agent continue', async () => {
    const harness = createHarness({
      onCwdChanged: () => {
        throw new Error('observer failed')
      },
    })
    harness.driver.send('hello')
    const verdict = await fireCwdChanged(harness.fakes[0]!, {
      new_cwd: '/tmp/elsewhere',
    })
    expect(verdict).toEqual({ continue: true })
    harness.driver.kill()
  })

  test("subagent cwd changes don't move the chat row", async () => {
    const harness = createHarness()
    harness.driver.send('hello')
    const fake = harness.fakes[0]!
    // Mirrors the real hook shape: agent_id rides subagent firings only.
    await fireCwdChanged(fake, {
      agent_id: 'agent-sub-1',
      old_cwd: '/tmp/project',
      new_cwd: '/tmp/subagent-scratch',
    })
    expect(harness.cwds).toEqual([])
    // The main thread's firing — same fields without agent_id — still reports.
    await fireCwdChanged(fake, { new_cwd: '/tmp/project/.worktrees/fix' })
    expect(harness.cwds).toEqual(['/tmp/project/.worktrees/fix'])
    harness.driver.kill()
  })
})

describe('ChatSessionDriver workers', () => {
  /** Roster publishes without elapsedMs, which ticks on the live clock. */
  function roster(lists: ChatWorker[][]): unknown[][] {
    return lists.map((list) =>
      list.map(({ elapsedMs: _elapsed, ...body }) => body)
    )
  }

  /** Assistant frame carrying one tool_use; a non-null parent = a worker's. */
  function assistantToolUse(
    id: string,
    name: string,
    parent: string | null
  ): SDKMessage {
    return {
      type: 'assistant',
      message: {
        id: `msg_${id}`,
        content: [{ type: 'tool_use', id, name, input: {} }],
        role: 'assistant',
      },
      parent_tool_use_id: parent,
      uuid: `uuid-${id}`,
      session_id: 'sdk-1',
    } as unknown as SDKMessage
  }

  /** A worker's tool_result frame (design D4: only nested spawns survive). */
  function workerToolResult(toolUseId: string, parent: string): SDKMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }],
      },
      parent_tool_use_id: parent,
    } as unknown as SDKMessage
  }

  /** A system task frame; fields follow sdk.d.ts verbatim. */
  function taskFrame(fields: Record<string, unknown>): SDKMessage {
    return { type: 'system', ...fields } as unknown as SDKMessage
  }

  /** The spawn prefix every roster test begins with (design D1). */
  async function spawnWorker(
    harness: Harness,
    overrides: Record<string, unknown> = {}
  ): Promise<void> {
    const fake = harness.fakes[0]!
    fake.push(assistantToolUse('toolu_agent', 'Agent', null))
    fake.push(
      taskFrame({
        subtype: 'task_started',
        task_id: 'task_1',
        tool_use_id: 'toolu_agent',
        description: 'Map the workspace',
        subagent_type: 'Explore',
        spawn_depth: 1,
        task_type: 'local_agent',
        ...overrides,
      })
    )
    await flush()
  }

  test("a worker's traffic stays out of the parent transcript except nested spawns", async () => {
    const harness = createHarness()
    harness.driver.send('spawn one')
    const fake = harness.fakes[0]!
    fake.push(assistantToolUse('toolu_task', 'Task', null))
    // The worker's own Bash call and its result: dropped (design D4).
    fake.push(assistantToolUse('toolu_sub_bash', 'Bash', 'toolu_task'))
    fake.push(workerToolResult('toolu_sub_bash', 'toolu_task'))
    // The worker's chatter: dropped too.
    fake.push({
      type: 'assistant',
      message: {
        id: 'msg_chatter',
        content: [{ type: 'text', text: 'worker chatter' }],
        role: 'assistant',
      },
      parent_tool_use_id: 'toolu_task',
      uuid: 'uuid-chatter',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    // A nested Agent call and its result: kept — the depth-2 row anchor.
    fake.push(assistantToolUse('toolu_nested', 'Agent', 'toolu_task'))
    fake.push(workerToolResult('toolu_nested', 'toolu_task'))
    await flush()
    expect(
      harness.events
        .filter((event) => event.type === 'tool_call')
        .map((event) => event.toolCallId)
    ).toEqual(['toolu_task', 'toolu_nested'])
    expect(
      harness.events
        .filter((event) => event.type === 'tool_result')
        .map((event) => event.toolCallId)
    ).toEqual(['toolu_nested'])
    expect(
      harness.events.some((event) => event.type === 'assistant_text')
    ).toBe(false)
    harness.driver.kill()
  })

  test('task frames build the roster: spawn, fill, last tool, settle', async () => {
    const harness = createHarness()
    harness.driver.send('research')
    const fake = harness.fakes[0]!
    fake.push(assistantToolUse('toolu_agent', 'Agent', null))
    await flush()
    fake.push(
      taskFrame({
        subtype: 'task_started',
        task_id: 'task_1',
        tool_use_id: 'toolu_agent',
        description: 'Map the workspace',
        subagent_type: 'Explore',
        spawn_depth: 1,
        task_type: 'local_agent',
      })
    )
    await flush()
    fake.push(
      taskFrame({
        subtype: 'task_progress',
        task_id: 'task_1',
        tool_use_id: 'toolu_agent',
        description: 'Map the workspace',
        usage: { total_tokens: 12_400, tool_uses: 6, duration_ms: 31_000 },
        last_tool_name: 'Grep',
      })
    )
    await flush()
    fake.push(
      taskFrame({
        subtype: 'task_notification',
        task_id: 'task_1',
        tool_use_id: 'toolu_agent',
        status: 'completed',
        output_file: '/home/u/.claude/subagents/agent-task_1.jsonl',
        summary: 'Mapped 14 files',
      })
    )
    await flush()
    expect(roster(harness.workers)).toEqual([
      [{ workerId: 'toolu_agent', status: 'running', live: true }],
      [
        {
          workerId: 'toolu_agent',
          taskId: 'task_1',
          agentType: 'Explore',
          description: 'Map the workspace',
          depth: 1,
          status: 'running',
          live: true,
        },
      ],
      [
        {
          workerId: 'toolu_agent',
          taskId: 'task_1',
          agentType: 'Explore',
          description: 'Map the workspace',
          depth: 1,
          status: 'running',
          live: true,
          lastTool: 'Grep',
        },
      ],
      [
        {
          workerId: 'toolu_agent',
          taskId: 'task_1',
          agentType: 'Explore',
          description: 'Map the workspace',
          depth: 1,
          status: 'completed',
          live: false,
          lastTool: 'Grep',
          summary: 'Mapped 14 files',
        },
      ],
    ])
    expect(harness.driver.getWorkers()).toMatchObject([
      { workerId: 'toolu_agent', status: 'completed', live: false },
    ])
    harness.driver.kill()
  })

  test('the background level set governs live only; a late notification still lands', async () => {
    const harness = createHarness()
    harness.driver.send('research')
    const fake = harness.fakes[0]!
    await spawnWorker(harness, { is_backgrounded: true })
    const before = harness.workers.length
    fake.push(
      taskFrame({
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'task_1', task_type: 'local_agent', description: 'Map' },
        ],
      })
    )
    await flush()
    // Already live: the level's arrival changes nothing (no publish).
    expect(harness.workers.length).toBe(before)
    // The turn ends; the set drops the task before its notification.
    fake.push(result('success'))
    fake.push(taskFrame({ subtype: 'background_tasks_changed', tasks: [] }))
    await flush()
    expect(roster(harness.workers).at(-1)).toEqual([
      {
        workerId: 'toolu_agent',
        taskId: 'task_1',
        agentType: 'Explore',
        description: 'Map the workspace',
        depth: 1,
        status: 'running',
        live: false,
        // The gap: not live, so the session is not working either (D7).
      },
    ])
    expect(harness.statuses.at(-1)).toBe('waiting')
    // The notification after the drop still writes the real outcome (D3).
    fake.push(
      taskFrame({
        subtype: 'task_notification',
        task_id: 'task_1',
        tool_use_id: 'toolu_agent',
        status: 'completed',
        output_file: '/x',
        summary: 'Mapped 14 files',
      })
    )
    await flush()
    expect(roster(harness.workers).at(-1)).toEqual([
      expect.objectContaining({
        status: 'completed',
        live: false,
        summary: 'Mapped 14 files',
      }),
    ])
    harness.driver.kill()
  })

  test('a foreground worker stays live when the level set omits it', async () => {
    const harness = createHarness()
    harness.driver.send('research')
    const fake = harness.fakes[0]!
    await spawnWorker(harness)
    const before = harness.workers.length
    fake.push(taskFrame({ subtype: 'background_tasks_changed', tasks: [] }))
    fake.push(result('success'))
    await flush()
    // The empty set never touched the foreground row (D3), and its liveness
    // holds the session at working after the turn (D7).
    expect(harness.workers.length).toBe(before)
    expect(harness.driver.getWorkers()).toMatchObject([
      { workerId: 'toolu_agent', status: 'running', live: true },
    ])
    expect(harness.statuses.at(-1)).toBe('working')
    harness.driver.kill()
  })

  test('a live worker holds working with no turn running', async () => {
    const harness = createHarness()
    harness.driver.send('research')
    const fake = harness.fakes[0]!
    await spawnWorker(harness)
    fake.push(result('success'))
    await flush()
    expect(harness.statuses.at(-1)).toBe('working')
    // And back to waiting once it settles.
    fake.push(
      taskFrame({
        subtype: 'task_notification',
        task_id: 'task_1',
        tool_use_id: 'toolu_agent',
        status: 'failed',
        output_file: '/x',
        summary: 'no match',
      })
    )
    await flush()
    expect(harness.statuses.at(-1)).toBe('waiting')
    harness.driver.kill()
  })

  test('driver death settles outcome-less workers as stopped', async () => {
    const harness = createHarness()
    harness.driver.send('research')
    await spawnWorker(harness)
    harness.fakes[0]!.exit()
    await flush()
    expect(harness.driver.isDead).toBe(true)
    expect(harness.driver.getWorkers()).toMatchObject([
      { workerId: 'toolu_agent', status: 'stopped', live: false },
    ])
  })

  test('interrupt settles outcome-less workers as stopped', async () => {
    const harness = createHarness()
    harness.driver.send('research')
    await spawnWorker(harness)
    harness.driver.interrupt()
    expect(harness.driver.getWorkers()).toMatchObject([
      { workerId: 'toolu_agent', status: 'stopped', live: false },
    ])
    harness.driver.kill()
  })

  test('kill settles outcome-less workers as stopped', async () => {
    const harness = createHarness()
    harness.driver.send('research')
    await spawnWorker(harness)
    harness.driver.kill()
    expect(harness.driver.getWorkers()).toMatchObject([
      { workerId: 'toolu_agent', status: 'stopped', live: false },
    ])
  })

  test('archive settles outcome-less workers as stopped', async () => {
    // ChatSessionManager.archive composes exactly these two calls; pinned
    // here so the composition cannot drift.
    const harness = createHarness()
    harness.driver.send('research')
    await spawnWorker(harness)
    harness.driver.interrupt()
    harness.driver.kill()
    expect(harness.driver.getWorkers()).toMatchObject([
      { workerId: 'toolu_agent', status: 'stopped', live: false },
    ])
  })

  test('a rejected spawn settles its row and frees the session', async () => {
    const harness = createHarness()
    harness.driver.send('spawn a worker')
    const fake = harness.fakes[0]!
    fake.push(assistantToolUse('toolu_agent', 'Agent', null))
    await flush()
    expect(harness.statuses.at(-1)).toBe('working')
    // The spawn is rejected before any task starts: the error result is the
    // only bookend the row will ever get.
    fake.push({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_agent',
            content: 'Unknown agent type "scout"',
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage)
    fake.push(result('success'))
    await flush()
    expect(roster(harness.workers).at(-1)).toEqual([
      { workerId: 'toolu_agent', status: 'failed', live: false, summary: 'Unknown agent type "scout"' },
    ])
    expect(harness.statuses.at(-1)).toBe('waiting')
    harness.driver.kill()
  })

  test("a worker's stream stays out of the parent transcript and off its id", async () => {
    const harness = createHarness()
    harness.driver.send('stream')
    const fake = harness.fakes[0]!
    fake.push(assistantToolUse('toolu_task', 'Task', null))
    await flush()
    // A worker's message_start must not hijack the parent's streaming id…
    fake.push({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_task',
      event: { type: 'message_start', message: { id: 'msg_worker' } },
      uuid: 'w-0',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    // …and its text deltas must not reach the parent transcript.
    fake.push({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_task',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'worker chatter' },
      },
      uuid: 'w-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    expect(harness.events.filter((event) => event.type === 'assistant_delta')).toEqual([])
    // The parent's own stream still maps, under its own message id.
    fake.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'msg_parent' } },
      uuid: 'p-0',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    fake.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'parent text' },
      },
      uuid: 'p-1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)
    await flush()
    const deltas = harness.events.filter(
      (event): event is Extract<ChatEvent, { type: 'assistant_delta' }> =>
        event.type === 'assistant_delta'
    )
    expect(deltas.map((event) => `${event.messageId}:${event.delta}`))
      .toEqual(['msg_parent:parent text'])
    harness.driver.kill()
  })

  test('recovered rows seed the fresh roster and survive later publishes', async () => {
    const harness = createHarness({
      recoveredWorkers: [
        { workerId: 'toolu_done', status: 'completed', live: false, elapsedMs: 0, summary: 'mapped' },
      ],
    })
    harness.driver.send('research')
    // Before any publish this turn, the recovered outcome is still on offer.
    expect(harness.driver.getWorkers()).toMatchObject([
      { workerId: 'toolu_done', status: 'completed', live: false, summary: 'mapped' },
    ])
    await spawnWorker(harness)
    // The first publish appends to the seeded roster, not replaces it.
    expect(
      roster(harness.workers).at(-1)?.map((worker) => (worker as { workerId: string }).workerId)
    ).toEqual(['toolu_done', 'toolu_agent'])
    harness.driver.kill()
  })
})


test('mailbox tools are registered and allowed without cards under either policy', async () => {
  const { TEAM_ALLOWED_TOOLS } = await import('../team/mailboxTools')
  for (const policy of ['manual', 'auto'] as const) {
    const server = { type: 'stdio' as const, command: 'mailbox-test' }
    const h = createHarness({ teamMcpServer: server, getApprovalPolicy: () => policy })
    h.driver.start()
    const options = h.fakes[0]!.options
    expect(options.mcpServers).toEqual({ 'kawai-team': server })
    expect(options.allowedTools).toEqual(TEAM_ALLOWED_TOOLS)
    for (const name of TEAM_ALLOWED_TOOLS) {
      const answer = await options.canUseTool!(name, {}, { signal: new AbortController().signal, toolUseID: 'mail-call', requestId: 'mail-request' })
      expect(answer?.behavior).toBe('allow')
    }
    expect(h.events.some(event => event.type === 'approval_request')).toBe(false)
    expect(h.driver.getPendingRequests()).toEqual([])
    h.driver.kill()
  }
})

test('peer delivery pushes a peer-origin turn and emits display metadata without a user copy', async () => {
  const PEER = { messageId: 'mail-1', senderSession: 'lead', senderGroup: null, priority: 'normal' as const, originPath: '/repo', tags: [], threadId: 'mail-1', body: 'Review this', possibleDuplicate: false }
  const { formatEnvelope } = await import('../team/envelope')
  const h = createHarness()
  h.driver.deliver(PEER)
  expect(h.events.find(event => event.type === 'peer_message')).toMatchObject(PEER)
  const prompt = await h.fakes[0]!.pullPrompt()
  expect(prompt?.origin).toEqual({ kind: 'peer', from: PEER.senderSession })
  expect(prompt?.message.content).toBe(formatEnvelope(PEER))
  expect(h.events.some(event => event.type === 'user_message')).toBe(false)
  expect(() => h.driver.deliver(PEER)).toThrow('not idle')
  h.driver.kill()
})

describe('ChatSessionDriver limit events', () => {
  function frame(fields: Record<string, unknown>): SDKMessage {
    return { uuid: 'f-uuid', session_id: 'sdk-1', ...fields } as unknown as SDKMessage
  }
  function failedAssistant(error: string, text: string, parent: string | null = null): SDKMessage {
    return frame({
      type: 'assistant',
      error,
      message: { id: 'msg_err', content: [{ type: 'text', text }], role: 'assistant' },
      parent_tool_use_id: parent,
    })
  }
  function limitHarness() {
    const limits: ChatLimitSignal[] = []
    const harness = createHarness({ onLimitEvent: (signal) => limits.push(signal) })
    harness.driver.send('hello')
    return { harness, limits, fake: harness.fakes[0]! }
  }

  test('a retried rate-limit attempt is a non-final event; an unrelated retry is not', async () => {
    const { fake, limits } = limitHarness()
    fake.push(frame({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: 'rate_limit' }))
    fake.push(frame({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 504, error: 'server_error' }))
    fake.push(result('success'))
    await flush()
    expect(limits).toEqual([{ kind: 'rate_limit', final: false, status: 429, message: null, resetsAt: null, window: null }])
  })

  test('a failed assistant message is the final event, with the reset a rejected rate_limit_event announced', async () => {
    const { fake, limits } = limitHarness()
    const reset = Math.floor(Date.now() / 1000) + 2400
    fake.push(frame({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day_opus' } }))
    fake.push(failedAssistant('rate_limit', 'API Error: 429 {"error":"quota"}'))
    fake.push(result('success'))
    await flush()
    expect(limits).toEqual([{
      kind: 'rate_limit', final: true, status: 429, message: 'API Error: 429 {"error":"quota"}',
      resetsAt: new Date(reset * 1000).toISOString(), window: 'seven_day_opus',
    }])
  })

  test('the window follows the latest reset-bearing rejected event, nameless or not', async () => {
    const { fake, limits } = limitHarness()
    const first = Math.floor(Date.now() / 1000) + 2400
    const second = first + 60
    fake.push(frame({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: first, rateLimitType: 'seven_day_opus' } }))
    fake.push(frame({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: second } }))
    fake.push(failedAssistant('rate_limit', 'API Error: 429 quota'))
    fake.push(result('success'))
    await flush()
    expect(limits).toEqual([{
      kind: 'rate_limit', final: true, status: 429, message: 'API Error: 429 quota',
      resetsAt: new Date(second * 1000).toISOString(), window: null,
    }])
  })

  test('the window drops together with its reset once past', async () => {
    const { fake, limits } = limitHarness()
    const stale = Math.floor(Date.now() / 1000) - 10
    fake.push(frame({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: stale, rateLimitType: 'five_hour' } }))
    fake.push(failedAssistant('rate_limit', 'API Error: 429 quota'))
    fake.push(result('success'))
    await flush()
    expect(limits).toEqual([{
      kind: 'rate_limit', final: true, status: 429, message: 'API Error: 429 quota', resetsAt: null, window: null,
    }])
  })

  test('a gateway quota error classified otherwise still counts on status 429', async () => {
    const { fake, limits } = limitHarness()
    fake.push(failedAssistant('unknown', 'API Error: 429 quota exhausted'))
    fake.push(result('success'))
    await flush()
    expect(limits).toMatchObject([{ kind: 'unknown', final: true, status: 429 }])
  })

  test('other errors and subagent failures record nothing', async () => {
    const { fake, limits } = limitHarness()
    fake.push(failedAssistant('invalid_request', 'API Error: 400 bad request'))
    fake.push(failedAssistant('rate_limit', 'API Error: 429', 'toolu_agent'))
    fake.push(result('success'))
    await flush()
    expect(limits).toEqual([])
  })

  test('a throwing observer does not break the turn', async () => {
    const harness = createHarness({ onLimitEvent: () => { throw new Error('boom') } })
    harness.driver.send('hello')
    harness.fakes[0]!.push(failedAssistant('overloaded', 'API Error: 529 overloaded'))
    harness.fakes[0]!.push(result('success'))
    await flush()
    expect(typesOf(harness.events)).toContain('turn_completed')
  })
})

describe('ChatSessionDriver agent-started turns (background tasks D5)', () => {
  /** A background task_notification arriving while no turn is active. */
  function taskNotification(taskId: string, status = 'completed'): SDKMessage {
    return {
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: 'call_task_1',
      status,
      summary: `Background command "${taskId}" completed (exit code 0)`,
      uuid: 'n-uuid',
      session_id: 'sdk-1',
    } as unknown as SDKMessage
  }

  /** The turn-opening frame: one `init` per turn, consumer-visible. */
  function initFrame(): SDKMessage {
    return {
      type: 'system',
      subtype: 'init',
      cwd: '/tmp/project',
      session_id: 'sdk-1',
      model: 'glm-5.3',
      permissionMode: 'default',
      tools: [],
      slash_commands: [],
    } as unknown as SDKMessage
  }

  test('the captured monitor wake replays into a triggered turn', async () => {
    const harness = createHarness()
    harness.driver.start()
    // Real captured sequence: late first-turn frames (dropped — no turn),
    // the settle, then the wake turn (init → status → stream → assistant →
    // result). The sdk_host_only state frames are already filtered out.
    for (const message of consumerMessages('monitor')) {
      harness.fakes[0]!.push(message)
    }
    await flush(10)
    const started = harness.events.filter((event) => event.type === 'turn_started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      trigger: {
        kind: 'task',
        tasks: [{ taskId: 'b9cx4spe1', toolCallId: 'call_8b6144525600423b96c9e216', status: 'completed' }],
      },
    })
    expect(typesOf(harness.events)).toContain('assistant_text')
    expect(typesOf(harness.events)).toContain('turn_completed')
    expect(harness.statuses).toContain('working')
    expect(harness.statuses.at(-1)).toBe('waiting')
  })

  test('interrupt ends an agent-started turn like a user one', async () => {
    const harness = createHarness()
    harness.driver.start()
    harness.fakes[0]!.push(taskNotification('btask_1'))
    harness.fakes[0]!.push(initFrame())
    await flush()
    expect(harness.events.some((event) => event.type === 'turn_started')).toBe(true)
    await harness.driver.interrupt()
    await flush()
    expect(typesOf(harness.events)).toContain('turn_interrupted')
    expect(harness.statuses.at(-1)).toBe('waiting')
  })

  test('a send racing the self-start joins the open turn', async () => {
    const harness = createHarness()
    harness.driver.start()
    harness.fakes[0]!.push(taskNotification('btask_1'))
    harness.fakes[0]!.push(initFrame())
    await flush()
    const started = harness.events.filter((event) => event.type === 'turn_started')
    expect(started).toHaveLength(1)
    harness.driver.send('while you are at it')
    harness.fakes[0]!.push(assistantText('joined answer'))
    harness.fakes[0]!.push(result('success'))
    await flush()
    const turnId = (started[0] as { turnId: string }).turnId
    const firstTwo = harness.events.slice(0, 2).map((event) => ({ type: event.type, turnId: (event as { turnId: string }).turnId }))
    expect(firstTwo).toEqual([
      { type: 'turn_started', turnId },
      { type: 'user_message', turnId },
    ])
    expect(harness.events.filter((event) => event.type === 'turn_started')).toHaveLength(1)
    expect(typesOf(harness.events)).toContain('turn_completed')
  })

  test('a self-start with no preceding notification carries the resumed trigger', async () => {
    const harness = createHarness()
    harness.driver.start()
    harness.fakes[0]!.push(initFrame())
    await flush()
    const started = harness.events.filter((event) => event.type === 'turn_started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ trigger: { kind: 'resumed' } })
    harness.fakes[0]!.push(assistantText('picked up on my own'))
    harness.fakes[0]!.push(result('success'))
    await flush()
    expect(typesOf(harness.events)).toContain('turn_completed')
    // No user message bubble for a self-started turn.
    expect(typesOf(harness.events)).not.toContain('user_message')
  })

  test('a user send consumes buffered notifications without a trigger', async () => {
    const harness = createHarness()
    harness.driver.start()
    harness.fakes[0]!.push(taskNotification('btask_1'))
    await flush()
    harness.driver.send('my turn now')
    harness.fakes[0]!.push(assistantText('answer'))
    harness.fakes[0]!.push(result('success'))
    await flush()
    const started = harness.events.filter((event) => event.type === 'turn_started')
    expect(started).toHaveLength(1)
    expect((started[0] as { trigger?: unknown }).trigger).toBeUndefined()
    expect(typesOf(harness.events)).toContain('turn_completed')
    // The stale buffer cannot leak into a later self-start.
    harness.fakes[0]!.push(initFrame())
    await flush()
    const later = harness.events.filter((event) => event.type === 'turn_started')
    expect(later).toHaveLength(2)
    expect(later[1]).toMatchObject({ trigger: { kind: 'resumed' } })
  })
})

describe('ChatSessionDriver background-task roster (background tasks D1/D7)', () => {
  test('the captured shell fixture publishes a live Shell entry that settles', async () => {
    const harness = createHarness()
    harness.driver.send('launch the probe tasks')
    for (const message of consumerMessages('shell')) {
      harness.fakes[0]!.push(message)
    }
    await flush(10)
    // Publishes fire on every roster change — the Bash tool-call join lands
    // before task_started, so early publishes can be empty.
    const rosters = harness.backgroundTasks
    expect(rosters.length).toBeGreaterThanOrEqual(2)
    const live = rosters.find(list => list.some(task => task.status === 'running'))
    expect(live).toMatchObject([
      { taskId: 'bnozyv5av', toolCallId: 'call_33dd57efbe6645178a8c9e6b', kind: 'shell', description: 'Sleep 6 seconds then print marker', status: 'running', live: true },
    ])
    expect(rosters.at(-1)).toMatchObject([
      { taskId: 'bnozyv5av', kind: 'shell', status: 'completed', live: false, summary: expect.stringContaining('Sleep 6 seconds then print marker') },
    ])
    // The output-file path never rides the roster.
    expect(JSON.stringify(rosters)).not.toContain('outputFile')
    // D7: a settled task leaves the session waiting.
    expect(harness.statuses.at(-1)).toBe('waiting')
  })

  test('the captured monitor fixture joins its task as a Monitor', async () => {
    const harness = createHarness()
    harness.driver.send('launch the probe tasks')
    for (const message of consumerMessages('monitor')) {
      harness.fakes[0]!.push(message)
    }
    await flush(10)
    expect(harness.backgroundTasks.at(-1)).toMatchObject([
      { taskId: 'b9cx4spe1', kind: 'monitor', description: 'Watch for trigger.txt', status: 'completed', live: false },
    ])
  })

  test('a foreground task never publishes; the level set alone promotes nothing unseen', async () => {
    const harness = createHarness()
    harness.driver.send('run')
    for (const message of consumerMessages('foreground')) {
      harness.fakes[0]!.push(message)
    }
    await flush()
    // Publishes can fire (the roster state changed) but stay empty: a
    // foreground task is never visible, so nothing ever joins it.
    expect(harness.backgroundTasks.flat()).toEqual([])
  })

  test('an interrupt keeps background tasks running; kill settles them stopped', async () => {
    const harness = createHarness()
    harness.driver.send('start a long task')
    harness.fakes[0]!.push({
      type: 'system', subtype: 'task_started', task_id: 'blong', tool_use_id: 'call_long',
      task_type: 'local_bash', description: 'dev server', is_backgrounded: true, uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    harness.fakes[0]!.push({
      type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'blong' }], uuid: 'u2', session_id: 's',
    } as unknown as SDKMessage)
    await flush()
    expect(harness.backgroundTasks.at(-1)).toMatchObject([{ taskId: 'blong', status: 'running', live: true }])
    await harness.driver.interrupt()
    await flush()
    // The turn aborted, but a background shell survives it (D1).
    expect(harness.backgroundTasks.at(-1)).toMatchObject([{ taskId: 'blong', status: 'running', live: true }])
    harness.driver.kill()
    await flush()
    expect(harness.backgroundTasks.at(-1)).toMatchObject([{ taskId: 'blong', status: 'stopped', live: false }])
  })
})

