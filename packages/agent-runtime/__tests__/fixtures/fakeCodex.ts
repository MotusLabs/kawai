// A fake `codex app-server` for the Codex driver tests, launched through a
// wrapper script as the driver's executablePath (helpers/codexDriverHarness.ts).
// Newline-delimited JSON-RPC on stdio. Its pid is appended to $CODEX_HOME/pids,
// its cwd and complete environment to $CODEX_HOME/envs.jsonl,
// and every inbound line to $CODEX_HOME/received.jsonl; threads persist as $CODEX_HOME/threads/<id>.json,
// so a resume in another process sees the same conversation history.
//
// Env: FAKE_CODEX_INIT=unauthorized|exit; FAKE_CODEX_RESUME=substitute|substitute-unknown|refuse|unauthorized;
//      FAKE_CODEX_START=unauthorized.
// A turn's text picks its script (default: one agent message with a unique
// transformed text naming the thread's earlier messages):
//   /hold            stays in progress until turn/interrupt or turn/steer
//   /ask <method> <json>  a server request; the turn's text is the JSON reply
//   /tool <json>     an item/tool/call; the turn's text is the JSON reply
//   /fail <info>     turn/completed failed with that codexErrorInfo (JSON or string)
//   /rpcfail <info>  turn/start answered with an error carrying that codexErrorInfo
//   /exit <code>     exits after turn/started
//   /agent           completes, then runs an agent-started turn
//   /late            completes, then repeats turn/completed and a foreign one
//   /facts           tool, compaction, token, rate-limit and retry notifications
//   /early           turn/started and the completion before the turn/start reply
//   /foreign         a second turn/started (another id) during the turn, then completes
//   /child           starts a helper in this process group holding stdout (pid in pids), then completes
// FAKE_CODEX_START=agent: an agent turn starts and completes right after thread/start.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.CODEX_HOME!
mkdirSync(join(home, 'threads'), { recursive: true })
mkdirSync(join(home, 'sessions'), { recursive: true })
appendFileSync(join(home, 'pids'), `${process.pid}\n`)
appendFileSync(join(home, 'envs.jsonl'), `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), env: process.env })}\n`)
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })
const fail = (id: unknown, message: string, info?: unknown) => send({ jsonrpc: '2.0', id, error: { code: -32000, message, ...(info !== undefined ? { data: { codexErrorInfo: info } } : {}) } })
const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params })
const asked = new Map<number, (message: Record<string, any>) => void>()
let nextAsk = 1000
let turns = 0

interface Thread { id: string; path: string; history: string[] }
const threadFile = (id: string) => join(home, 'threads', `${id}.json`)
const load = (id: string): Thread | null => (existsSync(threadFile(id)) ? (JSON.parse(readFileSync(threadFile(id), 'utf8')) as Thread) : null)
const save = (thread: Thread) => writeFileSync(threadFile(thread.id), JSON.stringify(thread))
let thread: Thread | null = null
let active: { id: string; steer(text: string): void; interrupt(): void } | null = null

const info = (raw: string) => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function ask(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  const id = nextAsk++
  return new Promise((resolve) => {
    asked.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function complete(turnId: string, status: string, text: string | null, error: unknown = null) {
  const items = text === null ? [] : [{ type: 'agentMessage', id: `msg-${turnId}`, text }]
  if (text !== null) {
    notify('item/started', { threadId: thread!.id, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: '' } })
    notify('item/agentMessage/delta', { threadId: thread!.id, turnId, itemId: `msg-${turnId}`, delta: text.slice(0, 3) })
    notify('item/completed', { threadId: thread!.id, turnId, item: items[0] })
  }
  if (active?.id === turnId) active = null
  notify('turn/completed', { threadId: thread!.id, turn: { id: turnId, status, error, items } })
}

function transformed(text: string): string {
  const reply = `codex:${[...text].reverse().join('')}|seen=${thread!.history.join('+')}`
  thread!.history.push(text)
  save(thread!)
  return reply
}

function turnStart(id: number, params: Record<string, any>) {
  const text: string = params.input?.[0]?.text ?? ''
  const [directive, ...rest] = text.split(' ')
  const arg = rest.join(' ')
  if (directive === '/rpcfail') return fail(id, 'turn refused', info(arg))
  const turnId = `turn-${++turns}`
  const started = () => notify('turn/started', { threadId: thread!.id, turn: { id: turnId, status: 'inProgress', items: [], error: null } })
  if (directive === '/early') {
    started()
    complete(turnId, 'completed', transformed('early'))
    return void setTimeout(() => reply(id, { turn: { id: turnId, status: 'completed', items: [], error: null } }), 30)
  }
  reply(id, { turn: { id: turnId, status: 'inProgress', items: [], error: null } })
  started()
  switch (directive) {
    case '/hold':
      active = {
        id: turnId,
        steer: (steered) => setTimeout(() => complete(turnId, 'completed', `steered:${steered}`), 5),
        interrupt: () => complete(turnId, 'interrupted', null),
      }
      return
    case '/ask': {
      const [method, ...json] = rest
      void ask(method!, { threadId: thread!.id, turnId, itemId: 'item-ask', ...(json.length ? JSON.parse(json.join(' ')) : {}) }).then((answer) =>
        complete(turnId, 'completed', JSON.stringify(answer.result ?? answer.error)),
      )
      return
    }
    case '/tool':
      void ask('item/tool/call', { threadId: thread!.id, turnId, callId: 'call-1', ...JSON.parse(arg) }).then((answer) => complete(turnId, 'completed', JSON.stringify(answer.result ?? answer.error)))
      return
    case '/fail':
      return complete(turnId, 'failed', null, { message: 'the turn failed', codexErrorInfo: info(arg), additionalDetails: null })
    case '/exit':
      return void setTimeout(() => process.exit(Number(arg)), 5)
    case '/agent': {
      complete(turnId, 'completed', transformed('agent-parent'))
      const agentTurn = `agent-${turns}`
      notify('turn/started', { threadId: thread!.id, turn: { id: agentTurn, status: 'inProgress', items: [], error: null } })
      return complete(agentTurn, 'completed', 'agent-started reply')
    }
    case '/child': {
      const child = spawn(process.execPath, [join(import.meta.dir, 'helper.ts'), join(home, `child-${process.pid}.ticks`)], { stdio: ['ignore', 'inherit', 'ignore'] })
      child.unref()
      appendFileSync(join(home, 'pids'), `${child.pid}\n`)
      return complete(turnId, 'completed', transformed('child'))
    }
    case '/foreign':
      notify('turn/started', { threadId: thread!.id, turn: { id: `foreign-${turns}`, status: 'inProgress', items: [], error: null } })
      return complete(turnId, 'completed', transformed('foreign'))
    case '/late':
      complete(turnId, 'completed', transformed('late'))
      notify('turn/completed', { threadId: thread!.id, turn: { id: turnId, status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'dup', text: 'duplicate' }] } })
      return notify('turn/completed', { threadId: thread!.id, turn: { id: 'ghost', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'g', text: 'ghost' }] } })
    case '/facts': {
      const t = { threadId: thread!.id, turnId }
      const command = { type: 'commandExecution', id: 'cmd-1', command: 'curl -H SECRET-TOKEN-123 x', cwd: '/', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }
      notify('item/started', { ...t, item: command })
      notify('item/completed', { ...t, item: command })
      notify('item/completed', { ...t, item: command })
      notify('item/started', { ...t, item: { type: 'webSearch', id: 'web-1', query: 'q' } })
      notify('item/completed', { ...t, item: { type: 'contextCompaction', id: 'cmp-1' } })
      notify('item/completed', { ...t, item: { type: 'contextCompaction', id: 'cmp-1' } })
      notify('thread/tokenUsage/updated', { ...t, tokenUsage: { total: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 40, outputTokens: 50, reasoningOutputTokens: 0 }, last: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 40, outputTokens: 50, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } })
      notify('account/rateLimits/updated', { rateLimits: { limitId: null, limitName: null, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1900500000 }, credits: null, planType: null, rateLimitReachedType: 'rateLimitReached' } })
      notify('error', { ...t, willRetry: true, error: { message: 'slow down', codexErrorInfo: 'rateLimitExceeded', additionalDetails: null } })
      return complete(turnId, 'completed', transformed('facts'))
    }
    default:
      return complete(turnId, 'completed', transformed(text))
  }
}

function handle(message: Record<string, any>) {
  const { id, method, params = {} } = message
  if (method === undefined) return asked.get(id)?.(message)
  switch (method) {
    case 'initialize':
      if (process.env.FAKE_CODEX_INIT === 'unauthorized') return fail(id, 'unauthorized', 'unauthorized')
      if (process.env.FAKE_CODEX_INIT === 'exit') return process.exit(9)
      return reply(id, { userAgent: 'fake-codex/0.163.0', codexHome: home, platformFamily: 'unix', platformOs: 'linux' })
    case 'thread/start': {
      if (process.env.FAKE_CODEX_START === 'unauthorized') return fail(id, '401 Unauthorized', { httpConnectionFailed: { httpStatusCode: 401 } })
      const threadId = `thr-${crypto.randomUUID()}`
      thread = { id: threadId, path: join(home, 'sessions', `${threadId}.jsonl`), history: [] }
      writeFileSync(thread.path, '')
      save(thread)
      reply(id, { thread: { id: threadId, path: thread.path }, model: 'fake-model' })
      if (process.env.FAKE_CODEX_START === 'agent') {
        notify('turn/started', { threadId, turn: { id: 'boot-agent', status: 'inProgress', items: [], error: null } })
        complete('boot-agent', 'completed', 'boot agent reply')
      }
      return
    }
    case 'thread/resume': {
      const mode = process.env.FAKE_CODEX_RESUME
      if (mode === 'unauthorized') return fail(id, 'unauthorized', 'unauthorized')
      if (mode === 'substitute' || (mode === 'substitute-unknown' && !load(params.threadId))) {
        const other = `thr-${crypto.randomUUID()}`
        thread = { id: other, path: join(home, 'sessions', `${other}.jsonl`), history: [] }
        save(thread)
        return reply(id, { thread: { id: other, path: thread.path }, model: 'fake-model' })
      }
      const found = mode === 'refuse' ? null : load(params.threadId)
      if (!found) return send({ jsonrpc: '2.0', id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } })
      thread = found
      return reply(id, { thread: { id: found.id, path: found.path }, model: 'fake-model' })
    }
    case 'turn/start':
      return turnStart(id, params)
    case 'turn/steer': {
      if (!active || params.expectedTurnId !== active.id) return fail(id, 'no active turn to steer', { activeTurnNotSteerable: { turnKind: 'review' } })
      reply(id, { turnId: active.id })
      return active.steer(params.input?.[0]?.text ?? '')
    }
    case 'turn/interrupt': {
      if (active && params.turnId === active.id) active.interrupt()
      return reply(id, {})
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
  }
}

let buffer = ''
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
    if (!line.trim()) continue
    appendFileSync(join(home, 'received.jsonl'), `${line}\n`)
    handle(JSON.parse(line) as Record<string, any>)
  }
})
process.stdin.on('end', () => process.exit(0))
