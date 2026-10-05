// Debug view of one chat session's raw Claude Code protocol: captured frames in
// sequence order with direction, time, and type; each expands to pretty JSON
// and copies its exact raw line. Older frames load on demand; the list follows
// the live tail only while the user is scrolled to the bottom.
import { useEffect, useRef, useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import { useChatDebugStore, type ChatDebugView } from '../../stores/chatDebugStore'
import { copyText } from '../../utils/copyText'
import { DIRECTION_LABELS, frameLabel, frameTime, prettyFrame } from '../../utils/chatWireFrames'

const DIRECTION_STYLES: Record<keyof typeof DIRECTION_LABELS, string> = {
  out: 'text-sky-400',
  in: 'text-emerald-400',
  stderr: 'text-amber-400',
  lifecycle: 'text-secondary',
}

export default function ChatDebugPanel({ sessionId, view, sendMessage, connected, onClose }: {
  sessionId: string; view: ChatDebugView; sendMessage: SendClientMessage; connected: boolean; onClose: () => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const newestSeq = view.frames.at(-1)?.seq
  useEffect(() => {
    const element = list.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [newestSeq])
  const toggle = (seq: number) => setExpanded(current => {
    const next = new Set(current)
    if (next.has(seq)) next.delete(seq)
    else next.add(seq)
    return next
  })
  const loadOlder = () => {
    const oldest = view.frames[0]
    if (!oldest) return
    useChatDebugStore.getState().beginLoadOlder(sessionId)
    sendMessage({ type: 'chat-debug-page', sessionId, beforeSeq: oldest.seq })
  }
  return <aside data-testid="chat-debug-panel" aria-label="Protocol frames"
    className="flex min-h-0 min-w-0 flex-1 flex-col border-border md:max-w-[50%] md:border-l">
    <header className="flex items-center gap-2 border-b border-border px-3 py-2">
      <h3 className="flex-1 text-xs font-medium">Protocol frames <span className="text-secondary">· {view.frames.length}</span></h3>
      <button className="btn text-xs" onClick={onClose}>Close</button>
    </header>
    <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-xs" onScroll={event => {
      const element = event.currentTarget
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
    }}>
      {view.hasOlder && <button className="btn mb-2 w-full text-xs" disabled={!connected || view.loadingOlder} onClick={loadOlder}>
        {view.loadingOlder ? 'Loading…' : 'Load older'}
      </button>}
      {view.frames.length === 0 && <p className="p-2 font-sans text-secondary">
        {view.awaitingOpen ? 'Loading…' : 'No protocol traffic recorded for this session yet.'}
      </p>}
      {view.frames.map(frame => {
        const open = expanded.has(frame.seq)
        return <div key={frame.seq} data-frame-seq={frame.seq} className="border-b border-border">
          <button className="flex w-full items-baseline gap-2 py-1 text-left hover:bg-elevated" aria-expanded={open}
            onClick={() => toggle(frame.seq)}>
            <span className={`w-16 shrink-0 ${DIRECTION_STYLES[frame.dir]}`}>{DIRECTION_LABELS[frame.dir]}</span>
            <span className="shrink-0 text-muted">{frameTime(frame)}</span>
            <span className="shrink-0 text-muted">#{frame.seq}</span>
            <span className="truncate">{frameLabel(frame)}</span>
          </button>
          {open && <div className="relative mb-2">
            <button className="btn absolute right-1 top-1 text-xs" onClick={() => copyText(frame.raw)}>Copy</button>
            <pre className="overflow-auto whitespace-pre-wrap break-all bg-elevated p-2 pr-16">{prettyFrame(frame)}</pre>
          </div>}
        </div>
      })}
    </div>
  </aside>
}
