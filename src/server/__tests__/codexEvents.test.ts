// §5.1 (codex-chat-sessions D7): the Codex notification mapping, table-
// tested from the recorded smoke transcript (streaming, a command, a dynamic
// tool call, token usage, user-echo suppression) plus synthetic frames the
// smoke runs never produced (a two-path file change, an MCP call, a failed
// turn), and the handoff digest a forwarded Codex member carries.
//
// Since task-ce05430a R4 the mapping is the package's (codex/events.ts and
// codex/activity.ts) and these cases read it where Kawai sees it: each
// frame group is replayed inside one turn of Kawai's production Codex
// composition (createChatDriver -> codexRuntime.ts -> the package) over the
// replaying fake, its thread and turn ids rebound to that turn and every item
// id kept, and the test reads the chat events and published activity. The
// expected values are the frames' own fields and this file's literals. The
// root mapping's activity inputs are read as the activity they publish
// through the shared reducer (text -> responding, a tool call ->
// running_tools on that tool, its result -> requesting, reasoning ->
// thinking). A19: the file change's `changes` and `Changed 2 files` summary,
// the dynamic tool's content text and the MCP failure's message are the
// package's repaired outputs.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatActivity, ChatEvent, ChatUsageReport } from '../../shared/chat'
import { formatHandoffHeader, ProgressDigest } from '../team/routing/handoff'
import { Script, startHarness, THREAD_ID, until, type Harness } from './codexDriverHarness'

const TRANSCRIPT = path.resolve(import.meta.dir, '../chat/codex/__fixtures__/smoke-transcript.jsonl')
const frames = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean)
  .map(line => JSON.parse(JSON.parse(line).line) as { method?: string; params?: Record<string, unknown> })
  .filter((frame): frame is { method: string; params: Record<string, unknown> } => typeof frame.method === 'string' && !!frame.params)

/** The first recorded notification matching `method` and (optionally) its item. */
function recorded(method: string, match: (params: Record<string, unknown>) => boolean = () => true) {
  const frame = frames.find(entry => entry.method === method && match(entry.params))
  if (!frame) throw new Error(`no recorded ${method}`)
  return frame.params
}
const itemOf = (type: string, status?: string) => (params: Record<string, unknown>) => {
  const item = params.item as { type?: string; status?: string } | undefined
  return item?.type === type && (status === undefined || item.status === status)
}

let harness: Harness | null = null
afterEach(async () => {
  const done = harness?.cleanup()
  harness = null
  await done
})

type Frame = [method: string, params: Record<string, unknown>]
type Draft = Record<string, unknown> & { type: string }
interface Run {
  /** Kawai's turn id for the replayed turn. */
  turnId: string
  /** The chat events between the user's message and the turn's end, without id/sequence/at. */
  between: Draft[]
  events: Draft[]
  /** Each published activity, as phase and tool. */
  activity: Array<{ phase: string; tool?: string } | null>
  reports: ChatUsageReport[]
}

/**
 * Replay `frames` inside one Codex turn ct-1 (each rebound to THREAD_ID and
 * ct-1), then end it with `end` (default: completed). `before` turns run first.
 */
async function replay(frameList: Frame[], end: (script: Script) => Script = script => script.completed('ct-1'), before?: (script: Script) => Script): Promise<Run> {
  let script = new Script().boot()
  if (before) script = before(script)
  script.turn('ct-1')
  for (const [method, params] of frameList) script.notify(method, { ...params, threadId: THREAD_ID, turnId: 'ct-1' })
  script = end(script)
  const activity: Run['activity'] = []
  const reports: ChatUsageReport[] = []
  harness = startHarness(script, {
    onActivity: (value: ChatActivity | null) => activity.push(value ? { phase: value.phase, ...(value.tool ? { tool: value.tool } : {}) } : null),
    onRateLimit: report => reports.push(report),
  })
  const turns = before ? 2 : 1
  for (let n = 0; n < turns; n++) {
    harness.driver.send(`turn ${n}`)
    await until(() => harness!.events.filter(event => event.type === 'turn_completed').length === n + 1)
  }
  const events = harness.events
  const last = events.filter(event => event.type === 'user_message').at(-1)!
  const from = events.indexOf(last) + 1
  const to = events.findIndex((event, index) => index >= from && event.type === 'turn_completed')
  const strip = (event: ChatEvent) => {
    const { id: _id, sequence: _sequence, at: _at, ...draft } = event as ChatEvent & Record<string, unknown>
    return draft as Draft
  }
  return { turnId: (last as { turnId: string }).turnId, between: events.slice(from, to).map(strip), events: events.map(strip), activity, reports }
}

describe('recorded frames', () => {
  test('streaming: a delta writes text under the Kawai turn; the completed message is the text', async () => {
    const delta = recorded('item/agentMessage/delta')
    const completed = recorded('item/completed', itemOf('agentMessage'))
    const item = completed.item as { id: string; text: string }
    const run = await replay([['item/agentMessage/delta', delta], ['item/completed', completed]])
    expect(run.between).toEqual([
      { type: 'assistant_delta', turnId: run.turnId, messageId: delta.itemId as string, delta: delta.delta as string },
      { type: 'assistant_text', turnId: run.turnId, messageId: item.id, text: item.text },
    ])
    // The delta opened a text block.
    expect(run.activity).toEqual([{ phase: 'requesting' }, { phase: 'responding' }, null])
  })

  test('the user echo is suppressed on start and completion', async () => {
    const run = await replay([['item/started', recorded('item/started', itemOf('userMessage'))], ['item/completed', recorded('item/completed', itemOf('userMessage'))]])
    expect(run.between).toEqual([])
    // Only Kawai's own echo of the send: one user_message for the turn.
    expect(run.events.filter(event => event.type === 'user_message')).toHaveLength(1)
  })

  test('a command is a Bash tool call and its result carries the exit code', async () => {
    const started = recorded('item/started', itemOf('commandExecution'))
    const item = started.item as { id: string; command: string; cwd: string }
    const done = recorded('item/completed', itemOf('commandExecution', 'completed'))
    const failed = recorded('item/completed', itemOf('commandExecution', 'failed'))
    const run = await replay([['item/started', started], ['item/completed', done], ['item/completed', failed]])
    expect(run.between[0]).toEqual({ type: 'tool_call', turnId: run.turnId, toolCallId: item.id, tool: 'Bash', input: { command: item.command, cwd: item.cwd } })
    const result = run.between[1] as { type: string; output: string; isError?: boolean }
    expect(result.type).toBe('tool_result')
    expect(result.output).toMatch(/\(exit code 0\)$/)
    expect(result.isError).toBeUndefined()
    expect(run.between[2]).toMatchObject({ type: 'tool_result', toolCallId: item.id, isError: true })
    // The call opened running_tools on Bash; its result closed it.
    expect(run.activity.slice(0, 2)).toEqual([{ phase: 'requesting' }, { phase: 'running_tools', tool: 'Bash' }])
    expect(run.activity.at(-1)).toBeNull()
  })

  test('a dynamic tool call is mcp__<namespace>__<tool> with its content as the result', async () => {
    const started = recorded('item/started', itemOf('dynamicToolCall'))
    const done = recorded('item/completed', itemOf('dynamicToolCall', 'completed'))
    const run = await replay([['item/started', started], ['item/completed', done]])
    expect(run.between[0]).toMatchObject({ type: 'tool_call', tool: 'mcp__kawai-team__team_ping', input: {} })
    // A19 E2: the content text, not the serialized contentItems.
    expect(run.between[1]).toMatchObject({ type: 'tool_result', output: '{"pong":true}' })
  })

  test('reasoning shows Thinking; token usage is passed through; the turn boundaries are typed', async () => {
    const usage = recorded('thread/tokenUsage/updated')
    const reported: Array<{ usedTokens: number; thresholdTokens: number }> = []
    const run = await replay([['item/started', recorded('item/started', itemOf('reasoning'))], ['thread/tokenUsage/updated', usage]])
    expect(run.between).toEqual([])
    expect(run.activity).toEqual([{ phase: 'requesting' }, { phase: 'thinking' }, null])
    // The pushed reading is the driver's context usage: the last request's tokens over the window.
    const tokenUsage = usage.tokenUsage as { last: { inputTokens: number; outputTokens: number }; modelContextWindow: number }
    for (const reading of harness!.usage) if (reading) reported.push(reading)
    expect(reported.at(-1)).toMatchObject({ usedTokens: tokenUsage.last.inputTokens + tokenUsage.last.outputTokens, thresholdTokens: tokenUsage.modelContextWindow })
    // turn/started opened the Kawai turn and turn/completed ended it.
    expect(run.events.map(event => event.type)).toEqual(['turn_started', 'user_message', 'turn_completed'])
  })

  test('an async question is announced on the item start with its options', async () => {
    const asking = recorded('item/started', params => Array.isArray((params.item as { questions?: unknown }).questions))
    const run = await replay([['item/started', asking]])
    expect(run.events.filter(event => event.type === 'question_request')).toHaveLength(1)
    expect(run.events.find(event => event.type === 'question_request')).toMatchObject({
      turnId: run.turnId,
      questions: [{ question: 'Proceed?', header: '', multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] }],
    })
  })

  test('unknown notifications map to nothing', async () => {
    const run = await replay([['thread/archived', {}]])
    expect(run.between).toEqual([])
  })

  test('a rate-limits push maps to its snapshot for the driver to normalize (PR E 7.1)', async () => {
    const push = recorded('account/rateLimits/updated')
    const snapshot = push.rateLimits as { primary: { usedPercent: number } | null; secondary: { usedPercent: number } | null }
    const run = await replay([['account/rateLimits/updated', push]])
    expect(run.reports).toHaveLength(1)
    expect(run.reports[0]!.source).toBe('push')
    expect(run.reports[0]!.windows.map(window => window.percentUsed)).toEqual([snapshot.primary, snapshot.secondary].filter(Boolean).map(window => window!.usedPercent))
  })
})

const FILE_CHANGE = {
  type: 'fileChange', id: 'fc-1', status: 'completed',
  changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '' }, { path: 'src/b.ts', kind: { type: 'add' }, diff: '' }],
}

describe('synthetic frames', () => {
  test('a file change touching two paths names both in its Edit input and result', async () => {
    const run = await replay([
      ['item/started', { item: { ...FILE_CHANGE, status: 'inProgress' } }],
      ['item/completed', { item: FILE_CHANGE }],
      ['item/completed', { item: { ...FILE_CHANGE, id: 'fc-2', status: 'declined' } }],
    ])
    // A19 E1: the ordered changes beside file_path/paths, and the summary.
    expect(run.between[0]).toEqual({
      type: 'tool_call', turnId: run.turnId, toolCallId: 'fc-1', tool: 'Edit',
      input: { file_path: 'src/a.ts', paths: ['src/a.ts', 'src/b.ts'], changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] },
    })
    expect(run.between[1]).toMatchObject({ toolCallId: 'fc-1', output: 'Changed 2 files: src/a.ts, src/b.ts' })
    expect(run.between[2]).toMatchObject({ toolCallId: 'fc-2', isError: true })
  })

  test('an MCP call is mcp__<server>__<tool>; an error is the result', async () => {
    const item = { type: 'mcpToolCall', id: 'm-1', server: 'docs', tool: 'search', status: 'failed', arguments: { q: 'x' }, result: null, error: { message: 'boom' } }
    const run = await replay([['item/started', { item }], ['item/completed', { item }]])
    expect(run.between[0]).toMatchObject({ tool: 'mcp__docs__search', input: { q: 'x' } })
    // A19 E3: the error's message, not 'null'.
    expect(run.between[1]).toMatchObject({ output: 'boom', isError: true })
  })

  test('a failed turn is an error completion naming its reason; a completed one carries the final text and usage', async () => {
    const failed = await replay([], script => script.completed('ct-1', 'failed', [], { message: 'Quota exceeded', codexErrorInfo: { usageLimitExceeded: {} } }))
    const tail = failed.events.slice(failed.events.findIndex(event => event.type === 'turn_completed'))
    expect(tail).toEqual([
      { type: 'turn_completed', turnId: failed.turnId, subtype: 'error_during_execution', isError: true, terminalReason: 'usageLimitExceeded' },
      { type: 'error', message: 'Quota exceeded (usageLimitExceeded)' },
    ])
    await harness!.cleanup()
    harness = null
    // The usage between two totals: the first turn reads the earlier total, this one the later.
    const total = (value: Record<string, number>) => ({ total: value, last: value, modelContextWindow: 100_000 })
    const before = { totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }
    const after = { totalTokens: 40, inputTokens: 30, cachedInputTokens: 6, cacheWriteInputTokens: 1, outputTokens: 10, reasoningOutputTokens: 0 }
    const ok = await replay(
      [['thread/tokenUsage/updated', { tokenUsage: total(after) }]],
      script => script.completed('ct-1', 'completed', [{ type: 'agentMessage', id: 'm', text: 'all done' }]),
      script => script.turn('ct-0').notify('thread/tokenUsage/updated', { threadId: THREAD_ID, turnId: 'ct-0', tokenUsage: total(before) }).completed('ct-0'),
    )
    expect(ok.events.filter(event => event.type === 'turn_completed').at(-1)).toEqual({
      type: 'turn_completed', turnId: ok.turnId, subtype: 'success', finalText: 'all done',
      usage: { inputTokens: 18, outputTokens: 8, cacheReadTokens: 4, cacheCreationTokens: 1 },
    })
  })
})

test("a forwarded Codex member's handoff digest lists both files of a two-path change", async () => {
  // The limit outcomes record each transcript tool call into the digest.
  const run = await replay([['item/started', { item: { ...FILE_CHANGE, status: 'inProgress' } }]])
  const call = run.between[0] as { type: string; tool: string; input: unknown } | undefined
  const digest = new ProgressDigest()
  if (call?.type !== 'tool_call') throw new Error('expected a tool call')
  digest.record(call.tool, call.input)
  expect(digest.snapshot()).toEqual({ toolCalls: 1, tools: ['Edit'], filesTouched: ['src/a.ts', 'src/b.ts'] })
  const header = formatHandoffHeader({ fromSession: 'codex-dev', fromProfile: 'codex', claimCommit: null, lastError: null, progress: digest.snapshot() })
  expect(header).toContain('src/a.ts')
  expect(header).toContain('src/b.ts')
})
