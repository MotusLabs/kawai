// The live strip (workers design D8, background tasks D2): one muted line
// per worker or background task still running, above the transcript.
// Liveness, not status, decides membership — a worker in the completion gap
// (running, already left the background set) shows nowhere and holds nothing.
// Each row carries its own live detail and a client-ticked elapsed; task rows
// add a per-task Stop (design D4) that ends only that task. The strip hides
// itself when nothing is live or the chat is archived (ChatView's decision,
// like the activity row).
import { useMemo, useState } from 'react'
import type { SendClientMessage } from '@shared/types'
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

function TaskStripRow({ sessionId, taskId, kind, description, startedAtMs, sendMessage, connected }: {
  sessionId: string
  taskId: string
  kind: 'shell' | 'monitor'
  description?: string
  startedAtMs: number
  sendMessage?: SendClientMessage
  connected?: boolean
}) {
  const now = useTickingClock(true)
  const [stopping, setStopping] = useState(false)
  return (
    <p className="flex items-center gap-2 text-chat-meta text-secondary" data-testid="chat-task-strip-row" data-task-id={taskId}>
      <span className="chat-activity-dot" aria-hidden="true" />
      <span className="shrink-0">{kind === 'monitor' ? 'Monitor' : 'Shell'}</span>
      {description !== undefined && <span className="min-w-0 truncate" title={description}>{description}</span>}
      <span className="shrink-0" data-testid="chat-task-strip-elapsed">
        {formatElapsed(now - startedAtMs)}
      </span>
      <button type="button"
        className="ml-auto shrink-0 rounded border border-border px-2 text-xs text-secondary hover:bg-elevated disabled:opacity-50"
        data-testid="chat-task-strip-stop" disabled={stopping || connected === false}
        onClick={() => {
          if (stopping) return
          setStopping(true)
          sendMessage?.({ type: 'chat-task-stop', sessionId, taskId })
        }}>
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </p>
  )
}

export default function ChatWorkersStrip({ sessionId, sendMessage, connected }: {
  sessionId: string
  sendMessage?: SendClientMessage
  connected?: boolean
}) {
  const workers = useChatStore(state => state.sessions[sessionId]?.workers)
  const tasks = useChatStore(state => state.sessions[sessionId]?.backgroundTasks)
  const liveWorkers = useMemo(() => (workers ?? []).filter(worker => worker.live), [workers])
  const liveTasks = useMemo(() => (tasks ?? []).filter(task => task.live), [tasks])
  if (liveWorkers.length === 0 && liveTasks.length === 0) return null
  return (
    <div className="space-y-1 border-b border-border px-4 py-2" data-testid="chat-workers-strip">
      {liveWorkers.map(worker => (
        <WorkerStripRow
          key={worker.workerId}
          agentType={worker.agentType}
          description={worker.description}
          lastTool={worker.lastTool}
          startedAt={worker.startedAt}
        />
      ))}
      {liveTasks.map(task => (
        <TaskStripRow
          key={task.taskId}
          sessionId={sessionId}
          taskId={task.taskId}
          kind={task.kind}
          description={task.description}
          startedAtMs={task.startedAtMs}
          sendMessage={sendMessage}
          connected={connected}
        />
      ))}
    </div>
  )
}
