// @reads: packages/agent-runtime/__tests__/fixtures/**
// I7 over seeded streams (tasks 5.2/5.3; R01-R06/R08): results, counts,
// window and wait facts belong only to their actual identity, and unknown
// stays unknown. Both providers' production session, parsers and reducers
// run unchanged: Claude on the controlled query (the session core with only
// the SDK's query() replaced; claudeUsageFacts.test.ts covers the same facts
// through the default fake CLI), Codex through the public factory and the
// owned fake app-server over stdio. Each stream interleaves turns, idle
// and in-turn quota pushes, limit and non-limit retries, progress frames,
// subagent and foreign-turn frames, tool and boundary ids reused across
// turns, repeated token updates, results with and without usage, and failed
// turns. The reference models (oracles/usageModels.ts) are told only what
// was sent; after the stop every result, the limit/wait signal sequence
// (with each wait-end's waitId naming its start) and the quota reports must
// equal theirs.
import { afterEach, describe, expect, test } from 'bun:test'
import type { TurnResult } from '../src/contract.js'
import type { AgentEvent } from '../src/events.js'
import type { LimitEvent, QuotaReport, TokenUsage } from '../src/usage/types.js'
import { driver } from './helpers/claudeDriverHarness.js'
import { codexDriver, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'
import { ClaudeUsageModel, CodexUsageModel, type CodexSnapshot, type ExpectedTurn } from './oracles/usageModels.js'

afterEach(stopDrivers)

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
/** mulberry32: consecutive draws are independent enough that any op can follow any other (an LCG's high bits are not). */
const random = (seed: number) => {
  let state = seed >>> 0
  return (n: number) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) % n
  }
}
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

/** The driver's signals in the models' compact form; a wait-end must name the wait it ends. */
function signals(limits: LimitEvent[], key: (turnId: string) => string): { strings: string[]; violations: string[] } {
  const strings: string[] = []
  const violations: string[] = []
  let open: string | null = null
  for (const event of limits) {
    if (event.type === 'failure') strings.push(`failure:${event.final}:${event.resetsAt}:${event.window}`)
    else if (event.type === 'wait-start') {
      if (open !== null) violations.push(`wait ${event.waitId} started while ${open} was open`)
      open = event.waitId
      strings.push(`start:${event.turnId === null ? 'none' : key(event.turnId)}:${event.resetsAt}:${event.window}`)
    } else {
      if (event.waitId !== open) violations.push(`wait-end ${event.waitId} does not name the open wait ${open}`)
      open = null
      strings.push(`end:${event.cause}`)
    }
  }
  return { strings, violations }
}

/** What a stream exercised (from the reference), so a slice can show it covered each fact class. */
function exercised(model: { limits: string[]; quotas: string[]; results: ExpectedTurn[]; marks: Set<string> }, into: Set<string>): void {
  for (const mark of model.marks) into.add(mark)
  for (const limit of model.limits) into.add(limit.split(':').slice(0, limit.startsWith('end') ? 2 : 1).join(':'))
  for (const quota of model.quotas) into.add(`quota:${quota.split(':')[0]}`)
  for (const result of model.results) {
    into.add(`outcome:${result.outcome}`)
    into.add(result.usage === null ? 'usage:null' : 'usage:known')
    if (result.toolCallCount > 1) into.add('tools:several')
    if (result.compactionCount > 0) into.add('compaction')
    if (result.providerCostUsd != null) into.add('cost:known')
    if (result.model === null) into.add('model:null')
  }
}

function compare(name: string, actual: unknown, expected: unknown, violations: string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) violations.push(`${name}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

const resultFacts = (r: TurnResult, key: string, events: AgentEvent[], extra: boolean): ExpectedTurn => {
  const completed = events.find((e) => e.type === 'turn_completed' && e.turnId === r.turnId) as Extract<AgentEvent, { type: 'turn_completed' }> | undefined
  const facts: ExpectedTurn = { key, outcome: r.outcome as ExpectedTurn['outcome'], usage: r.usage, toolCallCount: r.toolCallCount, compactionCount: r.compactionCount }
  if (completed && JSON.stringify(completed.usage) !== JSON.stringify(r.usage)) facts.usage = { inputTokens: -1, outputTokens: -1, cacheReadTokens: -1, cacheCreationTokens: -1 }
  return extra ? { ...facts, model: r.model, providerCostUsd: completed?.providerCostUsd ?? null } : facts
}

// ---- Claude ------------------------------------------------------------------

type ClaudeOp = 'start' | 'startSub' | 'cost' | 'costSub' | 'tool' | 'text' | 'subTool' | 'compact' | 'retry' | 'retryOther' | 'push'
const CLAUDE_OPS: ClaudeOp[] = ['start', 'startSub', 'cost', 'costSub', 'tool', 'tool', 'text', 'subTool', 'compact', 'retry', 'retry', 'retryOther', 'push']
const STATUSES = ['allowed', 'allowed_warning', 'rejected'] as const

async function claudeStream(seed: number, seen: Set<string>): Promise<string[]> {
  const next = random(seed)
  const model = new ClaudeUsageModel()
  const limits: LimitEvent[] = []
  const quotas: QuotaReport[] = []
  const f = driver({ resume: null, observers: { onLimitEvent: (e) => void limits.push(e), onQuotaReport: (q) => void quotas.push(q) } })
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  const now = Math.floor(Date.now() / 1000)
  const keys = new Map<string, string>()
  let frame = 0
  const uuid = () => `${seed}-f${++frame}`
  const push = (status: (typeof STATUSES)[number]) => {
    const resetsAt = now + 600 + next(5000)
    const window = ['five_hour', 'seven_day'][next(2)]!
    model.push(status, iso(resetsAt), window)
    f.q().push({ type: 'rate_limit_event', uuid: uuid(), session_id: 'sess-1', rate_limit_info: { status, resetsAt, rateLimitType: window, utilization: next(101) / 100 } } as never)
  }
  const assistant = (subagent: boolean, name: string, blocks: Record<string, unknown>[]) =>
    ({ type: 'assistant', uuid: uuid(), session_id: 'sess-1', parent_tool_use_id: subagent ? 'toolu_parent' : null, message: { id: uuid(), role: 'assistant', model: name, content: blocks } }) as never
  const stream = (subagent: boolean, event: Record<string, unknown>) => ({ type: 'stream_event', uuid: uuid(), session_id: 'sess-1', parent_tool_use_id: subagent ? 'toolu_parent' : null, event }) as never
  const turns = 1 + next(4)
  for (let t = 0; t < turns; t++) {
    if (next(3) === 0) push(STATUSES[next(3)]!)
    const handle = await f.d.send(`m${t}`)
    const key = `t${t}`
    keys.set(handle.turnId, key)
    model.open(key)
    await f.q().drain()
    const length = next(10)
    for (let i = 0; i < length; i++) {
      const op = CLAUDE_OPS[next(CLAUDE_OPS.length)]!
      const q = f.q()
      if (op === 'start' || op === 'startSub') {
        model.messageStart(op === 'startSub')
        q.push(stream(op === 'startSub', { type: 'message_start', message: { id: uuid(), usage: { input_tokens: 1 + next(50) } } }))
      } else if (op === 'cost' || op === 'costSub') {
        const cost = next(3) === 0 ? null : [0.25, 0.5, 1.25][next(3)]!
        model.delta(cost)
        q.push(stream(op === 'costSub', { type: 'message_delta', usage: { output_tokens: 1, ...(cost === null ? {} : { cost }) } }))
      } else if (op === 'tool' || op === 'text' || op === 'subTool') {
        const name = ['model-a', 'model-b'][next(2)]!
        const ids = op === 'text' ? [] : op === 'subTool' ? ['ts'] : ['ta', 'tb', 'tc'].filter(() => next(2) === 0)
        model.assistant(op === 'subTool', name, ids)
        const blocks = op === 'text' ? [{ type: 'text', text: `x${i}` }] : ids.map((id) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }))
        q.push(assistant(op === 'subTool', name, blocks))
      } else if (op === 'compact') {
        const id = ['b1', 'b2'][next(2)]!
        model.boundary(id)
        q.push({ type: 'system', subtype: 'compact_boundary', uuid: id, session_id: 'sess-1', compact_metadata: { trigger: 'auto', pre_tokens: 100 } } as never)
      } else if (op === 'retry' || op === 'retryOther') {
        model.retry(op === 'retry')
        const [error, status] = op === 'retry' ? ([['rate_limit', 429], ['overloaded', 529]] as const)[next(2)]! : (['server_error', 500] as const)
        q.push({ type: 'system', subtype: 'api_retry', uuid: uuid(), session_id: 'sess-1', attempt: 1, max_retries: 5, retry_delay_ms: 10, error_status: status, error } as never)
      } else push(STATUSES[next(3)]!)
      await q.drain()
    }
    const usage = next(3) === 0 ? null : { input_tokens: next(500), output_tokens: next(500), ...(next(2) === 0 ? { cache_read_input_tokens: next(100) } : {}), cache_creation_input_tokens: next(50) }
    const failed = next(4) === 0
    const expected: TokenUsage | null = usage && { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_input_tokens ?? null, cacheCreationTokens: usage.cache_creation_input_tokens }
    model.result(failed, expected)
    f.q().push({ ...(frames.result([handle.messageUuid], 'done', failed ? 'error_during_execution' : 'success', failed) as object), ...(usage ? { usage } : {}) } as never)
    await f.q().drain()
    await handle.result
  }
  await f.d.kill()
  const key = (turnId: string) => keys.get(turnId) ?? `unknown:${turnId}`
  const violations: string[] = []
  compare('results', f.results.map((r) => resultFacts(r, key(r.turnId), f.events, true)), model.results, violations)
  const actual = signals(limits, key)
  violations.push(...actual.violations)
  compare('limits', actual.strings, model.limits, violations)
  compare('quotas', quotas.map((q) => `${q.source}:${q.accountScope}:${q.status}`), model.quotas, violations)
  exercised(model, seen)
  return violations
}

// ---- Codex -------------------------------------------------------------------

type Note = { method: string; params?: Record<string, unknown> }
type CodexOp = 'tok' | 'dup' | 'foreign' | 'tool' | 'foreignTool' | 'delta' | 'compact' | 'retry' | 'push'
const CODEX_OPS: CodexOp[] = ['tok', 'tok', 'dup', 'foreign', 'tool', 'tool', 'foreignTool', 'delta', 'compact', 'retry', 'retry', 'push']
const RETRY_INFOS = ['rateLimitExceeded', 'usageLimitExceeded', 'serverOverloaded', 'sessionBudgetExceeded', 'other', 'contextWindowExceeded']

async function codexStream(seed: number, seen: Set<string>): Promise<string[]> {
  const next = random(seed)
  const model = new CodexUsageModel()
  const now = Math.floor(Date.now() / 1000)
  const window = (): CodexSnapshot['primary'] => (next(4) === 0 ? null : { usedPercent: [0, 37, 100][next(3)]!, windowDurationMins: [300, 10080][next(2)]!, resetsAt: now + next(2) * 7200 - 3600 })
  const snapshot = (): CodexSnapshot => ({ primary: window(), secondary: window(), rateLimitReachedType: next(2) === 0 ? 'rateLimitReached' : null })
  const wire = (s: CodexSnapshot) => ({ limitId: null, limitName: null, ...s, credits: null, planType: null })
  const read = next(3) === 0 ? null : snapshot()
  const limits: LimitEvent[] = []
  const quotas: QuotaReport[] = []
  const h = codexDriver({ ...(read ? { env: { FAKE_CODEX_RATELIMITS: JSON.stringify(wire(read)) } } : {}), callbacks: { onLimitEvent: (e) => void limits.push(e), onQuotaReport: (q) => void quotas.push(q) } })
  await h.driver.start()
  if (read) {
    model.read(read)
    if (read.primary || read.secondary) await waitFor(() => quotas.length > 0)
  }
  const total = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  const tokens = (last: Record<string, number>, foreign: boolean): Note => ({ method: 'thread/tokenUsage/updated', params: { ...(foreign ? { turnId: 'ghost' } : {}), tokenUsage: { total: { ...total }, last, modelContextWindow: 1000 } } })
  const request = (foreign: boolean): Note => {
    const input = 10 + next(200)
    const cached = next(10)
    const output = next(100)
    const last = { totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output }
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += last[k]
    if (!foreign) model.request({ inputTokens: input - cached, outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: null })
    return tokens(last, foreign)
  }
  const command = (id: string, foreign: boolean): Note[] => {
    const item = { type: 'commandExecution', id, command: 'ls', cwd: '/', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }
    const turn = foreign ? { turnId: 'ghost' } : {}
    return [{ method: 'item/started', params: { ...turn, item } }, { method: 'item/completed', params: { ...turn, item } }]
  }
  const keys = new Map<string, string>()
  const turns = 1 + next(4)
  for (let t = 0; t < turns; t++) {
    const key = `t${t}`
    model.open(key)
    const notes: Note[] = []
    let lastOwn: Note | null = null
    const length = next(10)
    for (let i = 0; i < length; i++) {
      const op = CODEX_OPS[next(CODEX_OPS.length)]!
      if (op === 'tok') notes.push((lastOwn = request(false)))
      else if (op === 'dup') {
        if (lastOwn) {
          notes.push(lastOwn)
          model.repeated()
        }
      } else if (op === 'foreign') notes.push(request(true))
      else if (op === 'tool' || op === 'foreignTool') {
        const id = ['c1', 'c2', 'c3'][next(3)]!
        if (op === 'tool') model.tool(id)
        notes.push(...command(id, op === 'foreignTool'))
      } else if (op === 'delta') {
        model.delta()
        notes.push({ method: 'item/agentMessage/delta', params: { itemId: `d${i}`, delta: 'x' } })
      } else if (op === 'compact') {
        const id = ['k1', 'k2'][next(2)]!
        model.boundary(id)
        notes.push({ method: 'item/completed', params: { item: { type: 'contextCompaction', id } } })
      } else if (op === 'retry') {
        const info = RETRY_INFOS[next(RETRY_INFOS.length)]!
        model.retry(info)
        notes.push({ method: 'error', params: { willRetry: true, error: { message: 'retrying', codexErrorInfo: info, additionalDetails: null } } })
      } else {
        const s = snapshot()
        model.push(s)
        notes.push({ method: 'account/rateLimits/updated', params: { rateLimits: wire(s) } })
      }
    }
    const failed = next(4) === 0 ? RETRY_INFOS[next(RETRY_INFOS.length)]! : null
    if (failed) model.failed(failed)
    else model.completed()
    const handle = await h.driver.send(`/script ${JSON.stringify({ notes, ...(failed ? { end: `failed:${JSON.stringify(failed)}` } : {}) })}`)
    keys.set(handle.turnId, key)
    await handle.result
  }
  await h.driver.kill()
  const key = (turnId: string) => keys.get(turnId) ?? `unknown:${turnId}`
  const violations: string[] = []
  compare('results', h.results.map((r) => resultFacts(r, key(r.turnId), h.events, false)), model.results, violations)
  const actual = signals(limits, key)
  violations.push(...actual.violations)
  compare('limits', actual.strings, model.limits, violations)
  compare('quotas', quotas.map((q) => `${q.source}:${q.accountScope}:${q.status}`), model.quotas, violations)
  exercised(model, seen)
  return violations
}

const SHARED_CLASSES = ['failure', 'start', 'end:resumed', 'end:cancelled', 'quota:push', 'outcome:success', 'outcome:failed', 'usage:null', 'usage:known', 'tools:several', 'compaction', 'push-in-wait-unresumed']
const CLAUDE_CLASSES = [...SHARED_CLASSES, 'cost:known', 'model:null']
const CODEX_CLASSES = [...SHARED_CLASSES, 'quota:report']
const claudeSeen: Set<string>[] = []
const codexSeen: Set<string>[] = []

describe('I7: facts belong only to their actual identity; unknown stays unknown', () => {
  // 0xA607, 300 streams per provider (mulberry32), in slices so each test stays within its timeout.
  for (let slice = 0; slice < 6; slice++) {
    test(`Claude: results, counts, waits and quota reports match the reference (streams ${slice * 50}-${slice * 50 + 49})`, async () => {
      const failures: string[] = []
      const seen = new Set<string>()
      for (let i = slice * 50; i < slice * 50 + 50; i++) {
        const violations = await claudeStream(0xa607 + i * 7919, seen)
        if (violations.length > 0) failures.push(`stream ${i}: ${violations.join('; ')}`)
      }
      expect(failures).toEqual([])
      claudeSeen.push(seen)
    })
  }
  for (let slice = 0; slice < 15; slice++) {
    test(`Codex: results, counts, waits and quota reports match the reference (streams ${slice * 20}-${slice * 20 + 19})`, async () => {
      const failures: string[] = []
      const seen = new Set<string>()
      for (let i = slice * 20; i < slice * 20 + 20; i++) {
        const violations = await codexStream(0xa607 + i * 7919, seen)
        if (violations.length > 0) failures.push(`stream ${i}: ${violations.join('; ')}`)
      }
      expect(failures).toEqual([])
      codexSeen.push(seen)
    })
  }
  test('each provider\'s 300 streams exercised every fact class', () => {
    const claude = new Set(claudeSeen.flatMap((set) => [...set]))
    const codex = new Set(codexSeen.flatMap((set) => [...set]))
    expect([claudeSeen.length, codexSeen.length]).toEqual([6, 15])
    expect(CLAUDE_CLASSES.filter((c) => !claude.has(c))).toEqual([])
    expect(CODEX_CLASSES.filter((c) => !codex.has(c))).toEqual([])
  })
})
