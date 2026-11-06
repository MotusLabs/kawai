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
// ignores SIGTERM and stdin EOF from then on (only SIGKILL ends it);
// `tool <Name> [path]` attempts a tool call the way the documented CLI order
// evaluates it: the registered PreToolUse hooks first (a deny wins), then
// --disallowedTools; an executed tool leaves `executed-<Name>` in the cwd
// (a Read reads [path] first), then PostToolUse runs. `mcp <server> <tool>
// <json>` calls an SDK MCP server tool the same way, via mcp_message control
// requests (initialize once, then tools/call); `mcp-list <server>` answers
// with its tools/list names. Anything else is echoed. Stdin EOF exits 0.
// Every received frame, and first the process argv as {"argv": [...]},
// is appended to $FAKE_CLAUDE_LOG when set.
import fs from 'node:fs'

const OUT = 3
const sessionId = 'fake-session-0001'
const log = process.env.FAKE_CLAUDE_LOG
const write = (frame: Record<string, unknown>) => fs.writeSync(OUT, `${JSON.stringify(frame)}\n`)
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
let running: string | null = null
const argv = process.argv.slice(2)
const flag = (name: string) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const disallowed = new Set((flag('--disallowedTools') ?? '').split(',').filter(Boolean))
type Matcher = { matcher?: string; hookCallbackIds: string[] }
let hooks: Record<string, Matcher[]> = {}
let sdkServers: string[] = []
const initializedServers = new Set<string>()
let nextMcpId = 0
const pending = new Map<string, (response: Record<string, unknown>) => void>()
let nextRequest = 0

function askHook(callbackId: string, input: Record<string, unknown>, toolUseId: string): Promise<Record<string, unknown>> {
  const requestId = `fake-${++nextRequest}`
  write({ type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: callbackId, input, tool_use_id: toolUseId } })
  return new Promise((resolve) => pending.set(requestId, resolve))
}

/** Run one event's matching hooks in order; the first deny reason, else null. */
async function runHooks(event: string, tool: string, toolUseId: string, extra: Record<string, unknown>): Promise<string | null> {
  let denial: string | null = null
  const input = { hook_event_name: event, session_id: sessionId, transcript_path: '', cwd: process.cwd(), tool_name: tool, tool_use_id: toolUseId, ...extra }
  for (const matcher of hooks[event] ?? []) {
    if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test(tool)) continue
    for (const id of matcher.hookCallbackIds) {
      const output = await askHook(id, input, toolUseId)
      const specific = output.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined
      if (specific?.permissionDecision === 'deny') denial ??= `hook: ${specific.permissionDecisionReason ?? 'denied'}`
    }
  }
  return denial
}

/** One tool attempt: PreToolUse hooks, then --disallowedTools, then `execute`, then PostToolUse(Failure). */
async function toolTurn(uuid: string, tool: string, toolInput: Record<string, unknown>, execute: () => Promise<{ text: string; isError: boolean }>) {
  const toolUseId = `toolu_${crypto.randomUUID()}`
  write({
    type: 'assistant', session_id: sessionId, uuid: crypto.randomUUID(), parent_tool_use_id: null,
    message: { id: crypto.randomUUID(), role: 'assistant', model: 'fake-model', content: [{ type: 'tool_use', id: toolUseId, name: tool, input: toolInput }], usage },
  })
  let denial = await runHooks('PreToolUse', tool, toolUseId, { tool_input: toolInput })
  if (denial === null && disallowed.has(tool)) denial = `disallowed: ${tool}`
  let text: string
  let isError = denial !== null
  if (denial !== null) {
    text = `denied ${tool} (${denial})`
  } else {
    const outcome = await execute()
    text = outcome.text
    isError = outcome.isError
    await runHooks(isError ? 'PostToolUseFailure' : 'PostToolUse', tool, toolUseId, { tool_input: toolInput, ...(isError ? { error: text } : { tool_response: text }) })
  }
  write({ type: 'user', session_id: sessionId, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] } })
  assistant(text)
  result(uuid, 'success', text)
}

function attemptTool(uuid: string, tool: string, target: string | undefined) {
  return toolTurn(uuid, tool, target ? { file_path: target } : {}, async () => {
    const content = tool === 'Read' && target ? fs.readFileSync(target, 'utf8') : ''
    fs.writeFileSync(`executed-${tool}`, '')
    return { text: `executed ${tool}${content ? `: ${content}` : ''}`, isError: false }
  })
}

function mcpRequest(server: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = `fake-${++nextRequest}`
  write({ type: 'control_request', request_id: requestId, request: { subtype: 'mcp_message', server_name: server, message } })
  return new Promise((resolve) => pending.set(requestId, (response) => resolve((response.mcp_response ?? {}) as Record<string, unknown>)))
}

async function mcpCall(server: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!initializedServers.has(server)) {
    initializedServers.add(server)
    await mcpRequest(server, { jsonrpc: '2.0', id: ++nextMcpId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } } })
    await mcpRequest(server, { jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  return mcpRequest(server, { jsonrpc: '2.0', id: ++nextMcpId, method, params })
}

function attemptMcp(uuid: string, server: string, tool: string, json: string | undefined) {
  const args = json ? (JSON.parse(json) as Record<string, unknown>) : {}
  return toolTurn(uuid, `mcp__${server}__${tool}`, args, async () => {
    if (!sdkServers.includes(server)) return { text: `no MCP server ${server}`, isError: true }
    const response = await mcpCall(server, 'tools/call', { name: tool, arguments: args })
    if (response.error) return { text: `mcp error: ${JSON.stringify(response.error)}`, isError: true }
    const outcome = response.result as { content?: Array<{ text?: string }>; isError?: boolean }
    const text = (outcome.content ?? []).map((item) => item.text ?? '').join('')
    return { text: `${outcome.isError ? 'mcp error' : 'mcp ok'}: ${text}`, isError: outcome.isError === true }
  })
}

async function listMcp(uuid: string, server: string) {
  const names = sdkServers.includes(server)
    ? ((await mcpCall(server, 'tools/list', {})).result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
    : null
  const text = JSON.stringify({ servers: sdkServers, tools: names })
  assistant(text)
  result(uuid, 'success', text)
}
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
    case 'tool':
      void attemptTool(uuid, rest[0] ?? '', rest[1])
      return
    case 'mcp':
      void attemptMcp(uuid, rest[0] ?? '', rest[1] ?? '', rest.slice(2).join(' ') || undefined)
      return
    case 'mcp-list':
      void listMcp(uuid, rest[0] ?? '')
      return
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
      hooks = (frame.request as { hooks?: Record<string, Matcher[]> }).hooks ?? {}
      sdkServers = (frame.request as { sdkMcpServers?: string[] }).sdkMcpServers ?? []
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
    if (frame.type === 'control_response') {
      const resolve = pending.get(frame.response.request_id)
      pending.delete(frame.response.request_id)
      resolve?.(frame.response.response ?? {})
    } else if (frame.type === 'control_request') onControl(frame)
    else if (frame.type === 'user') onUser(frame)
  }
})
process.stdin.on('end', () => {
  if (!holdOnEof) process.exit(0)
})
