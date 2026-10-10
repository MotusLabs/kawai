// Read-only transcript entries; active approval/question controls live
// separately. A tool call and its result pair into one entry per tool use
// (keyed by toolCallId, paths relative to the session's project), failed
// uses carry a ✗ mark, and expanding shows the input followed by the output.
import type { ChatEvent } from '@shared/chat'
import Markdown from '../Markdown'
import { toolCallHandle } from './toolCallLabel'

type ToolCallEvent = Extract<ChatEvent, { type: 'tool_call' }>
type ToolResultEvent = Extract<ChatEvent, { type: 'tool_result' }>

/** One tool use: its call and, once arrived, its result. */
type ToolUse = { call: ToolCallEvent | null; result: ToolResultEvent | null }

/** One transcript row: a plain event, or a grouped tool use. */
type Row = { key: string; event: ChatEvent } | { key: string; use: ToolUse }

/**
 * Orders the transcript into render rows, grouping a tool call and its later
 * result (same toolCallId) into one row at the call's position. A result
 * whose toolCallId matches no earlier call keeps its own row so replayed
 * partial history never hides agent output.
 */
function transcriptRows(events: ChatEvent[]): Row[] {
  const rows: Row[] = []
  const toolUses = new Map<string, ToolUse>()
  for (const event of events) {
    if (event.type === 'tool_call') {
      if (toolUses.has(event.toolCallId)) continue
      const use: ToolUse = { call: event, result: null }
      toolUses.set(event.toolCallId, use)
      rows.push({ key: event.toolCallId, use })
    } else if (event.type === 'tool_result') {
      const existing = toolUses.get(event.toolCallId)
      if (existing) {
        existing.result = event
      } else {
        // Orphan: no loaded call to pair with, so it stands alone.
        const use: ToolUse = { call: null, result: event }
        rows.push({ key: event.id, use })
      }
    } else {
      rows.push({ key: event.id, event })
    }
  }
  return rows
}

/**
 * `<summary>` whose optional handle shrinks instead of wrapping. The
 * chevron, failure mark and tool name share one line (see `.chat-summary`);
 * only the handle ellipsizes, with the full value on hover. The mark sits
 * outside the truncating span so it survives a long handle.
 */
function ToolUseSummary({ name, handle, failed }: { name: string; handle: string | null; failed: boolean }) {
  return <summary className="chat-summary">
    {failed && <span className="shrink-0 text-chat-danger" data-testid="tool-failed-mark">✗</span>}
    <span className="shrink-0">{name}</span>
    {handle !== null && <>
      <span className="shrink-0">{' ('}</span>
      <span className="min-w-0 truncate" title={handle}>{handle}</span>
      <span className="shrink-0">)</span>
    </>}
  </summary>
}

function ToolUseEntry({ use, projectPath }: { use: ToolUse; projectPath?: string }) {
  const { call, result } = use
  const handle = call === null ? null : toolCallHandle(call.tool, call.input, projectPath)
  return <details className="border-l-2 border-border px-3 text-chat-meta text-secondary">
    <ToolUseSummary name={call?.tool ?? 'Tool result'} handle={handle} failed={result?.isError === true} />
    {call !== null && <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(call.input, null, 2)}</pre>}
    {result !== null && <pre className="mt-2 overflow-auto whitespace-pre-wrap">{result.output}</pre>}
  </details>
}

function TranscriptEvent({ event }: { event: ChatEvent }) {
  switch (event.type) {
    case 'user_message':
      return <article data-chat-role="user" className="ml-8 border border-border bg-elevated p-3">
        <div className="mb-1 text-chat-meta text-secondary">You</div>
        <p className="whitespace-pre-wrap break-words text-chat-body">{event.text}</p>
      </article>
    case 'assistant_text':
      return <article data-chat-role="assistant" className="mr-8 p-3">
        <div className="mb-1 text-chat-meta text-secondary">Claude</div>
        <Markdown content={event.text} />
      </article>
    case 'command_output':
      return <div data-testid="chat-command-output" data-chat-role="assistant"
        className="mx-3 border-l-2 border-border px-3 py-2 font-mono text-xs text-secondary">
        <div className="mb-1 text-xs">Command output</div>
        <Markdown content={event.text} />
      </div>
    case 'notice': return <p className="text-chat-meta text-secondary">{event.text}</p>
    case 'error': return <p role="alert" className="text-chat-body text-chat-danger">{event.message}</p>
    case 'turn_interrupted': return <p className="text-chat-meta text-secondary">Turn stopped</p>
    case 'request_resolved': {
      // Who decided: policy grants stand apart from the user's own calls.
      if (event.decidedBy === 'policy') {
        return <p className="text-chat-meta text-secondary" data-testid="auto-approved">
          Auto-approved {event.tool ?? 'tool'}
        </p>
      }
      if (event.decidedBy === 'user' && (event.outcome === 'allowed' || event.outcome === 'denied')) {
        return <p className="text-chat-meta text-secondary">
          {event.outcome === 'allowed' ? 'Allowed' : 'Denied'} by user
        </p>
      }
      return <p className="text-chat-meta text-secondary">Request {event.outcome}</p>
    }
    case 'turn_completed': return <p className="text-chat-muted">
      Turn complete · {event.subtype}{event.totalCostUsd !== undefined ? ` · $${event.totalCostUsd.toFixed(4)}` : ''}
      {event.numTurns !== undefined ? ` · ${event.numTurns} turns` : ''}
    </p>
    default: return null
  }
}

export default function ChatMessages({ events, projectPath }: { events: ChatEvent[]; projectPath?: string }) {
  return <div className="space-y-4" data-testid="chat-transcript">
    {transcriptRows(events).map(row => 'use' in row
      ? <ToolUseEntry key={row.key} use={row.use} projectPath={projectPath} />
      : <TranscriptEvent key={row.key} event={row.event} />)}
  </div>
}
