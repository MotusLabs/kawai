// Explicit development-only fake SDK: exercises the real driver, approvals,
// questions, status, and WebSocket path without authentication or model calls.
// It never spawns a process, so it records synthetic wire frames shaped like
// the real stream-json protocol for the chat debug view. The activity turns
// (thinking / tool / retry) hold each phase long enough to watch the
// indicator's timer tick; the context turn climbs the meter toward the
// compaction threshold and drops it across a compact_boundary; the worker turn
// spawns a subagent (with a nested one) through task frames. Tests shrink
// the holds via AGENTBOARD_CHAT_FIXTURE_HOLD_MS. Tool turns exercise short
// Bash handles; "tool fail" adds a failed result and a project-relative Read;
// "prompt-too-long" ends the turn with the CLI's context-exhaustion result.
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatQueryFactory } from './ChatSessionDriver'

export const chatFixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.AGENTBOARD_CHAT_FIXTURE === '1'

/** Hold a phase for human-scale watching unless a test collapses all holds. */
const hold = (ms: number) =>
  new Promise<void>(resolve =>
    setTimeout(resolve, Number(process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS ?? ms)))

/** Every real CLI result reports the turn's usage; a result without it is recorded as unknown, not zero. */
const resultUsage = { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }

export const fixtureQueryFactory: ChatQueryFactory = ({ prompt, options, wire }) => {
  const frame = (dir: 'out' | 'in' | 'lifecycle', value: unknown) => wire?.record(dir, JSON.stringify(value))
  frame('lifecycle', { event: 'spawn', command: 'fixture', args: [], cwd: options.cwd ?? null })
  const events: SDKMessage[] = []
  let wake: (() => void) | null = null
  let closed = false
  let generation = 0
  /** A run is in flight: an interrupt owes its trailing result, like the CLI. */
  let running = false
  /** The client uuid of the prompt in flight, echoed on its results like the CLI. */
  let current: string | undefined
  const echo = () => (current ? { user_message_uuid: current, user_message_uuids: [current] } : {})
  const controller = new AbortController()
  /** The background scenario's tasks, answering getTaskOutput/stopTask. */
  const backgroundTasks = new Map<string, { output: string; lines: string[]; stopped?: boolean }>()
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
    // Session metadata opens every turn in a real stream; the fixture reports
    // the same model each time so the header badge (chat-session-model D1)
    // lights up like a live agent's would.
    push({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] })
    // Activity turns hold the initial request first so the "Waiting for
    // model…" phase is long enough to observe in a browser.
    if (/thinking|tool|retry/i.test(text)) {
      await hold(900)
      if (closed || turn !== generation) return
    }
    assistant('**Fixture response** — chat streaming, tools, and permissions are ready.')
    if (/approval|question/i.test(text)) {
      const tool = /question/i.test(text) ? 'AskUserQuestion' : 'Bash'
      // "recommended question" asks one that marks a (Recommended) option, so
      // a positive auto-answer wait arms a deadline (question-auto-answer
      // 5.2); the plain question flow above stays exactly as it was.
      const input = tool === 'Bash' ? { description: 'Print the fixture greeting', command: 'echo fixture' } : /recommended/i.test(text) ? {
        questions: [{ question: 'Deploy which color?', header: 'Color', multiSelect: false,
          options: [{ label: 'Blue (Recommended)', description: 'Ocean' }, { label: 'Green', description: 'Forest' }] }],
      } : {
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
    if (/background/i.test(text)) {
      // Background-task walkthrough (background tasks D9): a quick shell that
      // settles and wakes the agent into a triggered turn, beside a dev
      // server that keeps running until it is stopped from the UI. The
      // output file is real, so the tail reader (live and fallback) works.
      const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-fixture-tasks-'))
      const quickTool = `toolu_fixture_${crypto.randomUUID()}`
      const longTool = `toolu_fixture_${crypto.randomUUID()}`
      const quickId = `bq_${crypto.randomUUID().slice(0, 8)}`
      const longId = `bl_${crypto.randomUUID().slice(0, 8)}`
      const quickOutput = path.join(tasksDir, 'tasks', `${quickId}.output`)
      const longOutput = path.join(tasksDir, 'tasks', `${longId}.output`)
      fs.mkdirSync(path.join(tasksDir, 'tasks'), { recursive: true })
      backgroundTasks.set(longId, { output: longOutput, lines: ['dev server starting…', 'listening on :5173'] })
      backgroundTasks.set(quickId, { output: quickOutput, lines: ['waiting…', 'fixture-shell-done'] })
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: quickTool, name: 'Bash', input: { description: 'Wait then print a marker', command: 'sleep 2; echo fixture-shell-done', run_in_background: true } }] } })
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: longTool, name: 'Bash', input: { description: 'Fixture dev server', command: 'bun run dev --fixture', run_in_background: true } }] } })
      push({ type: 'system', subtype: 'task_started', task_id: quickId, tool_use_id: quickTool, description: 'Wait then print a marker', task_type: 'local_bash', is_backgrounded: true })
      push({ type: 'system', subtype: 'task_started', task_id: longId, tool_use_id: longTool, description: 'Fixture dev server', task_type: 'local_bash', is_backgrounded: true })
      push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: quickId }, { task_id: longId }] })
      assistant('Both tasks are running; the marker one will report back.')
      // The turn ends here (the shared result below); the quick task then
      // settles, its notification wakes the agent into a triggered turn.
      setTimeout(() => {
        if (closed) return
        const quick = backgroundTasks.get(quickId)
        if (quick) quick.stopped = true // settled: its tail no longer grows
        fs.writeFileSync(quickOutput, 'fixture-shell-done\n')
        push({ type: 'system', subtype: 'task_updated', task_id: quickId, patch: { status: 'completed', end_time: Date.now() } })
        push({ type: 'system', subtype: 'task_notification', task_id: quickId, tool_use_id: quickTool, status: 'completed', summary: 'Background command "Wait then print a marker" completed (exit code 0)', output_file: quickOutput })
        push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: longId }] })
        push({ type: 'system', subtype: 'init', cwd: options.cwd ?? '/tmp', session_id: 'fixture', model: 'fixture-model', tools: [], slash_commands: [] })
        push({ type: 'system', subtype: 'status', status: 'requesting' })
        push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'The marker printed fixture-shell-done.' }] } })
        push({ type: 'result', subtype: 'success', result: '', total_cost_usd: 0, num_turns: 1, ...resultUsage })
      }, Number(process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS ?? 1200))
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
    if (/audit/i.test(text)) {
      // Outbound-audit walkthrough (execution-safety-recovery D3/D9): the two
      // calls run through the driver's registered audit hooks — exactly what
      // the real CLI invokes — so the observer, classifier, and store record
      // an allowed push and a foreign-repository gh write for real.
      const runAuditHooks = async (event: 'PreToolUse' | 'PostToolUse', toolUseID: string, input: Record<string, unknown>) => {
        for (const entry of options.hooks?.[event] ?? []) {
          for (const hook of entry.hooks) await hook(input as never, toolUseID, { signal: controller.signal })
        }
      }
      for (const command of ['git push origin main', 'gh issue create -R other/repo --title Fixture']) {
        const toolUseID = crypto.randomUUID()
        const input = { description: 'Audit walkthrough send', command }
        push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input }] } })
        await runAuditHooks('PreToolUse', toolUseID, { tool_name: 'Bash', tool_input: input, tool_use_id: toolUseID })
        await hold(500)
        if (closed || turn !== generation) return
        await runAuditHooks('PostToolUse', toolUseID, { tool_name: 'Bash', tool_input: input, tool_use_id: toolUseID, tool_response: 'fixture output' })
      }
      assistant('Recorded the audit walkthrough sends.')
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
    if (/prompt-too-long/i.test(text)) {
      // Context-exhaustion walkthrough (chat-context-exhaustion 6.1): the
      // incident's frames — the CLI's synthetic API-error reply, then a
      // success-subtype result marked is_error with its terminal reason.
      if (!closed && turn === generation) {
        push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] }, error: 'invalid_request' })
        push({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long', terminal_reason: 'blocking_limit', total_cost_usd: 0, num_turns: 1, ...resultUsage, ...echo() })
      }
      return
    }
    if (/rate-limit/i.test(text)) {
      // Worker-choice walkthrough (dispatch-worker-choice 5.1): a final 429
      // the driver records as a limit of the session's profile and provider.
      if (!closed && turn === generation) {
        push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 429 {"error":"usage limit reached"}' }] }, error: 'rate_limit' })
        push({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, num_turns: 1, ...resultUsage, ...echo() })
      }
      return
    }
    if (!closed && turn === generation) push({ type: 'result', subtype: 'success', result: '', total_cost_usd: 0, num_turns: 1, ...resultUsage, ...echo() })
  }
  void (async () => {
    for await (const message of prompt) {
      if (closed) break
      frame('out', message)
      const content = message.message.content
      running = true
      current = message.uuid
      try { await run(typeof content === 'string' ? content : '') } finally { running = false; current = undefined }
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
    interrupt: async (interruptOptions?: { cancelQueued?: boolean }) => {
      const cancelQueued = interruptOptions?.cancelQueued === true
      frame('out', { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt', ...(cancelQueued ? { cancel_queued: true } : {}) } })
      generation++
      // The real CLI flushes the aborted turn's result, naming its prompt,
      // after the ack (docs/claude-cli-contract.md).
      if (running) {
        running = false
        const ids = echo()
        setTimeout(() => push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], total_cost_usd: 0, num_turns: 1, ...resultUsage, ...ids }), 0)
      }
      // Prompts the fixture has not pulled stay in the driver's queue, which
      // the driver clears itself: nothing queued here to cancel.
      return { still_queued: [], ...(cancelQueued ? { cancelled: [] } : {}) }
    },
    // The background-task controls (background tasks D3/D4), shaped like the
    // real CLI's runtime surface: getTaskOutput reads the scenario's real
    // output file (the long task keeps appending, so the polled tail grows),
    // stopTask settles through the normal notification.
    getTaskOutput: async (taskId: string) => {
      const task = backgroundTasks.get(taskId)
      if (!task) throw new Error(`Unknown task: ${taskId}`)
      // A running task prints a line per poll, so the expanded tail grows
      // in the browser; a stopped or settled one reads its final output.
      if (!task.stopped && backgroundTasks.has(taskId)) {
        const next = task.lines.length > 0 ? task.lines.shift()! : `GET /health 200 at ${new Date().toISOString()}`
        try { fs.appendFileSync(task.output, `${next}\n`) } catch { /* dev-only */ }
      }
      let output = ''
      try { output = fs.readFileSync(task.output, 'utf8') } catch { output = '' }
      const bytes = Buffer.byteLength(output, 'utf8')
      return { output: bytes > 8192 ? output.slice(-8192) : output, total_bytes: bytes, truncated: bytes > 8192 }
    },
    stopTask: async (taskId: string) => {
      const task = backgroundTasks.get(taskId)
      if (!task) throw new Error(`Unknown task: ${taskId}`)
      if (task.stopped) return
      task.stopped = true
      try { fs.writeFileSync(task.output, '[killed]') } catch { /* dev-only */ }
      frame('out', { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'stop_task', task_id: taskId } })
      push({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status: 'killed', end_time: Date.now() } })
      push({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'stopped', summary: 'Stopped from the chat view' })
      push({ type: 'system', subtype: 'background_tasks_changed', tasks: [...backgroundTasks.entries()].filter(([, t]) => !t.stopped).map(([id]) => ({ task_id: id })) })
    },
    close: () => {
      if (!closed) frame('lifecycle', { event: 'exit', code: 0, signal: null })
      closed = true; generation++; controller.abort(); wake?.()
    },
  }) as unknown as Query
}
