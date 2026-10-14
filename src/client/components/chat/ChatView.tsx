// Attach on selection and reconnect; detaching never stops the agent. The
// header (ChatHeader, chat-header-layout D1) renders identity, status, and
// controls from props; this view owns the side-slot subscriptions, which
// follow the same reconnect rules. The side slot beside the transcript (in
// place of it on narrow screens) holds one panel at a time — Debug, Mailbox,
// Tasks, Messages, or Strategy — opened through `toggleSideSlot`; a chat
// working on a task opens that task from the header (team-tasks 7.3), and
// the Mailbox panel keeps its delivery operations (team-message-threads 5.4).
// The approval policy renders from the broadcast Session, never local state.
// During an in-flight turn an activity row (design D6) follows ChatMessages:
// the live phase with a client-ticked timer, hidden while text streams, while
// a request awaits the user, and in archived chats (design D4).
// Under the header, the usage bar is joined by the notification strip
// (notification strip design D7): the session's active notices, styled by
// severity and closable, hidden when there are none.
// Archived chats render read-only: the transcript and debug view stay, the
// composer/Stop/request actions are replaced by a Restore bar, and archiving
// a live turn asks for confirmation first (the server interrupts it).
// Unsubmitted composer text is kept per session across switches and archive/restore.
// Submitting clears that session draft; killing discards it; reload drops all drafts.
// The composer opens a slash-command menu for the `/` word at the caret,
// anywhere in the message (slash-anywhere design D1/D2): choosing replaces
// just that word with `/<name> ` without sending, Enter falls through when
// nothing matches, and /clear /reset /new compose a new chat only when they
// are the whole message.
// The root opts into `chat-palette`, the chat view's reduced-glare dark palette,
// and `chat-root`, whose --chat-font-size (Settings "Chat Font Size") sizes
// chat text through the em-based text-chat-body / text-chat-meta utilities.
import { useClaudeProfiles } from './useClaudeProfiles'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SendClientMessage, ServerMessage, Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { emptyTranscript, useChatStore } from '../../stores/chatStore'
import { closedDebugView, useChatDebugStore } from '../../stores/chatDebugStore'
import ChatActivityRow from './ChatActivityRow'
import ChatHeader from './ChatHeader'
import ChatDebugPanel from './ChatDebugPanel'
import ChatMessages from './ChatMessages'
import TeamMailboxPanel from './TeamMailboxPanel'
import { useTeamGroups } from './useTeamGroups'
import { closedMailbox, useTeamMailboxStore } from '../../stores/teamMailboxStore'
import TeamTasksPanel from './TeamTasksPanel'
import { closedTaskView, useTeamTaskStore } from '../../stores/teamTaskStore'
import TeamMessagesPanel from './TeamMessagesPanel'
import { closedMessageView, useTeamMessageStore } from '../../stores/teamMessageStore'
import { closeOtherSideSlots, toggleSideSlot, useOpenSideSlot } from './sideSlot'
import { openParticipantChat } from './openParticipant'
import { useSessionStore } from '../../stores/sessionStore'
import ProductStrategyPanel from './ProductStrategyPanel'
import { closedStrategyView, useStrategyStore } from '../../stores/strategyStore'
import ChatRequests from './ChatRequests'
import ChatWorkersStrip from './ChatWorkersStrip'
import NotificationStrip from './NotificationStrip'
import SlashCommandMenu from './SlashCommandMenu'
import UsageBar from './UsageBar'
import { filterChatCommands, insertCommand, slashTokenAt } from './slashCommandFilter'
import { requestChatArchive } from '../../utils/chatArchive'

const EMPTY = emptyTranscript()
const CLOSED_DEBUG = closedDebugView()
const CLOSED_MAILBOX = closedMailbox()
const CLOSED_TASKS = closedTaskView()
const CLOSED_MESSAGES = closedMessageView()
const CLOSED_STRATEGY = closedStrategyView()

/** `/clear`, `/reset`, `/new` — optionally followed by the new chat's name. */
const CLEAR_COMMAND = /^\/(clear|reset|new)(?:\s+(.*))?$/

export default function ChatView({ session, sendMessage, subscribe, connectionStatus, connectionEpoch, error, onClose, onKill, onCreateWorktree }: {
  session: Session; sendMessage: SendClientMessage; connectionStatus: ConnectionStatus; connectionEpoch: number
  error: string | null; onClose: () => void; onKill: () => void
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  /** Opens the worktree-creation flow for the session's repository (task pickers). */
  onCreateWorktree?: () => void
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
  const toggleDebug = () => toggleSideSlot('debug', session.id)
  const mailbox = useTeamMailboxStore(state => state.views[session.id]) ?? CLOSED_MAILBOX
  const teamGroups = useTeamGroups(mailbox.open, session.projectPath)
  useEffect(() => {
    if (!connected || !mailbox.open) return
    useTeamMailboxStore.getState().open(session.id)
    sendMessage({ type: 'team-mailbox-open', sessionId: session.id })
    return () => sendMessage({ type: 'team-mailbox-close', sessionId: session.id })
  }, [session.id, connected, connectionEpoch, mailbox.open, sendMessage])
  const toggleMailbox = () => toggleSideSlot('mailbox', session.id)
  const tasks = useTeamTaskStore(state => state.views[session.id]) ?? CLOSED_TASKS
  useEffect(() => {
    if (!connected || !tasks.open) return
    sendMessage({ type: 'team-tasks-open', sessionId: session.id })
    return () => sendMessage({ type: 'team-tasks-close', sessionId: session.id })
  }, [session.id, connected, connectionEpoch, tasks.open, sendMessage])
  const selectedTaskId = tasks.open ? tasks.selectedTaskId : null
  useEffect(() => {
    if (!connected || !selectedTaskId) return
    sendMessage({ type: 'team-task-open', sessionId: session.id, taskId: selectedTaskId })
    return () => sendMessage({ type: 'team-task-close', sessionId: session.id, taskId: selectedTaskId })
  }, [session.id, connected, connectionEpoch, selectedTaskId, sendMessage])
  const openTasks = (taskId?: string) => {
    closeOtherSideSlots('tasks', session.id)
    useTeamTaskStore.getState().open(session.id, taskId)
  }
  const toggleTasks = () => toggleSideSlot('tasks', session.id)
  // Messages (team-message-threads 5.4): the host-agnostic feed in the same
  // side slot. Its subscription is owned by the view itself, so this only
  // decides whether the panel is mounted.
  const messages = useTeamMessageStore(state => state.views[session.id]) ?? CLOSED_MESSAGES
  // Naming message participants (team-message-threads D3): live rows come from
  // the session list, and whichever side panel has been open last supplies the
  // team directory that names a killed one `Name (gone)`.
  const liveSessions = useSessionStore(state => state.sessions)
  const participantDirectory = messages.directory.length > 0 ? messages.directory : tasks.directory
  const toggleMessages = () => toggleSideSlot('messages', session.id)
  // A task's messages link into the thread in the Messages view (5.4): the
  // side slot flips to Messages and the thread opens.
  const openThread = (threadId: string) => {
    closeOtherSideSlots('messages', session.id)
    const store = useTeamMessageStore.getState()
    store.open(session.id)
    store.select(session.id, threadId)
  }
  // Product strategy (product-strategy 5.1): same side slot, team-scoped.
  const strategy = useStrategyStore(state => state.views[session.id]) ?? CLOSED_STRATEGY
  useEffect(() => {
    if (!connected || !strategy.open) return
    sendMessage({ type: 'strategy-open', sessionId: session.id })
    return () => sendMessage({ type: 'strategy-close', sessionId: session.id })
  }, [session.id, connected, connectionEpoch, strategy.open, sendMessage])
  const toggleStrategy = () => toggleSideSlot('strategy', session.id)
  const openSlot = useOpenSideSlot(session.id)
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
        // Clone this chat's setup, mirroring the profile: a cleared chat is
        // the same working session with a fresh conversation, not a new pick
        // from the dialog. Legacy sessions without a stored policy read manual.
        approvalPolicy: session.approvalPolicy ?? 'manual',
        // A grouped chat clones its server-owned role even if its file is gone.
        ...(session.groupId ? { groupId: session.groupId, cloneFromSessionId: session.id } : {}),
      })
      return
    }
    sendMessage({ type: 'chat-send', sessionId: session.id, text: trimmed })
  }
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [transcript.events.length, transcript.throughSequence])

  // Slash-command menu: open while the caret is inside a `/` word anywhere in
  // the message (slash-command-autocomplete-anywhere design D2) and a list can
  // exist. Escape dismisses until the token changes; Enter/Tab choose only with
  // a highlighted match, so unknown commands still send as typed.
  const commandState = transcript.commands
  const [highlighted, setHighlighted] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [caret, setCaret] = useState<number | null>(null)
  const token = useMemo(() => (caret == null ? null : slashTokenAt(text, caret)), [text, caret])
  useEffect(() => { setHighlighted(0); setMenuDismissed(false) }, [token?.start, token?.query])
  const menuOpen =
    token !== null && !menuDismissed && commandState.status !== 'unavailable'
  const matches = useMemo(
    () => (menuOpen && token ? filterChatCommands(commandState.commands, token.query) : []),
    [menuOpen, commandState.commands, token]
  )
  // Choosing replaces only the token's word, in place (design D3): the caret
  // state lands just after the inserted `/name `, and the layout effect below
  // restores the DOM caret there after the choice commits. The restore is
  // keyed on a fresh object per choice, not on the text: choosing a command
  // that is already spelled out in the word leaves the value unchanged, so a
  // text-keyed effect would never fire — the DOM caret would stay mid-word and
  // the stale restore would land on the next keystroke instead.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [caretRestore, setCaretRestore] = useState<{ caret: number } | null>(null)
  useLayoutEffect(() => {
    if (caretRestore) composerRef.current?.setSelectionRange(caretRestore.caret, caretRestore.caret)
  }, [caretRestore])
  const chooseCommand = (name: string) => {
    if (!token) return
    const next = insertCommand(text, token, name)
    setText(next.text)
    setCaret(next.caret)
    setCaretRestore({ caret: next.caret })
  }
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
  // The caret drives the slash menu (design D2). A non-collapsed selection has
  // no single caret and keeps the menu closed; when the event carries no
  // selectionStart (the test renderer), typing left the caret at the end.
  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { value, selectionStart, selectionEnd } = event.target
    setText(value)
    if (selectionStart == null) setCaret(value.length)
    else setCaret(selectionStart === selectionEnd ? selectionStart : null)
  }
  // onSelect covers caret moves that never type: arrows, clicks, selections.
  const handleComposerSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const { selectionStart, selectionEnd } = event.target as HTMLTextAreaElement
    if (selectionStart == null) return
    setCaret(selectionStart === selectionEnd ? selectionStart : null)
  }
  // The argument hint of a just-inserted or typed `/<name> ` directly before
  // the caret (design D4) shows until the user types arguments (the
  // trailing-space match stops matching then).
  const hintName = caret == null ? null : /(?:^|\s)\/(\S+) $/.exec(text.slice(0, caret))?.[1]
  const hintCommand = hintName
    ? commandState.commands.find(
        (command) => command.name === hintName || command.aliases.includes(hintName)
      )
    : undefined
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
    <ChatHeader session={session} profileLabel={profileLabel} model={transcript.model} contextUsage={transcript.contextUsage}
      connectionStatus={connectionStatus} openSlot={openSlot} onToggleSlot={slot => toggleSideSlot(slot, session.id)}
      onOpenTask={openTasks} onRename={name => sendMessage({ type: 'session-rename', sessionId: session.id, newName: name })}
      onToggleApproval={toggleApprovalPolicy} onArchive={handleArchive} onKill={onKill} onClose={onClose}
      fontSizePx={chatFontSize} />
    <UsageBar report={usage} />
    {/* The notification strip (design D7): under the header, beside the
        usage bar. Archived chats are read-only surfaces that no agent feeds,
        so they render account notices only (design D4). */}
    <NotificationStrip
      notifications={
        archived
          ? transcript.notifications.filter((notice) => notice.source === 'account')
          : transcript.notifications
      }
      onClose={(notice) =>
        useChatStore.getState().closeNotification(session.id, notice, sendMessage)
      }
    />
    {error && <p role="alert" className="border-b border-border p-3 text-chat-body text-chat-danger">{error}</p>}
    <div className="flex min-h-0 flex-1">
      <div className={`min-h-0 min-w-0 flex-1 flex-col ${openSlot ? 'hidden md:flex' : 'flex'}`}>
        {/* The live-workers strip (design D8): live rows only, hidden in
            archived chats and when nothing runs (the strip hides itself). */}
        {!archived && <ChatWorkersStrip sessionId={session.id} sendMessage={sendMessage} connected={connected} />}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-3xl space-y-4">
            <ChatMessages events={transcript.events} projectPath={session.projectPath}
              sessionId={session.id} sendMessage={sendMessage} connected={connected}
              archived={archived}
              sessions={liveSessions} directory={participantDirectory} onOpenParticipant={openParticipantChat} />
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
                <textarea ref={composerRef} aria-label="Message Claude" className="input chat-composer min-h-20 flex-1 resize-y text-chat-body" value={text}
                  disabled={!connected} placeholder="Message Claude…" onChange={handleComposerChange}
                  onSelect={handleComposerSelect} onKeyDown={handleComposerKeyDown} />
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
      {mailbox.open && <TeamMailboxPanel sessionId={session.id} view={mailbox} sendMessage={sendMessage} connected={connected} onClose={toggleMailbox}
        groups={teamGroups.groups.map(group => group.id)} sessions={liveSessions} onOpenSession={openParticipantChat} />}
      {tasks.open && <TeamTasksPanel sessionId={session.id} projectPath={session.projectPath} view={tasks} sendMessage={sendMessage}
        connected={connected} onClose={toggleTasks} onOpenThread={openThread} onCreateWorktree={onCreateWorktree} />}
      {messages.open && <TeamMessagesPanel sessionId={session.id} projectPath={session.projectPath} sendMessage={sendMessage}
        connected={connected} connectionEpoch={connectionEpoch} onClose={toggleMessages} />}
      {strategy.open && <ProductStrategyPanel sessionId={session.id} view={strategy} sendMessage={sendMessage} connected={connected} onClose={toggleStrategy} />}
      {debugOpen && <ChatDebugPanel key={session.id} sessionId={session.id} view={debug} sendMessage={sendMessage}
        connected={connected} onClose={toggleDebug} />}
    </div>
  </main>
}
