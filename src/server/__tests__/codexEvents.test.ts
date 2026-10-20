// §5.1 (codex-chat-sessions D7): the pure Codex notification mapping, table-
// tested from the recorded smoke transcript (streaming, a command, a dynamic
// tool call, token usage, user-echo suppression) plus synthetic frames the
// smoke runs never produced (a two-path file change, an MCP call, a failed
// turn), and the handoff digest a forwarded Codex member carries.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { mapCodexNotification, turnCompletedDrafts, turnUsageBetween, type CodexOutput } from '../chat/codex/codexEvents'
import type { Turn } from '../chat/codex/protocol/v2/Turn'
import { formatHandoffHeader, ProgressDigest } from '../team/routing/handoff'

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
const map = (method: string, params: Record<string, unknown>): CodexOutput[] => mapCodexNotification(method, params, 'turn-k')
const drafts = (outputs: CodexOutput[]) => outputs.flatMap(output => (output.kind === 'event' ? [output.draft] : []))
const activities = (outputs: CodexOutput[]) => outputs.flatMap(output => (output.kind === 'activity' ? [output.input] : []))

describe('recorded frames', () => {
  test('streaming: a delta writes text under the Kawai turn; the completed message is the text', () => {
    const delta = recorded('item/agentMessage/delta')
    const out = map('item/agentMessage/delta', delta)
    expect(activities(out)).toEqual([{ type: 'block_start', blockType: 'text' }])
    expect(drafts(out)).toEqual([{ type: 'assistant_delta', turnId: 'turn-k', messageId: delta.itemId as string, delta: delta.delta as string }])
    const completed = recorded('item/completed', itemOf('agentMessage'))
    const item = completed.item as { id: string; text: string }
    expect(drafts(map('item/completed', completed))).toEqual([{ type: 'assistant_text', turnId: 'turn-k', messageId: item.id, text: item.text }])
  })

  test('the user echo is suppressed on start and completion', () => {
    expect(map('item/started', recorded('item/started', itemOf('userMessage')))).toEqual([])
    expect(map('item/completed', recorded('item/completed', itemOf('userMessage')))).toEqual([])
  })

  test('a command is a Bash tool call and its result carries the exit code', () => {
    const started = recorded('item/started', itemOf('commandExecution'))
    const item = started.item as { id: string; command: string; cwd: string }
    const out = map('item/started', started)
    expect(drafts(out)).toEqual([{ type: 'tool_call', turnId: 'turn-k', toolCallId: item.id, tool: 'Bash', input: { command: item.command, cwd: item.cwd } }])
    expect(activities(out)).toEqual([{ type: 'tool_call', toolCallId: item.id, tool: 'Bash' }])
    const done = recorded('item/completed', itemOf('commandExecution', 'completed'))
    const result = drafts(map('item/completed', done))[0] as { type: string; output: string; isError?: boolean }
    expect(result.type).toBe('tool_result')
    expect(result.output).toMatch(/\(exit code 0\)$/)
    expect(result.isError).toBeUndefined()
    const failed = recorded('item/completed', itemOf('commandExecution', 'failed'))
    expect(drafts(map('item/completed', failed))[0]).toMatchObject({ type: 'tool_result', isError: true })
  })

  test('a dynamic tool call is mcp__<namespace>__<tool> with its content as the result', () => {
    const started = recorded('item/started', itemOf('dynamicToolCall'))
    expect(drafts(map('item/started', started))[0]).toMatchObject({ type: 'tool_call', tool: 'mcp__kawai-team__team_ping', input: {} })
    const done = recorded('item/completed', itemOf('dynamicToolCall', 'completed'))
    expect(drafts(map('item/completed', done))[0]).toMatchObject({ type: 'tool_result', output: '{"pong":true}' })
  })

  test('reasoning shows Thinking; token usage is passed through; the turn boundaries are typed', () => {
    expect(map('item/started', recorded('item/started', itemOf('reasoning')))).toEqual([{ kind: 'activity', input: { type: 'block_start', blockType: 'thinking' } }])
    const usage = recorded('thread/tokenUsage/updated')
    expect(map('thread/tokenUsage/updated', usage)).toEqual([{ kind: 'token_usage', usage: usage.tokenUsage as never }])
    const started = recorded('turn/started')
    expect(map('turn/started', started)).toEqual([{ kind: 'turn_started', codexTurnId: (started.turn as { id: string }).id }])
    const completed = recorded('turn/completed')
    expect(map('turn/completed', completed)).toEqual([{ kind: 'turn_completed', turn: completed.turn as Turn }])
  })

  test('an async question is announced on the item start with its options', () => {
    const asking = recorded('item/started', params => Array.isArray((params.item as { questions?: unknown }).questions))
    expect(map('item/started', asking)).toEqual([{
      kind: 'question', itemId: (asking.item as { id: string }).id,
      questions: [{ question: 'Proceed?', header: '', multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] }],
    }])
  })

  test('unknown notifications map to nothing', () => {
    expect(map('account/rateLimits/updated', recorded('account/rateLimits/updated'))).toEqual([])
  })
})

const FILE_CHANGE = {
  type: 'fileChange', id: 'fc-1', status: 'completed',
  changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '' }, { path: 'src/b.ts', kind: { type: 'add' }, diff: '' }],
}

describe('synthetic frames', () => {
  test('a file change touching two paths names both in its Edit input and result', () => {
    const [call] = drafts(map('item/started', { item: { ...FILE_CHANGE, status: 'inProgress' } }))
    expect(call).toEqual({
      type: 'tool_call', turnId: 'turn-k', toolCallId: 'fc-1', tool: 'Edit',
      input: { file_path: 'src/a.ts', paths: ['src/a.ts', 'src/b.ts'], changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] },
    })
    expect(drafts(map('item/completed', { item: FILE_CHANGE }))[0]).toMatchObject({ output: 'Changed 2 files: src/a.ts, src/b.ts' })
    expect(drafts(map('item/completed', { item: { ...FILE_CHANGE, status: 'declined' } }))[0]).toMatchObject({ isError: true })
  })

  test('an MCP call is mcp__<server>__<tool>; an error is the result', () => {
    const item = { type: 'mcpToolCall', id: 'm-1', server: 'docs', tool: 'search', status: 'failed', arguments: { q: 'x' }, result: null, error: { message: 'boom' } }
    expect(drafts(map('item/started', { item }))[0]).toMatchObject({ tool: 'mcp__docs__search', input: { q: 'x' } })
    expect(drafts(map('item/completed', { item }))[0]).toMatchObject({ output: 'boom', isError: true })
  })

  test('a failed turn is an error completion naming its reason; a completed one carries the final text and usage', () => {
    const failed = { id: 't', status: 'failed', items: [], error: { message: 'Quota exceeded', codexErrorInfo: { usageLimitExceeded: {} } } } as unknown as Turn
    expect(turnCompletedDrafts(failed, 'turn-k')).toEqual([
      { type: 'turn_completed', turnId: 'turn-k', subtype: 'error_during_execution', isError: true, terminalReason: 'usageLimitExceeded' },
      { type: 'error', message: 'Quota exceeded (usageLimitExceeded)' },
    ])
    const ok = { id: 't', status: 'completed', items: [{ type: 'agentMessage', id: 'm', text: 'all done' }], error: null } as unknown as Turn
    const usage = turnUsageBetween(
      { totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      { totalTokens: 40, inputTokens: 30, cachedInputTokens: 6, cacheWriteInputTokens: 1, outputTokens: 10, reasoningOutputTokens: 0 },
    )
    expect(turnCompletedDrafts(ok, 'turn-k', usage)).toEqual([{
      type: 'turn_completed', turnId: 'turn-k', subtype: 'success', finalText: 'all done',
      usage: { inputTokens: 18, outputTokens: 8, cacheReadTokens: 4, cacheCreationTokens: 1 },
    }])
  })
})

test("a forwarded Codex member's handoff digest lists both files of a two-path change", () => {
  // The limit outcomes record each transcript tool call into the digest.
  const [call] = drafts(map('item/started', { item: { ...FILE_CHANGE, status: 'inProgress' } }))
  const digest = new ProgressDigest()
  if (call?.type !== 'tool_call') throw new Error('expected a tool call')
  digest.record(call.tool, call.input)
  expect(digest.snapshot()).toEqual({ toolCalls: 1, tools: ['Edit'], filesTouched: ['src/a.ts', 'src/b.ts'] })
  const header = formatHandoffHeader({ fromSession: 'codex-dev', fromProfile: 'codex', claimCommit: null, lastError: null, progress: digest.snapshot() })
  expect(header).toContain('src/a.ts')
  expect(header).toContain('src/b.ts')
})
