// Read-only transcript entries; active approval/question controls live
// separately. Tool-call summaries add a one-line input detail (paths relative
// to the session's project) and tool-result summaries a first-line hint, each
// ellipsizing with the full value on hover.
import type { ChatEvent } from '@shared/chat'
import Markdown from '../Markdown'
import { toolCallDetail, toolResultDetail } from './toolCallLabel'

/**
 * `<summary>` whose optional parenthetical detail shrinks instead of wrapping.
 * The chevron and label share one line (see `.chat-summary`); only the detail
 * ellipsizes, with the full value on hover.
 */
function SummaryLabel({ label, detail }: { label: string; detail: string | null }) {
  return <summary className="chat-summary">
    <span className="shrink-0">{label}</span>
    {detail !== null && <>
      <span className="shrink-0">{' ('}</span>
      <span className="min-w-0 truncate" title={detail}>{detail}</span>
      <span className="shrink-0">)</span>
    </>}
  </summary>
}

export default function ChatMessages({ events, projectPath }: { events: ChatEvent[]; projectPath?: string }) {
  return <div className="space-y-4" data-testid="chat-transcript">
    {events.map(event => {
      switch (event.type) {
        case 'user_message':
          return <article key={event.id} data-chat-role="user" className="ml-8 border border-border bg-elevated p-3">
            <div className="mb-1 text-chat-meta text-secondary">You</div>
            <p className="whitespace-pre-wrap break-words text-chat-body">{event.text}</p>
          </article>
        case 'assistant_text':
          return <article key={event.id} data-chat-role="assistant" className="mr-8 p-3">
            <div className="mb-1 text-chat-meta text-secondary">Claude</div>
            <Markdown content={event.text} />
          </article>
        case 'tool_call': {
          const detail = toolCallDetail(event.tool, event.input, projectPath)
          return <details key={event.id} className="border-l-2 border-border px-3 text-chat-meta text-secondary">
            <SummaryLabel label={`Tool: ${event.tool}`} detail={detail} />
            <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(event.input, null, 2)}</pre>
          </details>
        }
        case 'tool_result': {
          const hint = toolResultDetail(event.output)
          return <details key={event.id} className="px-3 text-chat-meta text-secondary">
            <SummaryLabel label={event.isError ? 'Tool failed' : 'Tool result'} detail={hint} />
            <pre className="mt-2 overflow-auto whitespace-pre-wrap">{event.output}</pre>
          </details>
        }
        case 'command_output':
          return <div key={event.id} data-testid="chat-command-output" data-chat-role="assistant"
            className="mx-3 border-l-2 border-border px-3 py-2 font-mono text-xs text-secondary">
            <div className="mb-1 text-xs">Command output</div>
            <Markdown content={event.text} />
          </div>
        case 'notice': return <p key={event.id} className="text-chat-meta text-secondary">{event.text}</p>
        case 'error': return <p key={event.id} role="alert" className="text-chat-body text-chat-danger">{event.message}</p>
        case 'turn_interrupted': return <p key={event.id} className="text-chat-meta text-secondary">Turn stopped</p>
        case 'request_resolved': {
          // Who decided: policy grants stand apart from the user's own calls.
          if (event.decidedBy === 'policy') {
            return <p key={event.id} className="text-chat-meta text-secondary" data-testid="auto-approved">
              Auto-approved {event.tool ?? 'tool'}
            </p>
          }
          if (event.decidedBy === 'user' && (event.outcome === 'allowed' || event.outcome === 'denied')) {
            return <p key={event.id} className="text-chat-meta text-secondary">
              {event.outcome === 'allowed' ? 'Allowed' : 'Denied'} by user
            </p>
          }
          return <p key={event.id} className="text-chat-meta text-secondary">Request {event.outcome}</p>
        }
        case 'turn_completed': return <p key={event.id} className="text-chat-meta text-muted">
          Turn complete · {event.subtype}{event.totalCostUsd !== undefined ? ` · $${event.totalCostUsd.toFixed(4)}` : ''}
          {event.numTurns !== undefined ? ` · ${event.numTurns} turns` : ''}
        </p>
        default: return null
      }
    })}
  </div>
}
