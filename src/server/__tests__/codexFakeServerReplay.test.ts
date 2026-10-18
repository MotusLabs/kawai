// §4.4 (codex-chat-sessions): the fake app-server replays every recorded
// smoke run through the real client, spawned through KAWAI_CODEX_PATH like
// the host executable. The driver replays each run's recorded requests
// verbatim and answers recorded server requests with their recorded replies,
// so a replay that drifts from the transcript fails loudly (the fake exits 2
// on an unexpected client method).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppServerClient } from '../chat/codex/appServerClient'
import { resetCodexExecutableCache, resolveCodexExecutable } from '../chat/codex/codexExecutable'

const TRANSCRIPT = path.resolve(import.meta.dir, '../chat/codex/__fixtures__/smoke-transcript.jsonl')
const FAKE = path.resolve(import.meta.dir, '../../../tests/fixtures/fake-codex-app-server.ts')

interface TranscriptRecord { dir: 'out' | 'in'; line: string }
interface Message {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

interface Run {
  requests: Array<{ method: string; params: Record<string, unknown> }>
  /** Recorded replies to server requests, in server-request order. */
  replies: Array<{ id: unknown; result?: unknown; error?: unknown }>
  /** Recorded inbound server requests, in order. */
  serverRequests: Array<{ id: unknown; method: string; params: Record<string, unknown> }>
  /** Recorded notifications (id-less inbound messages). */
  expectedNotifications: number
}

const parseRuns = (): Run[] => {
  const records = fs.readFileSync(TRANSCRIPT, 'utf8')
    .split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as TranscriptRecord)
  const runs: Run[] = []
  for (const record of records) {
    const message = JSON.parse(record.line) as Message
    if (record.dir === 'out' && message.method === 'initialize') {
      runs.push({ requests: [], replies: [], serverRequests: [], expectedNotifications: 0 })
    }
    const run = runs.at(-1)!
    if (record.dir === 'out') {
      if (message.method !== undefined) {
        run.requests.push({ method: String(message.method), params: message.params ?? {} })
      } else {
        // A recorded client reply to a server request.
        run.replies.push({ id: message.id, result: message.result, error: message.error })
      }
    } else if (message.method !== undefined && message.id !== undefined) {
      run.serverRequests.push({ id: message.id, method: String(message.method), params: message.params ?? {} })
    } else if (message.method !== undefined) {
      run.expectedNotifications += 1
    }
  }
  return runs
}

let runs: Run[]
let tempDir: string

beforeEach(() => {
  runs = parseRuns()
  expect(runs.length).toBeGreaterThanOrEqual(3)
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-replay-')))
  // The executable gate caches by path+realpath+\":\"+mtime; the fake is
  // static, but reset anyway so each test probes it fresh.
  resetCodexExecutableCache()
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
  resetCodexExecutableCache()
})

/** Poll until the predicate holds, for cross-process stream settling. */
const until = async (predicate: () => boolean, ms = 2_000): Promise<boolean> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) return false
    await Bun.sleep(10)
  }
  return true
}

/** Replay one recorded run through a fresh client, like one smoke process. */
const replayRun = async (index: number) => {
  const run = runs[index - 1]!
  // Selection through KAWAI_CODEX_PATH (task 4.4): the same resolution the
  // gates use picks the fake, and the client spawns `<fake> app-server`.
  const executable = resolveCodexExecutable({ KAWAI_CODEX_PATH: FAKE, PATH: process.env.PATH })
  if (!executable) throw new Error('the fake was not resolved through KAWAI_CODEX_PATH')
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const answered: string[] = []
  const results: unknown[] = []
  let replyIndex = 0
  const client = new AppServerClient({
    executable,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      FAKE_RUN: String(index),
      FAKE_EXIT_AFTER_REPLAY: '1',
    },
    wire: { record: () => {} },
    onNotification: (method, params) => notifications.push({ method, params }),
    onServerRequest: async (method) => {
      answered.push(method)
      const recorded = run.replies[replyIndex++]
      if (!recorded) throw new Error(`no recorded reply for server request ${replyIndex - 1}`)
      if (recorded.error !== undefined) throw new Error(JSON.stringify(recorded.error))
      return recorded.result
    },
    onExit: () => {},
  })
  client.start()
  try {
    for (const request of run.requests) {
      results.push(await client.request(request.method, request.params))
    }
    await client.whenExited()
    // 'exit' can precede the final stdout flush: the replay is done only
    // when every recorded notification has been routed, not merely when the
    // process is gone.
    if (!(await until(() => notifications.length >= run.expectedNotifications, 2_000))) {
      throw new Error(`run ${index}: ${notifications.length} of ${run.expectedNotifications} notifications routed`)
    }
  } finally {
    client.end()
  }
  return { run, notifications, answered, results, client }
}


test('every recorded run replays through the client spawned via KAWAI_CODEX_PATH', async () => {
  for (let index = 1; index <= runs.length; index++) {
    const { run, notifications, answered, client } = await replayRun(index)
    // A clean exit 0 means the whole recorded request sequence matched —
    // the fake exits 2 on an unexpected client method.
    expect(client.exit).toEqual({ code: 0, signal: null })
    expect(answered).toEqual(run.serverRequests.map(request => request.method))
    expect(notifications).toHaveLength(run.expectedNotifications)
  }
})

test('the replay carries the recorded shapes: thread ids, tool calls, approvals, questions', async () => {
  const replays: Array<Awaited<ReturnType<typeof replayRun>>> = []
  for (let index = 1; index <= runs.length; index++) replays.push(await replayRun(index))
  const answered = replays.flatMap(replay => replay.answered)
  // The dynamic tool call and the approval round-trip both reached the
  // client's server-request handler.
  expect(answered).toContain('item/tool/call')
  expect(answered).toContain('item/commandExecution/requestApproval')
  // An async question arrived as an agentMessage item carrying questions.
  const question = replays
    .flatMap(replay => replay.notifications)
    .find(notification => {
      const item = notification.params.item as { questions?: unknown[]; delivery?: string } | undefined
      return Array.isArray(item?.questions) && item!.questions!.length > 0
    })
  expect(question).toBeDefined()
  // The fresh thread and the resumed threads all resolved with recorded ids.
  expect((replays[0]!.results[1] as { thread?: { id?: string } }).thread?.id).toBeString()
  expect((replays[1]!.results[1] as { thread?: { id?: string } }).thread?.id).toBeString()
}, 20_000)
