// Root component: app layout, keyboard shortcuts, and the WebSocket
// subscription that routes every server message into stores and local state.
import { createMessageRouter } from './protocol/messageRouter'
import type { SessionFormPrefill } from './protocol/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, AutoStartAgent, ChatApprovalPolicy, Session, SessionKillSource, UpdateState } from '@shared/types'
import { FALLBACK_ARCHIVE_SECTION_KEY, type WorkspaceBranch } from '@shared/workspace'
import Header from './components/Header'
import SessionList from './components/SessionList'
import Terminal from './components/Terminal'
import ChatView from './components/chat/ChatView'
import { useUpdateStore } from './stores/updateStore'
import NewSessionModal from './components/NewSessionModal'
import BranchBrowserModal from './components/BranchBrowserModal'
import CreateWorktreeModal from './components/CreateWorktreeModal'
import SettingsModal from './components/SettingsModal'
import UpdatePanel from './components/UpdatePanel'
import { ToastViewport } from './components/Toast'
import { useSessionStore } from './stores/sessionStore'
import { useSessionSearchStore } from './stores/sessionSearchStore'
import {
  useSettingsStore,
  useSettingsHasHydrated,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './stores/settingsStore'
import { useThemeStore } from './stores/themeStore'
import { useWorkspaceStore } from './stores/workspaceStore'
import { useWebSocket } from './hooks/useWebSocket'
import { invalidateSnapshotCache } from './hooks/useTerminal'
import { useVisualViewport } from './hooks/useVisualViewport'
import { sortSessions } from './utils/sessions'
import { buildWorkspaceView } from './utils/workspaceView'
import { requestChatArchive } from './utils/chatArchive'
import { flushSync } from 'react-dom'
import { primeAudio, needsUserGesture } from './utils/sound'
import { getEffectiveModifier, matchesModifier } from './utils/device'
import { startTeamViewMigration } from './stores/teamViewMigration'

interface ServerInfo {
  port: number
  tailscaleIp: string | null
  protocol: string
  cwd?: string | null
  /** AGENTBOARD_PROJECT_DIR, when the server was started with it. */
  defaultProjectDir?: string | null
  /** Build version of the server, e.g. `1.0.0-17` or `1.0.0-dev`. */
  version?: string
  /** Update availability, seeded from discovery (see server/updates). */
  update?: UpdateState | null
}

function filterAgentSessions(
  sessions: AgentSession[],
  projectFilters: string[],
  hostFilters: string[]
) {
  let next = sessions
  if (projectFilters.length > 0) {
    next = next.filter((session) => projectFilters.includes(session.projectPath))
  }
  if (hostFilters.length > 0) {
    next = next.filter((session) => hostFilters.includes(session.host ?? ''))
  }
  return next
}

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [newSessionInitialHost, setNewSessionInitialHost] = useState<string | undefined>(undefined)
  const [newSessionInitialPath, setNewSessionInitialPath] = useState<string | undefined>(undefined)
  const [newSessionInitialCommand, setNewSessionInitialCommand] = useState<string | undefined>(undefined)
  const [newSessionInitialAutoStartChange, setNewSessionInitialAutoStartChange] = useState<string | undefined>(undefined)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [branchBrowserRepositoryId, setBranchBrowserRepositoryId] = useState<string | null>(null)
  const [createWorktreeBranch, setCreateWorktreeBranch] = useState<WorkspaceBranch | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
  const [pendingHibernatingSession, setPendingHibernatingSession] =
    useState<AgentSession | null>(null)

  const sessions = useSessionStore((state) => state.sessions)
  const agentSessions = useSessionStore((state) => state.agentSessions)
  const agentSessionsEpoch = useSessionStore((state) => state.agentSessionsEpoch)
  const selectedSessionId = useSessionStore(
    (state) => state.selectedSessionId
  )
  const selectedHibernatingSessionId = useSessionStore(
    (state) => state.selectedHibernatingSessionId
  )
  const setSessions = useSessionStore((state) => state.setSessions)
  const setSelectedSessionId = useSessionStore(
    (state) => state.setSelectedSessionId
  )
  const setSelectedHibernatingSessionId = useSessionStore(
    (state) => state.setSelectedHibernatingSessionId
  )
  const hasLoaded = useSessionStore((state) => state.hasLoaded)
  const connectionStatus = useSessionStore(
    (state) => state.connectionStatus
  )
  const connectionError = useSessionStore((state) => state.connectionError)
  const markSessionExiting = useSessionStore((state) => state.markSessionExiting)
  const hostStatuses = useSessionStore((state) => state.hostStatuses)
  const remoteAllowControl = useSessionStore((state) => state.remoteAllowControl)
  const hostLabel = useSessionStore((state) => state.hostLabel)

  const theme = useThemeStore((state) => state.theme)
  const settingsHydrated = useSettingsHasHydrated()
  const defaultProjectDir = useSettingsStore(
    (state) => state.defaultProjectDir
  )
  const commandPresets = useSettingsStore((state) => state.commandPresets)
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId)
  const lastProjectPath = useSettingsStore((state) => state.lastProjectPath)
  const setLastProjectPath = useSettingsStore(
    (state) => state.setLastProjectPath
  )
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth)
  const setSidebarWidth = useSettingsStore((state) => state.setSidebarWidth)
  const projectFilters = useSettingsStore((state) => state.projectFilters)
  const hostFilters = useSettingsStore((state) => state.hostFilters)
  const soundOnPermission = useSettingsStore((state) => state.soundOnPermission)
  const soundOnIdle = useSettingsStore((state) => state.soundOnIdle)

  // Empty defaultProjectDir means "not set" — fall back to the server's
  // AGENTBOARD_PROJECT_DIR, then its working directory, when pre-filling the
  // New Session dialog.
  const serverDefaultProjectDir =
    serverInfo?.defaultProjectDir || serverInfo?.cwd || ''
  const effectiveDefaultProjectDir = defaultProjectDir || serverDefaultProjectDir

  const connectionEpoch = useSessionStore((state) => state.connectionEpoch)
  const { sendMessage, subscribe, getConnectionEpoch } = useWebSocket()

  // Stable UI callbacks for the protocol router (see protocol/types.ts): the
  // transient error banner owns one clearable timer, and the session-form
  // prefill resets every field like the inline code did.
  const transientErrorTimerRef = useRef<number | null>(null)
  const setTransientError = useCallback((message: string) => {
    setServerError(message)
    if (transientErrorTimerRef.current !== null) window.clearTimeout(transientErrorTimerRef.current)
    transientErrorTimerRef.current = window.setTimeout(() => setServerError(null), 6000)
  }, [])
  const clearTransientError = useCallback(() => {
    if (transientErrorTimerRef.current !== null) {
      window.clearTimeout(transientErrorTimerRef.current)
      transientErrorTimerRef.current = null
    }
    setServerError(null)
  }, [])
  const openSessionFormPrefilled = useCallback((prefill: SessionFormPrefill) => {
    setNewSessionInitialHost(prefill.host)
    setNewSessionInitialPath(prefill.path)
    setNewSessionInitialCommand(prefill.command)
    setNewSessionInitialAutoStartChange(prefill.autoStartChange)
    setIsModalOpen(true)
  }, [])

  // Handle mobile keyboard viewport adjustments
  useVisualViewport()

  // Team panel views follow workspace discovery to their team's key, for every
  // chat — not only the selected one (team-workspace-pages D2).
  useEffect(() => startTeamViewMigration(), [])

  // Prime audio on user interaction. Persistent listener (not once) because Safari
  // suspends AudioContext after sleep/wake and needs a fresh gesture to resume.
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!soundOnPermission && !soundOnIdle) return

    let primed = false
    const unlockAudio = () => {
      // After initial prime, only re-prime when wake detection flags it
      if (primed && !needsUserGesture()) return
      primed = true
      void primeAudio()
    }

    document.addEventListener('click', unlockAudio, { passive: true })
    document.addEventListener('keydown', unlockAudio, { passive: true })
    document.addEventListener('touchstart', unlockAudio, { passive: true })

    return () => {
      document.removeEventListener('click', unlockAudio)
      document.removeEventListener('keydown', unlockAudio)
      document.removeEventListener('touchstart', unlockAudio)
    }
  }, [soundOnPermission, soundOnIdle])

  // Sidebar resize handling
  const isResizing = useRef(false)
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    // Guard for SSR/test environments where document.addEventListener may not exist
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = e.clientX
      setSidebarWidth(
        Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, newWidth))
      )
    }

    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [setSidebarWidth])

  // Route every server message through the protocol router. Constructed
  // inside the effect so the pending refs (declared below in the component
  // body) are initialized; the deps are stable callbacks, so this subscribes
  // once for the app's lifetime instead of re-subscribing on selection
  // changes (which used to open a stale-closure window).
  useEffect(() => {
    const routeMessage = createMessageRouter({
      getConnectionEpoch,
      setTransientError,
      clearTransientError,
      openSessionFormPrefilled,
      setPendingHibernatingSession,
      pendingKills,
      pendingHibernateSelection: pendingHibernateSelectionRef,
      pendingWakeSelection: pendingWakeSelectionRef,
      pendingWorktreeLaunch: pendingWorktreeLaunchRef,
      pendingChangeLaunch: pendingChangeLaunchRef,
    })
    const unsubscribe = subscribe(routeMessage)
    return () => { unsubscribe() }
  }, [
    subscribe,
    getConnectionEpoch,
    setTransientError,
    clearTransientError,
    openSessionFormPrefilled,
    setPendingHibernatingSession,
  ])

  const selectedSession = useMemo(() => {
    return (
      sessions.find((session) => session.id === selectedSessionId) || null
    )
  }, [selectedSessionId, sessions])
  const hibernatingAgentSessions = agentSessions.hibernating ?? []
  const historyAgentSessions = agentSessions.history ?? []
  const filteredHibernatingSessions = useMemo(
    () => filterAgentSessions(hibernatingAgentSessions, projectFilters, hostFilters),
    [hibernatingAgentSessions, projectFilters, hostFilters]
  )
  const selectedHibernatingSession = useMemo(() => {
    return (
      filteredHibernatingSessions.find(
        (session) => session.sessionId === selectedHibernatingSessionId
      ) ||
      (pendingHibernatingSession?.sessionId === selectedHibernatingSessionId
        ? pendingHibernatingSession
        : null)
    )
  }, [
    filteredHibernatingSessions,
    pendingHibernatingSession,
    selectedHibernatingSessionId,
  ])

  // Track last viewed project path
  useEffect(() => {
    if (selectedSession?.projectPath && !selectedSession.remote) {
      setLastProjectPath(selectedSession.projectPath)
    }
  }, [selectedSession?.projectPath, selectedSession?.remote, setLastProjectPath])

  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const manualSessionOrder = useSettingsStore(
    (state) => state.manualSessionOrder
  )

  const sortedSessions = useMemo(
    () =>
      sortSessions(sessions, {
        mode: sessionSortMode,
        direction: sessionSortDirection,
        manualOrder: manualSessionOrder,
      }),
    [sessions, sessionSortMode, sessionSortDirection, manualSessionOrder]
  )

  // Apply filters to sorted sessions for keyboard navigation
  const filteredSortedSessions = useMemo(() => {
    let next = sortedSessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [sortedSessions, projectFilters, hostFilters])

  // Sectioned workspace view: sessions partitioned into change and worktree
  // explicit local-ungrouped and remote fallbacks. Built when a successful
  // workspace snapshot exists; navigation falls back to the flat order
  // otherwise (older server or before the first snapshot).
  const workspaceSnapshot = useWorkspaceStore((state) => state.snapshot)
  const collapsedSectionIds = useWorkspaceStore((state) => state.collapsedSectionIds)
  const archiveSectionExpanded = useWorkspaceStore((state) => state.archiveSectionExpanded)
  const toggleSectionCollapsed = useWorkspaceStore((state) => state.toggleSectionCollapsed)
  // First-use collapse: until the user has expanded it once, the Archive
  // section reads as collapsed even without a stored collapse entry.
  const effectiveCollapsedSectionIds = useMemo(
    () =>
      archiveSectionExpanded || collapsedSectionIds.includes(FALLBACK_ARCHIVE_SECTION_KEY)
        ? collapsedSectionIds
        : [...collapsedSectionIds, FALLBACK_ARCHIVE_SECTION_KEY],
    [collapsedSectionIds, archiveSectionExpanded]
  )
  // Compact worktree options for the new-session picker.
  const worktreeOptions = useMemo(() => {
    if (!workspaceSnapshot) return []
    return workspaceSnapshot.repositories.flatMap((repository) =>
      repository.worktrees.map((worktree) => ({
        worktreeId: worktree.id,
        repositoryName: repository.name,
        path: worktree.path,
        ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
        detached: worktree.detached,
        headRevision: worktree.headRevision,
      }))
    )
  }, [workspaceSnapshot])
  // Repository whose branches the branch browser is showing, when open.
  const branchBrowserRepository = useMemo(
    () =>
      branchBrowserRepositoryId === null
        ? null
        : workspaceSnapshot?.repositories.find(
            (repository) => repository.id === branchBrowserRepositoryId
          ) ?? null,
    [branchBrowserRepositoryId, workspaceSnapshot]
  )
  // Every known worktree path, for create-worktree destination de-confliction.
  const allWorktreePaths = useMemo(
    () =>
      workspaceSnapshot?.repositories.flatMap((repository) =>
        repository.worktrees.map((worktree) => worktree.path)
      ) ?? [],
    [workspaceSnapshot]
  )
  const workspaceView = useMemo(
    () =>
      buildWorkspaceView(
        workspaceSnapshot,
        sortedSessions,
        hibernatingAgentSessions,
        historyAgentSessions,
        {
          filter: { projectFilters, hostFilters },
          collapsedSectionIds: effectiveCollapsedSectionIds,
        }
      ),
    [
      workspaceSnapshot,
      sortedSessions,
      hibernatingAgentSessions,
      historyAgentSessions,
      projectFilters,
      hostFilters,
      effectiveCollapsedSectionIds,
    ]
  )

  // Flattened visible order across expanded groups drives keyboard and
  // terminal navigation; falls back to the flat filtered order when no
  // workspace snapshot is available.
  const navigationLiveSessions = useMemo(() => {
    if (!workspaceSnapshot) return filteredSortedSessions
    return workspaceView.visibleEntries.flatMap((entry) =>
      entry.kind === 'live' && entry.liveSession ? [entry.liveSession] : []
    )
  }, [workspaceSnapshot, workspaceView, filteredSortedSessions])

  const navigationHibernatingSessions = useMemo(() => {
    if (!workspaceSnapshot) return filteredHibernatingSessions
    return workspaceView.visibleEntries.flatMap((entry) =>
      entry.kind === 'hibernating' && entry.agentSession ? [entry.agentSession] : []
    )
  }, [workspaceSnapshot, workspaceView, filteredHibernatingSessions])

  const lastSelectedHibernatingSessionIdRef = useRef<string | null>(
    selectedHibernatingSessionId
  )
  const pendingHibernateSelectionRef = useRef<string | null>(null)
  const pendingWakeSelectionRef = useRef<string | null>(null)
  /** Create-worktree request awaiting its result to open the session form. */
  const pendingWorktreeLaunchRef = useRef<{ repositoryId: string; branch: string } | null>(null)
  /** Create-change-worktree request awaiting its result the same way. */
  const pendingChangeLaunchRef = useRef<{ repositoryId: string; change: string } | null>(null)
  const lastConnectionEpochRef = useRef(connectionEpoch)

  const selectFirstVisibleTarget = useCallback(() => {
    if (navigationLiveSessions.length > 0) {
      setSelectedSessionId(navigationLiveSessions[0].id)
      return true
    }
    if (navigationHibernatingSessions.length > 0) {
      setSelectedHibernatingSessionId(navigationHibernatingSessions[0].sessionId)
      return true
    }
    return false
  }, [
    navigationLiveSessions,
    navigationHibernatingSessions,
    setSelectedSessionId,
    setSelectedHibernatingSessionId,
  ])

  useEffect(() => {
    const previousHibernatingSelectionId = lastSelectedHibernatingSessionIdRef.current

    if (
      previousHibernatingSelectionId &&
      selectedHibernatingSessionId === null &&
      !hibernatingAgentSessions.some(
        (session) => session.sessionId === previousHibernatingSelectionId
      )
    ) {
      pendingWakeSelectionRef.current = previousHibernatingSelectionId
    } else if (selectedHibernatingSessionId !== null) {
      pendingWakeSelectionRef.current = null
    }

    lastSelectedHibernatingSessionIdRef.current = selectedHibernatingSessionId
  }, [hibernatingAgentSessions, selectedHibernatingSessionId])

  useEffect(() => {
    if (!pendingHibernatingSession) return
    if (selectedHibernatingSessionId === pendingHibernatingSession.sessionId) return
    setPendingHibernatingSession(null)
  }, [pendingHibernatingSession, selectedHibernatingSessionId])

  useEffect(() => {
    if (lastConnectionEpochRef.current === connectionEpoch) {
      return
    }

    lastConnectionEpochRef.current = connectionEpoch
    pendingHibernateSelectionRef.current = null
    pendingWakeSelectionRef.current = null
    setPendingHibernatingSession(null)
  }, [connectionEpoch])

  // Auto-select first visible session when current selection is filtered out
  useEffect(() => {
    if (!hasLoaded) return
    if (selectedHibernatingSessionId) return
    if (!selectedSessionId) return
    if (navigationLiveSessions.some((session) => session.id === selectedSessionId)) {
      return
    }
    if (selectFirstVisibleTarget()) return
    setSelectedSessionId(null)
  }, [
    hasLoaded,
    selectedSessionId,
    selectedHibernatingSessionId,
    navigationLiveSessions,
    selectFirstVisibleTarget,
    setSelectedSessionId,
  ])

  useEffect(() => {
    if (!selectedHibernatingSessionId) return
    if (pendingHibernatingSession?.sessionId === selectedHibernatingSessionId) {
      return
    }
    if (agentSessionsEpoch !== connectionEpoch) {
      return
    }
    if (
      navigationHibernatingSessions.some(
        (session) => session.sessionId === selectedHibernatingSessionId
      )
    ) {
      return
    }

    const matchingLiveSession = navigationLiveSessions.find(
      (session) => session.agentSessionId?.trim() === selectedHibernatingSessionId
    )
    if (matchingLiveSession) {
      setSelectedSessionId(matchingLiveSession.id)
      return
    }

    if (selectFirstVisibleTarget()) return
    setSelectedHibernatingSessionId(null)
  }, [
    navigationHibernatingSessions,
    navigationLiveSessions,
    agentSessionsEpoch,
    pendingHibernatingSession,
    selectedHibernatingSessionId,
    selectFirstVisibleTarget,
    setSelectedSessionId,
    setSelectedHibernatingSessionId,
    connectionEpoch,
  ])

  useEffect(() => {
    const pendingWakeSelectionId = pendingWakeSelectionRef.current
    if (!pendingWakeSelectionId) return
    if (selectedHibernatingSessionId !== null) {
      pendingWakeSelectionRef.current = null
      return
    }

    const matchingLiveSession = navigationLiveSessions.find(
      (session) => session.agentSessionId?.trim() === pendingWakeSelectionId
    )
    if (matchingLiveSession) {
      pendingWakeSelectionRef.current = null
      setSelectedSessionId(matchingLiveSession.id)
      return
    }

    if (selectedSessionId !== null) {
      pendingWakeSelectionRef.current = null
      return
    }

    if (selectFirstVisibleTarget()) {
      pendingWakeSelectionRef.current = null
    }
  }, [
    navigationLiveSessions,
    selectedSessionId,
    selectedHibernatingSessionId,
    selectFirstVisibleTarget,
    setSelectedSessionId,
  ])

  // Auto-select first session on mobile when sessions load
  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches
    if (
      isMobile &&
      hasLoaded &&
      selectedSessionId === null &&
      selectedHibernatingSessionId === null &&
      (navigationLiveSessions.length > 0 || navigationHibernatingSessions.length > 0)
    ) {
      selectFirstVisibleTarget()
    }
  }, [
    navigationHibernatingSessions.length,
    navigationLiveSessions.length,
    hasLoaded,
    selectFirstVisibleTarget,
    selectedSessionId,
    selectedHibernatingSessionId,
  ])

  // Pending kills: snapshot + selection state for rollback on kill-failed.
  // Separate from exitingSessions (which gets cleaned up by animation timers).
  // Each entry stores the connectionEpoch at which the kill was issued so stale
  // entries from a previous connection can be discarded on reconnect.
  const pendingKills = useRef<Map<string, { session: Session; wasSelected: boolean; epoch: number }>>(new Map())

  const handleKillSession = useCallback((
    sessionId: string,
    source: SessionKillSource = 'unknown',
  ) => {
    invalidateSnapshotCache(sessionId)
    // Snapshot session and selection state before removal for kill-failed rollback
    const { sessions: currentSessions, selectedSessionId: currentSelected } = useSessionStore.getState()
    const session = currentSessions.find(s => s.id === sessionId)
    if (session) {
      pendingKills.current.set(sessionId, {
        session,
        wasSelected: currentSelected === sessionId,
        epoch: getConnectionEpoch(),
      })
    }
    // Force synchronous DOM update so the session card disappears immediately,
    // even if the browser's main thread is busy with WebSocket messages or
    // xterm.js rendering. Without flushSync, React 18 may defer the paint.
    flushSync(() => {
      markSessionExiting(sessionId)
      setSessions(currentSessions.filter(s => s.id !== sessionId))
    })
    sendMessage({ type: 'session-kill', sessionId, source })
  }, [markSessionExiting, setSessions, sendMessage])

  // Chat archive/restore (chat-archive design D2/D3): the server operation is
  // unconditional and idempotent; requestChatArchive asks before
  // interrupting a turn in flight, same as the chat view header.
  const handleArchiveChat = useCallback(
    (sessionId: string) => {
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      if (session) requestChatArchive(session, sendMessage)
    },
    [sendMessage]
  )
  const handleRestoreChat = useCallback(
    (sessionId: string) => {
      sendMessage({ type: 'chat-restore', sessionId })
    },
    [sendMessage]
  )

  useEffect(() => {
    const effectiveModifier = getEffectiveModifier(shortcutModifier)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      // Use event.code for consistent detection across browsers
      // (event.key fails in Chrome/Arc on macOS due to Option dead keys)
      const code = event.code
      const isShortcut = matchesModifier(event, effectiveModifier)

      // Bracket navigation: [mod]+[ / ]
      // When only hibernating sessions are visible, fall back to navigating
      // within the hibernating bucket so the keyboard shortcut keeps working.
      // The order is the flattened grouped order when a workspace snapshot
      // exists, crossing expanded worktree groups.
      if (isShortcut && (code === 'BracketLeft' || code === 'BracketRight')) {
        event.preventDefault()
        const delta = code === 'BracketLeft' ? -1 : 1
        const activeNav = navigationLiveSessions
        if (activeNav.length === 0) {
          const hibernatingNav = navigationHibernatingSessions
          if (hibernatingNav.length === 0) return
          const currentIndex = hibernatingNav.findIndex(
            s => s.sessionId === selectedHibernatingSessionId
          )
          if (currentIndex === -1) {
            setSelectedHibernatingSessionId(hibernatingNav[0].sessionId)
            return
          }
          const newIndex =
            (currentIndex + delta + hibernatingNav.length) % hibernatingNav.length
          setSelectedHibernatingSessionId(hibernatingNav[newIndex].sessionId)
          return
        }
        const currentIndex = activeNav.findIndex(s => s.id === selectedSessionId)
        if (currentIndex === -1) {
          setSelectedSessionId(activeNav[0].id)
          return
        }
        const newIndex = (currentIndex + delta + activeNav.length) % activeNav.length
        setSelectedSessionId(activeNav[newIndex].id)
        return
      }

      // Direct navigation: [mod]+1..9 selects the corresponding visible
      // session. As with bracket navigation, use hibernating sessions only
      // when there are no visible live sessions. Invalid indices remain
      // unhandled so the browser/terminal keeps the key event.
      if (isShortcut && /^Digit[1-9]$/.test(code)) {
        const index = Number(code.slice('Digit'.length)) - 1
        if (navigationLiveSessions.length > 0) {
          const target = navigationLiveSessions[index]
          if (!target) return
          event.preventDefault()
          setSelectedSessionId(target.id)
          return
        }

        const target = navigationHibernatingSessions[index]
        if (!target) return
        event.preventDefault()
        setSelectedHibernatingSessionId(target.sessionId)
        return
      }

      // New session: [mod]+N
      if (isShortcut && code === 'KeyN') {
        event.preventDefault()
        // Never stack over Settings: its close would restore terminal focus under this dialog.
        if (!isModalOpen && !isSettingsOpen && settingsHydrated) {
          setIsModalOpen(true)
        }
        return
      }

      // Search chats: [mod]+K focuses the navigator's search box.
      if (isShortcut && code === 'KeyK') {
        event.preventDefault()
        useSessionSearchStore.getState().requestFocus()
        return
      }

      // Kill session: [mod]+X
      if (isShortcut && code === 'KeyX') {
        event.preventDefault()
        if (selectedSessionId && !isModalOpen) {
          handleKillSession(selectedSessionId, 'keyboard_shortcut')
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    isModalOpen,
    isSettingsOpen,
    selectedSessionId,
    selectedHibernatingSessionId,
    setSelectedSessionId,
    setSelectedHibernatingSessionId,
    navigationLiveSessions,
    navigationHibernatingSessions,
    handleKillSession,
    shortcutModifier,
    settingsHydrated,
  ])

  const handleNewSession = (): boolean => {
    if (!settingsHydrated) return false
    setNewSessionInitialHost(undefined)
    setNewSessionInitialPath(undefined)
    setNewSessionInitialCommand(undefined)
    setNewSessionInitialAutoStartChange(undefined)
    setIsModalOpen(true)
    return true
  }

  // Contextual new-session from a section header: preselect the worktree
  // root; command presets, names, and hosts flow through the normal form.
  // From a change section the form also offers the apply auto-start.
  const handleNewSessionInWorktree = useCallback(
    (worktreePath: string, changeName?: string) => {
      if (!settingsHydrated) return
      setNewSessionInitialHost(undefined)
      setNewSessionInitialPath(worktreePath)
      setNewSessionInitialCommand(undefined)
      setNewSessionInitialAutoStartChange(changeName)
      setIsModalOpen(true)
    },
    [settingsHydrated]
  )
  // Seeded creation from a worktree-less change section (§7.2): the server
  // creates `.worktrees/<change>`, and the result routing below opens the
  // prefilled session form (with auto-start offered) on success.
  const handleCreateChangeWorktree = useCallback(
    (repositoryId: string, change: string) => {
      pendingChangeLaunchRef.current = { repositoryId, change }
      sendMessage({ type: 'create-change-worktree', repositoryId, change })
    },
    [sendMessage]
  )
  // Repository branch browser entry from a worktree header (§8.1).
  const handleBrowseBranches = useCallback((repositoryId: string) => {
    setBranchBrowserRepositoryId(repositoryId)
    setCreateWorktreeBranch(null)
  }, [])
  // The task pickers' create-worktree link (task-assignment D8): opens the
  // same branch-browser flow for the repository containing the project path;
  // the pickers refresh their lists when they regain focus on return.
  const handleBrowseBranchesForPath = useCallback((projectPath: string) => {
    const repository = workspaceSnapshot?.repositories.find(row =>
      row.worktrees.some(worktree => projectPath === worktree.path || projectPath.startsWith(`${worktree.path}/`)))
    if (repository) handleBrowseBranches(repository.id)
  }, [workspaceSnapshot, handleBrowseBranches])
  const handleCloseBranchBrowser = useCallback(() => {
    setBranchBrowserRepositoryId(null)
    setCreateWorktreeBranch(null)
  }, [])
  // Create-worktree form (§8.2): branch chosen in the browser.
  const handleCreateWorktreeFromBranch = useCallback((branch: WorkspaceBranch) => {
    setCreateWorktreeBranch(branch)
  }, [])
  const handleCancelCreateWorktree = useCallback(() => {
    setCreateWorktreeBranch(null)
  }, [])
  const handleConfirmCreateWorktree = useCallback(
    (destination: string, launchSession: boolean) => {
      const branch = createWorktreeBranch
      const repositoryId = branchBrowserRepositoryId
      setBranchBrowserRepositoryId(null)
      setCreateWorktreeBranch(null)
      if (!branch || repositoryId === null) return
      if (launchSession) {
        pendingWorktreeLaunchRef.current = {
          repositoryId,
          branch: branch.name,
        }
      }
      sendMessage({
        type: 'create-worktree',
        repositoryId,
        branch: branch.name,
        destination,
        ...(launchSession ? { launchSession: true } : {}),
      })
    },
    [createWorktreeBranch, branchBrowserRepositoryId, sendMessage]
  )
  const handleOpenSettings = () => setIsSettingsOpen(true)

  const handleCreateSession = (
    projectPath: string,
    name?: string,
    command?: string,
    host?: string,
    autoStartChange?: string,
    autoStartAgent?: AutoStartAgent,
    kind?: 'terminal' | 'chat',
    claudeProfileId?: string,
    approvalPolicy?: ChatApprovalPolicy,
    groupId?: string
  ) => {
    sendMessage({ type: 'session-create', projectPath, name, command, host, autoStartChange, autoStartAgent, kind, claudeProfileId, approvalPolicy, ...(groupId ? { groupId } : {}) })
    if (!host) setLastProjectPath(projectPath)
  }

  const handleResumeSession = useCallback((sessionId: string) => {
    sendMessage({ type: 'session-wake', sessionId })
  }, [sendMessage])

  const handleHibernateSession = useCallback((sessionId: string) => {
    sendMessage({ type: 'session-hibernate', sessionId })
  }, [sendMessage])

  const handleRenameSession = useCallback((sessionId: string, newName: string) => {
    sendMessage({ type: 'session-rename', sessionId, newName })
  }, [sendMessage])

  const handleDuplicateSession = useCallback((sessionId: string) => {
    // Read sessions from the store at click time: memoized session rows must
    // duplicate from current data, not from a snapshot captured when this
    // callback was created (design D6 audit).
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === sessionId)
    if (!session) return
    sendMessage({
      type: 'session-create',
      projectPath: session.projectPath,
      command: session.command || undefined,
      host: session.remote && session.host ? session.host : undefined,
    })
  }, [sendMessage])

  const handleMoveToHistory = useCallback((sessionId: string) => {
    sendMessage({ type: 'session-move-to-history', sessionId })
  }, [sendMessage])

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Fetch server info (including Tailscale IP) on mount and on every
  // reconnect: after an update the server across the socket is a different
  // build, and a fresh build never re-broadcasts the update state (its
  // checker starts at "current"), so this re-seed is what clears a stale
  // target the previous build pushed — and refreshes the shown version.
  useEffect(() => {
    fetch('/api/server-info')
      .then((res) => res.json())
      .then((info: ServerInfo) => {
        setServerInfo(info)
        useUpdateStore.getState().setFromServerInfo(info.update)
      })
      .catch(() => {})
  }, [connectionEpoch])

  const remoteHostStatuses = useMemo(() => {
    if (!hostLabel) return hostStatuses
    return hostStatuses.filter((hostStatus) => hostStatus.host !== hostLabel)
  }, [hostStatuses, hostLabel])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left column: header + sidebar - always hidden on mobile (drawer handles it) */}
      <div
        className="hidden h-full flex-col md:flex md:shrink-0"
        style={{ width: sidebarWidth }}
      >
        <Header
          connectionStatus={connectionStatus}
          onNewSession={handleNewSession}
          onOpenSettings={handleOpenSettings}
          tailscaleIp={serverInfo?.tailscaleIp ?? null}
          version={serverInfo?.version ?? null}
        />
        <SessionList
          sessions={sessions}
          hibernatingSessions={hibernatingAgentSessions}
          historySessions={historyAgentSessions}
          selectedSessionId={selectedSessionId}
          selectedHibernatingSessionId={selectedHibernatingSessionId}
          onSelect={setSelectedSessionId}
          onSelectHibernating={setSelectedHibernatingSessionId}
          onRename={handleRenameSession}
          onResume={handleResumeSession}
          onHibernate={handleHibernateSession}
          onArchiveChat={handleArchiveChat}
          onRestoreChat={handleRestoreChat}
          onKill={handleKillSession}
          onDuplicate={handleDuplicateSession}
          onMoveToHistory={handleMoveToHistory}
          onNewSession={handleNewSession}
          loading={!hasLoaded}
          error={connectionError || serverError}
          workspaceView={workspaceSnapshot ? workspaceView : null}
          onToggleSectionCollapse={toggleSectionCollapsed}
          onNewSessionInWorktree={handleNewSessionInWorktree}
          onCreateChangeWorktree={handleCreateChangeWorktree}
          onBrowseBranches={handleBrowseBranches}
        />
      </div>

      {/* Sidebar resize handle */}
      <div
        className="hidden md:block w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-white/10 active:bg-white/20"
        onMouseDown={handleResizeStart}
      />

      {/* Active session pane - full height on desktop */}
      {selectedSession?.kind === 'chat' ? <ChatView
        session={selectedSession} sendMessage={sendMessage} subscribe={subscribe}
        connectionStatus={connectionStatus} connectionEpoch={connectionEpoch}
        error={connectionError || serverError} onClose={() => setSelectedSessionId(null)}
        onKill={() => handleKillSession(selectedSession.id)}
        onCreateWorktree={() => handleBrowseBranchesForPath(selectedSession.projectPath)}
      /> : <Terminal
        session={selectedSession}
        sessions={navigationLiveSessions}
        hibernatingSession={selectedHibernatingSession}
        hibernatingSessions={hibernatingAgentSessions}
        connectionStatus={connectionStatus}
        connectionEpoch={connectionEpoch}
        sendMessage={sendMessage}
        subscribe={subscribe}
        onClose={() => setSelectedSessionId(null)}
        onSelectSession={setSelectedSessionId}
        onSelectHibernatingSession={setSelectedHibernatingSessionId}
        onNewSession={handleNewSession}
        onKillSession={handleKillSession}
        onRenameSession={handleRenameSession}
        onOpenSettings={handleOpenSettings}
        onResumeSession={handleResumeSession}
        onHibernateSession={handleHibernateSession}
        onMoveToHistory={handleMoveToHistory}
        onArchiveChat={handleArchiveChat}
        onRestoreChat={handleRestoreChat}
        historySessions={historyAgentSessions}
        loading={!hasLoaded}
        error={connectionError || serverError}
        workspaceView={workspaceSnapshot ? workspaceView : null}
        onToggleSectionCollapse={toggleSectionCollapsed}
        onNewSessionInWorktree={handleNewSessionInWorktree}
        onCreateChangeWorktree={handleCreateChangeWorktree}
        onBrowseBranches={handleBrowseBranches}
      />}

      <NewSessionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreateSession}
        defaultProjectDir={effectiveDefaultProjectDir}
        commandPresets={commandPresets}
        defaultPresetId={defaultPresetId}
        lastProjectPath={lastProjectPath}
        activeProjectPath={selectedSession && !selectedSession.remote ? selectedSession.projectPath : undefined}
        remoteHosts={remoteHostStatuses}
        remoteAllowControl={remoteAllowControl}
        initialHost={newSessionInitialHost}
        initialPath={newSessionInitialPath}
        initialCommand={newSessionInitialCommand}
        initialAutoStartChange={newSessionInitialAutoStartChange}
        worktrees={worktreeOptions}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        serverDefaultDir={serverDefaultProjectDir || null}
        version={serverInfo?.version ?? null}
      />

      <UpdatePanel />

      {branchBrowserRepository && createWorktreeBranch === null && (
        <BranchBrowserModal
          repository={branchBrowserRepository}
          onClose={handleCloseBranchBrowser}
          onCreateWorktree={handleCreateWorktreeFromBranch}
        />
      )}

      {branchBrowserRepository && createWorktreeBranch !== null && (
        <CreateWorktreeModal
          repository={branchBrowserRepository}
          branch={createWorktreeBranch}
          existingWorktreePaths={allWorktreePaths}
          onConfirm={handleConfirmCreateWorktree}
          onCancel={handleCancelCreateWorktree}
        />
      )}

      <ToastViewport />
    </div>
  )
}
