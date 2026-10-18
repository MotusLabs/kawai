// Codex app-server smoke (openspec codex-chat-sessions §1). Run by hand, never
// in CI: it drives real Codex turns on the host's own login, so the human's
// quota pays for every prompt. Requires codex-cli >= 0.163.0 installed and
// signed in (default CODEX_HOME; the spawn itself reads nothing from it and
// writes nothing into it — the rollout dump below only reads the recorded
// thread's rollout file under it):
//
//   bun scripts/codex-smoke.ts --record /tmp/codex-smoke-raw.jsonl
//
// It spawns its own `codex app-server` child over stdio JSON-RPC and walks the
// §1 checklist — initialize, thread/start with a kawai-team dynamic-tool
// namespace and the D5 sandbox, a dynamic tool call, a sandboxed git commit,
// a declined out-of-sandbox write, a requestUserInput round-trip, an
// interrupt, then thread/resume from a second process with thread/read and a
// rollout dump. Every raw JSON-RPC line both directions lands in --record,
// scrubbed into fixture shape at write time (src/server/chat/codex/smokeScrub.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { scrubRawLine, scrubSmokeValue } from '../src/server/chat/codex/smokeScrub'

const CODEX = (process.env.KAWAI_CODEX_PATH ?? '').trim() || 'codex'
const CLIENT = { name: 'kawai-codex-smoke', title: 'Kawai Codex smoke', version: '0.0.0' }

interface RawLine { ts: string; dir: 'out' | 'in'; line: string }
type Json = Record<string, unknown>

const fail = (reason: string): never => {
  console.error(`smoke failed: ${reason}`)
  process.exit(1)
}

const timeout = (ms: number, what: string) => {
  const err = new Error(`timeout after ${ms}ms: ${what}`)
  return new Promise<never>((_, reject) => setTimeout(() => reject(err), ms))
}

/** One scratch git repo per run; writable root and sandbox workspace both. */
function makeWorkspace(): { dir: string; gitCommonDir: string } {
  const dir = fs.mkdtempSync(path.join('/tmp', 'kawai-codex-smoke-'))
  const git = (args: string[]) =>
    Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (git(['init', '-q']).exitCode !== 0) fail('git init failed in scratch workspace')
  git(['config', 'user.email', 'smoke@example.internal'])
  git(['config', 'user.name', 'kawai smoke'])
  fs.writeFileSync(path.join(dir, 'note.txt'), 'kawai smoke scratch\n')
  const common = git(['rev-parse', '--git-common-dir'])
  const gitCommonDir = path.resolve(dir, common.stdout.toString().trim())
  return { dir, gitCommonDir }
}

/**
 * One app-server child, one JSON-RPC session. Requests get promises by id;
 * notifications go to waitFor waiters; server requests (approvals, user
 * input, dynamic tool calls) go to the phase's onServerRequest, whose return
 * value becomes the reply. Every raw line, both directions, is recorded.
 */
class SmokeClient {
  /** Every live client, so a Ctrl-C can stop the detached children (review N3). */
  static readonly live = new Set<SmokeClient>()
  readonly proc: ChildProcess
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  private readonly waiters: Array<{ method: string; resolve: (n: Json) => void; reject: (e: Error) => void }> = []
  onServerRequest: ((method: string, params: Json) => unknown | Promise<unknown>) | null = null
  /** Observes every notification (async questions ride item/started). */
  onNotification: ((method: string, params: Json) => void) | null = null
  readonly serverRequests: Array<{ method: string; params: Json }> = []
  exit: Promise<number | null>

  constructor(private readonly record: RawLine[]) {
    // Detached: the child leads its own process group, so stop() can signal
    // the sandboxed grandchildren alongside it (review O5).
    this.proc = spawn(CODEX, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    SmokeClient.live.add(this)
    this.proc.on('error', (error) => this.failAll(`spawn ${CODEX} app-server: ${error.message}`))
    this.exit = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)))
    const rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity })
    rl.on('line', (line) => this.onLine(line))
    const stderr: string[] = []
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString())
      if (stderr.join('').length > 16_000) stderr.splice(0, stderr.length - 8_000)
    })
    this.proc.on('exit', () => this.failAll(`app-server exited: ${(stderr.join('').trim().split('\n').at(-1)) ?? 'no stderr'}`))
  }

  private failAll(reason: string) {
    for (const entry of this.pending.values()) entry.reject(new Error(reason))
    this.pending.clear()
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(reason))
  }

  private onLine(line: string) {
    this.record.push({ ts: new Date().toISOString(), dir: 'in', line })
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return // torn line: recorded raw, never dispatched
    }
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id)
      if (entry) {
        this.pending.delete(msg.id)
        if (msg.error !== undefined) entry.reject(new Error(`request ${msg.id} error: ${JSON.stringify(msg.error)}`))
        else entry.resolve(msg.result as Json)
      }
      return
    }
    const method = typeof msg.method === 'string' ? msg.method : ''
    if (!method) return
    const params = (msg.params ?? {}) as Json
    if (msg.id !== undefined) {
      // Server request: record, answer from the phase handler, reply.
      this.serverRequests.push({ method, params })
      void Promise.resolve()
        .then(() => this.onServerRequest?.(method, params))
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }))
        .catch((error) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(error) } }))
      return
    }
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].method === method) {
        this.waiters.splice(i, 1)[0].resolve(params)
        break
      }
    }
    try {
      this.onNotification?.(method, params)
    } catch {
      // Observer errors never disturb the smoke.
    }
  }

  write(msg: Json) {
    const line = JSON.stringify(msg)
    this.record.push({ ts: new Date().toISOString(), dir: 'out', line })
    this.proc.stdin!.write(`${line}\n`)
  }

  request(method: string, params: Json, ms = 30_000): Promise<Json> {
    const id = this.nextId++
    const result = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return Promise.race([result, timeout(ms, method)]).finally(() => this.pending.delete(id)) as Promise<Json>
  }

  /** Resolve on the next notification with this method (one-shot). */
  waitFor(method: string, ms: number): Promise<Json> {
    return Promise.race([
      new Promise<Json>((resolve, reject) => this.waiters.push({ method, resolve, reject })),
      timeout(ms, `notification ${method}`),
    ])
  }

  async stop() {
    SmokeClient.live.delete(this)
    // Signal the whole process group: a sandboxed app-server can leave
    // helper grandchildren that outlive the pid alone (review O5). Falls
    // back to the pid when the group is already gone.
    const signalGroup = (sig: 'SIGTERM' | 'SIGKILL') => {
      if (this.proc.pid === undefined) return
      try {
        process.kill(-this.proc.pid, sig)
      } catch {
        this.proc.kill(sig)
      }
    }
    signalGroup('SIGTERM')
    await Promise.race([this.exit, timeout(3_000, 'app-server stop (SIGTERM)')]).catch(() => {
      signalGroup('SIGKILL')
    })
    await this.exit.catch(() => {})
  }
}

/** The kawai-team namespace spec from design D6, with one trivial probe tool. */
const TEAM_TOOLS = [{
  type: 'namespace',
  name: 'kawai-team',
  description: 'Kawai team mailbox, tasks, and strategy tools (smoke: one probe tool).',
  tools: [{
    type: 'function',
    name: 'team_ping',
    description: 'Smoke probe: returns {"pong":true}. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
}]

/** Thread settings from design D5: one sandbox under both approval policies. */
function threadParams(cwd: string, gitCommonDir: string): Json {
  return {
    cwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    config: {
      // Dotted override keys, the app-server's config convention (the same
      // grammar as `codex -c` and config/value/write's keyPath).
      'sandbox_workspace_write.writable_roots': [gitCommonDir],
      'sandbox_workspace_write.network_access': true,
    },
    developerInstructions: 'You are the kawai smoke agent. Keep replies to one short line.',
    dynamicTools: TEAM_TOOLS,
  }
}

const userText = (text: string): Json => ({ type: 'text', text, text_elements: [] })

/** Resume carries the thread overrides but never dynamicTools (stored per thread). */
function resumeParams(threadId: string, cwd: string, gitCommonDir: string): Json {
  const { dynamicTools: _drop, ...rest } = threadParams(cwd, gitCommonDir) as Json & { dynamicTools?: Json }
  return { ...rest, threadId }
}

/** Run one turn: send the prompt, answer server requests per `answer`, resolve on turn/completed. */
async function runTurn(
  client: SmokeClient,
  threadId: string,
  prompt: string,
  answer: (method: string, params: Json) => unknown,
  label: string,
  ms = 180_000,
): Promise<Json> {
  client.onServerRequest = (method, params) => {
    console.log(`  [${label}] server request: ${method}`)
    return answer(method, params)
  }
  // 0.163.0 asks questions as agentMessage items (delivery "async",
  // questions[] set) and sleeps waiting for the answer; the answer is
  // turn/start input added to the active turn. The blocking
  // item/tool/requestUserInput server request never fired for it.
  client.onNotification = (method, params) => {
    if (method !== 'item/started') return
    const item = (params.item ?? {}) as Json
    if (!Array.isArray(item.questions) || item.questions.length === 0) return
    console.log(`  [${label}] async question on ${String(item.id)}: ${JSON.stringify(item.questions).slice(0, 200)}`)
    void client.request('turn/start', { threadId, input: [userText('yes')] }, 15_000).catch((error) => {
      console.log(`  [${label}] answering async question failed: ${String(error)}`)
    })
  }
  // Register both waiters before the request so a fast turn cannot slip
  // between them; turn/completed always follows turn/started.
  const startedP = client.waitFor('turn/started', ms)
  const completedP = client.waitFor('turn/completed', ms)
  const startReq = client.request('turn/start', { threadId, input: [userText(prompt)], clientUserMessageId: `smoke-${label}` }, 15_000)
  const startedParams = await startedP
  await startReq
  const turnId = String(((startedParams.turn ?? {}) as Json).id)
  const turn = (await completedP).turn as Json
  client.onServerRequest = null
  client.onNotification = null
  console.log(`  [${label}] turn ${turnId} -> ${turn.status}${turn.error ? ` error: ${JSON.stringify(turn.error)}` : ''}`)
  return { turnId, status: turn.status, error: turn.error ?? null, items: turn.items ?? [] }
}

/** Server-request answers each phase passes to runTurn. */
const answers = {
  /** Dynamic tool call: run team_ping, return the MCP-shaped result text. */
  toolCall: (_method: string, params: Json) => {
    console.log(`    dynamic tool call: ${String(params.namespace)}.${String(params.tool)} ${JSON.stringify(params.arguments)}`)
    if (params.namespace === 'kawai-team' && params.tool === 'team_ping') {
      return { success: true, contentItems: [{ type: 'inputText', text: '{"pong":true}' }] }
    }
    return { success: false, contentItems: [{ type: 'inputText', text: 'unknown smoke tool' }] }
  },
  /** Approvals: record the command, then accept or decline per phase. */
  approval(decision: 'accept' | 'decline') {
    return (_method: string, params: Json) => {
      console.log(`    approval ${decision}: ${JSON.stringify(params).slice(0, 300)}`)
      return { decision }
    }
  },
  /** requestUserInput: answer option label per question id. */
  question(answerLabel: string) {
    return (_method: string, params: Json) => {
      const questions = (params.questions ?? []) as Array<Json>
      const answerMap: Json = {}
      for (const q of questions) answerMap[String(q.id)] = { answers: [answerLabel] }
      console.log(`    user input: ${JSON.stringify(questions).slice(0, 300)} -> ${JSON.stringify(answerMap)}`)
      return { answers: answerMap }
    }
  },
}

/** The scrub rules live in src/server/chat/codex/smokeScrub.ts, shared with
 * the committed fixture's hygiene test; this script only applies them. */

function record(args: string[]): { lines: RawLine[]; resumeThreadId: string | undefined } {
  const lines: RawLine[] = []
  const threadFlag = args.indexOf('--thread')
  const resumeThreadId = threadFlag >= 0 ? args[threadFlag + 1] : undefined
  const fileFlag = args.indexOf('--record')
  const file = fileFlag >= 0 ? args[fileFlag + 1] : undefined
  if (file) {
    process.on('exit', () => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // A recording leaves the process already in fixture shape.
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(scrubRawLine(l))).join('\n') + '\n')
      console.log(`recorded ${lines.length} JSON-RPC lines -> ${file}`)
    })
  }
  return { lines, resumeThreadId }
}

/** One phase, recorded; a failure is a spike answer, not a crash. */
async function phase(name: string, summary: Record<string, Json>, run: () => Promise<Json>): Promise<Json> {
  try {
    const result = await run()
    summary[name] = result
    return result
  } catch (error) {
    summary[name] = { error: String(error) }
    console.log(`  [${name}] FAILED: ${String(error)}`)
    return { error: String(error) }
  }
}

async function main() {
  const { lines, resumeThreadId } = record(process.argv.slice(2))
  const summary: Record<string, Json> = {}
  const { dir: workspace, gitCommonDir } = makeWorkspace()
  console.log(`workspace: ${workspace}`)

  // The detached child leads its own process group, so the terminal's
  // Ctrl-C never reaches it (review N3): stop every live client's group
  // here, then exit. stop() escalates to SIGKILL and awaits the child, so
  // nothing is left behind; a second Ctrl-C finds the set empty and exits.
  process.on('SIGINT', () => {
    void Promise.allSettled([...SmokeClient.live].map((client) => client.stop()))
      .then(() => process.exit(130))
  })

  // Process 1: initialize, thread/start (or resume --thread), phases A–D.
  const first = new SmokeClient(lines)
  try {
    const init = await first.request('initialize', {
      clientInfo: CLIENT,
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    console.log(`initialize ok: ${String((init as Json).userAgent)}`)
    summary.initialize = init

    const threadId = await phase('threadStart', summary, async () => {
      const started = resumeThreadId
        ? await first.request('thread/resume', resumeParams(resumeThreadId, workspace, gitCommonDir))
        : await first.request('thread/start', threadParams(workspace, gitCommonDir))
      const thread = started.thread as Json
      console.log(`thread ${String(thread.id)} path ${String(thread.path)}`)
      return { threadId: thread.id, path: thread.path, resumed: Boolean(resumeThreadId), approvalsReviewer: started.approvalsReviewer, approvalPolicy: started.approvalPolicy, sandbox: started.sandbox, dynamicToolsStored: Boolean(started.thread) }
    })
    const tid = String((threadId as Json).threadId)

    const answerAll = (decision: 'accept' | 'decline') => (method: string, params: Json) => {
      if (method === 'item/tool/call') return answers.toolCall(method, params)
      if (method === 'item/tool/requestUserInput') return answers.question('yes')(method, params)
      return answers.approval(decision)(method, params)
    }

    if (!resumeThreadId) {
      // A: dynamic tool call + sandboxed git commit (no escalation expected;
      //    an arriving approval is itself the .git-writability answer).
      await phase('toolCallAndCommit', summary, async () => {
        const a = await runTurn(first, tid,
          "kawai smoke A: first call the kawai-team team_ping tool once. Then run `git add -A && git commit -m kawai-smoke` in the repo. Then reply with exactly: a-ok",
          answerAll('accept'), 'A')
        const committed = Bun.spawnSync(['git', '-C', workspace, 'log', '--format=%s', '-1'])
        const commitSubject = committed.stdout.toString().trim()
        console.log(`  [A] git log -1: ${commitSubject || '(no commit)'}`)
        return { turn: a, commitSubject, approvalsSeen: first.serverRequests.map((r) => r.method) }
      })
      first.serverRequests.length = 0

      // B: out-of-sandbox write declined -> the decline round-trip.
      await phase('declinedWrite', summary, async () => {
        const b = await runTurn(first, tid,
          'kawai smoke B: run `git log --oneline -1 > $HOME/kawai-smoke-outside.txt` (a file in the home directory, outside the workspace). That write will be refused; then reply with exactly: b-declined',
          answerAll('decline'), 'B')
        return { turn: b, approvalsSeen: first.serverRequests.map((r) => r.method) }
      })
      first.serverRequests.length = 0
    }

    // C: question round-trip. 0.163.0 asks as an async agentMessage question
    // (answered by runTurn's onNotification) — and the blocking
    // item/tool/requestUserInput would be answered here too if it fires.
    await phase('userInput', summary, async () => {
      const c = await runTurn(first, tid,
        "kawai smoke C: ask me one question 'Proceed?' with options yes and no using your user-input facility, and wait for my answer. After it, reply with exactly: c-answered",
        // Questions are answered 'yes' by answerAll itself; the decision here
        // only covers an approval, which this phase does not expect.
        answerAll('accept'), 'C')
      return { turn: c, requestsSeen: first.serverRequests.map((r) => r.method) }
    })
    first.serverRequests.length = 0

    // D: interrupt an in-flight turn; completion arrives as interrupted.
    await phase('interrupt', summary, async () => {
      const startedP = first.waitFor('turn/started', 60_000)
      const deltaP = first.waitFor('item/agentMessage/delta', 60_000)
      const completedP = first.waitFor('turn/completed', 120_000)
      first.request('turn/start', { threadId: tid, input: [userText('kawai smoke D: write the numbers from 1 to 300, one per line, counting carefully. Then reply with exactly: d-done')], clientUserMessageId: 'smoke-D' }, 15_000)
      const dStart = await startedP
      await deltaP // streaming under way: interrupt now
      const dTurnId = String(((dStart.turn ?? {}) as Json).id)
      let interruptError = null
      try {
        await first.request('turn/interrupt', { threadId: tid, turnId: dTurnId }, 15_000)
      } catch (error) {
        interruptError = String(error) // already finished: still a spike answer
      }
      const dTurn = (await completedP).turn as Json
      console.log(`  [D] interrupted turn ${dTurnId} -> ${String(dTurn.status)}${interruptError ? ` (interrupt: ${interruptError})` : ''}`)
      return { turnId: dTurnId, status: dTurn.status, error: dTurn.error ?? null, interruptError }
    })

    // F: localhost binding inside the sandbox (network on).
    await phase('localhostBind', summary, async () => {
      const f = await runTurn(first, tid,
        'kawai smoke F: run exactly this command and show me its output, then reply with exactly: f-done\nbun -e "const s=Bun.serve({hostname:\'127.0.0.1\',port:0,fetch:()=>new Response(\'ok\')}); const r=await fetch(s.url); console.log(\'bind\', r.status); s.stop(true)"',
        answerAll('accept'), 'F')
      const outputs = ((f.items as Array<Json>) ?? [])
        .filter((item) => item.type === 'commandExecution')
        .map((item) => String((item as Json).aggregatedOutput ?? '').slice(0, 200))
      console.log(`  [F] command outputs: ${JSON.stringify(outputs)}`)
      return { turn: f, outputs }
    })

    // Usage and rate-limit reads (no model turn).
    await phase('rateLimits', summary, async () => {
      const read = await first.request('account/rateLimits/read', {}, 10_000)
      console.log(`rate limits: ${JSON.stringify(read).slice(0, 300)}`)
      return read
    })
    await first.stop()
  } finally {
    await first.stop().catch(() => {})
  }

  // E (skippable): resume in a second process; are dynamic tools restored?
  if (!process.argv.includes('--skip-e')) {
    const second = new SmokeClient(lines)
    try {
      await second.request('initialize', { clientInfo: CLIENT, capabilities: { experimentalApi: true, requestAttestation: false } })
      await phase('resume', summary, async () => {
        const tid = String((summary.threadStart as Json).threadId)
        const resumed = await second.request('thread/resume', resumeParams(tid, workspace, gitCommonDir))
        const rThread = resumed.thread as Json
        console.log(`resumed thread ${String(rThread.id)} path ${String(rThread.path)}`)
        const e = await runTurn(second, String(rThread.id),
          'kawai smoke E: call the kawai-team team_ping tool once more, then reply with exactly: e-resumed',
          (method, params) => (method === 'item/tool/call' ? answers.toolCall(method, params) : { decision: 'accept' }), 'E')
        return { threadPath: rThread.path, turn: e, requestsSeen: second.serverRequests.map((r) => r.method) }
      })

      await phase('threadRead', summary, async () => {
        const tid = String((summary.threadStart as Json).threadId)
        const read = await second.request('thread/read', { threadId: tid, includeTurns: true }, 20_000)
        const turns = (((read as Json).thread as Json)?.turns ?? []) as Array<Json>
        const itemTypes = new Map<string, number>()
        for (const turn of turns) for (const item of (turn.items ?? []) as Array<Json>) itemTypes.set(String(item.type), (itemTypes.get(String(item.type)) ?? 0) + 1)
        console.log(`thread/read: ${turns.length} turns, items ${JSON.stringify([...itemTypes])}`)
        return { turns: turns.length, itemTypes: Object.fromEntries(itemTypes) }
      })
      await second.stop()
    } finally {
      await second.stop().catch(() => {})
    }
  }

  // Rollout dump: row payload types, one scrub-safe sample per type.
  const rolloutPath = summary.resume && !(summary.resume as Json).error
    ? String((summary.resume as Json).threadPath)
    : ''
  if (rolloutPath && fs.existsSync(rolloutPath)) {
    const rows = fs.readFileSync(rolloutPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json)
    const byType = new Map<string, Json>()
    for (const row of rows) {
      const payload = (row.payload ?? {}) as Json
      const key = `${String(row.type)}:${String(payload.type ?? payload.role ?? '')}`
      if (!byType.has(key)) byType.set(key, row)
    }
    summary.rollout = { path: '<rollout>', rows: rows.length, rowTypes: [...byType.keys()], samples: [...byType.values()] }
    console.log(`rollout: ${rows.length} rows, types ${byType.size}`)
  }
  // The summary carries rollout samples and rate-limit reads; it gets the
  // same scrub as the fixture before reaching stdout (review O4).
  console.log(`\nSUMMARY ${JSON.stringify(scrubSmokeValue(summary), null, 2)}`)
}

// Main runs only on direct execution; the hygiene test imports the scrub
// module, never this script.
if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error)
      process.exit(1)
    },
  )
}
