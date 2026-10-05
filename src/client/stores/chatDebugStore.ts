// Chat debug view state per session: captured wire frames kept sorted and
// deduplicated by sequence. The server subscribes a debug view before reading
// its first page, so the open reply replaces stale frames but keeps any live
// frame newer than the page; older pages and live batches merge by sequence.
// Live growth is capped by dropping the oldest frames (which stay loadable).
import { create } from 'zustand'
import type { ChatWireFrame } from '@shared/chat'
import type { ServerMessage } from '@shared/types'

export const MAX_DEBUG_FRAMES = 5000

export interface ChatDebugView {
  open: boolean
  frames: ChatWireFrame[]
  hasOlder: boolean
  loadingOlder: boolean
  /** An open request is in flight; its page reply replaces stale frames. */
  awaitingOpen: boolean
}

export const closedDebugView = (): ChatDebugView => ({
  open: false, frames: [], hasOlder: false, loadingOlder: false, awaitingOpen: false,
})

export function mergeFrames(existing: ChatWireFrame[], incoming: ChatWireFrame[]): ChatWireFrame[] {
  const bySeq = new Map<number, ChatWireFrame>()
  for (const frame of existing) bySeq.set(frame.seq, frame)
  for (const frame of incoming) bySeq.set(frame.seq, frame)
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq)
}

type DebugFramesMessage = Extract<ServerMessage, { type: 'chat-debug-frames' }>

export function applyDebugFrames(view: ChatDebugView, message: DebugFramesMessage): ChatDebugView {
  if (!view.open) return view
  if (message.page && view.awaitingOpen) {
    const newest = message.frames.at(-1)?.seq ?? 0
    return {
      ...view,
      frames: mergeFrames(message.frames, view.frames.filter(frame => frame.seq > newest)),
      hasOlder: message.hasOlder ?? false,
      awaitingOpen: false,
    }
  }
  if (message.page) {
    return {
      ...view,
      frames: mergeFrames(view.frames, message.frames),
      hasOlder: message.hasOlder ?? false,
      loadingOlder: false,
    }
  }
  const frames = mergeFrames(view.frames, message.frames)
  if (frames.length <= MAX_DEBUG_FRAMES) return { ...view, frames }
  return { ...view, frames: frames.slice(frames.length - MAX_DEBUG_FRAMES), hasOlder: true }
}

interface ChatDebugStore {
  views: Record<string, ChatDebugView>
  /** Open (or re-open after reconnect): the next page reply is authoritative. */
  beginOpen: (sessionId: string) => void
  close: (sessionId: string) => void
  beginLoadOlder: (sessionId: string) => void
  apply: (message: DebugFramesMessage) => void
}

export const useChatDebugStore = create<ChatDebugStore>((set) => {
  const update = (sessionId: string, change: (view: ChatDebugView) => ChatDebugView) =>
    set(state => ({ views: { ...state.views, [sessionId]: change(state.views[sessionId] ?? closedDebugView()) } }))
  return {
    views: {},
    beginOpen: sessionId => update(sessionId, view => ({ ...view, open: true, awaitingOpen: true, loadingOlder: false })),
    close: sessionId => set(state => {
      const views = { ...state.views }
      delete views[sessionId]
      return { views }
    }),
    beginLoadOlder: sessionId => update(sessionId, view => ({ ...view, loadingOlder: true })),
    apply: message => update(message.sessionId, view => applyDebugFrames(view, message)),
  }
})
