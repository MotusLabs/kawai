// The host-independent conversation surface (plan-workspace §6.1, design
// D7): everything a conversation needs below the page chrome — the usage
// bar, the notification strip (with the archived account-only filter), the
// live workers/background-tasks strip, the connection error banner, the
// transcript scroller with the activity row, the request cards and the end
// anchor, then the archived Restore bar or the composer with its submit and
// local /clear-/reset-/new flow — so a full-screen wrapper and an embedded
// host render the same component and keep ordinary behavior. The HOST owns
// the root element: it carries the `chat-palette chat-root` classes and the
// `--chat-font-size` variable; the surface renders the strips and column
// inside it. Header/identity, the debug panel and global navigation stay in
// the wrapper.
//
// Strip placement (`showStrips`, default true): embedded hosts render the
// usage/notification/error strips inside the surface, stacked above the
// column. The full-screen wrapper hoists those three strips ABOVE its
// debug/content row instead — they must span the whole palette root there,
// desktop and narrow debug views alike — and passes `showStrips={false}`,
// which drops the surface's own copies and leaves the column alone as the
// row's flex-1 child (the strips are never row items and never render
// twice).
//
// Host contract (advisory 396ee67b R2/R5): a host that wants local reset
// support (/clear, /reset, /new composing a new chat and archiving the old
// one) MUST pass `subscribe` — the lifecycle subscription the flow needs to
// observe the created replacement and creation failures. Without it the
// surface is not lifecycle-capable: a reset command refuses visibly (and
// keeps the typed text) instead of half-creating a chat nothing archives.
// `onResetCreated` is the §6.4 seam, invoked when a local reset created the
// replacement chat, before the previous chat archives; binding transfer is
// NOT implemented here, F2 decides its final shape.
//
// Attachment ownership lives in chatAttachment.ts and keys on the
// connection identity: `sendMessage` MUST be the connection's stable
// reference (App's single useWebSocket() value), never a per-render
// wrapper — it is the registry key every host of the connection shares.
// Holds follow mount and session lifetime; the connection sync below owns
// the wire attach (MiMo ca90ce4e): mounted offline defers it, a held
// reconnect resumes once, a real reopen after a detach never resumes.
// Reveal consumption is claimed here and gated to the designated host
// (`revealEnabled={false}` renders statically and never claims).
//
// Two hosts of one session share chatStore state exactly like two browser
// tabs: the draft is per session (last write wins, a submit clears it for
// both) and both hosts render the same request cards; a second host
// answering an already-resolved request gets the server's stale error
// inline — accepted and documented, not disabled.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SendClientMessage, ServerMessage, Session } from '@shared/types'
import type { SessionDirectoryEntry } from '@shared/team'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { emptyTranscript, useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { pendingContextSends, type CapturedWorkspaceScope } from '../../stores/planWorkspaceScopeStore'
import { claimReveal, createHostToken, isRevealDesignated, registryFor, releaseReveal } from '../../stores/chatAttachment'
import ChatActivityRow from './ChatActivityRow'
import ChatMessages from './ChatMessages'
import ChatRequests from './ChatRequests'
import ChatComposer from './ChatComposer'
import ChatWorkersStrip from './ChatWorkersStrip'
import NotificationStrip from './NotificationStrip'
import UsageBar from './UsageBar'
import { AsideRow } from './ChatRow'
import { agentLabelOf } from './transcriptLayout'
import { useHistoryAnchor } from './useHistoryAnchor'
import { useRevealRow } from './useRevealRow'

const EMPTY = emptyTranscript()
/** Stable empty list so an absent directory never re-renders (getSnapshot caching). */
const NO_DIRECTORY: never[] = []

/** `/clear`, `/reset`, `/new` — optionally followed by the new chat's name. */
const CLEAR_COMMAND = /^\/(clear|reset|new)(?:\s+(.*))?$/

export default function ChatSurface({
  session, sendMessage, subscribe, connectionStatus, connectionEpoch,
  revealEnabled = true, onOpenParticipant, onResetCreated, participantDirectory,
  onSubmitContext, composerAttachment,
  error = null, className = 'flex', showStrips = true,
}: {
  session: Session
  /** The connection's stable sendMessage — the attachment registry keys on it. */
  sendMessage: SendClientMessage
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  connectionStatus: ConnectionStatus
  connectionEpoch: number
  /** False on a secondary host: renders statically, never claims the reveal. */
  revealEnabled?: boolean
  /** Opens a participant's chat from a transcript row; omit to disable click-through. */
  onOpenParticipant?: (sessionId: string) => void
  /** §6.4 seam: the local reset created `newSessionId` to replace `previousSessionId`. */
  onResetCreated?: (newSessionId: string, previousSessionId: string) => void
  /** §6.3 seam: the draft's captured scope at submit time; null/absent sends unscoped. */
  onSubmitContext?: () => CapturedWorkspaceScope | null
  /** The captured-attachment line rendered above the composer input (§6.3). */
  composerAttachment?: ReactNode
  /** The team message directory for naming killed participants (wrapper-owned). */
  participantDirectory?: SessionDirectoryEntry[]
  /** The connection/server error banner text; null renders nothing. */
  error?: string | null
  /** Extra layout classes on the column root (the wrapper's debug-aware visibility). */
  className?: string
  /** Render the usage/notification/error strips inside this surface
      (embedded hosts, the default). A host that hoists the full-width
      strips above its debug/content row — the full-screen wrapper — passes
      false and renders them itself, so the strips span the palette root,
      never become row items beside the debug panel, and never duplicate. */
  showStrips?: boolean
}) {
  const transcript = useChatStore(state => state.sessions[session.id]) ?? EMPTY
  const connected = connectionStatus === 'connected'
  const archived = session.archivedAt != null
  const end = useRef<HTMLDivElement>(null)
  // Attachment ownership (chatAttachment.ts): holds follow this component's
  // mount and session lifetime — never the connected flag, so a socket drop
  // keeps both the hold and the attached wire state and the sync below
  // re-attaches exactly once on the reconnect.
  const registry = useMemo(() => registryFor(sendMessage), [sendMessage])
  const token = useRef(createHostToken()).current
  useEffect(() => {
    registry.acquire(session.id, token)
    return () => registry.release(session.id, token)
  }, [registry, session.id, token])
  // Connection sync: the initial attach (deferred while mounted offline) or
  // the one held-session reconnect attach. No cleanup — detaching is owned
  // by the hold lifetime above (chat-history-window D3 semantics read the
  // held transcript at attach time, as the full-screen view always did).
  useEffect(() => {
    if (!connected) return
    const held = useChatStore.getState().sessions[session.id]
    registry.sync(session.id, connectionEpoch, {
      historyExpanded: held?.historyExpanded,
      historyStartId: held?.historyStartId,
    })
  }, [registry, session.id, connected, connectionEpoch])
  // `/clear` composition (design D6): remember which session awaits archival;
  // the matching session-created (a new chat in this project) archives it,
  // an error reply leaves it untouched. Never sent to the agent. The flow is
  // lifecycle-capable only with `subscribe` (host contract above): without a
  // subscription nothing would observe the created replacement to archive
  // this chat, so the command refuses visibly instead of half-creating.
  const profileId = session.claudeProfileId ?? 'default'
  // Plan usage is per profile (usage bar design D4): every session of the
  // profile renders the same shared report.
  const usage = useChatStore(state => state.usage[profileId]) ?? null
  const [resetRefusal, setResetRefusal] = useState(false)
  // The refused command's text, restored after the composer's own post-submit
  // clear (an effect runs once the submit flow has finished writing).
  const [restoreDraft, setRestoreDraft] = useState<string | null>(null)
  useEffect(() => {
    if (restoreDraft === null) return
    useChatStore.getState().setDraft(session.id, restoreDraft)
    setRestoreDraft(null)
  }, [restoreDraft, session.id])
  const pendingClearRef = useRef<string | null>(null)
  useEffect(() => { pendingClearRef.current = null; setResetRefusal(false); setRestoreDraft(null) }, [session.id])
  useEffect(() => {
    if (!subscribe) return
    return subscribe((message) => {
      // Contextual-send answers (§6.3, B1) are settled by the connection
      // consumer (pendingSendRecovery, wired into the message router), not
      // here — a role switch, a closed Plans tab, or a closed full-screen
      // view must never strand an unanswered send or its recovery.
      const previous = pendingClearRef.current
      if (!previous) return
      if (
        message.type === 'session-created' &&
        message.session.id !== previous &&
        message.session.kind === 'chat' &&
        message.session.projectPath === session.projectPath
      ) {
        pendingClearRef.current = null
        // §6.4 seam: the host transfers a repository binding to the
        // replacement (planWorkspaceResetTransfer) before the old archives.
        onResetCreated?.(message.session.id, previous)
        sendMessage({ type: 'chat-archive', sessionId: previous })
      } else if (message.type === 'error') {
        // The creation failed: the old chat stays exactly as it was.
        pendingClearRef.current = null
      }
    })
  }, [subscribe, sendMessage, session.projectPath, session.id, onResetCreated])
  const submitText = (trimmed: string) => {
    const clear = CLEAR_COMMAND.exec(trimmed)
    if (clear) {
      if (!subscribe) {
        // The composer already cleared its draft; restore the command after
        // the submit flow so the refusal keeps the user's text editable
        // (no silent half-reset).
        setResetRefusal(true)
        setRestoreDraft(trimmed)
        return
      }
      const name = clear[2]?.trim()
      pendingClearRef.current = session.id
      setResetRefusal(false)
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
    setResetRefusal(false)
    // A workspace host supplies the draft's captured scope (§6.3); reset
    // commands above never carry context. The envelope rides the additive
    // chat-send field with a client-minted requestId (Q2) that gets exactly
    // one terminal answer (B1), settled by the connection consumer
    // (pendingSendRecovery): the sender-only acceptance, or the correlated
    // refusal, which restores text and attachment. Entries are keyed by the
    // requestId, so rapid sends stay independent.
    const scope = onSubmitContext?.() ?? null
    const requestId = scope ? crypto.randomUUID() : undefined
    if (scope) pendingContextSends.set(requestId!, { sessionId: session.id, text: trimmed, scope })
    sendMessage({
      type: 'chat-send', sessionId: session.id, text: trimmed,
      ...(scope ? { workspaceContext: scope.envelope, requestId } : {}),
    })
  }
  // A pending search reveal owns the scroll position: stick-to-bottom yields
  // to it (the reveal hook below runs after this effect in the same commit).
  // After a history page prepends (chat-history-window D4), the stick skips
  // once instead of yanking the reader to the bottom.
  const transcriptBox = useRef<HTMLDivElement>(null)
  const { capture: captureHistoryAnchor, skipStickOnce: historyStickSkip } =
    useHistoryAnchor(transcriptBox, transcript.historyLoading, transcript.events[0]?.id ?? null)
  useEffect(() => {
    if (useChatStore.getState().pendingReveal?.sessionId === session.id) return
    if (historyStickSkip.current) {
      historyStickSkip.current = false
      return
    }
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [transcript.events.length, transcript.throughSequence, session.id])
  // Reveal designation (plan-workspace §6.1): claim while mounted so this
  // surface is its session's reveal consumer; the layout effect runs before
  // the passive reveal attempt below. Only the designated surface consumes
  // (the gate is consulted live, so a survivor takes over for reveals set
  // after it became designated); a `revealEnabled={false}` host never claims.
  useLayoutEffect(() => {
    if (!revealEnabled) return
    claimReveal(session.id, token)
    return () => releaseReveal(session.id, token)
  }, [revealEnabled, session.id, token])
  useRevealRow({
    sessionId: session.id, loaded: transcript !== EMPTY, container: transcriptBox, sendMessage,
    eventCount: transcript.events.length,
    mayConsume: () => revealEnabled && isRevealDesignated(session.id, token),
  })
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
  // Naming message participants: live rows come from the session list; killed
  // ones keep their name through the wrapper's team directory when loaded.
  const liveSessions = useSessionStore(state => state.sessions)
  const directory = participantDirectory ?? NO_DIRECTORY
  // The conversation column: workers strip, transcript scroller, then the
  // archived Restore bar or the composer. `showStrips={false}` hosts get
  // exactly this element as the row's flex-1 child — the pre-surface
  // content-column shape, with the full-width strips hoisted above the row
  // by the host instead.
  const column = <div className={`min-h-0 min-w-0 flex-1 flex-col ${className}`}>
      {/* The live-workers strip (workers design D8, background tasks D2):
          live rows only, hidden in archived chats and when nothing runs
          (the strip hides itself). */}
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
            sessions={liveSessions} directory={directory} onOpenParticipant={onOpenParticipant} />
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
      {/* The reset refusal (host contract, R2): a host without the lifecycle
          subscription says so at the composer instead of half-creating. */}
      {resetRefusal && (
        <p role="alert" data-testid="chat-reset-unsupported"
          className="border-t border-border p-3 text-chat-body text-chat-danger">
          Local reset (/clear, /reset, /new) is unavailable in this host: it has no chat lifecycle subscription.
        </p>
      )}
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
          attachment={composerAttachment}
          onInterrupt={() => sendMessage({ type: 'chat-interrupt', sessionId: session.id })} />
      )}
  </div>
  if (!showStrips) return column
  // One column root so the strips stack above the transcript inside any
  // host layout — the wrapper places this root beside its debug slot in a
  // row; the strips must never become row items.
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {/* Plan usage (usage bar design D4) and the notification strip (design
        D7) under wherever the host renders its header: every session of the
        profile shares the report; archived chats are read-only surfaces no
        agent feeds, so they render account notices only (design D4). */}
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
    {column}
  </div>
}
