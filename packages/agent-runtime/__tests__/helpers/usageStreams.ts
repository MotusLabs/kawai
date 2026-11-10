// Seeded usage streams for I7 and I8 (tasks 5.2-5.4), shared by usage.test.ts
// and observers.test.ts. Each stream drives a production driver (Claude on
// the controlled query, Codex through the production transport and session
// with the fake app-server served in-process behind the private spawn seam,
// inProcessCodex.ts) through interleaved turns, quota pushes, retries, progress,
// subagent and foreign frames, reused ids, repeated token updates, results
// with and without usage, and failed turns, while a reference model
// (oracles/usageModels.ts) is told only what was sent.
// - Observer modes: `absent` (no usage observers), `present` (recording
//   observers) and `throwing` (every observer and event/result sink records,
//   then throws its own Error).
// - A run returns its result facts (from the turn handles), its limit/wait
//   signals and quota reports, the model's violations, and the stop: its
//   receipt or its rejection's causes, with every Error the observers threw.
import type { TurnResult } from '../../src/contract.js'
import type { AgentRuntimeError } from '../../src/errors.js'
import type { AgentEvent } from '../../src/events.js'
import type { LimitEvent, QuotaReport, TokenUsage } from '../../src/usage/types.js'
import { driver } from './claudeDriverHarness.js'
import { codexDriver, sent, waitFor } from './codexDriverHarness.js'
import { frames } from './controlledQuery.js'
import { ClaudeUsageModel, CodexUsageModel, type CodexSnapshot, type ExpectedTurn } from '../oracles/usageModels.js'

export type ObserverMode = 'absent' | 'present' | 'throwing'

export interface StreamRun {
  /** Disagreements with the reference model (limits and quotas only where observers record). */
  violations: string[]
  results: ExpectedTurn[]
  limits: string[]
  quotas: string[]
  model: { limits: string[]; quotas: string[]; results: ExpectedTurn[]; marks: Set<string> }
  thrown: Error[]
  /** null: the stop resolved; else the causes of its rejection. */
  stopCauses: unknown[] | null
}

/** Observers for a mode: `wrap` records, then (throwing) throws a fresh Error, named for its observer, that it keeps. */
function observing(mode: ObserverMode) {
  const thrown: Error[] = []
  return {
    thrown,
    wrap:
      <A extends unknown[]>(name: string, record: (...args: A) => unknown) =>
      (...args: A): void => {
        record(...args)
        if (mode !== 'throwing') return
        const error = new Error(`${name} throw ${thrown.length + 1}`)
        thrown.push(error)
        throw error
      },
  }
}

async function stopped(stop: () => Promise<unknown>): Promise<unknown[] | null> {
  try {
    await stop()
    return null
  } catch (error) {
    return [...((error as AgentRuntimeError).causes ?? [error])]
  }
}

function finish(model: StreamRun['model'], results: ExpectedTurn[], actual: { strings: string[]; violations: string[] }, quotas: QuotaReport[], mode: ObserverMode, thrown: Error[], stopCauses: unknown[] | null, resultCallbackDiffers: boolean): StreamRun {
  const violations: string[] = [...actual.violations]
  compare('results', results, model.results, violations)
  const quotaStrings = quotas.map((q) => `${q.source}:${q.accountScope}:${q.status}`)
  if (mode !== 'absent') {
    compare('limits', actual.strings, model.limits, violations)
    compare('quotas', quotaStrings, model.quotas, violations)
  }
  if (resultCallbackDiffers) violations.push('onTurnResult reported other values than the handles')
  return { violations, results, limits: actual.strings, quotas: quotaStrings, model, thrown, stopCauses }
}

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
export function signals(limits: LimitEvent[], key: (turnId: string) => string): { strings: string[]; violations: string[] } {
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
export function exercised(model: { limits: string[]; quotas: string[]; results: ExpectedTurn[]; marks: Set<string> }, into: Set<string>): void {
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

type ClaudeOp = 'start' | 'startSub' | 'cost' | 'costSub' | 'tool' | 'text' | 'subTool' | 'compact' | 'retry' | 'retryOther' | 'push' | 'replay'
const CLAUDE_OPS: ClaudeOp[] = ['start', 'startSub', 'cost', 'costSub', 'tool', 'tool', 'text', 'subTool', 'compact', 'retry', 'retry', 'retryOther', 'push', 'replay']
const STATUSES = ['allowed', 'allowed_warning', 'rejected'] as const

/** `base`: the stream's clock origin in epoch seconds (paired I8 runs share one so their reset times agree). */
export async function claudeStream(seed: number, mode: ObserverMode = 'present', base = Math.floor(Date.now() / 1000)): Promise<StreamRun> {
  const next = random(seed)
  // Inits and model windows (onModel, onContextUsage) draw from their own sequence, so the main one's streams stay as they were.
  const extra = random(seed ^ 0x51ed)
  const model = new ClaudeUsageModel()
  const limits: LimitEvent[] = []
  const quotas: QuotaReport[] = []
  const o = observing(mode)
  const f = driver({
    resume: null,
    ...(mode === 'absent' ? {} : { observers: { onLimitEvent: o.wrap('onLimitEvent', (e: LimitEvent) => limits.push(e)), onQuotaReport: o.wrap('onQuotaReport', (q: QuotaReport) => quotas.push(q)), onContextUsage: o.wrap('onContextUsage', () => {}), onCompaction: o.wrap('onCompaction', () => {}), onModel: o.wrap('onModel', () => {}) } }),
    ...(mode === 'throwing' ? { onEvent: o.wrap('onEvent', () => {}), onTurnResult: o.wrap('onTurnResult', () => {}) } : {}),
  })
  const settled: TurnResult[] = []
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  const now = base
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
    if (extra(2) === 0) {
      f.q().push({ type: 'system', subtype: 'init', session_id: 'sess-1', model: ['model-a', 'model-b'][extra(2)], uuid: uuid(), cwd: '/', tools: [] } as never)
      await f.q().drain()
    }
    const length = next(10)
    for (let i = 0; i < length; i++) {
      const op = CLAUDE_OPS[next(CLAUDE_OPS.length)]!
      const q = f.q()
      if (op === 'start' || op === 'startSub') {
        const id = uuid()
        const input = 1 + next(50)
        model.messageStart(op === 'startSub', id, input)
        q.push(stream(op === 'startSub', { type: 'message_start', message: { id, usage: { input_tokens: input } } }))
      } else if (op === 'cost' || op === 'costSub') {
        const cost = next(3) === 0 ? null : [0.25, 0.5, 1.25][next(3)]!
        model.delta(cost, op === 'costSub', 1)
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
      } else if (op === 'replay') {
        // A main request already seen (this turn's or an earlier one's), replayed by its native id with its own reported input.
        const seen = model.seenRequests()
        if (seen.length > 0) {
          const [id, input] = seen[next(seen.length)]!
          if (next(2) === 0) {
            model.messageStart(false, id, input)
            q.push(stream(false, { type: 'message_start', message: { id, usage: { input_tokens: input } } }))
          } else {
            const name = ['model-a', 'model-b'][next(2)]!
            model.snapshot(id, input, name)
            q.push({ type: 'assistant', uuid: uuid(), session_id: 'sess-1', parent_tool_use_id: null, message: { id, role: 'assistant', model: name, content: [{ type: 'text', text: `r${i}` }], usage: { input_tokens: input } } } as never)
          }
        }
      } else push(STATUSES[next(3)]!)
      await q.drain()
    }
    const usage = next(3) === 0 ? null : { input_tokens: next(500), output_tokens: next(500), ...(next(2) === 0 ? { cache_read_input_tokens: next(100) } : {}), cache_creation_input_tokens: next(50) }
    const failed = next(4) === 0
    const expected: TokenUsage | null = usage && { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_input_tokens ?? null, cacheCreationTokens: usage.cache_creation_input_tokens }
    model.result(failed, expected)
    f.q().push({ ...(frames.result([handle.messageUuid], 'done', failed ? 'error_during_execution' : 'success', failed) as object), ...(usage ? { usage } : {}), ...(extra(2) === 0 ? { modelUsage: { 'model-a': { contextWindow: 200000 } } } : {}) } as never)
    await f.q().drain()
    settled.push(await handle.result)
  }
  const stop = await stopped(() => f.d.kill())
  const key = (turnId: string) => keys.get(turnId) ?? `unknown:${turnId}`
  if (mode === 'present') compare('onTurnResult', f.results, settled, [])
  return finish(model, settled.map((r) => resultFacts(r, key(r.turnId), f.events, true)), signals(limits, key), quotas, mode, o.thrown, stop, mode === 'present' && JSON.stringify(f.results) !== JSON.stringify(settled))
}

// ---- Codex -------------------------------------------------------------------

type Note = { method: string; params?: Record<string, unknown> }
type CodexOp = 'tok' | 'dup' | 'foreign' | 'tool' | 'foreignTool' | 'delta' | 'compact' | 'replay' | 'retry' | 'push'
const CODEX_OPS: CodexOp[] = ['tok', 'tok', 'dup', 'foreign', 'tool', 'tool', 'foreignTool', 'delta', 'compact', 'replay', 'retry', 'retry', 'push']
const RETRY_INFOS = ['rateLimitExceeded', 'usageLimitExceeded', 'serverOverloaded', 'sessionBudgetExceeded', 'other', 'contextWindowExceeded']

export async function codexStream(seed: number, mode: ObserverMode = 'present', base = Math.floor(Date.now() / 1000)): Promise<StreamRun> {
  const next = random(seed)
  const model = new CodexUsageModel()
  const now = base
  const window = (): CodexSnapshot['primary'] => (next(4) === 0 ? null : { usedPercent: [0, 37, 100][next(3)]!, windowDurationMins: [300, 10080][next(2)]!, resetsAt: now + next(2) * 7200 - 3600 })
  const snapshot = (): CodexSnapshot => ({ primary: window(), secondary: window(), rateLimitReachedType: next(2) === 0 ? 'rateLimitReached' : null })
  const wire = (s: CodexSnapshot) => ({ limitId: null, limitName: null, ...s, credits: null, planType: null })
  const read = next(3) === 0 ? null : snapshot()
  const limits: LimitEvent[] = []
  const quotas: QuotaReport[] = []
  const o = observing(mode)
  const observers = mode === 'absent' ? {} : { onLimitEvent: o.wrap('onLimitEvent', (e: LimitEvent) => limits.push(e)), onQuotaReport: o.wrap('onQuotaReport', (q: QuotaReport) => quotas.push(q)), onContextUsage: o.wrap('onContextUsage', () => {}), onCompaction: o.wrap('onCompaction', () => {}), onModel: o.wrap('onModel', () => {}) }
  const sinks = mode === 'throwing' ? { onEvent: o.wrap('onEvent', () => {}), onTurnResult: o.wrap('onTurnResult', () => {}) } : {}
  const h = codexDriver({ inProcess: true, ...(read ? { env: { FAKE_CODEX_RATELIMITS: JSON.stringify(wire(read)) } } : {}), callbacks: { ...observers, ...sinks } })
  await h.driver.start()
  if (read) {
    model.read(read)
    // The read's reply lands before the first push; absent observers leave nothing to wait on but the read itself.
    if (read.primary || read.secondary) await waitFor(() => (mode === 'absent' ? sent(h.root, 'account/rateLimits/read').length > 0 && h.driver.state === 'idle' : quotas.length > 0))
    if (mode === 'absent') await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const settled: TurnResult[] = []
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
      } else if (op === 'replay') {
        // item/completed of an item the turn already completed (F2: a replay is no progress and no count).
        const done = model.completedItems()
        if (done.length > 0) {
          const id = done[next(done.length)]!
          model.replayed(id)
          const item = id.startsWith('k') ? { type: 'contextCompaction', id } : { type: 'commandExecution', id, command: 'ls', cwd: '/', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }
          notes.push({ method: 'item/completed', params: { item } })
        }
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
    settled.push(await handle.result)
  }
  const stop = await stopped(() => h.driver.kill())
  const key = (turnId: string) => keys.get(turnId) ?? `unknown:${turnId}`
  return finish(model, settled.map((r) => resultFacts(r, key(r.turnId), h.events, false)), signals(limits, key), quotas, mode, o.thrown, stop, mode === 'present' && JSON.stringify(h.results) !== JSON.stringify(settled))
}
