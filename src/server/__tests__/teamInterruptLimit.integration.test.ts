// Real manager, driver, mailbox, dispatcher, and limit outcomes: urgent
// direct mail interrupts a busy agent and is delivered on the CLI's
// acknowledgement; the aborted turn's trailing result arrives after the
// delivery and names its own prompt, so the delivered turn ends only on its
// own result — at a final provider limit, where the message must be parked
// on its holder.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager, type ChatQueryFactory } from '../chat/ChatSessionManager'

interface FakeCli { push: (message: SDKMessage) => void; interrupts: number; prompts: SDKUserMessage[] }

function fakeQueryFactory(clis: FakeCli[]): ChatQueryFactory {
  return ({ prompt }) => {
    const queue: SDKMessage[] = []
    let wake: ((result: IteratorResult<SDKMessage>) => void) | null = null
    let ended = false
    const cli: FakeCli = { interrupts: 0, prompts: [], push: message => {
      if (wake) { const resolve = wake; wake = null; resolve({ value: message, done: false }) } else queue.push(message)
    } }
    const stream = async function* (): AsyncGenerator<SDKMessage, void> {
      while (true) {
        const next = await new Promise<IteratorResult<SDKMessage>>(resolve => {
          if (queue.length > 0) resolve({ value: queue.shift()!, done: false })
          else if (ended) resolve({ value: undefined, done: true })
          else wake = resolve
        })
        if (next.done) return
        yield next.value
      }
    }
    clis.push(cli)
    void (async () => { for await (const message of prompt) cli.prompts.push(message) })()
    return Object.assign(stream(), {
      interrupt: () => { cli.interrupts += 1; return Promise.resolve(undefined) },
      close: () => { ended = true; wake?.({ value: undefined, done: true }) },
    }) as unknown as Query
  }
}

const frame = (fields: Record<string, unknown>) => ({ uuid: 'f-uuid', session_id: 'sdk-1', ...fields }) as unknown as SDKMessage
const init = () => frame({ type: 'system', subtype: 'init' })
/** A result echoing the client uuid of the prompt it answers (none: agent-started). */
const result = (subtype: string, inputTokens: number, prompt?: SDKUserMessage) => frame({
  ...(prompt?.uuid ? { user_message_uuid: prompt.uuid, user_message_uuids: [prompt.uuid] } : {}),
  type: 'result', subtype, is_error: subtype !== 'success', num_turns: 1, total_cost_usd: 0, result: 'done',
  duration_ms: 1, duration_api_ms: 1, usage: { input_tokens: inputTokens, output_tokens: 1 }, modelUsage: {}, permission_denials: [], stop_reason: null,
})

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition')
    await Bun.sleep(5)
  }
}

let tempDir: string
let db: SessionDatabase
let manager: ChatSessionManager | null = null
const saved = { key: process.env.ANTHROPIC_API_KEY, config: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME }

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-interrupt-limit-'))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  process.env.HOME = tempDir
})

afterEach(() => {
  manager?.dispatcher.close()
  manager?.shutdown()
  manager = null
  for (const [key, value] of [['ANTHROPIC_API_KEY', saved.key], ['CLAUDE_CONFIG_DIR', saved.config], ['HOME', saved.home]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

/** A manager on fake CLIs with one session in a plain-directory team. */
async function setup() {
  const clis: FakeCli[] = []
  const project = path.join(tempDir, 'proj')
  fs.mkdirSync(project)
  manager = new ChatSessionManager({
    isDirectory: () => true, registry: new SessionRegistry(), db, onEvent: () => {},
    queryFactory: fakeQueryFactory(clis),
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
  })
  await manager.whenRestored()
  const created = manager.createSession({ projectPath: project })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id
  await waitFor(() => manager!.teams.teamOf(id) !== undefined)
  return { clis, project, id, teamId: manager.teams.teamOf(id)!.teamId }
}

/** The CLI records the delivered envelope (its `index`th prompt) in its transcript: the receipt. */
async function receipt(cli: FakeCli, index: number) {
  await waitFor(() => cli.prompts.length > index)
  const transcript = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'proj', 'sdk-1.jsonl')
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: cli.prompts[index]!.message }) + '\n')
}

/** A rejected window resetting in an hour, then the final limit error; returns the reset (epoch s). */
function finalLimit(cli: FakeCli): number {
  const resetsAt = Math.floor((Date.now() + 60 * 60_000) / 1000)
  cli.push(frame({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } }))
  cli.push(frame({ type: 'assistant', error: 'rate_limit', parent_tool_use_id: null,
    message: { id: 'msg_err', role: 'assistant', content: [{ type: 'text', text: 'API Error: 429 limit reached' }] } }))
  return resetsAt
}

test('urgent mail that interrupts a busy agent is parked when its delivered turn hits a final limit', async () => {
  const { clis, project, id, teamId } = await setup()
  // A busy turn-1.
  expect((await manager!.send(id, 'long job')).ok).toBe(true)
  clis[0]!.push(init())
  await waitFor(() => manager!.getSnapshot(id)?.status === 'working')

  const store = manager!.mailbox.store
  const mail = store.enqueue({ teamId, toKind: 'session', toId: id, fromSession: null, fromGroup: null,
    originPath: project, priority: 'urgent', body: 'Drop that and fix the build' })
  manager!.dispatcher.notify()
  await waitFor(() => clis[0]!.interrupts === 1)
  // Delivered on the acknowledgement, before the aborted turn's tail.
  await manager!.dispatcher.settled()
  expect(store.get(mail.id)).toMatchObject({ claimedBy: id })
  await receipt(clis[0]!, 1)
  // The tail names turn-1's prompt: it never completes the delivered turn.
  clis[0]!.push(result('error_during_execution', 900, clis[0]!.prompts[0]))

  // The delivered turn makes progress and fails at a final limit resetting
  // within 3h (parkIfResetWithin's default).
  clis[0]!.push(init())
  clis[0]!.push(frame({ type: 'assistant', parent_tool_use_id: null,
    message: { id: 'msg_tool', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: path.join(project, 'build.ts') } }] } }))
  clis[0]!.push(frame({ type: 'user', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }))
  const resetsAt = finalLimit(clis[0]!)
  clis[0]!.push(result('error_during_execution', 5, clis[0]!.prompts[1]))
  await waitFor(() => store.get(mail.id)?.state === 'parked')

  const parked = store.get(mail.id)!
  expect(parked.claimedBy).toBe(id)
  const resume = store.get(parked.resumeMessageId!)
  expect(resume).toMatchObject({ state: 'queued', toKind: 'session', toId: id, deliverAt: new Date(resetsAt * 1000).toISOString() })

  // Only the delivered turn's actual identity and usage are recorded; the
  // interrupted turn and its late result cannot consume that identity.
  const usage = db.db.prepare('SELECT turn_id, input_tokens FROM chat_turn_usage WHERE session_id = ? ORDER BY turn_id').all(id)
  const completed=manager!.getSnapshot(id)!.events.find(event=>event.type==='turn_completed')
  const interrupted=manager!.getSnapshot(id)!.events.find(event=>event.type==='turn_interrupted')
  expect(completed).toBeDefined()
  expect(completed!.turnId).not.toBe(interrupted?.turnId)
  expect(usage).toEqual([{ turn_id: completed!.turnId, input_tokens: 5 }])
})

test('a final limit in an agent-started turn parks the work the agent last held (limit-outcomes-agent-turns)', async () => {
  const { clis, project, id, teamId } = await setup()
  const store = manager!.mailbox.store
  const mail = store.enqueue({ teamId, toKind: 'session', toId: id, fromSession: null, fromGroup: null,
    originPath: project, body: 'Build the export and watch CI' })
  manager!.dispatcher.notify()
  await manager!.dispatcher.settled()
  await receipt(clis[0]!, 0)
  clis[0]!.push(init())
  clis[0]!.push(result('success', 3, clis[0]!.prompts[0]))
  await waitFor(() => store.get(mail.id)?.state === 'delivered' && manager!.getSnapshot(id)?.status === 'waiting')

  // A Monitor fires: the agent starts a turn itself, which ends at a final
  // limit although the CLI reports the result as success.
  clis[0]!.push(frame({ type: 'system', subtype: 'task_notification', task_id: 'mon_1', status: 'completed' }))
  clis[0]!.push(init())
  const resetsAt = finalLimit(clis[0]!)
  clis[0]!.push(result('success', 4))
  await waitFor(() => store.get(mail.id)?.state === 'parked')
  const parked = store.get(mail.id)!
  expect(parked).toMatchObject({ claimedBy: id, parkCount: 1 })
  expect(store.get(parked.resumeMessageId!)).toMatchObject({ state: 'queued', toId: id, deliverAt: new Date(resetsAt * 1000).toISOString() })
})
