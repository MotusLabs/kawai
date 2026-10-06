// Read-only transcript entries; active approval/question controls live separately.
import type { ChatEvent } from '@shared/chat'
import Markdown from '../Markdown'

export default function ChatMessages({ events }: { events: ChatEvent[] }) {
  return <div className="space-y-4" data-testid="chat-transcript">
    {events.map(event => {
      switch (event.type) {
        case 'user_message':
          return <article key={event.id} data-chat-role="user" className="ml-8 border border-border bg-elevated p-3">
            <div className="mb-1 text-xs text-secondary">You</div>
            <p className="whitespace-pre-wrap break-words text-sm">{event.text}</p>
          </article>
        case 'assistant_text':
          return <article key={event.id} data-chat-role="assistant" className="mr-8 p-3">
            <div className="mb-1 text-xs text-secondary">Claude</div>
            <Markdown content={event.text} />
          </article>
        case 'tool_call':
          return <details key={event.id} className="border-l-2 border-border px-3 text-xs text-secondary">
            <summary>Tool: {event.tool}</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(event.input, null, 2)}</pre>
          </details>
        case 'tool_result':
          return <details key={event.id} className="px-3 text-xs text-secondary">
            <summary>{event.isError ? 'Tool failed' : 'Tool result'}</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap">{event.output}</pre>
          </details>
        case 'notice': return <p key={event.id} className="text-xs text-secondary">{event.text}</p>
        case 'error': return <p key={event.id} role="alert" className="text-sm text-red-400">{event.message}</p>
        case 'turn_interrupted': return <p key={event.id} className="text-xs text-secondary">Turn stopped</p>
        case 'request_resolved': return <p key={event.id} className="text-xs text-secondary">Request {event.outcome}</p>
        case 'turn_completed': return <p key={event.id} className="text-xs text-muted">
          Turn complete · {event.subtype}{event.totalCostUsd !== undefined ? ` · $${event.totalCostUsd.toFixed(4)}` : ''}
          {event.numTurns !== undefined ? ` · ${event.numTurns} turns` : ''}
        </p>
        default: return null
      }
    })}
  </div>
}
