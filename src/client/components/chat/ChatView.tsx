// Attach on selection and reconnect; detaching never stops the agent. The
// Debug toggle opens the protocol-frame panel beside the transcript (in place
// of it on narrow screens); its subscription follows the same reconnect rules.
// The Auto-approve toggle switches the session's approval policy live (amber
// while on); it renders from the broadcast Session, never local state.
// During an in-flight turn an activity row (design D6) follows ChatMessages:
// the live phase with a client-ticked timer, hidden while text streams, while
// a request awaits the user, and in archived chats (design D4).
// Archived chats render read-only: the transcript and debug view stay, the
// composer/Stop/request actions are replaced by a Restore bar, and archiving
// a live turn asks for confirmation first (the server interrupts it).
// The root opts into `chat-palette`, the chat view's reduced-glare dark palette,
// and `chat-root`, whose --chat-font-size (Settings "Chat Font Size") sizes
// chat text through the em-based text-chat-body / text-chat-meta utilities.
import { useClaudeProfiles } from './useClaudeProfiles'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { emptyTranscript, useChatStore } from '../../stores/chatStore'
import { closedDebugView, useChatDebugStore } from '../../stores/chatDebugStore'
import ChatActivityRow from './ChatActivityRow'
import ChatDebugPanel from './ChatDebugPanel'
import ChatMessages from './ChatMessages'
import ChatRequests from './ChatRequests'
import { requestChatArchive } from '../../utils/chatArchive'

const EMPTY = emptyTranscript()
const CLOSED_DEBUG = closedDebugView()

export default function ChatView({ session, sendMessage, connectionStatus, connectionEpoch, error, onClose, onKill }: {
  session: Session; sendMessage: SendClientMessage; connectionStatus: ConnectionStatus; connectionEpoch: number
  error: string | null; onClose: () => void; onKill: () => void
}) {
  const catalog = useClaudeProfiles(true, session.projectPath)
  const profileId = session.claudeProfileId ?? 'default'
  const profileLabel = catalog.profiles.find(profile => profile.id === profileId)?.label ?? profileId
  const chatFontSize = useSettingsStore(state => state.chatFontSize)
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
  const handleArchive = () => { requestChatArchive(session, sendMessage) }
  // Approval policy (chat-auto-approve-tools design D6): rendered from the
  // broadcast Session so every client agrees; archived chats hide the control.
  const autoApprove = session.approvalPolicy === 'auto'
  const toggleApprovalPolicy = () => {
    sendMessage({
      type: 'chat-set-approval-policy',
      sessionId: session.id,
      policy: autoApprove ? 'manual' : 'auto',
    })
  }
  useEffect(() => { setText('') }, [session.id])
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [transcript.events.length, transcript.throughSequence])
  // Activity row hiding rules (design D4): text streaming is its own visible
  // progress, a pending approval/question owns the footer, and archived chats
  // are read-only — none of them also show the live phase row.
  const activity = transcript.activity
  const showActivity =
    !archived &&
    activity !== null &&
    activity.value.phase !== 'responding' &&
    transcript.pendingRequests.length === 0
  return <main className="chat-palette chat-root flex min-h-0 min-w-0 flex-1 flex-col bg-base text-primary" data-testid="chat-view"
    style={{ '--chat-font-size': `${chatFontSize}px` } as CSSProperties}>
    <header className="flex items-center gap-3 border-b border-border p-3">
      <button className="btn text-chat-meta md:hidden" onClick={onClose}>Sessions</button>
      <div className="min-w-0 flex-1"><h2 className="truncate text-chat-body font-medium">{session.name} · Chat</h2>
        <p className="text-chat-meta text-secondary" data-testid="chat-profile">Profile: {profileLabel}</p>
        <p className="truncate text-chat-meta text-secondary">{session.projectPath}</p></div>
      <span className="text-chat-meta text-secondary" data-testid="chat-status">{connected ? (archived ? 'archived' : session.status) : connectionStatus}</span>
      <button className={`btn text-chat-meta ${debugOpen ? 'btn-primary' : ''}`} aria-pressed={debugOpen} onClick={toggleDebug}>Debug</button>
      {!archived && <button className={`btn text-chat-meta ${autoApprove ? 'btn-approval-on' : ''}`} aria-pressed={autoApprove}
        onClick={toggleApprovalPolicy} data-testid="chat-approval-policy">Auto-approve</button>}
      {!archived && <button className="btn text-chat-meta" onClick={handleArchive} data-testid="chat-archive-button">Archive</button>}
      <button className="btn text-chat-meta" onClick={onKill}>Kill session</button>
    </header>
    {error && <p role="alert" className="border-b border-border p-3 text-chat-body text-chat-danger">{error}</p>}
    <div className="flex min-h-0 flex-1">
      <div className={`min-h-0 min-w-0 flex-1 flex-col ${debugOpen ? 'hidden md:flex' : 'flex'}`}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-3xl space-y-4">
            <ChatMessages events={transcript.events} projectPath={session.projectPath} />
            {showActivity && (
              <ChatActivityRow activity={activity.value} phaseStartedAt={activity.phaseStartedAt} />
            )}
            {!archived && <ChatRequests requests={transcript.pendingRequests} sessionId={session.id} sendMessage={sendMessage} disabled={!connected} />}
            <div ref={end} />
          </div>
        </div>
        {archived ? (
          <div className="border-t border-border p-3" data-testid="chat-archived-bar">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
              <p className="text-chat-meta text-secondary">Archived — read-only. Restore to continue this conversation.</p>
              <button className="btn btn-primary text-chat-meta" onClick={() => sendMessage({ type: 'chat-restore', sessionId: session.id })}
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
              <textarea aria-label="Message Claude" className="input chat-composer min-h-20 flex-1 resize-y text-chat-body" value={text}
                disabled={!connected} placeholder="Message Claude…" onChange={event => setText(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
              <button className="btn btn-primary text-chat-meta" disabled={!connected || !text.trim()}>Send</button>
              <button type="button" className="btn text-chat-meta" disabled={!connected || session.status === 'waiting'}
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
