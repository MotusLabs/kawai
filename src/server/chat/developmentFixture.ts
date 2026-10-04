// Explicit development-only fake SDK: exercises the real driver, approvals,
// questions, status, and WebSocket path without authentication or model calls.
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatQueryFactory } from './ChatSessionDriver'

export const chatFixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.AGENTBOARD_CHAT_FIXTURE === '1'

export const fixtureQueryFactory: ChatQueryFactory = ({ prompt, options }) => {
  const events: SDKMessage[] = []
  let wake: (() => void) | null = null
  let closed = false
  let generation = 0
  const controller = new AbortController()
  const push = (message: Record<string, unknown>) => {
    if (closed) return
    events.push({ uuid: crypto.randomUUID(), session_id: 'fixture', ...message } as SDKMessage)
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
      const result = await options.canUseTool!(tool, input, {
        signal: controller.signal, toolUseID, requestId: crypto.randomUUID(),
      })
      if (closed || turn !== generation) return
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, content: JSON.stringify(result) }] } })
      assistant(result?.behavior === 'allow' ? 'Request accepted.' : 'Request denied.')
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
    interrupt: async () => { generation++ },
    close: () => { closed = true; generation++; controller.abort(); wake?.() },
  }) as unknown as Query
}
