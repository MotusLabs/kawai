// Codex notifications → Kawai chat events (codex-chat-sessions design D7):
// a pure mapping with no I/O, so it is table-tested from recorded frames. The
// driver owns Kawai turn ids and passes the one a notification belongs to;
// this module turns each item into the event kinds Claude turns already use,
// so the transcript's existing tool renderers draw Codex rows unchanged:
// commands are `Bash`, file changes `Edit` (with every changed path), MCP and
// dynamic tool calls `mcp__<server>__<tool>`, web searches `WebSearch`.
// `userMessage` items echo what Kawai sent and are suppressed. Turn
// boundaries, async questions, compaction, and token usage are returned as
// typed outputs the driver acts on.
import type { ChatEvent, ChatQuestion, ChatTurnUsage } from '../../../shared/chat'
import type { ChatActivityInput } from '../chatActivity'
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { Turn } from './protocol/v2/Turn'
import type { ThreadTokenUsage } from './protocol/v2/ThreadTokenUsage'
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** A chat event before the driver stamps id, sequence, and time. */
export type CodexEventDraft = DistributiveOmit<ChatEvent, 'id' | 'sequence' | 'at'>

/** What one notification asks of the driver. */
export type CodexOutput =
  | { kind: 'event'; draft: CodexEventDraft }
  | { kind: 'activity'; input: ChatActivityInput }
  | { kind: 'turn_started'; codexTurnId: string }
  | { kind: 'turn_completed'; turn: Turn }
  /** An async question (0.163.0: an agentMessage carrying `questions`). */
  | { kind: 'question'; itemId: string; questions: ChatQuestion[] }
  | { kind: 'compaction'; itemId: string }
  | { kind: 'token_usage'; usage: ThreadTokenUsage }
  | { kind: 'rate_limits'; snapshot: RateLimitSnapshot }

/** The Kawai tool name of a dynamic or MCP tool call. */
export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`

/** The team tools' dynamic-tool namespace (design D6). */
export const TEAM_NAMESPACE = 'kawai-team'

type Item = ThreadItem & { id: string }

/** One notification's outputs; `turnId` is the Kawai turn it belongs to. */
export function mapCodexNotification(
  method: string,
  params: Record<string, unknown>,
  turnId: string,
): CodexOutput[] {
  switch (method) {
    case 'turn/started': {
      const turn = params.turn as { id?: unknown } | undefined
      return typeof turn?.id === 'string' ? [{ kind: 'turn_started', codexTurnId: turn.id }] : []
    }
    case 'turn/completed': {
      const turn = params.turn as Turn | undefined
      return turn && typeof turn.id === 'string' ? [{ kind: 'turn_completed', turn }] : []
    }
    case 'item/agentMessage/delta': {
      const delta = params.delta
      const itemId = params.itemId
      if (typeof delta !== 'string' || typeof itemId !== 'string' || delta === '') return []
      return [
        { kind: 'activity', input: { type: 'block_start', blockType: 'text' } },
        { kind: 'event', draft: { type: 'assistant_delta', turnId, messageId: itemId, delta } },
      ]
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/summaryPartAdded':
    case 'item/reasoning/textDelta':
      return [{ kind: 'activity', input: { type: 'block_start', blockType: 'thinking' } }]
    case 'thread/tokenUsage/updated': {
      const usage = params.tokenUsage as ThreadTokenUsage | undefined
      return usage && typeof usage === 'object' && usage.last ? [{ kind: 'token_usage', usage }] : []
    }
    case 'account/rateLimits/updated': {
      const snapshot = params.rateLimits
      return snapshot && typeof snapshot === 'object' ? [{ kind: 'rate_limits', snapshot: snapshot as RateLimitSnapshot }] : []
    }
    case 'item/started':
      return itemStarted(params.item as Item | undefined, turnId)
    case 'item/completed':
      return itemCompleted(params.item as Item | undefined, turnId)
    default:
      return []
  }
}

/** A started item: tool calls open their row; reasoning shows Thinking. */
export function itemStarted(item: Item | undefined, turnId: string): CodexOutput[] {
  if (!item || typeof item.id !== 'string') return []
  if (item.type === 'reasoning') return [{ kind: 'activity', input: { type: 'block_start', blockType: 'thinking' } }]
  if (item.type === 'agentMessage') {
    // 0.163.0 announces an async question on the item's start and expects
    // the answer before completing it; the driver dedupes by item id.
    const questions = asyncQuestions(item.questions)
    return questions ? [{ kind: 'question', itemId: item.id, questions }] : []
  }
  const call = toolCallOf(item)
  if (!call) return []
  return [
    { kind: 'event', draft: { type: 'tool_call', turnId, toolCallId: item.id, tool: call.tool, input: call.input } },
    { kind: 'activity', input: { type: 'tool_call', toolCallId: item.id, tool: call.tool } },
  ]
}

/** A completed item: the final text, a tool result, a question, or compaction. */
export function itemCompleted(item: Item | undefined, turnId: string): CodexOutput[] {
  if (!item || typeof item.id !== 'string') return []
  switch (item.type) {
    case 'agentMessage': {
      const questions = asyncQuestions(item.questions)
      const out: CodexOutput[] = []
      if (item.text.trim() !== '') {
        out.push({ kind: 'event', draft: { type: 'assistant_text', turnId, messageId: item.id, text: item.text } })
      }
      if (questions) out.push({ kind: 'question', itemId: item.id, questions })
      return out
    }
    case 'contextCompaction':
      return [{ kind: 'compaction', itemId: item.id }]
    default: {
      const result = toolResultOf(item)
      if (!result) return []
      return [
        { kind: 'event', draft: { type: 'tool_result', turnId, toolCallId: item.id, output: result.output, ...(result.isError ? { isError: true } : {}) } },
        { kind: 'activity', input: { type: 'tool_result', toolCallId: item.id } },
      ]
    }
  }
}

/** The Kawai tool name and input of a tool-shaped item, or null. */
export function toolCallOf(item: Item): { tool: string; input: Record<string, unknown> } | null {
  switch (item.type) {
    case 'commandExecution':
      return { tool: 'Bash', input: { command: item.command, cwd: item.cwd } }
    case 'fileChange': {
      const paths = item.changes.map(change => change.path)
      return {
        tool: 'Edit',
        input: {
          file_path: paths[0] ?? '',
          paths,
          changes: item.changes.map(change => ({ path: change.path, kind: change.kind.type })),
        },
      }
    }
    case 'mcpToolCall':
      return { tool: mcpToolName(item.server, item.tool), input: argumentsOf(item.arguments) }
    case 'dynamicToolCall':
      return { tool: mcpToolName(item.namespace ?? 'dynamic', item.tool), input: argumentsOf(item.arguments) }
    case 'webSearch':
      return { tool: 'WebSearch', input: { query: item.query } }
    case 'collabAgentToolCall':
    case 'subAgentActivity': {
      // Non-goal: no worker roster for Codex; these render as plain tools.
      const { id: _id, type, ...rest } = item as Record<string, unknown>
      return { tool: String(type), input: rest }
    }
    default:
      return null
  }
}

/** A completed tool-shaped item's transcript result, or null. */
export function toolResultOf(item: Item): { output: string; isError: boolean } | null {
  switch (item.type) {
    case 'commandExecution': {
      const exit = item.exitCode === null ? '' : `${item.aggregatedOutput ? '\n' : ''}(exit code ${item.exitCode})`
      const declined = item.status === 'declined' ? 'The command was declined.' : ''
      return {
        output: `${item.aggregatedOutput ?? declined}${exit}`,
        isError: item.status === 'failed' || item.status === 'declined' || (item.exitCode ?? 0) !== 0,
      }
    }
    case 'fileChange': {
      const failed = item.status !== 'completed'
      const count = item.changes.length
      return {
        output: failed ? `The file change ${item.status}.` : `Changed ${count} file${count === 1 ? '' : 's'}: ${item.changes.map(change => change.path).join(', ')}`,
        isError: failed,
      }
    }
    case 'mcpToolCall':
      if (item.error) return { output: item.error.message, isError: true }
      return { output: mcpContentText(item.result?.content), isError: item.status === 'failed' }
    case 'dynamicToolCall':
      return {
        output: (item.contentItems ?? []).map(entry => (entry.type === 'inputText' ? entry.text : `[${entry.type}]`)).join('\n'),
        isError: item.success === false || item.status === 'failed',
      }
    case 'webSearch':
      return { output: `Searched: ${item.query}`, isError: false }
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return { output: JSON.stringify((item as { status?: unknown }).status ?? 'done'), isError: false }
    default:
      return null
  }
}

/**
 * The turn_completed draft for a finished Codex turn, plus the error event a
 * failed turn shows. Interrupted turns are the driver's (it already emitted
 * turn_interrupted); this maps completed and failed ones.
 */
export function turnCompletedDrafts(turn: Turn, turnId: string, usage?: ChatTurnUsage): CodexEventDraft[] {
  const failed = turn.status === 'failed' || turn.error !== null
  const info = turn.error?.codexErrorInfo
  const reason = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined
  const drafts: CodexEventDraft[] = [{
    type: 'turn_completed',
    turnId,
    subtype: failed ? 'error_during_execution' : 'success',
    ...(failed ? { isError: true } : {}),
    ...(reason ? { terminalReason: reason } : {}),
    ...(usage ? { usage } : {}),
    ...(!failed ? finalTextOf(turn) : {}),
  }]
  if (failed) {
    const message = turn.error?.message?.trim() || 'The Codex turn failed'
    drafts.push({ type: 'error', message: reason ? `${message} (${reason})` : message })
  }
  return drafts
}

/** The turn's tokens as the difference of two thread totals. */
export function turnUsageBetween(before: TokenUsageBreakdown | null, after: TokenUsageBreakdown | null): ChatTurnUsage | undefined {
  if (!after) return undefined
  const delta = (key: keyof TokenUsageBreakdown) => Math.max(0, after[key] - (before?.[key] ?? 0))
  return {
    inputTokens: Math.max(0, delta('inputTokens') - delta('cachedInputTokens')),
    outputTokens: delta('outputTokens'),
    cacheReadTokens: delta('cachedInputTokens'),
    cacheCreationTokens: delta('cacheWriteInputTokens'),
  }
}

/** Async questions (title + options) as question cards; null when none. */
export function asyncQuestions(raw: unknown): ChatQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: ChatQuestion[] = []
  for (const entry of raw) {
    const title = (entry as { title?: unknown } | null)?.title
    if (typeof title !== 'string' || title.trim() === '') continue
    const options = (entry as { options?: unknown }).options
    questions.push({
      question: title,
      header: '',
      multiSelect: false,
      options: Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string').map(label => ({ label })) : [],
    })
  }
  return questions.length > 0 ? questions : null
}

function finalTextOf(turn: Turn): { finalText?: string } {
  const last = [...(turn.items ?? [])].reverse().find(item => item.type === 'agentMessage')
  return last && last.type === 'agentMessage' && last.text ? { finalText: last.text } : {}
}

function argumentsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { arguments: value }
}

function mcpContentText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    const text = (block as { text?: unknown } | null)?.text
    return typeof text === 'string' ? text : JSON.stringify(block)
  }).join('\n')
}
