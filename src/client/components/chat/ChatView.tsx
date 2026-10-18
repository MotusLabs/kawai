// Attach on selection and reconnect; detaching never stops the agent. The
// header (ChatHeader, chat-header-layout D1) renders identity, status, and
// controls from props. The side slot beside the transcript (in place of it
// on narrow screens) hosts only the debug panel (team-workspace-pages D4):
// the team views — Tasks, Messages, Mailbox, Strategy — live on the Team
// page, which the header's Team button and the task chip open for the chat's
// team key (D2), so every chat of one team shares them.
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
import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import type { SendClientMessage, ServerMessage, Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { emptyTranscript, useChatStore } from '../../stores/chatStore'
import { useRevealRow } from './useRevealRow'
import { closedDebugView, useChatDebugStore } from '../../stores/chatDebugStore'
import ChatActivityRow from './ChatActivityRow'
import ChatHeader from './ChatHeader'
import ChatDebugPanel from './ChatDebugPanel'
import ChatMessages from './ChatMessages'
import { useHistoryAnchor } from './useHistoryAnchor'
import { AsideRow } from './ChatRow'
import { agentLabelOf } from './transcriptLayout'
import { openParticipantChat } from './openParticipant'
import { useSessionStore } from '../../stores/sessionStore'
import { useTeamMessageStore } from '../../stores/teamMessageStore'
import ChatRequests from './ChatRequests'
import ChatWorkersStrip from './ChatWorkersStrip'
import NotificationStrip from './NotificationStrip'
import ChatComposer from './ChatComposer'
import UsageBar from './UsageBar'
import { requestChatArchive } from '../../utils/chatArchive'
import { teamKeyOf } from '../../utils/teamKey'
import { useWorkspaceStore } from '../../stores/workspaceStore'

const EMPTY = emptyTranscript()
const CLOSED_DEBUG = closedDebugView()
/** Stable empty list so an absent directory never re-renders (getSnapshot caching). */
const NO_DIRECTORY: never[] = []

/** `/clear`, `/reset`, `/new` — optionally followed by the new chat's name. */
const CLEAR_COMMAND = /^\/(clear|reset|new)(?:\s+(.*))?$/

export default function ChatView({ session, sendMessage, subscribe, connectionStatus, connectionEpoch, error, onClose, onKill, onOpenTeam, onOpenTask }: {
  session: Session; sendMessage: SendClientMessage; connectionStatus: ConnectionStatus; connectionEpoch: number
  error: string | null; onClose: () => void; onKill: () => void
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  /** Opens the Team page for the chat's team (the header's Team button). */
  onOpenTeam?: (teamKey: string) => void
  /** Opens the Team page's Tasks tab with one task (the task chip). */
  onOpenTask?: (teamKey: string, taskId: string) => void
}) {
  const catalog = useClaudeProfiles(true, session.projectPath)
  const profileId = session.claudeProfileId ?? 'default'
  const profileLabel = catalog.profiles.find(profile => profile.id === profileId)?.label ?? profileId
  const chatFontSize = useSettingsStore(state => state.chatFontSize)
  const transcript = useChatStore(state => state.sessions[session.id]) ?? EMPTY
  // Plan usage is per profile (usage bar design D4): every session of the
  // profile renders the same shared report.
  const usage = useChatStore(state => state.usage[profileId]) ?? null
  const end = useRef<HTMLDivElement>(null)
  const connected = connectionStatus === 'connected'
  const archived = session.archivedAt != null
  // Where this view's last attach landed (chat-history-window D3): the same
  // session re-running the effect is a reconnect, which resumes from the
  // window start the client still holds; a different session is an open,
  // which widens only what the user expanded in this page load.
  const lastAttachedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!connected) return
    const held = useChatStore.getState().sessions[session.id]
    const resume =
      lastAttachedRef.current === session.id || held?.historyExpanded === true
    const historyFrom = resume ? held?.historyStartId ?? undefined : undefined
    lastAttachedRef.current = session.id
    sendMessage({ type: 'chat-attach', sessionId: session.id, ...(historyFrom !== undefined ? { historyFrom } : {}) })
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
  // The chat's team key (team-workspace-pages D2): the Team button and the
  // task chip open the Team page for it, and every chat of one team agrees.
  const repositories = useWorkspaceStore(state => state.snapshot?.repositories)
  const teamKey = useMemo(() => teamKeyOf(session.projectPath, repositories), [session.projectPath, repositories])
  const liveSessions = useSessionStore(state => state.sessions)
  // Killed participants keep their names when a Messages view has loaded the
  // team directory (the Team page); a chat alone degrades to the raw id.
  const participantDirectory = useTeamMessageStore(state => state.views[teamKey]?.directory) ?? NO_DIRECTORY
  // Naming message participants (team-message-threads D3): live rows come
  // from the session list.
  const toggleDebug = () => useChatDebugStore.getState().views[session.id]?.open
    ? useChatDebugStore.getState().close(session.id)
    : useChatDebugStore.getState().beginOpen(session.id)
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
  // A pending search reveal owns the scroll position: stick-to-bottom yields
  // to it (the reveal hook below runs after this effect in the same commit).
  // After a history page prepends (chat-history-window D4), the stick skips
  // once instead of yanking the reader to the bottom.
  const transcriptBox = useRef<HTMLDivElement>(null)
  const { capture: captureHistoryAnchor, skipStickOnce: historyStickSkip } =
    useHistoryAnchor(transcriptBox, transcript.historyLoading)
  useEffect(() => {
    if (useChatStore.getState().pendingReveal?.sessionId === session.id) return
    if (historyStickSkip.current) {
      historyStickSkip.current = false
      return
    }
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [transcript.events.length, transcript.throughSequence, session.id])
  useRevealRow({ sessionId: session.id, loaded: transcript !== EMPTY, container: transcriptBox, sendMessage, eventCount: transcript.events.length })
  // Load earlier history (chat-history-window D4): claim the one page, keep
  // the first visible row still across the prepend, send the request.
  const loadEarlier = () => {
    const request = useChatStore.getState().requestOlder(session.id)
    if (!request) return
    captureHistoryAnchor()
    sendMessage(request)
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
    <ChatHeader session={session} profileLabel={profileLabel} model={transcript.model} contextUsage={transcript.contextUsage}
      connectionStatus={connectionStatus} debugOpen={debugOpen} onToggleDebug={toggleDebug}
      onOpenTeam={() => onOpenTeam?.(teamKey)} onOpenTask={taskId => onOpenTask?.(teamKey, taskId)}
      onRename={name => sendMessage({ type: 'session-rename', sessionId: session.id, newName: name })}
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
      <div className={`min-h-0 min-w-0 flex-1 flex-col ${debugOpen ? 'hidden md:flex' : 'flex'}`}>
        {/* The live-workers strip (design D8): live rows only, hidden in
            archived chats and when nothing runs (the strip hides itself). */}
        {!archived && <ChatWorkersStrip sessionId={session.id} sendMessage={sendMessage} connected={connected} />}
        {/* overflow-anchor off (chat-history-window D4): the history anchor
            owns the scroll adjustment across a prepend; the browser's own
            anchoring would compensate twice. */}
        <div ref={transcriptBox} className="min-h-0 flex-1 overflow-y-auto p-4" style={{ overflowAnchor: 'none' }}>
          <div className="mx-auto max-w-4xl space-y-4">
            <ChatMessages events={transcript.events} projectPath={session.projectPath}
              sessionId={session.id} sendMessage={sendMessage} connected={connected}
              archived={archived} agentLabel={agentLabelOf(session.agentType)}
              historyHasOlder={transcript.historyHasOlder} historyLoading={transcript.historyLoading}
              onLoadEarlier={loadEarlier}
              sessions={liveSessions} directory={participantDirectory} onOpenParticipant={openParticipantChat} />
            {/* The activity row keeps to the transcript's body column (chat-transcript-layout D3). */}
            {showActivity && <div className="chat-transcript">
              <AsideRow spacing="">
                <ChatActivityRow activity={activity.value} phaseStartedAt={activity.phaseStartedAt} />
              </AsideRow>
            </div>}
            {!archived && <ChatRequests requests={transcript.pendingRequests} sessionId={session.id} sendMessage={sendMessage} disabled={!connected} />}
            <div ref={end} />
          </div>
        </div>
        {archived ? (
          <div className="border-t border-border p-3" data-testid="chat-archived-bar">
            <div className="mx-auto flex max-w-4xl items-center justify-between gap-2">
              <p className="text-chat-meta text-secondary">Archived — read-only. Restore to continue this conversation.</p>
              <button className="btn btn-primary text-chat-meta" onClick={() => sendMessage({ type: 'chat-restore', sessionId: session.id })}
                disabled={!connected}>Restore</button>
            </div>
          </div>
        ) : (
          <ChatComposer key={session.id} sessionId={session.id} status={session.status}
            connected={connected} commandState={transcript.commands} onSubmit={submitText}
            onInterrupt={() => sendMessage({ type: 'chat-interrupt', sessionId: session.id })} />
        )}
      </div>
      {/* The side slot hosts only the debug panel (team-workspace-pages D4). */}
      {debugOpen && <ChatDebugPanel key={session.id} sessionId={session.id} view={debug} sendMessage={sendMessage}
        connected={connected} onClose={toggleDebug} />}
    </div>
  </main>
}
