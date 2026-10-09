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
// Unsubmitted composer text is kept per session across switches and archive/restore.
// Submitting clears that session draft; killing discards it; reload drops all drafts.
// The composer opens a slash-command menu while the text is a bare "/command"
// (design D5): choosing inserts `/<name> ` without sending, Enter falls
// through when nothing matches, and /clear /reset /new compose a new chat.
// The root opts into `chat-palette`, the chat view's reduced-glare dark palette,
// and `chat-root`, whose --chat-font-size (Settings "Chat Font Size") sizes
// chat text through the em-based text-chat-body / text-chat-meta utilities.
import { useClaudeProfiles } from './useClaudeProfiles'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SendClientMessage, ServerMessage, Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { emptyTranscript, useChatStore } from '../../stores/chatStore'
import { closedDebugView, useChatDebugStore } from '../../stores/chatDebugStore'
import ChatActivityRow from './ChatActivityRow'
import ChatDebugPanel from './ChatDebugPanel'
import ChatMessages from './ChatMessages'
import ChatRequests from './ChatRequests'
import SlashCommandMenu from './SlashCommandMenu'
import UsageBar from './UsageBar'
import { filterChatCommands, slashMenuQuery } from './slashCommandFilter'
import { requestChatArchive } from '../../utils/chatArchive'

const EMPTY = emptyTranscript()
const CLOSED_DEBUG = closedDebugView()

/** `/clear`, `/reset`, `/new` — optionally followed by the new chat's name. */
const CLEAR_COMMAND = /^\/(clear|reset|new)(?:\s+(.*))?$/

export default function ChatView({ session, sendMessage, subscribe, connectionStatus, connectionEpoch, error, onClose, onKill }: {
  session: Session; sendMessage: SendClientMessage; connectionStatus: ConnectionStatus; connectionEpoch: number
  error: string | null; onClose: () => void; onKill: () => void
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
}) {
  const catalog = useClaudeProfiles(true, session.projectPath)
  const profileId = session.claudeProfileId ?? 'default'
  const profileLabel = catalog.profiles.find(profile => profile.id === profileId)?.label ?? profileId
  const chatFontSize = useSettingsStore(state => state.chatFontSize)
  const transcript = useChatStore(state => state.sessions[session.id]) ?? EMPTY
  // Plan usage is per profile (usage bar design D4): every session of the
  // profile renders the same shared report.
  const usage = useChatStore(state => state.usage[profileId]) ?? null
  const text = useChatStore(state => state.drafts[session.id] ?? '')
  const setDraft = useChatStore(state => state.setDraft)
  const setText = (value: string) => setDraft(session.id, value)
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
  // `/clear` composition (design D6): remember which session awaits archival;
  // the matching session-created (a new chat in this project) archives it,
  // an error reply leaves it untouched. Never sent to the agent.
  const pendingClearRef = useRef<string | null>(null)
  useEffect(() => { pendingClearRef.current = null }, [session.id])
  useEffect(() => {
    if (!subscribe) return
    return subscribe((message) => {
      const previous = pendingClearRef.current
      if (!previous) return
      if (
        message.type === 'session-created' &&
        message.session.id !== previous &&
        message.session.kind === 'chat' &&
        message.session.projectPath === session.projectPath
      ) {
        pendingClearRef.current = null
        sendMessage({ type: 'chat-archive', sessionId: previous })
      } else if (message.type === 'error') {
        // The creation failed: the old chat stays exactly as it was.
        pendingClearRef.current = null
      }
    })
  }, [subscribe, sendMessage, session.projectPath])
  const submitText = (trimmed: string) => {
    const clear = CLEAR_COMMAND.exec(trimmed)
    if (clear) {
      const name = clear[2]?.trim()
      pendingClearRef.current = session.id
      sendMessage({
        type: 'session-create',
        projectPath: session.projectPath,
        kind: 'chat',
        ...(name ? { name } : {}),
        claudeProfileId: profileId,
      })
      return
    }
    sendMessage({ type: 'chat-send', sessionId: session.id, text: trimmed })
  }
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [transcript.events.length, transcript.throughSequence])

  // Slash-command menu: open while the text is a bare "/command" and a list
  // can exist. Escape dismisses until the text changes; Enter/Tab choose only
  // with a highlighted match, so unknown commands still send as typed.
  const commandState = transcript.commands
  const [highlighted, setHighlighted] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  useEffect(() => { setHighlighted(0); setMenuDismissed(false) }, [text])
  const menuOpen =
    slashMenuQuery(text) !== null && !menuDismissed && commandState.status !== 'unavailable'
  const matches = useMemo(
    () => (menuOpen ? filterChatCommands(commandState.commands, text) : []),
    [menuOpen, commandState.commands, text]
  )
  const chooseCommand = (name: string) => { setText(`/${name} `) }
  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlighted((highlighted + 1) % matches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlighted((highlighted - 1 + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const chosen = matches[highlighted] ?? matches[0]!
        chooseCommand(chosen.name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuDismissed(true)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }
  // The argument hint of a just-inserted or typed `/<name> ` shows until the
  // user types arguments (the trailing-space match stops matching then).
  const hintName = /^\/(\S+) $/.exec(text)?.[1]
  const hintCommand = hintName
    ? commandState.commands.find(
        (command) => command.name === hintName || command.aliases.includes(hintName)
      )
    : undefined
  // Header rename (chat-session-naming): the title edits in place. A blank
  // submit just exits editing — the server's empty-name refusal belongs to
  // paths that can send one. The draft follows broadcast renames while not
  // being edited, so another client's rename shows here without a reload.
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(session.name)
  useEffect(() => { setEditingName(false); setNameDraft(session.name) }, [session.id])
  useEffect(() => { if (!editingName) setNameDraft(session.name) }, [session.name, editingName])
  const submitName = () => {
    const trimmed = nameDraft.trim()
    setEditingName(false)
    if (trimmed && trimmed !== session.name) {
      sendMessage({ type: 'session-rename', sessionId: session.id, newName: trimmed })
    }
  }
  const handleNameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitName()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setNameDraft(session.name)
      setEditingName(false)
    }
  }
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
      <div className="min-w-0 flex-1">
        {editingName ? (
          <input data-testid="chat-name-input" autoFocus aria-label="Session name"
            className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-chat-body font-medium text-primary outline-none focus:border-accent"
            value={nameDraft} onChange={event => setNameDraft(event.target.value)}
            onBlur={submitName} onKeyDown={handleNameKeyDown} />
        ) : (
          <h2 className="cursor-text truncate text-chat-body font-medium" title="Rename"
            data-testid="chat-name" onClick={() => setEditingName(true)}>{session.name} · Chat</h2>
        )}
        <p className="text-chat-meta text-secondary" data-testid="chat-profile">Profile: {profileLabel}</p>
        <p className="truncate text-chat-meta text-secondary">{session.projectPath}</p></div>
      <span className="text-chat-meta text-secondary" data-testid="chat-status">{connected ? (archived ? 'archived' : session.status) : connectionStatus}</span>
      <button className={`btn text-chat-meta ${debugOpen ? 'btn-primary' : ''}`} aria-pressed={debugOpen} onClick={toggleDebug}>Debug</button>
      {!archived && <button className={`btn text-chat-meta ${autoApprove ? 'btn-approval-on' : ''}`} aria-pressed={autoApprove}
        onClick={toggleApprovalPolicy} data-testid="chat-approval-policy">Auto-approve</button>}
      {!archived && <button className="btn text-chat-meta" onClick={handleArchive} data-testid="chat-archive-button">Archive</button>}
      <button className="btn text-chat-meta" onClick={onKill}>Kill session</button>
    </header>
    <UsageBar report={usage} />
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
            submitText(text.trim())
            setText('')
          }}>
            <div className="mx-auto max-w-3xl">
              {menuOpen && (
                <div className="mb-2">
                  <SlashCommandMenu matches={matches} loading={commandState.status === 'loading'}
                    highlightedIndex={highlighted} onHighlight={setHighlighted}
                    onChoose={command => chooseCommand(command.name)} />
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea aria-label="Message Claude" className="input chat-composer min-h-20 flex-1 resize-y text-chat-body" value={text}
                  disabled={!connected} placeholder="Message Claude…" onChange={event => setText(event.target.value)}
                  onKeyDown={handleComposerKeyDown} />
                <button className="btn btn-primary text-chat-meta" disabled={!connected || !text.trim()}>Send</button>
                <button type="button" className="btn text-chat-meta" disabled={!connected || session.status === 'waiting'}
                  onClick={() => sendMessage({ type: 'chat-interrupt', sessionId: session.id })}>Stop</button>
              </div>
              {hintCommand?.argumentHint && (
                <p className="mt-1 font-mono text-xs text-muted" data-testid="command-argument-hint">
                  /{hintCommand.name} {hintCommand.argumentHint}
                </p>
              )}
            </div>
          </form>
        )}
      </div>
      {debugOpen && <ChatDebugPanel key={session.id} sessionId={session.id} view={debug} sendMessage={sendMessage}
        connected={connected} onClose={toggleDebug} />}
    </div>
  </main>
}
