// Codex notifications as runtime events (design §6; from Kawai's committed
// codexEvents.ts and codexUsage.ts). A pure mapping with no I/O. The session
// passes the runtime turn id a notification belongs to; each item becomes the
// event kinds Claude turns use: commands are `Bash`, file changes `Edit`, MCP
// and dynamic tool calls `mcp__<server>__<tool>`, web searches `WebSearch`.
// Turn boundaries, compaction, token usage, rate limits and retry errors are
// typed outputs the session acts on; their token, quota and limit values are
// read by the pure ./usage helpers (facts.ts).
// A19 (task-ce05430a R3/R4) restored three outputs Kawai's transcript showed
// before the package took over: a file change's `changes` [{path, kind}] and
// its `Changed N file(s): <paths>` summary, a dynamic tool's content text,
// and a failed MCP call's own message.
import type { EventBody } from '../eventStream.js'
import type { JsonValue } from '../json.js'
import type { CodexTokenBreakdown } from '../usage/tokens.js'

/** The fields of a protocol Turn the session reads. */
export interface CodexTurn {
  id: string
  status?: unknown
  error?: { message?: unknown; codexErrorInfo?: unknown } | null
  items?: unknown[]
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
const fileChanges = (item: Item): Array<{ path?: unknown; kind?: unknown }> =>
  Array.isArray(item.changes) ? (item.changes as Array<{ path?: unknown; kind?: unknown }>) : []
const changeKind = (change: { kind?: unknown } | null | undefined): unknown =>
  isObject(change?.kind) ? change.kind.type : (change?.kind ?? null)
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
      const changes = fileChanges(item)
      const paths = changes.map((change) => String(change?.path ?? ''))
      // A19: each change's path and kind, as Kawai's transcript showed them.
      return { tool: 'Edit', input: { file_path: paths[0] ?? '', paths, changes: changes.map((change, n) => ({ path: paths[n]!, kind: changeKind(change) })) } }
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
    case 'fileChange': {
      if (item.status !== 'completed') return { output: `The file change ${String(item.status)}.`, isError: true }
      // A19: the completed change names its files, in order.
      const paths = fileChanges(item).map((change) => String(change?.path ?? ''))
      return { output: `Changed ${paths.length} file${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`, isError: false }
    }
    case 'mcpToolCall': {
      // A19: a failed call's own message is its result.
      const error = isObject(item.error) && typeof item.error.message === 'string' ? item.error.message : null
      if (error !== null) return { output: error, isError: true }
      return { output: JSON.stringify(item.result ?? item.contentItems ?? null), isError: item.status === 'failed' || item.success === false }
    }
    case 'dynamicToolCall': {
      // A19: the content's text, a placeholder for each non-text item.
      const items = Array.isArray(item.contentItems) ? (item.contentItems as unknown[]) : []
      const output = items.map((entry) => (isObject(entry) && entry.type === 'inputText' ? String(entry.text ?? '') : `[${String(isObject(entry) ? entry.type : entry)}]`)).join('\n')
      return { output, isError: item.status === 'failed' || item.success === false }
    }
    case 'webSearch':
      return { output: `Searched: ${String(item.query ?? '')}`, isError: false }
    default:
      return null
  }
}
