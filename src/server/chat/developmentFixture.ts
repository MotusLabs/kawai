// Explicit development-only fake SDK: exercises the real driver, approvals,
// questions, status, and WebSocket path without authentication or model calls.
// It never spawns a process, so it records synthetic wire frames shaped like
// the real stream-json protocol for the chat debug view. The activity turns
// (thinking / tool / retry) hold each phase long enough to watch the
// indicator's timer tick; the context turn climbs the meter toward the
// compaction threshold and drops it across a compact_boundary; the worker turn
// spawns a subagent (with a nested one) through task frames. Tests shrink
// the holds via AGENTBOARD_CHAT_FIXTURE_HOLD_MS. Tool turns exercise short
// Bash handles; "tool fail" adds a failed result and a project-relative Read.
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatQueryFactory } from './ChatSessionDriver'

export const chatFixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.AGENTBOARD_CHAT_FIXTURE === '1'

/** Hold a phase for human-scale watching unless a test collapses all holds. */
const hold = (ms: number) =>
  new Promise<void>(resolve =>
    setTimeout(resolve, Number(process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS ?? ms)))

export const fixtureQueryFactory: ChatQueryFactory = ({ prompt, options, wire }) => {
  const frame = (dir: 'out' | 'in' | 'lifecycle', value: unknown) => wire?.record(dir, JSON.stringify(value))
  frame('lifecycle', { event: 'spawn', command: 'fixture', args: [], cwd: options.cwd ?? null })
  const events: SDKMessage[] = []
  let wake: (() => void) | null = null
  let closed = false
  let generation = 0
  const controller = new AbortController()
  const push = (message: Record<string, unknown>) => {
    if (closed) return
    const sdkMessage = { uuid: crypto.randomUUID(), session_id: 'fixture', ...message } as SDKMessage
    frame('in', sdkMessage)
    events.push(sdkMessage)
    wake?.()
    wake = null
  }
  /** Per-request usage summing to `used` tokens (context meter design D1). */
  const usageAt = (used: number) => ({
    input_tokens: 2_000,
    cache_read_input_tokens: Math.max(0, used - 8_000),
    cache_creation_input_tokens: 4_000,
    output_tokens: 2_000,
  })
  const assistant = (text: string, used = 42_000) => push({
    type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }], usage: usageAt(used) },
  })
  const run = async (text: string) => {
    const turn = generation
    // Activity turns hold the initial request first so the "Waiting for
    // model…" phase is long enough to observe in a browser.
    if (/thinking|tool|retry/i.test(text)) {
      await hold(900)
      if (closed || turn !== generation) return
    }
    assistant('**Fixture response** — chat streaming, tools, and permissions are ready.')
    if (/approval|question/i.test(text)) {
      const tool = /question/i.test(text) ? 'AskUserQuestion' : 'Bash'
      const input = tool === 'Bash' ? { description: 'Print the fixture greeting', command: 'echo fixture' } : {
        questions: [{ question: 'Which color?', header: 'Color', multiSelect: true,
          options: [{ label: 'Blue', description: 'Ocean' }, { label: 'Green', description: 'Forest' }] }],
      }
      const toolUseID = crypto.randomUUID()
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolUseID, name: tool, input }] } })
      const requestId = crypto.randomUUID()
      frame('in', { type: 'control_request', request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: toolUseID } })
      const result = await options.canUseTool!(tool, input, {
        signal: controller.signal, toolUseID, requestId,
      })
      frame('out', { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: result } })
      if (closed || turn !== generation) return
      // The approved tool runs for a moment before its result lands — long
      // enough to watch the activity row restart its clock at zero when the
      // request resolves (the card's wait must not count as tool time).
      await hold(900)
      if (closed || turn !== generation) return
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, content: JSON.stringify(result) }] } })
      assistant(result?.behavior === 'allow' ? 'Request accepted.' : 'Request denied.')
    }
    if (/thinking/i.test(text)) {
      push({ type: 'system', subtype: 'status', status: 'requesting' })
      await hold(400)
      if (closed || turn !== generation) return
      push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, parent_tool_use_id: null })
      // Long enough for a browser reload mid-phase to restore the row.
      await hold(5000)
      if (closed || turn !== generation) return
      push({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, parent_tool_use_id: null })
      assistant('Thought it over.')
    }
    if (/tool/i.test(text)) {
      const toolUseID = crypto.randomUUID()
      push({ type: 'system', subtype: 'status', status: 'requesting' })
      await hold(400)
      if (closed || turn !== generation) return
      push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseID, name: 'Bash', input: {} } }, parent_tool_use_id: null })
      await hold(600)
      if (closed || turn !== generation) return
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input: { description: 'Print the fixture greeting', command: 'echo fixture' } }] } })
      await hold(1600)
      if (closed || turn !== generation) return
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, content: /fail/i.test(text) ? 'Fixture command failed' : 'fixture output', is_error: /fail/i.test(text) }] } })
      if (/fail/i.test(text)) {
        const readID = crypto.randomUUID()
        push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: readID, name: 'Read', input: { file_path: `${options.cwd}/src/client/App.tsx` } }] } })
        push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: readID, content: '// Fixture file contents' }] } })
      }
      assistant('Tool finished.')
    }
    if (/retry/i.test(text)) {
      push({ type: 'system', subtype: 'status', status: 'requesting' })
      await hold(400)
      for (const attempt of [1, 2]) {
        if (closed || turn !== generation) return
        push({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: 504, error: 'server_error' })
        await hold(900)
      }
      if (closed || turn !== generation) return
      push({ type: 'system', subtype: 'status', status: 'requesting' })
      await hold(300)
      assistant('Recovered from the retry.')
    }
    if (/context/i.test(text)) {
      // Context-meter walkthrough: requests climb toward the compaction
      // threshold — a 200k window with a 33k buffer, so 167k (answered by
      // the getContextUsage control below) — a tool runs mid-climb, and an
      // auto-compaction drops the meter to the post-compaction size.
      assistant('Reading the project.', 60_000)
      await hold(900)
      if (closed || turn !== generation) return
      assistant('Investigating deeper.', 120_000)
      await hold(900)
      if (closed || turn !== generation) return
      const toolUseID = crypto.randomUUID()
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolUseID, name: 'Grep', input: { pattern: 'compact' } }] } })
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, content: '3 matches' }] } })
      assistant('Near the threshold now.', 157_900)
      await hold(900)
      if (closed || turn !== generation) return
      push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 157_900, post_tokens: 12_000 } })
    }
    if (/worker/i.test(text)) {
      // Spawned-worker walkthrough (workers design D9): a top-level Agent call
      // whose worker reports progress, runs one tool of its own (excluded
      // from the transcript), and spawns a nested Agent (kept, as its row
      // anchor). The level set drops the task before its notification — the
      // completion gap — so the settled outcome must be the notification's.
      const spawnId = `toolu_fixture_${crypto.randomUUID()}`
      const nestedId = `toolu_fixture_${crypto.randomUUID()}`
      const taskId = `task-${spawnId}`
      const nestedTaskId = `task-${nestedId}`
      const spawnInput = { subagent_type: 'Explore', description: 'Map the workspace', prompt: 'List the packages and their entry points.' }
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: spawnId, name: 'Agent', input: spawnInput }] }, parent_tool_use_id: null })
      push({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: spawnId, description: 'Map the workspace', subagent_type: 'Explore', task_type: 'local_agent', spawn_depth: 1, is_backgrounded: true })
      push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: taskId, task_type: 'local_agent', description: 'Map the workspace' }] })
      await hold(1200)
      if (closed || turn !== generation) return
      const workerToolId = `toolu_fixture_${crypto.randomUUID()}`
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: workerToolId, name: 'Grep', input: { pattern: 'package.json' } }] }, parent_tool_use_id: spawnId })
      push({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: spawnId, description: 'Map the workspace', subagent_type: 'Explore', last_tool_name: 'Grep', usage: { total_tokens: 1_200, tool_uses: 1, duration_ms: 1_200 } })
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: workerToolId, content: '3 matches' }] }, parent_tool_use_id: spawnId })
      await hold(1200)
      if (closed || turn !== generation) return
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: nestedId, name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Read the server entry', prompt: 'Summarize src/server/index.ts.' } }] }, parent_tool_use_id: spawnId })
      push({ type: 'system', subtype: 'task_started', task_id: nestedTaskId, tool_use_id: nestedId, description: 'Read the server entry', subagent_type: 'general-purpose', task_type: 'local_agent', spawn_depth: 2, is_backgrounded: true })
      push({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: spawnId, description: 'Map the workspace', subagent_type: 'Explore', last_tool_name: 'Agent', usage: { total_tokens: 2_400, tool_uses: 2, duration_ms: 2_400 } })
      await hold(1200)
      if (closed || turn !== generation) return
      push({ type: 'system', subtype: 'task_notification', task_id: nestedTaskId, tool_use_id: nestedId, status: 'completed', summary: 'The server entry wires Hono routes and the WebSocket.', output_file: '' })
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: nestedId, content: 'Hono routes and the WebSocket.' }] }, parent_tool_use_id: spawnId })
      // The completion gap: the level drops the task before its bookend.
      push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
      await hold(600)
      if (closed || turn !== generation) return
      push({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: spawnId, status: 'completed', summary: 'Found three packages: client, server, shared.', output_file: '' })
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: spawnId, content: 'Found three packages: client, server, shared.' }] }, parent_tool_use_id: null })
      assistant('The worker mapped the workspace.')
    }
    if (/markdown/i.test(text)) {
      assistant([
        '# Markdown showcase',
        '',
        'Headings, **bold**, *italic*, ~~struck through~~ and `inline code`, plus [a link](https://example.com).',
        '',
        '---',
        '',
        '## Lists',
        '',
        '- bullet one',
        '- bullet two',
        '',
        '1. first',
        '2. second',
        '',
        '- [ ] unchecked task',
        '- [x] done task',
        '',
        '## Table',
        '',
        '| Element | Rendered |',
        '| --- | --- |',
        '| table | bordered |',
        '| task list | checkboxes |',
        '',
        '> A blockquote sets text off.',
        '',
        '```ts',
        "const fenced = 'code block'",
        '```',
      ].join('\n'))
    }
    if (/stream/i.test(text)) {
      const messageId = crypto.randomUUID()
      push({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } })
      for (const delta of ['Streaming ', 'a response ', 'across reconnect.']) {
        await new Promise(resolve => setTimeout(resolve, 400))
        if (closed || turn !== generation) return
        push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } })
      }
      push({ type: 'assistant', message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: 'Streaming a response across reconnect.' }] } })
    }
    if (!closed && turn === generation) push({ type: 'result', subtype: 'success', result: '', total_cost_usd: 0, num_turns: 1 })
  }
  void (async () => {
    for await (const message of prompt) {
      if (closed) break
      frame('out', message)
      const content = message.message.content
      await run(typeof content === 'string' ? content : '')
    }
  })()
  const stream = (async function* () {
    while (!closed) {
      if (!events.length) await new Promise<void>(resolve => { wake = resolve })
      while (events.length) yield events.shift()!
    }
  })()
  return Object.assign(stream, {
    // The context-usage control (context meter design D2): the driver probes
    // it on attach and at turn boundaries, so the fixture answers with the
    // same 200k-window/33k-buffer shape as the pinned real report.
    getContextUsage: async () => ({
      categories: [
        { name: 'conversation', tokens: 60_000, color: '#3b82f6', kind: 'used' },
        { name: 'compaction buffer', tokens: 33_000, color: '#f59e0b', kind: 'buffer' },
        { name: 'free space', tokens: 107_000, color: '#22c55e', kind: 'free' },
      ],
      totalTokens: 60_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 30,
      gridRows: [],
      model: 'claude-sonnet-4-5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    }),
    interrupt: async () => {
      frame('out', { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } })
      generation++
    },
    close: () => {
      if (!closed) frame('lifecycle', { event: 'exit', code: 0, signal: null })
      closed = true; generation++; controller.abort(); wake?.()
    },
  }) as unknown as Query
}
