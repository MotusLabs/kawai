// A process-level fake Claude Code CLI for the real SDK composition (task
// 2.2/2.4): the pinned SDK spawns it through the owned spawner and speaks
// stream-json to it over stdin/stdout, so no credentials or model calls are
// needed. Protocol output goes to fd 3, which the generated wrapper dups from
// the real stdout pipe (fd 1 goes to /dev/null): a Bun process cannot close
// its own fd 1 for the reader, and the `eof-alive` prompt needs exactly that.
//
// Prompts: `env <NAME...>` answers with those variables as JSON; `env-all`
// answers with the whole initial environment (/proc/self/environ); `hang`
// starts a turn that ends only on interrupt; `crash` exits 3 mid-turn;
// `eof-alive` closes the protocol stream and keeps running; `ignore-term`
// ignores SIGTERM and stdin EOF from then on (only SIGKILL ends it); anything else is echoed. Stdin EOF exits 0.
// Every received frame, and first the process argv as {"argv": [...]},
// is appended to $FAKE_CLAUDE_LOG when set.
import fs from 'node:fs'

const OUT = 3
const sessionId = 'fake-session-0001'
const log = process.env.FAKE_CLAUDE_LOG
const write = (frame: Record<string, unknown>) => fs.writeSync(OUT, `${JSON.stringify(frame)}\n`)
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
let running: string | null = null
if (log) fs.appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2) })}\n`)
let holdOnEof = false

function result(uuid: string, subtype: string, text: string | null, isError = false) {
  write({
    type: 'result', subtype, is_error: isError, ...(text === null ? {} : { result: text }),
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage,
    session_id: sessionId, uuid: crypto.randomUUID(), user_message_uuid: uuid, user_message_uuids: [uuid],
  })
}

function assistant(text: string) {
  write({
    type: 'assistant', session_id: sessionId, uuid: crypto.randomUUID(), parent_tool_use_id: null,
    message: { id: crypto.randomUUID(), role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], usage },
  })
}

function onUser(frame: { uuid?: string; message?: { content?: unknown } }) {
  const uuid = frame.uuid ?? crypto.randomUUID()
  const content = frame.message?.content
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('') : ''
  write({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd(), tools: [], uuid: crypto.randomUUID() })
  const [command, ...rest] = text.trim().split(/\s+/)
  switch (command) {
    case 'env': {
      const values = Object.fromEntries(rest.map((name) => [name, process.env[name] ?? null]))
      assistant(JSON.stringify(values))
      return result(uuid, 'success', JSON.stringify(values))
    }
    case 'env-all': {
      // The kernel's record of this process's initial environment: Bun hides
      // some variables (NODE_TLS_REJECT_UNAUTHORIZED) from process.env.
      const entries = fs.readFileSync('/proc/self/environ', 'utf8').split('\0').filter(Boolean)
      const all = JSON.stringify(Object.fromEntries(entries.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])))
      assistant(all)
      return result(uuid, 'success', all)
    }
    case 'hang':
      running = uuid
      return
    case 'crash':
      process.exit(3)
    case 'eof-alive':
      fs.closeSync(OUT)
      setInterval(() => {}, 1000)
      return
    case 'ignore-term':
      process.on('SIGTERM', () => {})
      holdOnEof = true
      setInterval(() => {}, 1000)
      assistant('ignoring SIGTERM')
      return result(uuid, 'success', 'ignoring SIGTERM')
    default:
      assistant(`echo: ${text}`)
      return result(uuid, 'success', `echo: ${text}`)
  }
}

function onControl(frame: { request_id: string; request: { subtype: string } }) {
  const respond = (response: Record<string, unknown> = {}) =>
    write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } })
  switch (frame.request.subtype) {
    case 'initialize':
      return respond({ commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] })
    case 'interrupt': {
      const uuid = running
      running = null
      respond({ cancelled: [], still_queued: [] })
      if (uuid) result(uuid, 'error_during_execution', null, true)
      return
    }
    default:
      return respond()
  }
}

let buffer = ''
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let newline: number
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    if (log) fs.appendFileSync(log, `${line}\n`)
    const frame = JSON.parse(line)
    if (frame.type === 'control_request') onControl(frame)
    else if (frame.type === 'user') onUser(frame)
  }
})
process.stdin.on('end', () => {
  if (!holdOnEof) process.exit(0)
})
