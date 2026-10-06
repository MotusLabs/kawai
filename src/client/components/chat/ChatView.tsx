// Attach on selection and reconnect; detaching never stops the agent. The
// Debug toggle opens the protocol-frame panel beside the transcript (in place
// of it on narrow screens); its subscription follows the same reconnect rules.
// Archived chats render read-only: the transcript and debug view stay, the
// composer/Stop/request actions are replaced by a Restore bar, and archiving
// a live turn asks for confirmation first (the server interrupts it).
import { useClaudeProfiles } from './useClaudeProfiles'
import { useEffect, useRef, useState } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { emptyTranscript, useChatStore } from '../../stores/chatStore'
import { closedDebugView, useChatDebugStore } from '../../stores/chatDebugStore'
import ChatDebugPanel from './ChatDebugPanel'
import ChatMessages from './ChatMessages'
import ChatRequests from './ChatRequests'

const EMPTY = emptyTranscript()
const CLOSED_DEBUG = closedDebugView()

export default function ChatView({ session, sendMessage, connectionStatus, connectionEpoch, error, onClose, onKill }: {
  session: Session; sendMessage: SendClientMessage; connectionStatus: ConnectionStatus; connectionEpoch: number
  error: string | null; onClose: () => void; onKill: () => void
}) {
  const catalog = useClaudeProfiles(true)
  const profileId = session.claudeProfileId ?? 'default'
  const profileLabel = catalog.profiles.find(profile => profile.id === profileId)?.label ?? profileId
  const transcript = useChatStore(state => state.sessions[session.id]) ?? EMPTY
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const connected = connectionStatus === 'connected'
  const archived = session.archivedAt != null
  useEffect(() => {
    if (!connected) return
    sendMessage({ type: 'chat-attach', sessionId: session.id })
    return () => sendMessage({ type: 'chat-detach', sessionId: session.id })
  }, [session.id, connected, connectionEpoch, sendMessage])
  const debug = useChatDebugStore(state => state.views[session.id]) ?? CLOSED_DEBUG
  const debugOpen = debug.open
  useEffect(() => {
    if (!connected || !debugOpen) return
    useChatDebugStore.getState().beginOpen(session.id)
    sendMessage({ type: 'chat-debug-open', sessionId: session.id })
    return () => sendMessage({ type: 'chat-debug-close', sessionId: session.id })
  }, [session.id, connected, connectionEpoch, debugOpen, sendMessage])
  const toggleDebug = () => {
    const store = useChatDebugStore.getState()
    if (debugOpen) store.close(session.id)
    else store.beginOpen(session.id)
  }
  const handleArchive = () => {
    // Confirmation is a client concern (chat-archive design D3): a turn in
    // flight is interrupted by the archive, so ask first.
    const busy = session.status === 'working' || session.status === 'permission'
    if (busy && !window.confirm(`Archive "${session.name}"? A turn is in flight and will be interrupted.`)) return
    sendMessage({ type: 'chat-archive', sessionId: session.id })
  }
  useEffect(() => { setText('') }, [session.id])
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [transcript.events.length, transcript.throughSequence])
  return <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-base text-primary" data-testid="chat-view">
    <header className="flex items-center gap-3 border-b border-border p-3">
      <button className="btn md:hidden" onClick={onClose}>Sessions</button>
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">{session.name} · Chat</h2>
        <p className="text-xs text-secondary" data-testid="chat-profile">Profile: {profileLabel}</p>
        <p className="truncate text-xs text-secondary">{session.projectPath}</p></div>
      <span className="text-xs text-secondary" data-testid="chat-status">{connected ? (archived ? 'archived' : session.status) : connectionStatus}</span>
      <button className={`btn text-xs ${debugOpen ? 'btn-primary' : ''}`} aria-pressed={debugOpen} onClick={toggleDebug}>Debug</button>
      {!archived && <button className="btn text-xs" onClick={handleArchive} data-testid="chat-archive-button">Archive</button>}
      <button className="btn text-xs" onClick={onKill}>Kill session</button>
    </header>
    {error && <p role="alert" className="border-b border-border p-3 text-sm text-red-400">{error}</p>}
    <div className="flex min-h-0 flex-1">
      <div className={`min-h-0 min-w-0 flex-1 flex-col ${debugOpen ? 'hidden md:flex' : 'flex'}`}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-3xl space-y-4">
            <ChatMessages events={transcript.events} />
            {!archived && <ChatRequests requests={transcript.pendingRequests} sessionId={session.id} sendMessage={sendMessage} disabled={!connected} />}
            <div ref={end} />
          </div>
        </div>
        {archived ? (
          <div className="border-t border-border p-3" data-testid="chat-archived-bar">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
              <p className="text-xs text-secondary">Archived — read-only. Restore to continue this conversation.</p>
              <button className="btn btn-primary text-xs" onClick={() => sendMessage({ type: 'chat-restore', sessionId: session.id })}
                disabled={!connected}>Restore</button>
            </div>
          </div>
        ) : (
          <form className="border-t border-border p-3" onSubmit={event => {
            event.preventDefault()
            if (!connected || !text.trim()) return
            sendMessage({ type: 'chat-send', sessionId: session.id, text: text.trim() })
            setText('')
          }}>
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <textarea aria-label="Message Claude" className="input min-h-20 flex-1 resize-y" value={text}
                disabled={!connected} placeholder="Message Claude…" onChange={event => setText(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
              <button className="btn btn-primary" disabled={!connected || !text.trim()}>Send</button>
              <button type="button" className="btn" disabled={!connected || session.status === 'waiting'}
                onClick={() => sendMessage({ type: 'chat-interrupt', sessionId: session.id })}>Stop</button>
            </div>
          </form>
        )}
      </div>
      {debugOpen && <ChatDebugPanel key={session.id} sessionId={session.id} view={debug} sendMessage={sendMessage}
        connected={connected} onClose={toggleDebug} />}
    </div>
  </main>
}
