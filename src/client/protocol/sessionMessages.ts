// Session-lifecycle messages: list snapshots, per-session updates, and the
// wake/hibernate/kill result handling with their pending-selection state.
// Ordering-sensitive blocks (pendingKills epoch discard, pending-wake
// matching) moved verbatim from App.tsx — see the inline comments.
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useChatStore } from '../stores/chatStore'
import { invalidateSnapshotCache } from '../hooks/useTerminal'
import { notifySpawnedAttention } from '../utils/teamTaskNotification'
import { playIdleSound, playPermissionSound } from '../utils/sound'
import { decideTransitionSounds, pageIsVisible } from '../utils/soundTransitions'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

/** Play the sounds a status transition decides on (F7 dedupe). The idle
 * sound is suppressed for the selected session while the page is visible —
 * the user is already watching it (skip-idle-sound-for-selected-session). */
function notifyStatusTransitions(
  prevStatus: string | undefined,
  nextStatus: string,
  isSelected: boolean,
  pageVisible: boolean
): void {
  const { soundOnPermission, soundOnIdle } = useSettingsStore.getState()
  const sounds = decideTransitionSounds(
    prevStatus,
    nextStatus,
    isSelected,
    pageVisible,
    soundOnPermission,
    soundOnIdle
  )
  if (sounds.permission) void playPermissionSound()
  if (sounds.idle) void playIdleSound()
}

export function handleSessions(
  message: Extract<ServerMessage, { type: 'sessions' }>,
  deps: MessageRouterDeps
): void {
  const session = useSessionStore.getState()
  // Detect status transitions for sound notifications before updating;
  // read selection/visibility before the new list is applied (selection may
  // be rewritten later in this handler, e.g. after a hibernate/wake).
  const currentSessions = session.sessions
  const { soundOnPermission, soundOnIdle } = useSettingsStore.getState()
  const selectedSessionId = session.selectedSessionId
  const pageVisible = pageIsVisible()

  for (const nextSession of message.sessions) {
    notifySpawnedAttention(currentSessions.find((s) => s.id === nextSession.id), nextSession)
  }
  if (soundOnPermission || soundOnIdle) {
    for (const nextSession of message.sessions) {
      const prevSession = currentSessions.find((s) => s.id === nextSession.id)
      if (prevSession && prevSession.status !== nextSession.status) {
        notifyStatusTransitions(
          prevSession.status,
          nextSession.status,
          nextSession.id === selectedSessionId,
          pageVisible
        )
      }
    }
  }

  // Discard pending kills from a previous connection — the first
  // snapshot after reconnect is authoritative.  Uses getConnectionEpoch()
  // (reads manager directly) instead of a render-dependent ref so the
  // check is correct even if this message arrives before React re-renders.
  if (deps.pendingKills.current.size > 0) {
    const currentEpoch = deps.getConnectionEpoch()
    for (const [id, entry] of deps.pendingKills.current) {
      if (entry.epoch !== currentEpoch) {
        deps.pendingKills.current.delete(id)
      }
    }
  }

  // Filter out sessions with pending kills so stale refresh snapshots
  // don't re-add optimistically removed sessions (causes multi-second
  // delay before the session card finally disappears).
  // Note: we intentionally do NOT clear pendingKills here — only
  // kill-failed clears entries (for rollback).  Entries persist until
  // reconnect (epoch mismatch) so stale async refreshes can't
  // resurrect the killed session even after session-removed arrives.
  const nextSessions = deps.pendingKills.current.size > 0
    ? message.sessions.filter((session) => !deps.pendingKills.current.has(session.id))
    : message.sessions

  const {
    selectedSessionId: previousSelectedSessionId,
    selectedHibernatingSessionId: previousSelectedHibernatingSessionId,
  } = useSessionStore.getState()
  const removedSelectedAgentSessionId =
    previousSelectedSessionId !== null &&
    previousSelectedHibernatingSessionId === null &&
    !nextSessions.some((session) => session.id === previousSelectedSessionId)
      ? currentSessions.find((session) => session.id === previousSelectedSessionId)?.agentSessionId?.trim() ?? null
      : null

  if (removedSelectedAgentSessionId) {
    // Another client hibernates the live session before the hibernating bucket updates.
    deps.pendingHibernateSelection.current = removedSelectedAgentSessionId
  }

  session.setSessions(nextSessions)

  const pendingWakeSelectionId = deps.pendingWakeSelection.current
  const {
    selectedSessionId: currentSelectedSessionId,
    selectedHibernatingSessionId: currentSelectedHibernatingSessionId,
  } = useSessionStore.getState()
  const { projectFilters, hostFilters } = useSettingsStore.getState()
  if (
    pendingWakeSelectionId &&
    currentSelectedSessionId === null &&
    currentSelectedHibernatingSessionId === null
  ) {
    const matchingSession = nextSessions.find((session) => {
      if (session.agentSessionId?.trim() !== pendingWakeSelectionId) {
        return false
      }
      if (
        projectFilters.length > 0 &&
        !projectFilters.includes(session.projectPath)
      ) {
        return false
      }
      if (
        hostFilters.length > 0 &&
        !hostFilters.includes(session.host ?? '')
      ) {
        return false
      }
      return true
    })
    if (matchingSession) {
      deps.pendingWakeSelection.current = null
      useSessionStore.getState().setSelectedSessionId(matchingSession.id)
    }
  }
}

export function handleSessionUpdate(
  message: Extract<ServerMessage, { type: 'session-update' }>,
  _deps: MessageRouterDeps
): void {
  // Detect status transitions for sound notifications
  // Capture previous status BEFORE updating to ensure we have the old value
  const currentSessions = useSessionStore.getState().sessions
  const prevSession = currentSessions.find((s) => s.id === message.session.id)
  const prevStatus = prevSession?.status
  const nextStatus = message.session.status
  // Read selection/visibility before the update is applied
  const { selectedSessionId } = useSessionStore.getState()
  const pageVisible = pageIsVisible()

  useSessionStore.getState().updateSession(message.session)
  notifySpawnedAttention(prevSession, message.session)

  // Only play sounds for known sessions (skip new/unknown sessions)
  notifyStatusTransitions(
    prevStatus,
    nextStatus,
    message.session.id === selectedSessionId,
    pageVisible
  )
}

export function handleSessionCreated(
  message: Extract<ServerMessage, { type: 'session-created' }>,
  _deps: MessageRouterDeps
): void {
  // Add session to list immediately (don't wait for async refresh)
  const session = useSessionStore.getState()
  const currentSessions = session.sessions
  if (!currentSessions.some((s) => s.id === message.session.id)) {
    session.setSessions([message.session, ...currentSessions])
  }
  session.setSelectedSessionId(message.session.id)
  useSettingsStore.getState().addRecentPath(message.session.projectPath)

  // Auto-add to filter if filters are active and project isn't included
  const { projectFilters, setProjectFilters } = useSettingsStore.getState()
  if (projectFilters.length > 0 && !projectFilters.includes(message.session.projectPath)) {
    setProjectFilters([...projectFilters, message.session.projectPath])
  }
}

export function handleSessionRemoved(
  message: Extract<ServerMessage, { type: 'session-removed' }>,
  deps: MessageRouterDeps
): void {
  useChatStore.getState().remove(message.sessionId)
  // Do NOT clear pendingKills here — stale async refreshes (e.g. the
  // periodic 2s refresh) can arrive AFTER session-removed and re-add
  // the killed window if the tmux process hasn't fully exited yet.
  // Keeping the entry in pendingKills filters
  // those stale broadcasts.  Cleanup happens on reconnect (epoch mismatch)
  // or kill-failed (rollback).
  invalidateSnapshotCache(message.sessionId)
  const session = useSessionStore.getState()
  const currentSessions = session.sessions
  const nextSessions = currentSessions.filter(
    (session) => session.id !== message.sessionId
  )
  if (nextSessions.length !== currentSessions.length) {
    session.setSessions(nextSessions)
  }
  void deps
}

export function handleAgentSessions(
  message: Extract<ServerMessage, { type: 'agent-sessions' }>,
  deps: MessageRouterDeps
): void {
  const active = Array.isArray(message.active) ? message.active : []
  const hibernating = Array.isArray(message.hibernating) ? message.hibernating : []
  const history = Array.isArray(message.history) ? message.history : []
  const { selectedHibernatingSessionId: currentSelectedHibernatingSessionId } =
    useSessionStore.getState()
  const pendingHibernateSelectionId = deps.pendingHibernateSelection.current
  if (
    currentSelectedHibernatingSessionId &&
    !hibernating.some(
      (session) => session.sessionId === currentSelectedHibernatingSessionId
    )
  ) {
    deps.pendingWakeSelection.current = currentSelectedHibernatingSessionId
  }
  useSessionStore.getState().setAgentSessions(active, hibernating, history)
  deps.setPendingHibernatingSession((current) =>
    current &&
    hibernating.some((session) => session.sessionId === current.sessionId)
      ? null
      : current
  )
  if (
    pendingHibernateSelectionId &&
    hibernating.some((session) => session.sessionId === pendingHibernateSelectionId)
  ) {
    deps.pendingHibernateSelection.current = null
    useSessionStore.getState().setSelectedHibernatingSessionId(pendingHibernateSelectionId)
  } else if (pendingHibernateSelectionId) {
    deps.pendingHibernateSelection.current = null
  }
}

export function handleAgentSessionsActive(
  message: Extract<ServerMessage, { type: 'agent-sessions-active' }>,
  _deps: MessageRouterDeps
): void {
  useSessionStore.getState().setActiveAgentSessions(Array.isArray(message.active) ? message.active : [])
}

export function handleSessionOrphaned(
  message: Extract<ServerMessage, { type: 'session-orphaned' }>,
  _deps: MessageRouterDeps
): void {
  // When a session is superseded by slug (plan→execute transition),
  // don't remove the card — session-activated will update it in place.
  if (!message.supersededBy) {
    const session = useSessionStore.getState()
    const currentSessions = session.sessions
    const nextSessions = currentSessions.filter(
      (session) => session.agentSessionId?.trim() !== message.session.sessionId
    )
    if (nextSessions.length !== currentSessions.length) {
      session.setSessions(nextSessions)
    }
  }
}

export function handleSessionActivated(
  message: Extract<ServerMessage, { type: 'session-activated' }>,
  _deps: MessageRouterDeps
): void {
  // Update the session card's agent metadata in place (e.g., after slug supersede
  // or orphan rematch). Merges onto existing card — no-op if no card matches.
  const existing = useSessionStore.getState().sessions.find(
    (s) => s.tmuxWindow === message.window
  )
  if (existing) {
    useSessionStore.getState().updateSession({
      ...existing,
      agentSessionId: message.session.sessionId,
      agentSessionName: message.session.displayName,
      logFilePath: message.session.logFilePath,
      isPinned: message.session.isPinned,
      lastUserMessage: message.session.lastUserMessage ?? existing.lastUserMessage,
    })
  }
}

export function handleSessionWakeResult(
  message: Extract<ServerMessage, { type: 'session-wake-result' }>,
  deps: MessageRouterDeps
): void {
  if (message.ok && message.session) {
    deps.setPendingHibernatingSession((current) =>
      current?.sessionId === message.sessionId ? null : current
    )
    // Add woken session to list immediately
    const session = useSessionStore.getState()
    const currentSessions = session.sessions
    if (!currentSessions.some((s) => s.id === message.session!.id)) {
      session.setSessions([message.session, ...currentSessions])
    }
    session.setSelectedSessionId(message.session.id)
  } else if (!message.ok) {
    deps.setTransientError(`${message.error?.code}: ${message.error?.message}`)
  }
}

export function handleSessionHibernateResult(
  message: Extract<ServerMessage, { type: 'session-hibernate-result' }>,
  deps: MessageRouterDeps
): void {
  if (message.ok) {
    if (message.session) {
      deps.setPendingHibernatingSession(message.session)
    }
    useSessionStore.getState().setSelectedHibernatingSessionId(message.sessionId)
  } else {
    deps.setTransientError(message.error ?? 'Failed to hibernate session')
  }
}

export function handleKillFailed(
  message: Extract<ServerMessage, { type: 'kill-failed' }>,
  deps: MessageRouterDeps
): void {
  // Restore optimistically removed session from pending-kill snapshot
  // (not exitingSessions, which may have been cleared by animation timer)
  const pending = deps.pendingKills.current.get(message.sessionId)
  if (pending) {
    const session = useSessionStore.getState()
    const currentSessions = session.sessions
    // Guard: a `sessions` broadcast may have re-added the session already
    if (!currentSessions.some(s => s.id === message.sessionId)) {
      session.setSessions([pending.session, ...currentSessions])
    }
    if (pending.wasSelected) {
      session.setSelectedSessionId(message.sessionId)
    }
    deps.pendingKills.current.delete(message.sessionId)
  }
  useSessionStore.getState().clearExitingSession(message.sessionId)
  deps.setTransientError(message.message)
}

export function handleSessionMoveToHistoryResult(
  message: Extract<ServerMessage, { type: 'session-move-to-history-result' }>,
  deps: MessageRouterDeps
): void {
  if (!message.ok && message.error) {
    deps.setTransientError(message.error)
  }
}
