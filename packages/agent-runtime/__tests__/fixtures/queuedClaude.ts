// A minimal Claude CLI for the queued-successor case (INV-A2, ported from
// the task-73 fresh assessment probe). It holds the first prompt's turn
// until $RELEASE exists, so a second prompt can queue behind it. Then it
// writes the first turn's request, its successful result with a model
// window (the result frame's own context observation), and, when a second
// prompt arrived, that turn's init and successful result. Protocol on fd 3.
import { existsSync, writeFileSync } from 'node:fs'

const out = (frame: unknown) => writeFileSync(3, `${JSON.stringify(frame)}\n`)
const session = 'queued-session'
let first: { uuid: string } | null = null
let second: { uuid: string } | null = null
let buffer = ''
const init = () => out({ type: 'system', subtype: 'init', session_id: session, model: 'source-model', uuid: crypto.randomUUID(), tools: [] })
const result = (prompt: { uuid: string }, modelUsage: unknown = {}) =>
  out({ type: 'result', subtype: 'success', uuid: crypto.randomUUID(), session_id: session, user_message_uuids: [prompt.uuid], is_error: false, result: 'source success', usage: { input_tokens: 10, output_tokens: 5 }, modelUsage, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 })

const timer = setInterval(() => {
  if (!first || !existsSync(process.env.RELEASE!)) return
  clearInterval(timer)
  out({ type: 'stream_event', uuid: crypto.randomUUID(), session_id: session, parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'source-request', usage: { input_tokens: 100 } } } })
  result(first, { source: { contextWindow: 1000 } })
  if (second) {
    init()
    result(second)
  }
}, 5)

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  let i: number
  while ((i = buffer.indexOf('\n')) >= 0) {
    const frame = JSON.parse(buffer.slice(0, i)) as { type: string; uuid: string; request_id?: string; request?: { subtype?: string } }
    buffer = buffer.slice(i + 1)
    if (frame.type === 'control_request') {
      const response = frame.request?.subtype === 'initialize' ? { commands: [], models: [], agents: [], account: {} } : { cancelled: [], still_queued: [] }
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } })
    }
    if (frame.type === 'user') {
      if (!first) {
        first = frame
        init()
      } else second = frame
    }
  }
})
process.stdin.on('end', () => process.exit(0))
