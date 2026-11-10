// @reads: packages/agent-runtime/__tests__/fixtures/**
// Claude usage, quota and limit-wait facts through the public factory, the
// real SDK and the owned fake CLI process (tasks 5.2/5.3). The fake's
// `script` prompt streams exactly the frames a test names, then a result with
// the named usage, so every expected value comes from the frames the test
// wrote, not from the implementation.
// - A turn's tokens are its own result's; tool calls and compaction
//   boundaries count once per id; the provider cost is the sum of the turn's
//   message_delta costs; turn_completed carries the same values.
// - M-count: the next turn whose result reports no usage has usage null and
//   no cost, never the previous turn's.
// - A retried limit starts one wait for the turn; it ends resumed at the
//   turn's next request frame, and the rejected rate_limit_event's reset and
//   window ride on both. The push is a session-scoped quota report.
import { afterEach, describe, expect, test } from 'bun:test'
import { createClaudeDriver } from '../src/claude/index.js'
import type { ClaudeAgentDriver, TurnResult } from '../src/contract.js'
import type { AgentEvent } from '../src/events.js'
import type { ClaudeDriverOptions } from '../src/options.js'
import type { ContextUsage, LimitEvent, QuotaReport } from '../src/usage/types.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const silent = () => {}
const logger = { debug: silent, info: silent, warn: silent, error: silent }
let driver: ClaudeAgentDriver | null = null
afterEach(async () => {
  await driver?.kill().catch(() => {})
  driver = null
})

interface Seen {
  events: AgentEvent[]
  results: TurnResult[]
  limits: LimitEvent[]
  quotas: QuotaReport[]
  contexts: Array<ContextUsage | null>
  compactions: string[]
}

function claude(extra: Partial<ClaudeDriverOptions> = {}, env: Record<string, string> = {}): { d: ClaudeAgentDriver; seen: Seen } {
  const seen: Seen = { events: [], results: [], limits: [], quotas: [], contexts: [], compactions: [] }
  const d = createClaudeDriver({
    launch: fakeClaudeHome().launch(env),
    logger,
    permissions: { mode: 'default', enabledTools: ['Read'], disallowedTools: [] },
    callbacks: {
      onEvent: (e) => seen.events.push(e),
      onTurnResult: (r) => seen.results.push(r),
      onLimitEvent: (e) => seen.limits.push(e),
      onQuotaReport: (r) => seen.quotas.push(r),
      onContextUsage: (u) => seen.contexts.push(u),
      onCompaction: (c) => seen.compactions.push(c.boundaryId),
    },
    ...extra,
  })
  driver = d
  return { d, seen }
}

const script = (body: { frames: Array<Record<string, unknown>>; usage?: Record<string, number> | null; subtype?: string }) => `script ${JSON.stringify(body)}`
const resetSeconds = Math.floor(Date.now() / 1000) + 3600
const RESET = new Date(resetSeconds * 1000).toISOString()

const assistant = (id: string, blocks: Array<Record<string, unknown>>) => ({ type: 'assistant', uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: 'fake-model', content: blocks } })
const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', uuid: crypto.randomUUID(), parent_tool_use_id: null, event })
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } })

describe('Claude usage facts through the public driver and the fake CLI', () => {
  test('a turn reports its own tokens, distinct tool and compaction counts and summed cost; the next turn borrows nothing', async () => {
    const { d, seen } = claude()
    await d.start()
    const first = await d.send(script({
      frames: [
        stream({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 1 } } }),
        stream({ type: 'message_delta', usage: { output_tokens: 20, cost: 0.25 } }),
        assistant('m1', [toolUse('tool-a'), toolUse('tool-a'), toolUse('tool-b')]),
        { type: 'system', subtype: 'compact_boundary', uuid: 'boundary-1', compact_metadata: { trigger: 'auto', pre_tokens: 900, post_tokens: 300 } },
        { type: 'system', subtype: 'compact_boundary', uuid: 'boundary-1', compact_metadata: { trigger: 'auto', pre_tokens: 900, post_tokens: 300 } },
        stream({ type: 'message_delta', usage: { output_tokens: 30, cost: 0.5 } }),
      ],
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    }))
    const result = await first.result
    expect(result).toMatchObject({ outcome: 'success', model: 'fake-model', toolCallCount: 2, compactionCount: 1 })
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 1 })
    const completed = seen.events.find((e) => e.type === 'turn_completed' && e.turnId === first.turnId)
    expect(completed).toMatchObject({ usage: result.usage, providerCostUsd: 0.75 })
    expect(seen.compactions).toEqual(['boundary-1'])

    // M-count: a result without usage, no cost and no tools reports none of the first turn's.
    const second = await d.send(script({ frames: [], usage: null }))
    const next = await second.result
    expect(next).toMatchObject({ outcome: 'success', usage: null, toolCallCount: 0, compactionCount: 0 })
    expect(seen.events.find((e) => e.type === 'turn_completed' && e.turnId === second.turnId)).toMatchObject({ usage: null, providerCostUsd: null })
    expect(seen.results.map((r) => r.turnId)).toEqual([first.turnId, second.turnId])
  })

  test('a retried limit opens one wait that ends resumed at the next request frame; the rejected push names its reset and window', async () => {
    const { d, seen } = claude()
    await d.start()
    const handle = await d.send(script({
      frames: [
        { type: 'rate_limit_event', uuid: crypto.randomUUID(), rate_limit_info: { status: 'rejected', resetsAt: resetSeconds, rateLimitType: 'five_hour', utilization: 1 } },
        { type: 'system', subtype: 'api_retry', uuid: crypto.randomUUID(), attempt: 1, max_retries: 5, retry_delay_ms: 10, error_status: 429, error: 'rate_limit' },
        { type: 'system', subtype: 'api_retry', uuid: crypto.randomUUID(), attempt: 2, max_retries: 5, retry_delay_ms: 10, error_status: 429, error: 'rate_limit' },
        stream({ type: 'message_start', message: { id: 'm2', usage: { input_tokens: 5 } } }),
      ],
    }))
    await handle.result
    const [failure1, start, failure2, end, ...rest] = seen.limits
    expect(rest).toEqual([])
    expect(failure1).toEqual({ type: 'failure', kind: 'rate_limit', final: false, status: 429, message: null, resetsAt: RESET, window: 'five_hour' })
    expect(start).toMatchObject({ type: 'wait-start', turnId: handle.turnId, window: 'five_hour', resetsAt: RESET })
    expect(failure2).toEqual(failure1)
    expect(end).toEqual({ type: 'wait-end', waitId: (start as { waitId: string }).waitId, cause: 'resumed' })
    expect(seen.quotas).toEqual([expect.objectContaining({ status: 'limited', source: 'push', accountScope: 'session' })])
    expect(seen.quotas[0]!.windows).toEqual([{ key: 'five_hour', label: '5-hour window', percentUsed: 100, resetsAt: RESET, periodMs: 5 * 60 * 60 * 1000 }])
  })

  test('a failed result ends the wait resumed only when a request frame was observed after the retry, else cancelled', async () => {
    const { d, seen } = claude()
    await d.start()
    const retry = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, retry_delay_ms: 10, error_status: 429, error: 'rate_limit' }
    const failedQuiet = await d.send(script({ frames: [{ ...retry, uuid: crypto.randomUUID() }], subtype: 'error_during_execution' }))
    await failedQuiet.result
    const failedResumed = await d.send(script({
      frames: [{ ...retry, uuid: crypto.randomUUID() }, stream({ type: 'message_start', message: { id: 'm3', usage: { input_tokens: 5 } } })],
      subtype: 'error_during_execution',
    }))
    await failedResumed.result
    const waits = seen.limits.filter((e) => e.type !== 'failure')
    expect(waits.map((e) => [e.type, e.type === 'wait-start' ? e.turnId : e.cause])).toEqual([
      ['wait-start', failedQuiet.turnId], ['wait-end', 'cancelled'],
      ['wait-start', failedResumed.turnId], ['wait-end', 'resumed'],
    ])
  })
})
