// The full-screen chat wrapper (plan-workspace §6.1, design D7): the page
// identity and chrome around the shared ChatSurface. The wrapper owns the
// palette root (its `--chat-font-size` sizes chat text through the em-based
// text-chat-body / text-chat-meta utilities), the header (ChatHeader,
// chat-header-layout D1: identity, status, controls), the debug side slot,
// and the Team navigation — the Team button and the task chip open the Team
// page for the chat's team key (team-workspace-pages D2), so every chat of
// one team shares those views. The full-width strips — usage, notifications
// and the error banner — are wrapper-owned too, rendered above the
// debug/content row exactly as before the shared surface (they must span
// the palette root with the debug panel open, never sit beside it as row
// items); ChatSurface gets showStrips={false} so they are not duplicated.
// Everything else the conversation needs — workers/background tasks, the
// transcript column, and the wire attach/detach ownership — lives in
// ChatSurface, so an embedded host renders the same component with its own
// strips (the wrapper passes its subscribe through: the full-screen host is
// lifecycle-capable).
// Attach on selection and reconnect; detaching never stops the agent. The
// approval policy renders from the broadcast Session, never local state.
// During an in-flight turn an activity row (design D6) follows ChatMessages:
// the live phase with a client-ticked timer, hidden while text streams, while
// a request awaits the user, and in archived chats (design D4).
// Archived chats render read-only: the transcript and debug view stay, the
// composer/Stop/request actions are replaced by a Restore bar, and archiving
// a live turn asks for confirmation first (the server interrupts it).
// Unsubmitted composer text is kept per session across switches and archive/restore
// (chatStore drafts); submitting clears that session draft; killing discards it;
// reload drops all drafts.
// The composer opens a slash-command menu for the `/` word at the caret,
// anywhere in the message (slash-anywhere design D1/D2): choosing replaces
// just that word with `/<name> ` without sending, Enter falls through when
// nothing matches, and /clear /reset /new compose a new chat only when they
// are the whole message.
import { useClaudeProfiles } from './useClaudeProfiles'
import { profileIdentityLabels } from '../../utils/profileIdentity'
import { useEffect, useMemo, type CSSProperties } from 'react'
import type { SendClientMessage, ServerMessage, Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { emptyTranscript, useChatStore } from '../../stores/chatStore'
import { closedDebugView, useChatDebugStore } from '../../stores/chatDebugStore'
import ChatHeader from './ChatHeader'
import ChatDebugPanel from './ChatDebugPanel'
import ChatSurface from './ChatSurface'
import NotificationStrip from './NotificationStrip'
import UsageBar from './UsageBar'
import { requestChatArchive } from '../../utils/chatArchive'
import { openParticipantChat } from './openParticipant'
import { teamKeyOf } from '../../utils/teamKey'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useTeamMessageStore } from '../../stores/teamMessageStore'

const EMPTY = emptyTranscript()
const CLOSED_DEBUG = closedDebugView()
/** Stable empty list so an absent directory never re-renders (getSnapshot caching). */
const NO_DIRECTORY: never[] = []

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
  const { profileLabel, providerLabel } = profileIdentityLabels(catalog.profiles, profileId)
  const chatFontSize = useSettingsStore(state => state.chatFontSize)
  const transcript = useChatStore(state => state.sessions[session.id]) ?? EMPTY
  const connected = connectionStatus === 'connected'
  const archived = session.archivedAt != null
  // Plan usage is per profile (usage bar design D4): every session of the
  // profile renders the same shared report.
  const usage = useChatStore(state => state.usage[profileId]) ?? null
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
  // Killed participants keep their names when a Messages view has loaded the
  // team directory (the Team page); a chat alone degrades to the raw id.
  const participantDirectory = useTeamMessageStore(state => state.views[teamKey]?.directory) ?? NO_DIRECTORY
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
  return <main className="chat-palette chat-root flex min-h-0 min-w-0 flex-1 flex-col bg-base text-primary" data-testid="chat-view"
    style={{ '--chat-font-size': `${chatFontSize}px` } as CSSProperties}>
    <ChatHeader session={session} profileLabel={profileLabel} providerLabel={providerLabel} model={transcript.model} contextUsage={transcript.contextUsage}
      connectionStatus={connectionStatus} debugOpen={debugOpen} onToggleDebug={toggleDebug}
      onOpenTeam={() => onOpenTeam?.(teamKey)} onOpenTask={taskId => onOpenTask?.(teamKey, taskId)}
      onRename={name => sendMessage({ type: 'session-rename', sessionId: session.id, newName: name })}
      onToggleApproval={toggleApprovalPolicy} onArchive={handleArchive} onKill={onKill} onClose={onClose}
      fontSizePx={chatFontSize} />
    {/* Full-width strips above the debug/content row (the pre-surface
        placement, §6.1): the usage bar, the notification strip (archived
        chats render account notices only, design D4) and the error banner
        span the palette root with the debug panel open — desktop and narrow
        alike — so they must not become row items beside the panel. The
        surface renders none of its own (showStrips={false}). */}
    <UsageBar report={usage} />
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
      {/* The shared surface owns the content column (§6.1): workers, the
          transcript and the composer. Passing sendMessage through
          unchanged: its identity is the attachment registry key
          (ChatSurface). */}
      <ChatSurface session={session} sendMessage={sendMessage} subscribe={subscribe}
        connectionStatus={connectionStatus} connectionEpoch={connectionEpoch}
        showStrips={false}
        className={debugOpen ? 'hidden md:flex' : 'flex'}
        participantDirectory={participantDirectory}
        onOpenParticipant={openParticipantChat} />
      {/* The side slot hosts only the debug panel (team-workspace-pages D4). */}
      {debugOpen && <ChatDebugPanel key={session.id} sessionId={session.id} view={debug} sendMessage={sendMessage}
        connected={connected} onClose={toggleDebug}
        runtime={session.runtime ?? 'claude'} />}
    </div>
  </main>
}
