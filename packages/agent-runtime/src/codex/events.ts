// Codex notifications as runtime events (design §6; from Kawai's committed
// codexEvents.ts and codexUsage.ts). A pure mapping with no I/O. The session
// passes the runtime turn id a notification belongs to; each item becomes the
// event kinds Claude turns use: commands are `Bash`, file changes `Edit`, MCP
// and dynamic tool calls `mcp__<server>__<tool>`, web searches `WebSearch`.
// Turn boundaries, compaction, token usage, rate limits and retry errors are
// typed outputs the session acts on. Unknown values stay null (R08): a
// missing token count is never a zero.
import type { EventBody } from '../eventStream.js'
import type { JsonValue } from '../json.js'
import type { QuotaReport, QuotaWindow, TokenUsage } from '../usage/types.js'

/** The fields of a protocol Turn the session reads. */
export interface CodexTurn {
  id: string
  status?: unknown
  error?: { message?: unknown; codexErrorInfo?: unknown } | null
  items?: unknown[]
}

/** The token counters of one ThreadTokenUsage breakdown. */
export interface CodexTokenBreakdown {
  totalTokens?: unknown
  inputTokens?: unknown
  cachedInputTokens?: unknown
  outputTokens?: unknown
  cacheWriteInputTokens?: unknown
}

export type CodexOutput =
  | { kind: 'event'; body: EventBody }
  | { kind: 'turn_started'; codexTurnId: string }
  | { kind: 'turn_completed'; turn: CodexTurn }
  | { kind: 'tool'; itemId: string }
  | { kind: 'agent_text'; text: string }
  | { kind: 'compaction'; itemId: string }
  | { kind: 'token_usage'; total: CodexTokenBreakdown | null; last: CodexTokenBreakdown | null; window: number | null }
  | { kind: 'rate_limits'; snapshot: Record<string, unknown> }
  | { kind: 'retry_error'; error: { message?: unknown; codexErrorInfo?: unknown }; willRetry: boolean }

type Item = Record<string, unknown> & { id: string; type?: unknown }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const json = (value: unknown): JsonValue => (value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue))
export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`

/** The native turn id a notification names, or null. */
export function notificationTurnId(params: Record<string, unknown>): string | null {
  if (typeof params.turnId === 'string') return params.turnId
  const turn = params.turn
  return isObject(turn) && typeof turn.id === 'string' ? turn.id : null
}

/** One notification's outputs; `turnId` is the runtime turn it belongs to (null: none). */
export function mapCodexNotification(method: string, params: Record<string, unknown>, turnId: string | null): CodexOutput[] {
  switch (method) {
    case 'turn/started': {
      const id = notificationTurnId(params)
      return id ? [{ kind: 'turn_started', codexTurnId: id }] : []
    }
    case 'turn/completed': {
      const turn = params.turn
      return isObject(turn) && typeof turn.id === 'string' ? [{ kind: 'turn_completed', turn: turn as unknown as CodexTurn }] : []
    }
    case 'item/agentMessage/delta': {
      if (!turnId || typeof params.delta !== 'string' || params.delta === '' || typeof params.itemId !== 'string') return []
      return [{ kind: 'event', body: { type: 'assistant_delta', turnId, messageId: params.itemId, delta: params.delta } }]
    }
    case 'thread/tokenUsage/updated': {
      const usage = params.tokenUsage
      if (!isObject(usage)) return []
      const window = typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : null
      return [{ kind: 'token_usage', total: isObject(usage.total) ? usage.total : null, last: isObject(usage.last) ? usage.last : null, window }]
    }
    case 'account/rateLimits/updated':
      return isObject(params.rateLimits) ? [{ kind: 'rate_limits', snapshot: params.rateLimits }] : []
    case 'error':
      return isObject(params.error) ? [{ kind: 'retry_error', error: params.error, willRetry: params.willRetry === true }] : []
    case 'item/started':
      return isObject(params.item) && typeof params.item.id === 'string' ? itemStarted(params.item as Item, turnId) : []
    case 'item/completed':
      return isObject(params.item) && typeof params.item.id === 'string' ? itemCompleted(params.item as Item, turnId) : []
    default:
      return []
  }
}

function itemStarted(item: Item, turnId: string | null): CodexOutput[] {
  const call = toolCallOf(item)
  if (!call || !turnId) return []
  return [
    { kind: 'tool', itemId: item.id },
    { kind: 'event', body: { type: 'tool_call', turnId, toolCallId: item.id, tool: call.tool, input: json(call.input) } },
  ]
}

function itemCompleted(item: Item, turnId: string | null): CodexOutput[] {
  if (item.type === 'contextCompaction') return [{ kind: 'compaction', itemId: item.id }]
  if (!turnId) return []
  if (item.type === 'agentMessage') {
    const text = typeof item.text === 'string' ? item.text : ''
    if (text.trim() === '') return []
    return [
      { kind: 'agent_text', text },
      { kind: 'event', body: { type: 'assistant_text', turnId, messageId: item.id, text } },
    ]
  }
  const result = toolResultOf(item)
  if (!result) return []
  return [
    { kind: 'tool', itemId: item.id },
    { kind: 'event', body: { type: 'tool_result', turnId, toolCallId: item.id, output: result.output, isError: result.isError } },
  ]
}

/** The tool name and input of a tool-shaped item, or null. */
export function toolCallOf(item: Item): { tool: string; input: unknown } | null {
  switch (item.type) {
    case 'commandExecution':
      return { tool: 'Bash', input: { command: item.command ?? '', cwd: item.cwd ?? null } }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: unknown }>) : []
      const paths = changes.map((change) => String(change?.path ?? ''))
      return { tool: 'Edit', input: { file_path: paths[0] ?? '', paths } }
    }
    case 'mcpToolCall':
      return { tool: mcpToolName(String(item.server ?? ''), String(item.tool ?? '')), input: item.arguments ?? null }
    case 'dynamicToolCall':
      return { tool: mcpToolName(String(item.namespace ?? 'dynamic'), String(item.tool ?? '')), input: item.arguments ?? null }
    case 'webSearch':
      return { tool: 'WebSearch', input: { query: item.query ?? '' } }
    default:
      return null
  }
}

function toolResultOf(item: Item): { output: string; isError: boolean } | null {
  switch (item.type) {
    case 'commandExecution': {
      const code = typeof item.exitCode === 'number' ? item.exitCode : null
      const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
      return { output: code === null ? output : `${output}${output ? '\n' : ''}(exit code ${code})`, isError: item.status === 'failed' || item.status === 'declined' || (code ?? 0) !== 0 }
    }
    case 'fileChange':
      return { output: item.status === 'completed' ? 'The file change completed.' : `The file change ${String(item.status)}.`, isError: item.status !== 'completed' }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return { output: JSON.stringify(item.result ?? item.contentItems ?? null), isError: item.status === 'failed' || item.success === false }
    case 'webSearch':
      return { output: `Searched: ${String(item.query ?? '')}`, isError: false }
    default:
      return null
  }
}

const count = (breakdown: CodexTokenBreakdown | null, key: keyof CodexTokenBreakdown): number | null => {
  const value = breakdown?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** One turn's tokens from the latest request breakdown; an unreported counter stays null (R08). */
export function turnUsage(last: CodexTokenBreakdown | null): TokenUsage | null {
  if (!last) return null
  const input = count(last, 'inputTokens')
  const cached = count(last, 'cachedInputTokens')
  return {
    inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
    outputTokens: count(last, 'outputTokens'),
    cacheReadTokens: cached,
    cacheCreationTokens: count(last, 'cacheWriteInputTokens'),
  }
}

/**
 * The tokens between two thread totals (the requests since the previous
 * update), or null when either total is unknown.
 */
export function usageDelta(total: CodexTokenBreakdown | null, previous: CodexTokenBreakdown | null): CodexTokenBreakdown | null {
  if (!total || !previous) return null
  const keys = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'cacheWriteInputTokens'] as const
  const delta: CodexTokenBreakdown = {}
  for (const key of keys) {
    const now = count(total, key)
    const before = count(previous, key)
    delta[key] = now === null ? null : Math.max(0, now - (before ?? 0))
  }
  return delta
}

/** Sum two turn usages (several requests in one turn); null stays null only when both are. */
export function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a || !b) return a ?? b
  const add = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0))
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: add(a.cacheCreationTokens, b.cacheCreationTokens),
  }
}

function windowLabel(mins: number | null): string {
  if (mins === null || mins <= 0) return 'Window'
  if (mins === 300) return '5-hour'
  if (mins === 10080) return 'weekly'
  if (mins % 1440 === 0) return `${mins / 1440}-day`
  if (mins % 60 === 0) return `${mins / 60}-hour`
  return `${mins} min`
}

function isoReset(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // The protocol reports reset times in Unix seconds.
  return new Date(value * 1000).toISOString()
}

function quotaWindow(key: string, raw: unknown, limitName: unknown): QuotaWindow | null {
  if (!isObject(raw) || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) return null
  const mins = typeof raw.windowDurationMins === 'number' && Number.isFinite(raw.windowDurationMins) ? raw.windowDurationMins : null
  const name = typeof limitName === 'string' && limitName.trim() ? limitName.trim() : null
  const label = windowLabel(mins)
  return { key, label: name ? `${label} · ${name}` : label, percentUsed: raw.usedPercent, resetsAt: isoReset(raw.resetsAt), periodMs: mins === null ? null : mins * 60_000 }
}

/** A rate-limit snapshot as a quota report (source `push`, the session's own login). */
export function quotaReport(snapshot: Record<string, unknown>, receivedAt = new Date().toISOString()): QuotaReport {
  const windows = [quotaWindow('codex:primary', snapshot.primary, snapshot.limitName), quotaWindow('codex:secondary', snapshot.secondary, snapshot.limitName)].filter((w): w is QuotaWindow => w !== null)
  return { status: snapshot.rateLimitReachedType != null ? 'limited' : 'allowed', windows, receivedAt, source: 'push', accountScope: 'session' }
}

/** The latest reset among exhausted windows of the snapshot, or null. */
export function exhaustedReset(snapshot: Record<string, unknown> | null): string | null {
  let latest: string | null = null
  for (const raw of [snapshot?.primary, snapshot?.secondary]) {
    if (!isObject(raw) || typeof raw.usedPercent !== 'number' || raw.usedPercent < 100) continue
    const reset = isoReset(raw.resetsAt)
    if (reset && (latest === null || reset > latest)) latest = reset
  }
  return latest
}
