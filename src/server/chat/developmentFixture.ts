// Explicit development-only fake SDK: exercises the real driver, approvals,
// questions, status, and WebSocket path without authentication or model calls.
// It never spawns a process, so it records synthetic wire frames shaped like
// the real stream-json protocol for the chat debug view. The activity turns
// (thinking / tool / retry) hold each phase long enough to watch the
// indicator's timer tick; tests shrink the holds via
// AGENTBOARD_CHAT_FIXTURE_HOLD_MS.
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
  const assistant = (text: string) => push({
    type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }] },
  })
  const run = async (text: string) => {
    const turn = generation
    assistant('**Fixture response** — chat streaming, tools, and permissions are ready.')
    if (/approval|question/i.test(text)) {
      const tool = /question/i.test(text) ? 'AskUserQuestion' : 'Bash'
      const input = tool === 'Bash' ? { command: 'echo fixture' } : {
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
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, content: JSON.stringify(result) }] } })
      assistant(result?.behavior === 'allow' ? 'Request accepted.' : 'Request denied.')
    }
    if (/thinking/i.test(text)) {
      push({ type: 'system', subtype: 'status', status: 'requesting' })
      await hold(400)
      if (closed || turn !== generation) return
      push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, parent_tool_use_id: null })
      await hold(1600)
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
      push({ type: 'assistant', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input: { command: 'echo fixture' } }] } })
      await hold(1600)
      if (closed || turn !== generation) return
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, content: 'fixture output' }] } })
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
