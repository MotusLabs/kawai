// The live-workers strip (design D8): one muted line per worker still
// running, above the transcript. Liveness, not status, decides membership —
// a worker in the completion gap (running, already left the background set)
// shows nowhere and holds nothing. Each row carries its own last tool and a
// client-ticked elapsed; the strip hides itself when no worker is live or
// the chat is archived (ChatView's decision, like the activity row).
import { useMemo } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { formatElapsed, useTickingClock } from './chatElapsed'

function WorkerStripRow({ agentType, description, lastTool, startedAt }: {
  agentType?: string
  description?: string
  lastTool?: string
  startedAt: number
}) {
  const now = useTickingClock(true)
  return (
    <p className="flex items-center gap-2 text-chat-meta text-secondary" data-testid="chat-worker-strip-row">
      <span className="chat-activity-dot" aria-hidden="true" />
      <span className="shrink-0">{agentType ?? 'Agent'}</span>
      {description !== undefined && <span className="min-w-0 truncate" title={description}>{description}</span>}
      {lastTool !== undefined && <span className="shrink-0">{`· ${lastTool}`}</span>}
      <span className="shrink-0" data-testid="chat-worker-strip-elapsed">
        {formatElapsed(now - startedAt)}
      </span>
    </p>
  )
}

export default function ChatWorkersStrip({ sessionId }: { sessionId: string }) {
  const workers = useChatStore(state => state.sessions[sessionId]?.workers)
  const live = useMemo(() => (workers ?? []).filter(worker => worker.live), [workers])
  if (live.length === 0) return null
  return (
    <div className="space-y-1 border-b border-border px-4 py-2" data-testid="chat-workers-strip">
      {live.map(worker => (
        <WorkerStripRow
          key={worker.workerId}
          agentType={worker.agentType}
          description={worker.description}
          lastTool={worker.lastTool}
          startedAt={worker.startedAt}
        />
      ))}
    </div>
  )
}
