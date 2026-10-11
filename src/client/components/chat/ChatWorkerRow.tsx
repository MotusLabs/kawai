// One spawned worker's row (design D8): the Agent/Task tool_call rendered as
// a lifecycle summary — agent type, description, status, elapsed, last tool —
// joining the roster by workerId. The depth badge marks nested spawns
// (depth > 1) and is omitted when unknown. Expanding fetches the worker's
// on-disk transcript once (design D5) and caches it in the store; a missing
// file reports the body unavailable. With no roster entry (a replayed
// transcript the server never saw spawn), the row renders the caller's plain
// tool card instead. Archived chats render the same row read-only from its
// persisted outcome; expand stays available. The transcript renderer is the
// caller's too (`renderBody`), so the body reads exactly like the parent.
import type { ReactNode } from 'react'
import type { ChatEvent } from '@shared/chat'
import type { SendClientMessage } from '@shared/types'
import { useChatStore } from '../../stores/chatStore'
import { formatElapsed, useTickingClock } from './chatElapsed'

/** Settled-state labels; running renders live instead of a pill. */
const STATUS_LABEL = {
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
} as const

export default function ChatWorkerRow({ sessionId, workerId, tool, fallback, renderBody, sendMessage, connected }: {
  sessionId: string
  workerId: string
  tool: string
  /** The plain tool card, shown while no roster entry exists. */
  fallback: ReactNode
  /** Renders the worker's own transcript once its body arrives. */
  renderBody: (events: ChatEvent[]) => ReactNode
  sendMessage?: SendClientMessage
  connected?: boolean
}) {
  const worker = useChatStore(state =>
    state.sessions[sessionId]?.workers.find(candidate => candidate.workerId === workerId)
  )
  const body = useChatStore(state => state.workerBodies[sessionId]?.[workerId])
  const now = useTickingClock(worker?.live === true)

  // No roster entry: the plain card, exactly like any other tool.
  if (!worker) return fallback

  // First expand fetches once (design D5); the reply lands in the store.
  const handleToggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) return
    if (useChatStore.getState().requestWorkerBody(sessionId, workerId)) {
      sendMessage?.({
        type: 'chat-worker-transcript',
        sessionId,
        workerId,
      })
    }
  }

  return <details className="border-l-2 border-border px-3 text-chat-meta text-secondary"
    data-testid="chat-worker-row" data-worker-id={workerId} data-status={worker.status}
    onToggle={handleToggle}>
    <summary className="chat-summary gap-2">
      {worker.live && <span className="chat-activity-dot shrink-0" aria-hidden="true" />}
      <span className="shrink-0">{tool}{worker.agentType ? ` · ${worker.agentType}` : ''}</span>
      {worker.depth !== undefined && worker.depth > 1 && (
        <span className="shrink-0 rounded border border-border px-1 text-xs" data-testid="chat-worker-depth">
          {`depth ${worker.depth}`}
        </span>
      )}
      {worker.description !== undefined && (
        <span className="min-w-0 truncate" title={worker.description}>{worker.description}</span>
      )}
      {worker.live ? (
        <>
          {worker.lastTool !== undefined && <span className="shrink-0">{`· ${worker.lastTool}`}</span>}
          <span className="shrink-0" data-testid="chat-worker-elapsed">
            {formatElapsed(now - worker.startedAt)}
          </span>
        </>
      ) : (
        // A gap worker (running, not live) shows no outcome label yet.
        <span className="shrink-0">
          {worker.status === 'running' ? '' : STATUS_LABEL[worker.status]}
        </span>
      )}
    </summary>
    <div className="mt-2">
      {worker.summary !== undefined && (
        <p className="text-chat-body text-secondary" data-testid="chat-worker-summary">{worker.summary}</p>
      )}
      {body === undefined || body.status === 'fetching' ? (
        <p className="text-xs text-muted" data-testid="chat-worker-body-status">
          {connected === false ? 'Body unavailable — reconnect to load it.' : 'Loading…'}
        </p>
      ) : body.status === 'unavailable' ? (
        <p className="text-xs text-muted" data-testid="chat-worker-body-status">
          Body unavailable — the worker transcript was not found.
        </p>
      ) : (
        <div className="mt-2" data-testid="chat-worker-body">{renderBody(body.events)}</div>
      )}
    </div>
  </details>
}
