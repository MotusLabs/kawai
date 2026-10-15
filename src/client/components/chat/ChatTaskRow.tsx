// One background task's tool entry (background tasks design D2-D4): the
// Bash/Monitor tool_call rendered with its roster state — a running mark and
// ticking elapsed while live, the outcome mark and one-line summary once
// settled (✗ on failed). Expanding fetches the output tail (at most the last
// 8 KiB, plain text, ANSI stripped, truncation noted) through the store's
// reply cache and, while the task runs and the entry stays open, re-fetches
// every 2 s with one request in flight; an ended task fetches once. A Stop
// control ends only this task and never appears in archived chats. With no
// roster entry (a foreground call, or a replay the server never saw start),
// the caller's plain tool card renders instead.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SendClientMessage } from '@shared/types'
import { useChatStore } from '../../stores/chatStore'
import { formatElapsed, useTickingClock } from './chatElapsed'

/** Settled-state labels; running renders live instead of a pill. */
const STATUS_LABEL = {
  completed: 'done',
  failed: '✗ failed',
  stopped: 'stopped',
} as const

/** ANSI escape sequences (CSI and OSC): shown as plain text, never interpreted. */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g

export default function ChatTaskRow({ sessionId, toolCallId, tool, fallback, sendMessage, connected, archived }: {
  sessionId: string
  toolCallId: string
  tool: string
  /** The plain tool card, shown while no roster entry exists. */
  fallback: ReactNode
  sendMessage?: SendClientMessage
  connected?: boolean
  archived?: boolean
}) {
  const task = useChatStore(state =>
    state.sessions[sessionId]?.backgroundTasks.find(candidate => candidate.toolCallId === toolCallId)
  )
  const tail = useChatStore(state => state.taskOutputs[sessionId]?.[task?.taskId ?? ''])
  const now = useTickingClock(task?.live === true)
  const [stopping, setStopping] = useState(false)
  const openRef = useRef(false)
  /** A request was skipped because one was in flight; run it on its reply. */
  const retryOnReply = useRef(false)
  const live = task?.live === true

  const requestTail = () => {
    if (task === undefined || connected === false) return
    if (useChatStore.getState().requestTaskOutput(sessionId, task.taskId)) {
      sendMessage?.({ type: 'chat-task-output', sessionId, taskId: task.taskId })
    } else {
      // Blocked by the in-flight request: queue this one, or a settle-time
      // fetch would be silently dropped and the in-flight (running-time)
      // reply would stand as the final output.
      retryOnReply.current = true
    }
  }

  // Hooks must run before the fallback return below.
  useEffect(() => {
    // A socket that dies mid-fetch strands the marker: roll it back so the
    // reopened socket can request the tail again. Its reply is gone, so any
    // queued retry goes with it — the reconnect effect re-fetches.
    if (connected === false && task !== undefined) {
      useChatStore.getState().resetTaskOutput(sessionId, task.taskId)
      retryOnReply.current = false
    }
  }, [connected, sessionId, task])
  // The in-flight reply landed (the marker left 'fetching'): run one queued
  // request, if any — the settle's final refresh after a blocked poll.
  useEffect(() => {
    if (retryOnReply.current && tail !== undefined && tail.status !== 'fetching') {
      retryOnReply.current = false
      if (openRef.current) requestTail()
    }
  }, [tail])
  useEffect(() => {
    // Reconnect retries the fetch for the row the user still has open.
    if (connected !== true || !openRef.current || task === undefined) return
    requestTail()
  }, [connected, sessionId, task?.taskId])

  // Re-poll while expanded and live (design D3): the interval fires through
  // the one-shot marker, so an in-flight request never doubles up. The
  // connection is a dependency so a row mounted (or last re-created) while
  // disconnected refreshes its callback — otherwise the interval keeps a
  // `connected: false` closure and never polls again after a reconnect.
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => {
      if (openRef.current) requestTail()
    }, 2_000)
    return () => clearInterval(id)
  }, [live, task?.taskId, connected])

  // A row still open when the task settles fetches the final tail once
  // (design D3: ended tasks fetch once) instead of keeping the last running
  // snapshot until it is collapsed and reopened.
  useEffect(() => {
    if (!live && openRef.current) requestTail()
  }, [live])

  // The settle arrives through the roster; any change re-arms the control.
  useEffect(() => { setStopping(false) }, [task?.status, task?.live])

  // No roster entry: the plain card, exactly like any other tool.
  if (!task) return fallback

  const handleToggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    openRef.current = event.currentTarget.open
    if (event.currentTarget.open) requestTail()
    else retryOnReply.current = false
  }

  const stop = () => {
    if (stopping) return
    setStopping(true)
    sendMessage?.({ type: 'chat-task-stop', sessionId, taskId: task.taskId })
  }

  return <details className="border-l-2 border-border px-3 text-chat-meta text-secondary"
    data-testid="chat-task-row" data-task-id={task.taskId} data-status={task.status} data-kind={task.kind}
    onToggle={handleToggle}>
    <summary className="chat-summary gap-2">
      {live && <span className="chat-activity-dot shrink-0" aria-hidden="true" />}
      <span className="shrink-0">{tool}{task.kind === 'monitor' ? ' · Monitor' : ''}</span>
      {task.description !== undefined && (
        <span className="min-w-0 truncate" title={task.description}>{task.description}</span>
      )}
      {live ? (
        <span className="shrink-0" data-testid="chat-task-elapsed">
          {formatElapsed(now - task.startedAtMs)}
        </span>
      ) : (
        <span className="shrink-0" data-testid="chat-task-status">
          {task.status === 'running' ? '' : STATUS_LABEL[task.status]}
        </span>
      )}
      {live && !archived && (
        <button type="button"
          className="ml-auto shrink-0 rounded border border-border px-2 text-xs text-secondary hover:bg-elevated disabled:opacity-50"
          data-testid="chat-task-stop" disabled={stopping || connected === false}
          onClick={stop}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      )}
    </summary>
    <div className="mt-2">
      {task.summary !== undefined && (
        <p className="text-chat-body text-secondary" data-testid="chat-task-summary">{task.summary}</p>
      )}
      {tail === undefined || tail.status === 'fetching' ? (
        <p className="text-xs text-muted" data-testid="chat-task-output-status">
          {connected === false ? 'Output unavailable — reconnect to load it.' : 'Loading…'}
        </p>
      ) : tail.status === 'unavailable' ? (
        <p className="text-xs text-muted" data-testid="chat-task-output-status">
          Output unavailable — it can no longer be read.
        </p>
      ) : (
        <div className="mt-1" data-testid="chat-task-output">
          {tail.truncated && (
            <p className="text-xs text-muted" data-testid="chat-task-output-truncated">Earlier output was omitted</p>
          )}
          <pre className="mt-1 overflow-auto whitespace-pre-wrap text-xs">{tail.output.replace(ANSI_ESCAPE, '')}</pre>
        </div>
      )}
    </div>
  </details>
}
