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
// `quit` exits 0 mid-turn (the CLI ending on its own, no failure);
// `eof-alive` closes the protocol stream and keeps running; `ignore-term`
// ignores SIGTERM and stdin EOF from then on (only SIGKILL ends it);
// `trap3` traps SIGTERM and exits 3 on it, ignoring stdin EOF;
// `child` starts a helper in this process's own group (not detached, no
// shared pipes) that outlives this process, appends its pid to
// $HOME/child-pids, and exits on its own after 20 s at most;
// `stderr-tail <dir>` starts a helper in its own session that shares this
// stderr, writes the unterminated line `TAIL`, records its pid in
// <dir>/tail-helper.pid and exits once <dir>/release exists (after 20 s at
// most), so stderr's EOF comes after this process is gone; `pipes-hold <dir>
// <mode>` records this process's fd 1/2/3 pipe identities in
// <dir>/leader-fds.json and starts a helper in its own session that holds
// this stderr and, in mode `protocol`, also the protocol pipe (fd 3); it
// records its own fd 2/3 identities in <dir>/helper-fds.json, writes the line
// `HELD`, records its pid in <dir>/hold-helper.pid and exits once
// <dir>/release exists (after 20 s at most);
// `tool <Name> [path]` attempts a tool call the way the documented CLI order
// evaluates it: the registered PreToolUse hooks first (a deny wins), then
// --disallowedTools; an executed tool leaves `executed-<Name>` in the cwd
// (a Read reads [path] first), then PostToolUse runs. `mcp <server> <tool>
// <json>` calls an SDK MCP server tool the same way, via mcp_message control
// requests (initialize once, then tools/call); `mcp-list <server>` answers
// with its tools/list names. `ask <Name> <json>` attempts a tool with that
// input the same way, then, when the SDK passed `--permission-prompt-tool
// stdio`, asks it with a `can_use_tool` control request; an allow runs the
// tool with the returned input and answers `allowed <Name> <json>`, a deny
// answers `denied <Name> (<message>)`. `script <json>` (task 5.2) writes
// the JSON's `frames` verbatim, each with this session's id, then a result
// whose `usage` is the JSON's (null: no usage key; absent: the default) and
// whose subtype is the JSON's `subtype` (default success; any other carries
// the `errors` list the SDK reads from an error result); with `hold: true`
// it writes no result and the turn runs on, like `hang`; with `exit: <code>`
// it exits with that code after the frames, mid-turn. Anything else is
// echoed. Stdin EOF exits 0. The get_usage control request (the usage pull)
// answers $HOME/.claude/usage.json verbatim, else rate_limits_available false.
// Every received frame, and first the process argv as {"argv": [...], "pid": n},
// is appended to $FAKE_CLAUDE_LOG when set.
//
// Sessions (FAKE_CLAUDE_SESSIONS=1): conversations persist as transcripts
// under $HOME/.fake-claude/sessions/<id>.jsonl, one line per user prompt,
// written on the first prompt. A fresh launch gets a new random id.
// `--resume=<id>` follows the pinned CLI 2.1.289's headless order (its
// transcript loader runs before the stdin loop that answers initialize):
// - with that transcript, the session keeps the id and its history;
// - without one, it writes the CLI's refusal line to stderr, then the
//   CLI's startup-failure frame (a result error_during_execution, no turns,
//   errors [the line]), and exits 1 without reading stdin or answering
//   initialize.
// FAKE_CLAUDE_RESUME=fresh is a nonconforming CLI that silently starts a
// new session instead. FAKE_CLAUDE_EARLY_EXIT=<text> fails any launch before
// stdin: the text on stderr, no frame, exit 1. `history` answers with the prompts the conversation
// held before it, as JSON. Without FAKE_CLAUDE_SESSIONS the id is fixed and
// --resume is ignored.
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const OUT = 3
/** The `stderr-tail` helper: holds the shared stderr until released (bounded). */
const TAIL_HELPER = "const fs = require('node:fs'); process.stderr.write('TAIL'); const started = Date.now(); setInterval(() => { if (fs.existsSync(process.env.TAIL_RELEASE ?? '') || Date.now() - started > 20000) process.exit(0) }, 20)"
/**
 * The `pipes-hold` helper: records which pipes its fds 2 and 3 are, writes the
 * terminated stderr line `HELD`, holds them until released (bounded), then
 * tries one late stderr line `LATE` before exiting.
 */
const HOLD_HELPER = "const fs = require('node:fs'); const id = (fd) => { try { const s = fs.fstatSync(fd); return s.dev + ':' + s.ino } catch { return null } }; const dir = process.env.HOLD_DIR; fs.writeFileSync(dir + '/helper-fds.json', JSON.stringify({ fd2: id(2), fd3: id(3) })); fs.writeSync(2, 'HELD\\n'); const started = Date.now(); setInterval(() => { if (fs.existsSync(dir + '/release') || Date.now() - started > 20000) { try { fs.writeSync(2, 'LATE\\n') } catch {} process.exit(0) } }, 20)"
/** The `child` helper: stays in the CLI's process group, holding no pipe, until a signal (bounded). */
const CHILD_HELPER = 'setTimeout(() => process.exit(0), 20000)'
/** A descriptor's pipe identity (dev:ino), or null when it is not open. */
const fdId = (fd: number): string | null => {
  try {
    const stat = fs.fstatSync(fd)
    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
  }
}
const log = process.env.FAKE_CLAUDE_LOG
const write = (frame: Record<string, unknown>) => fs.writeSync(OUT, `${JSON.stringify(frame)}\n`)
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
let running: string | null = null
const argv = process.argv.slice(2)
const flag = (name: string) => {
  const at = argv.indexOf(name)
  if (at >= 0) return argv[at + 1]
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

const sessions = process.env.FAKE_CLAUDE_SESSIONS === '1' && process.env.HOME ? `${process.env.HOME}/.fake-claude/sessions` : null
const transcriptOf = (id: string) => `${sessions}/${id}.jsonl`
let sessionId = sessions ? crypto.randomUUID() : 'fake-session-0001'
/** The prompts this conversation held before the current one. */
let history: string[] = []
const resumeTarget = sessions ? flag('--resume') : undefined
if (process.env.FAKE_CLAUDE_EARLY_EXIT !== undefined) {
  // A startup failure that is not (or not only) a resume refusal: the text on stderr, no frame, exit 1 before stdin.
  if (log) fs.appendFileSync(log, `${JSON.stringify({ argv, pid: process.pid })}\n`)
  fs.writeSync(2, `${process.env.FAKE_CLAUDE_EARLY_EXIT}\n`)
  process.exit(1)
}
if (resumeTarget !== undefined) {
  if (fs.existsSync(transcriptOf(resumeTarget))) {
    sessionId = resumeTarget
    history = fs.readFileSync(transcriptOf(resumeTarget), 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { text: string }).text)
  } else if (process.env.FAKE_CLAUDE_RESUME !== 'fresh') {
    if (log) fs.appendFileSync(log, `${JSON.stringify({ argv, pid: process.pid })}\n`)
    const line = `No conversation found with session ID: ${resumeTarget}`
    fs.writeSync(2, `${line}\n`)
    write({
      type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0, stop_reason: null,
      session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: crypto.randomUUID(), errors: [line], result_index: 0,
    })
    process.exit(1)
  }
}

/** Record a prompt in the conversation's transcript (created by the first one). */
function remember(text: string) {
  if (!sessions) return
  fs.mkdirSync(sessions, { recursive: true })
  fs.appendFileSync(transcriptOf(sessionId), `${JSON.stringify({ text })}\n`)
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
async function toolTurn(uuid: string, tool: string, toolInput: Record<string, unknown>, execute: (toolUseId: string) => Promise<{ text: string; isError: boolean }>) {
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
    const outcome = await execute(toolUseId)
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

/** `ask`: the documented order, then the SDK's permission prompt (can_use_tool) when it is wired. */
function askTool(uuid: string, tool: string, input: Record<string, unknown>) {
  return toolTurn(uuid, tool, input, async (toolUseId) => {
    if (flag('--permission-prompt-tool') !== 'stdio') return { text: `no permission prompt for ${tool}`, isError: true }
    const requestId = `fake-${++nextRequest}`
    write({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: toolUseId, permission_suggestions: [] } })
    const decision = await new Promise<Record<string, unknown>>((resolve) => pending.set(requestId, resolve))
    if (decision.behavior !== 'allow') return { text: `denied ${tool} (${String(decision.message)})`, isError: true }
    fs.writeFileSync(`executed-${tool}`, '')
    return { text: `allowed ${tool} ${JSON.stringify(decision.updatedInput ?? input)}`, isError: false }
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
if (log) fs.appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), pid: process.pid })}\n`)
let holdOnEof = false

function result(uuid: string, subtype: string, text: string | null, isError = false, turnUsage: unknown = usage, errors?: string[]) {
  write({
    type: 'result', subtype, is_error: isError, ...(text === null ? {} : { result: text }), ...(errors ? { errors } : {}),
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, ...(turnUsage === null ? {} : { usage: turnUsage }),
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
  const before = history
  history = [...history, text]
  remember(text)
  const [command, ...rest] = text.trim().split(/\s+/)
  switch (command) {
    case 'history': {
      const held = JSON.stringify(before)
      assistant(held)
      return result(uuid, 'success', held)
    }
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
    case 'ask':
      void askTool(uuid, rest[0] ?? '', JSON.parse(rest.slice(1).join(' ') || '{}') as Record<string, unknown>)
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
    case 'script': {
      const script = JSON.parse(rest.join(' ')) as { frames?: Array<Record<string, unknown>>; usage?: unknown; subtype?: string; hold?: boolean; exit?: number }
      for (const frame of script.frames ?? []) write({ ...frame, session_id: sessionId })
      if (script.exit !== undefined) process.exit(script.exit)
      if (script.hold) {
        running = uuid
        return
      }
      const subtype = script.subtype ?? 'success'
      return result(uuid, subtype, subtype === 'success' ? 'scripted' : null, subtype !== 'success', script.usage === undefined ? usage : script.usage, subtype === 'success' ? undefined : ['scripted failure'])
    }
    case 'crash':
      process.exit(3)
    case 'quit':
      process.exit(0)
    case 'eof-alive':
      fs.closeSync(OUT)
      setInterval(() => {}, 1000)
      return
    case 'trap3':
      process.on('SIGTERM', () => process.exit(3))
      holdOnEof = true
      setInterval(() => {}, 1000)
      assistant('trapping SIGTERM')
      return result(uuid, 'success', 'trapping SIGTERM')
    case 'stderr-tail': {
      const dir = rest[0] ?? '.'
      const helper = spawn(process.execPath, ['-e', TAIL_HELPER], { detached: true, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TAIL_RELEASE: `${dir}/release` } })
      fs.writeFileSync(`${dir}/tail-helper.pid`, String(helper.pid))
      helper.unref()
      holdOnEof = true
      setInterval(() => {}, 1000)
      assistant('stderr tail pending')
      return result(uuid, 'success', 'stderr tail pending')
    }
    case 'pipes-hold': {
      const [dir = '.', mode = 'stderr'] = rest
      const protocol = mode === 'protocol' ? 'inherit' : 'ignore'
      fs.writeFileSync(`${dir}/leader-fds.json`, JSON.stringify({ fd1: fdId(1), fd2: fdId(2), fd3: fdId(OUT) }))
      const helper = spawn(process.execPath, ['-e', HOLD_HELPER], { detached: true, stdio: ['ignore', 'ignore', 'inherit', protocol], env: { ...process.env, HOLD_DIR: dir } })
      fs.writeFileSync(`${dir}/hold-helper.pid`, String(helper.pid))
      helper.unref()
      holdOnEof = true
      setInterval(() => {}, 1000)
      assistant('pipes held')
      return result(uuid, 'success', 'pipes held')
    }
    case 'child': {
      const helper = spawn(process.execPath, ['-e', CHILD_HELPER], { stdio: 'ignore' })
      fs.appendFileSync(`${process.env.HOME ?? '.'}/child-pids`, `${helper.pid}\n`)
      helper.unref()
      assistant('child started')
      return result(uuid, 'success', 'child started')
    }
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
    case 'get_usage': {
      // The usage pull reads this process's own home: $HOME/.claude/usage.json answers it verbatim, else no plan windows.
      const file = `${process.env.HOME ?? ''}/.claude/usage.json`
      return respond(fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : { rate_limits_available: false })
    }
    case 'interrupt': {
      const uuid = running
      running = null
      respond({ cancelled: [], still_queued: [] })
      // An error result always carries `errors` (the pinned SDK's SDKResultError
      // requires it and reads it once a turn has completed on this process).
      if (uuid) result(uuid, 'error_during_execution', null, true, usage, [])
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
