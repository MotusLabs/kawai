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
// - F3: a turn whose result carries no usage (an interrupt, an exit, a
//   failure without usage) reports its own bound main-thread requests'
//   observed tokens, each request once by message id, never a subagent's or
//   an earlier turn's; an unreported field is null; a result with usage is the
//   aggregate. The tokens are on the turn before a reentrant stop can end it.
//   A request keeps the turn of its first sighting by native id: replayed
//   after the next turn's own request (snapshot, message_start, a delta, a
//   conversation reset between), it adds nothing to that next turn.
// - F4: quotaSource unset or 'none' asks no usage pull; 'host-login' asks
//   exactly one, answered from the supplied home, reported host-login-pull
//   with account scope host-login.
// - A retried limit starts one wait for the turn; it ends resumed at the
//   turn's next request frame, and the rejected rate_limit_event's reset and
//   window ride on both. The push is a session-scoped quota report.
// - Reentrancy (lead path review PC1/PC2 on fbd90661): an observer that
//   interrupts from the result's own context observation cannot replace the
//   decided success; one that interrupts from a retry's failure leaves no
//   orphan wait: the wait it ends was registered first and its end follows
//   its start.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

  test('PC1: an interrupt from the result frame\'s own context observation cannot replace the decided success', async () => {
    let interrupted = false
    const { d } = claude({
      callbacks: {
        onEvent: () => {},
        onContextUsage: (usage) => {
          if (usage && !interrupted) {
            interrupted = true
            void driver!.interrupt().catch(() => {})
          }
        },
      },
    })
    await d.start()
    const messageUuid = crypto.randomUUID()
    const handle = await d.send(script({
      frames: [
        stream({ type: 'message_start', message: { id: 'message-1', usage: { input_tokens: 100 } } }),
        { type: 'result', subtype: 'success', uuid: crypto.randomUUID(), user_message_uuid: messageUuid, user_message_uuids: [messageUuid], is_error: false, result: 'provider success', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { fake: { contextWindow: 1000 } } },
      ],
    }), { messageUuid })
    const result = await handle.result
    expect(interrupted).toBe(true)
    expect(result).toMatchObject({ outcome: 'success', usage: { inputTokens: 10, outputTokens: 5 } })
  })

  test('PC2: an interrupt from a retry failure observer ends the registered wait once, after its start', async () => {
    let interrupted = false
    const limits: LimitEvent[] = []
    const { d } = claude({
      callbacks: {
        onEvent: () => {},
        onLimitEvent: (event) => {
          limits.push(event)
          if (event.type === 'failure' && !interrupted) {
            interrupted = true
            void driver!.interrupt().catch(() => {})
          }
        },
      },
    })
    await d.start()
    const handle = await d.send(script({ frames: [{ type: 'system', subtype: 'api_retry', uuid: crypto.randomUUID(), attempt: 1, max_retries: 5, retry_delay_ms: 10, error_status: 429, error: 'rate_limit' }] }))
    expect((await handle.result).outcome).toBe('interrupted')
    // Before any stop (whose endAll would end an orphan too): the turn's own end closed its wait.
    await Bun.sleep(30)
    const settled = [...limits]
    await d.shutdown()
    expect(settled.map((e) => e.type)).toEqual(['failure', 'wait-start', 'wait-end'])
    expect(settled[2]).toEqual({ type: 'wait-end', waitId: (settled[1] as { waitId: string }).waitId, cause: 'cancelled' })
    expect(limits).toEqual(settled)
  })
})

// Review F3/A2: a turn whose result carries no tokens keeps its own bound main-thread requests' observed tokens.
describe('Claude partial turn usage through the public driver and the fake CLI', () => {
  const main = { input_tokens: 123, output_tokens: 0, cache_read_input_tokens: 8, cache_creation_input_tokens: 4 }
  const sub = (event: Record<string, unknown>) => ({ ...stream(event), parent_tool_use_id: 'toolu_parent' })
  // One request seen three times (start, delta, its assistant frame) plus a subagent's request: counted once, the subagent's never.
  const frames = [
    stream({ type: 'message_start', message: { id: 'pm', usage: main } }),
    sub({ type: 'message_start', message: { id: 'sub-m', usage: { input_tokens: 999, output_tokens: 999 } } }),
    stream({ type: 'message_delta', usage: { output_tokens: 17, cost: 0.25 } }),
    stream({ type: 'message_start', message: { id: 'pm', usage: main } }),
    { ...assistant('pm', [{ type: 'text', text: 'partial' }]), message: { id: 'pm', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'partial' }], usage: { ...main, output_tokens: 17 } } },
  ]
  const partial = { inputTokens: 123, outputTokens: 17, cacheReadTokens: 8, cacheCreationTokens: 4 }

  test('an interrupted turn reports the tokens its requests reported before the interrupt, once each, and no final text', async () => {
    const { d, seen } = claude({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000' })
    await d.start()
    // The previous turn's aggregate is its own: the held turn borrows none of it.
    await (await d.send(script({ frames: [], usage: { input_tokens: 5, output_tokens: 5 } }))).result
    const handle = await d.send(`script ${JSON.stringify({ frames, hold: true })}`)
    await waitUntil(() => seen.contexts.some((u) => (u?.usedTokens ?? 0) >= 152))
    await d.interrupt()
    const result = await handle.result
    expect(result).toMatchObject({ outcome: 'interrupted', finalText: null })
    expect(result.usage).toEqual(partial)
  })

  test('a turn whose process ends reports its requests\' observed tokens', async () => {
    const { d, seen } = claude({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000' })
    await d.start()
    const handle = await d.send(`script ${JSON.stringify({ frames, exit: 3 })}`)
    const result = await handle.result
    expect(result.outcome).toBe('process-ended')
    expect(result.usage).toEqual(partial)
    expect(seen.events.find((e) => e.type === 'turn_completed' && e.turnId === handle.turnId)).toMatchObject({ usage: partial })
  })

  test('a failed result without usage keeps the observed tokens; a result with usage is the aggregate, never added to them', async () => {
    const { d, seen } = claude()
    await d.start()
    const failed = await (await d.send(script({ frames, usage: null, subtype: 'error_during_execution' }))).result
    expect(failed).toMatchObject({ outcome: 'failed', finalText: null, usage: partial })
    const aggregate = await (await d.send(script({ frames: frames.map((f) => JSON.parse(JSON.stringify(f).replaceAll('"pm"', '"pm2"'))), usage: { input_tokens: 500, output_tokens: 60, cache_read_input_tokens: 9, cache_creation_input_tokens: 3 } }))).result
    expect(aggregate.usage).toEqual({ inputTokens: 500, outputTokens: 60, cacheReadTokens: 9, cacheCreationTokens: 3 })
    // A field no frame reported stays null: never a fabricated zero.
    const sparse = await (await d.send(script({ frames: [stream({ type: 'message_start', message: { id: 'pm3', usage: { input_tokens: 11 } } })], usage: null, subtype: 'error_during_execution' }))).result
    expect(sparse.usage).toEqual({ inputTokens: 11, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null })
    expect(seen.results.map((r) => r.outcome)).toEqual(['failed', 'success', 'failed'])
  })

  test('a late message_delta of the earlier turn\'s request adds nothing to the next turn: its usage stays null', async () => {
    const { d } = claude()
    await d.start()
    const first = await (await d.send(script({ frames: frames.slice(0, 1), usage: null }))).result
    expect(first.usage).toEqual({ inputTokens: 123, outputTokens: 0, cacheReadTokens: 8, cacheCreationTokens: 4 })
    const next = await (await d.send(script({ frames: [stream({ type: 'message_delta', usage: { output_tokens: 99 } })], usage: null }))).result
    expect(next.usage).toBeNull()
  })

  test('a stop reentered from the first request\'s own context observation keeps the tokens that request already reported', async () => {
    let stop: (() => void) | null = null
    const { d } = claude({
      callbacks: {
        onEvent: () => {},
        onContextUsage: (u) => {
          if (stop && (u?.usedTokens ?? 0) >= 135) {
            const once = stop
            stop = null
            once()
          }
        },
      },
    }, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000' })
    await d.start()
    stop = () => void d.kill().catch(() => {})
    const handle = await d.send(`script ${JSON.stringify({ frames: frames.slice(0, 1), hold: true })}`)
    const result = await handle.result
    expect(stop).toBeNull()
    expect(result.outcome).toBe('interrupted')
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 0, cacheReadTokens: 8, cacheCreationTokens: 4 })
  })
})

// Review F3 (findings-55a68ce4, creator note-229f71ee): a request keeps its first owner by native id across intervening requests and turns.
describe('Claude request ownership by native request id through the public driver and the fake CLI', () => {
  const old = { input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 }
  const own = { input_tokens: 7, output_tokens: 3 }
  const start = (id: string, usage: Record<string, number>) => stream({ type: 'message_start', message: { id, usage } })
  const snapshot = (id: string, usage: Record<string, number>) => ({ ...assistant(id, [{ type: 'text', text: 'snapshot' }]), message: { id, role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: 'snapshot' }], usage } })
  const ownOnly = { inputTokens: 7, outputTokens: 3, cacheReadTokens: null, cacheCreationTokens: null }
  /** Turn A owns old-request and settles without an aggregate; turn B makes its own request, then sees `replay`, then fails without one. */
  const replayedInNextTurn = async (replay: Array<Record<string, unknown>>) => {
    const { d } = claude()
    await d.start()
    const a = await (await d.send(script({ frames: [start('old-request', old), snapshot('old-request', old)], usage: null }))).result
    expect(a.usage).toEqual({ inputTokens: 100, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 5 })
    const b = await (await d.send(script({ frames: [start('new-request', own), ...replay], usage: null, subtype: 'error_during_execution' }))).result
    expect(b.outcome).toBe('failed')
    return b.usage
  }

  test('an earlier turn\'s request replayed as an assistant snapshot after the next turn\'s own request stays with its original turn', async () => {
    expect(await replayedInNextTurn([snapshot('old-request', old)])).toEqual(ownOnly)
  })

  test('an earlier turn\'s request replayed as a message_start after the next turn\'s own request stays with its original turn', async () => {
    expect(await replayedInNextTurn([start('old-request', old)])).toEqual(ownOnly)
  })

  test('a message_delta after a replayed earlier-turn request continues that request: the next turn gains nothing', async () => {
    expect(await replayedInNextTurn([start('old-request', old), stream({ type: 'message_delta', usage: { output_tokens: 50 } })])).toEqual(ownOnly)
  })

  test('a conversation reset clears the context, not request ownership: a later replay still stays with its original turn', async () => {
    expect(await replayedInNextTurn([{ type: 'conversation_reset', uuid: crypto.randomUUID() }, snapshot('old-request', old)])).toEqual(ownOnly)
  })

  test('a turn\'s own request replayed after its second request still counts once, merged per field', async () => {
    const { d } = claude()
    await d.start()
    const result = await (await d.send(script({ frames: [start('r1', { input_tokens: 10, output_tokens: 0 }), start('r2', { input_tokens: 20, output_tokens: 1 }), snapshot('r1', { input_tokens: 10, output_tokens: 6 })], usage: null, subtype: 'error_during_execution' }))).result
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 7, cacheReadTokens: null, cacheCreationTokens: null })
  })
})

// Review F4/A3: quotaSource is the public opt-in for the host-login pull; it reads the supplied home's login.
describe('Claude quota source through the public factory, the real SDK and the owned fake CLI', () => {
  const pullsOnlyWhenChosen = async (quotaSource: 'none' | 'host-login' | undefined) => {
    const home = fakeClaudeHome()
    const launch = home.launch()
    // Only the supplied home holds this login's windows.
    mkdirSync(join(launch.homeDir, '.claude'), { recursive: true })
    writeFileSync(join(launch.homeDir, '.claude', 'usage.json'), JSON.stringify({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 37, resets_at: '2030-01-01T00:00:00.000Z' } } }))
    const quotas: QuotaReport[] = []
    const d = createClaudeDriver({
      launch, logger, permissions: { mode: 'default', enabledTools: [], disallowedTools: [] },
      callbacks: { onEvent: () => {}, onQuotaReport: (q) => void quotas.push(q) },
      ...(quotaSource ? { quotaSource } : {}),
    })
    driver = d
    await d.start()
    // Native prompt exchanges are the barriers: the pull is asked at initialize, answered before these prompts' results.
    await (await d.send('native barrier 1')).result
    await (await d.send('native barrier 2')).result
    const pulls = home.received().filter((f) => (f.request as { subtype?: unknown } | undefined)?.subtype === 'get_usage')
    expect(pulls.length).toBe(quotaSource === 'host-login' ? 1 : 0)
    const pulled = quotas.map((q) => ({ source: q.source, accountScope: q.accountScope, windows: q.windows.map((w) => [w.key, w.percentUsed]) }))
    expect(pulled).toEqual(quotaSource === 'host-login' ? [{ source: 'host-login-pull', accountScope: 'host-login', windows: [['five_hour', 37]] }] : [])
  }
  test('quotaSource unset: no usage pull and no pulled report', () => pullsOnlyWhenChosen(undefined))
  test('quotaSource none: no usage pull and no pulled report', () => pullsOnlyWhenChosen('none'))
  test('quotaSource host-login: exactly one usage pull of the supplied home, reported as host-login-pull / host-login', () => pullsOnlyWhenChosen('host-login'))
})

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await Bun.sleep(5)
  }
}
