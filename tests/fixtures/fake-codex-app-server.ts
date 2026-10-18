#!/usr/bin/env bun
// Fake Codex app-server (codex-chat-sessions 4.4): replays one run of the
// recorded smoke transcript over stdio, so tests exercise the real recorded
// JSON-RPC shapes without a Codex install. Spawned as `<fake> app-server`
// (the AppServerClient's argv), selected through KAWAI_CODEX_PATH like the
// real executable.
//
// FAKE_RUN=<n> picks the run (1-based; the transcript splits on each fresh
// `initialize` request; default 1). FAKE_TRANSCRIPT overrides the path.
// FAKE_EXIT_AFTER_REPLAY=1 exits 0 once the run is replayed; the default
// stays alive until stdin closes (the driver's end()).
//
// Causality: a recorded response waits until the client sent the request
// with that id; a recorded server request is emitted and then waits for the
// client's reply with that id; notifications emit in order. A client request
// whose method does not match the run's recorded sequence fails loudly
// (exit 2), so a replay drift is a test failure, not a silent mismatch.
import { fileURLToPath } from 'node:url'

if (!process.argv.includes('app-server')) {
  console.error('fake-codex-app-server must be spawned as `<fake> app-server`')
  process.exit(2)
}

const runNumber = Number(process.env.FAKE_RUN ?? '1')
const defaultTranscript = fileURLToPath(
  new URL('../../src/server/chat/codex/__fixtures__/smoke-transcript.jsonl', import.meta.url),
)
const transcriptPath = process.env.FAKE_TRANSCRIPT ?? defaultTranscript

interface Record {
  dir: 'out' | 'in'
  line: string
}
interface Message {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

const records: Record[] = (await Bun.file(transcriptPath).text())
  .split('\n')
  .filter(line => line.trim())
  .map(line => JSON.parse(line) as Record)

// Split into runs at each fresh `initialize` the recorded client sent.
const runs: Array<Record[]> = []
for (const record of records) {
  const message = JSON.parse(record.line) as Message
  if (record.dir === 'out' && message.method === 'initialize') runs.push([])
  runs.at(-1)!.push(record)
}
const run = runs[runNumber - 1]
if (!run) {
  console.error(`FAKE_RUN=${runNumber} but the transcript has ${runs.length} runs`)
  process.exit(2)
}

const steps = run.map(record => ({ dir: record.dir, message: JSON.parse(record.line) as Message }))
// Only the recorded client REQUESTS (method-bearing): the run's replies to
// server requests cross stdin without a method and are matched by id.
const expectedOut = steps
  .filter(step => step.dir === 'out' && step.message.method !== undefined)
  .map(step => String(step.message.method))
const sentRequests = new Set<unknown>()
const replies = new Map<unknown, unknown>()
const waiters: Array<{ ready: () => boolean; resume: () => void }> = []
const checkWaiters = () => {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i]!.ready()) {
      waiters[i]!.resume()
      waiters.splice(i, 1)
    }
  }
}
const waitFor = async (ready: () => boolean) => {
  if (ready()) return
  await new Promise<void>(resolve => waiters.push({ ready, resume: resolve }))
}

const emit = (message: Message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const onClientLine = (line: string) => {
  if (!line.trim()) return
  const message = JSON.parse(line) as Message
  if (message.method !== undefined) {
    const expected = expectedOut.shift()
    if (expected !== message.method) {
      console.error(`fake-codex-app-server: expected client ${expected ?? '<end of run>'}, got ${String(message.method)}`)
      process.exit(2)
    }
    if (message.id !== undefined) sentRequests.add(message.id)
  } else if (message.id !== undefined) {
    // A reply to a recorded server request; the waiting step consumes it.
    replies.set(message.id, message)
  }
  checkWaiters()
}

;(async () => {
  for (const step of steps) {
    if (step.dir !== 'in') continue
    const message = step.message
    if (message.method !== undefined && message.id !== undefined) {
      emit(message) // server request: the client's reply continues the run
      await waitFor(() => replies.has(message.id))
    } else if (message.method !== undefined) {
      emit(message) // notification, in order
    } else {
      await waitFor(() => sentRequests.has(message.id)) // a response follows its request
      emit(message)
    }
  }
  if (process.env.FAKE_EXIT_AFTER_REPLAY === '1') process.exit(0)
})()

let buffered = ''
;(async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buffered += new TextDecoder().decode(chunk)
    let index
    while ((index = buffered.indexOf('\n')) !== -1) {
      onClientLine(buffered.slice(0, index))
      buffered = buffered.slice(index + 1)
    }
  }
  process.exit(0) // stdin closed: the client ended the child
})()
