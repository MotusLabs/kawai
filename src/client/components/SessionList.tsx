import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import ChevronRightIcon from '@untitledui-icons/react/line/esm/ChevronRightIcon'
import PlusIcon from '@untitledui-icons/react/line/esm/PlusIcon'
import type { AgentSession, Session, SessionKillSource } from '@shared/types'
import { getSessionOrderKey, getUniqueHosts, getUniqueProjects, sortSessions } from '../utils/sessions'
import { formatRelativeTime } from '../utils/time'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import { useCounterBump } from '../hooks/useCounterBump'
import { useExitCleanup } from '../hooks/useExitCleanup'
import HostFilterDropdown from './HostFilterDropdown'
import ProjectFilterDropdown from './ProjectFilterDropdown'
import SessionPreviewModal from './SessionPreviewModal'
import HibernatingSessionItem from './HibernatingSessionItem'
import HistorySessionItem from './HistorySessionItem'
import { SortableSessionItem } from './SessionRow'
import WorkspaceSectionList from './WorkspaceSectionList'
import type { WorkspaceView } from '../utils/workspaceView'

interface SessionListProps {
  sessions: Session[]
  hibernatingSessions?: AgentSession[]
  historySessions?: AgentSession[]
  selectedSessionId: string | null
  selectedHibernatingSessionId?: string | null
  loading: boolean
  error: string | null
  onSelect: (sessionId: string) => void
  onSelectHibernating?: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onResume?: (sessionId: string) => void
  onHibernate?: (sessionId: string) => void
  onKill?: (sessionId: string, source?: SessionKillSource) => void
  onDuplicate?: (sessionId: string) => void
  onMoveToHistory?: (sessionId: string) => void
  onNewSession?: () => void
  /**
   * Grouped workspace view from App. When present (a workspace snapshot
   * exists), rows render inside worktree groups with local-ungrouped and
   * remote fallbacks; otherwise the flat list is preserved for older
   * servers and the pre-snapshot window.
   */
  workspaceView?: WorkspaceView | null
  onToggleSectionCollapse?: (sectionKey: string) => void
  /** Contextual new-session action on worktree group headers. */
  onNewSessionInWorktree?: (worktreePath: string) => void
  /** Opens the repository branch browser from a worktree header. */
  onBrowseBranches?: (repositoryId: string) => void
}

function useTimestampRefresh() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30000)
    return () => clearInterval(id)
  }, [])
}

export default function SessionList({
  sessions,
  hibernatingSessions = [],
  historySessions = [],
  selectedSessionId,
  selectedHibernatingSessionId = null,
  loading,
  error,
  onSelect,
  onSelectHibernating,
  onRename,
  onResume,
  onHibernate,
  onKill,
  onDuplicate,
  onMoveToHistory,
  onNewSession,
  workspaceView = null,
  onToggleSectionCollapse,
  onNewSessionInWorktree,
  onBrowseBranches,
}: SessionListProps) {
  useTimestampRefresh()
  const isSafari = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  }, [])
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const showHistory = useSettingsStore((state) => state.historySessionsExpanded)
  const setShowHistory = useSettingsStore((state) => state.setHistorySessionsExpanded)
  const showHibernating = useSettingsStore((state) => state.hibernatingSessionsExpanded)
  const setShowHibernating = useSettingsStore((state) => state.setHibernatingSessionsExpanded)
  const [previewSession, setPreviewSession] = useState<AgentSession | null>(null)
  const [historyLimit, setHistoryLimit] = useState(20)
  const prefersReducedMotion = useReducedMotion()
  const useSafariLayoutFallback = isSafari && !prefersReducedMotion
  const dormantSessions = useMemo(
    () => [...hibernatingSessions, ...historySessions],
    [hibernatingSessions, historySessions]
  )

  // Reset pagination when history panel is collapsed
  useEffect(() => {
    if (!showHistory) {
      setHistoryLimit(20)
    }
  }, [showHistory])

  // Animation sequencing constants (in ms)
  const EXIT_DURATION = 200

  // Counter bump animations
  const [activeCounterBump, clearActiveCounterBump] = useCounterBump(
    sessions.length,
    EXIT_DURATION
  )
  const [historyCounterBump, clearHistoryCounterBump] = useCounterBump(historySessions.length, EXIT_DURATION, true)

  // Track newly added sessions for entry animations
  const prevActiveIdsRef = useRef<Set<string>>(new Set(sessions.map((s) => s.id)))
  const prevDormantIdsForActiveRef = useRef<Set<string>>(
    new Set(
      [...hibernatingSessions, ...historySessions].map((session) => session.sessionId)
    )
  )
  const [newlyActiveIds, setNewlyActiveIds] = useState<Set<string>>(new Set())

  // Detect newly active sessions
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    const currentDormantIds = new Set(
      [...hibernatingSessions, ...historySessions].map((session) => session.sessionId)
    )
    const newIds = new Set<string>()
    for (const id of currentIds) {
      if (!prevActiveIdsRef.current.has(id)) {
        newIds.add(id)
      }
    }
    for (const session of sessions) {
      const agentId = session.agentSessionId?.trim()
      if (
        agentId &&
        prevDormantIdsForActiveRef.current.has(agentId) &&
        !currentDormantIds.has(agentId)
      ) {
        newIds.add(session.id)
      }
    }
    prevActiveIdsRef.current = currentIds
    prevDormantIdsForActiveRef.current = currentDormantIds

    if (newIds.size > 0) {
      setNewlyActiveIds(newIds)
    }
  }, [sessions, hibernatingSessions, historySessions])

  // Auto-clear newlyActiveIds after delay (separate effect to avoid timer bugs)
  useEffect(() => {
    if (newlyActiveIds.size === 0) return
    const timer = setTimeout(() => setNewlyActiveIds(new Set()), 500)
    return () => clearTimeout(timer)
  }, [newlyActiveIds])

  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))
  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const setSessionSortMode = useSettingsStore((state) => state.setSessionSortMode)
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const manualSessionOrder = useSettingsStore((state) => state.manualSessionOrder)
  const setManualSessionOrder = useSettingsStore((state) => state.setManualSessionOrder)
  const showProjectName = useSettingsStore((state) => state.showProjectName)
  const showLastUserMessage = useSettingsStore(
    (state) => state.showLastUserMessage
  )
  const showSessionIdPrefix = useSettingsStore(
    (state) => state.showSessionIdPrefix
  )
  const projectFilters = useSettingsStore((state) => state.projectFilters)
  const setProjectFilters = useSettingsStore((state) => state.setProjectFilters)
  const hostFilters = useSettingsStore((state) => state.hostFilters)
  const setHostFilters = useSettingsStore((state) => state.setHostFilters)

  // Get exiting sessions from store (for kill-failed rollback only)
  const exitingSessions = useSessionStore((state) => state.exitingSessions)
  const clearExitingSession = useSessionStore((state) => state.clearExitingSession)
  const hostStatuses = useSessionStore((state) => state.hostStatuses)
  const remoteAllowControl = useSessionStore((state) => state.remoteAllowControl)

  // Clean up exiting session state after animations
  useExitCleanup(sessions, exitingSessions, clearExitingSession, EXIT_DURATION)


  // Clean up manualSessionOrder when sessions are removed
  useEffect(() => {
    if (manualSessionOrder.length === 0) return
    const currentIds = new Set<string>()
    for (const session of sessions) {
      currentIds.add(getSessionOrderKey(session))
      currentIds.add(session.id)
    }
    for (const session of dormantSessions) {
      currentIds.add(session.sessionId)
    }
    const validOrder = manualSessionOrder.filter((id) => currentIds.has(id))
    if (validOrder.length !== manualSessionOrder.length) {
      setManualSessionOrder(validOrder)
    }
  }, [sessions, dormantSessions, manualSessionOrder, setManualSessionOrder])

  const sortedActive = useMemo(
    () =>
      sortSessions(sessions, {
        mode: sessionSortMode,
        direction: sessionSortDirection,
        manualOrder: manualSessionOrder,
      }),
    [sessions, sessionSortMode, sessionSortDirection, manualSessionOrder]
  )

  // Don't add exiting sessions back to the list - let AnimatePresence handle
  // the exit animation naturally. This prevents the 250ms delay before animation starts.
  const sortedSessions = sortedActive

  const uniqueProjects = useMemo(
    () => getUniqueProjects(sessions, dormantSessions),
    [sessions, dormantSessions]
  )

  const uniqueHosts = useMemo(() => {
    const sessionHosts = getUniqueHosts(sessions, dormantSessions)
    const statusHosts = hostStatuses.map((status) => status.host)
    const seen = new Set<string>()
    const merged: string[] = []

    for (const host of statusHosts) {
      if (!host || seen.has(host)) continue
      seen.add(host)
      merged.push(host)
    }

    for (const host of sessionHosts) {
      if (!host || seen.has(host)) continue
      seen.add(host)
      merged.push(host)
    }

    return merged
  }, [sessions, dormantSessions, hostStatuses])

  // Auto-show host info when multiple hosts are present
  const showHostInfo = useMemo(() => uniqueHosts.length > 1, [uniqueHosts])

  const filteredSessions = useMemo(() => {
    let next = sortedSessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [sortedSessions, projectFilters, hostFilters])

  const filterKey = useMemo(
    () => {
      const projectKey = projectFilters.length === 0 ? 'all-projects' : projectFilters.join('|')
      const hostKey = hostFilters.length === 0 ? 'all-hosts' : hostFilters.join('|')
      return `${projectKey}::${hostKey}`
    },
    [projectFilters, hostFilters]
  )

  // Track sessions that became visible due to filter changes (for entry animation)
  const prevFilteredIdsRef = useRef<Set<string>>(new Set(filteredSessions.map((s) => s.id)))
  const [newlyFilteredInIds, setNewlyFilteredInIds] = useState<Set<string>>(new Set())

  // Detect sessions that became visible due to filter changes
  useEffect(() => {
    const currentFilteredIds = new Set(filteredSessions.map((s) => s.id))
    const newlyVisible = new Set<string>()

    // Find sessions that are now visible but weren't before
    for (const id of currentFilteredIds) {
      if (!prevFilteredIdsRef.current.has(id)) {
        // Only mark as "newly filtered in" if the session already existed (wasn't truly new)
        // This distinguishes filter changes from actual new sessions
        if (!newlyActiveIds.has(id)) {
          newlyVisible.add(id)
        }
      }
    }

    prevFilteredIdsRef.current = currentFilteredIds

    if (newlyVisible.size > 0) {
      setNewlyFilteredInIds(newlyVisible)
    }
  }, [filteredSessions, newlyActiveIds])

  // Auto-clear newlyFilteredInIds after delay (separate effect to avoid timer bugs)
  useEffect(() => {
    if (newlyFilteredInIds.size === 0) return
    const timer = setTimeout(() => setNewlyFilteredInIds(new Set()), 500)
    return () => clearTimeout(timer)
  }, [newlyFilteredInIds])

  const filteredHibernatingSessions = useMemo(() => {
    let next = hibernatingSessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [hibernatingSessions, projectFilters, hostFilters])

  const filteredHistorySessions = useMemo(() => {
    let next = historySessions
    if (projectFilters.length > 0) {
      next = next.filter((session) => projectFilters.includes(session.projectPath))
    }
    if (hostFilters.length > 0) {
      next = next.filter((session) => hostFilters.includes(session.host ?? ''))
    }
    return next
  }, [historySessions, projectFilters, hostFilters])

  const hiddenPermissionCount = useMemo(() => {
    if (projectFilters.length === 0) return 0
    const filterSet = new Set(projectFilters)
    return sessions.filter(
      (session) =>
        !filterSet.has(session.projectPath) && session.status === 'permission'
    ).length
  }, [sessions, projectFilters])

  useEffect(() => {
    // Skip cleanup when no projects loaded yet (would clear persisted filters on initial load)
    if (projectFilters.length === 0 || uniqueProjects.length === 0) return
    const validProjects = new Set(uniqueProjects)
    const nextFilters = projectFilters.filter((project) => validProjects.has(project))
    if (nextFilters.length !== projectFilters.length) {
      setProjectFilters(nextFilters)
    }
  }, [projectFilters, uniqueProjects, setProjectFilters])

  useEffect(() => {
    if (hostFilters.length === 0 || uniqueHosts.length === 0) return
    const validHosts = new Set(uniqueHosts)
    const nextFilters = hostFilters.filter((host) => validHosts.has(host))
    if (nextFilters.length !== hostFilters.length) {
      setHostFilters(nextFilters)
    }
  }, [hostFilters, uniqueHosts, setHostFilters])

  // Drag-and-drop setup
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement to start drag (prevents accidental drags)
      },
    })
  )

  // Track active drag state for drop indicator
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  /**
   * Apply a within-group manual reorder to the global manual order: slots
   * belonging to the group's sessions take the group's new sequence while
   * every other session keeps its relative position. Shared by the flat
   * list's DragEnd and the grouped navigator's per-group drops.
   */
  const applyManualReorder = useCallback(
    (reorderedVisible: string[], spine: Session[]) => {
      const reorderedSet = new Set(reorderedVisible)
      let visibleIndex = 0
      const newOrder = spine.map((session) => {
        const key = getSessionOrderKey(session)
        if (!reorderedSet.has(key)) return key
        const nextKey = reorderedVisible[visibleIndex]
        visibleIndex += 1
        return nextKey
      })

      // Switch to manual mode and update order
      if (sessionSortMode !== 'manual') {
        setSessionSortMode('manual')
      }
      setManualSessionOrder(newOrder)
    },
    [sessionSortMode, setSessionSortMode, setManualSessionOrder]
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }, [])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setOverId(event.over?.id as string | null)
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      setOverId(null)

      if (!over || active.id === over.id) {
        return
      }

      const oldIndex = filteredSessions.findIndex((s) => s.id === active.id)
      const newIndex = filteredSessions.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) {
        return
      }

      const reorderedVisible = filteredSessions.map((s) => getSessionOrderKey(s))
      const [removed] = reorderedVisible.splice(oldIndex, 1)
      reorderedVisible.splice(newIndex, 0, removed)

      applyManualReorder(reorderedVisible, sortedSessions)
    },
    [filteredSessions, sortedSessions, applyManualReorder]
  )

  // Grouped navigator drop: the group hands us its live session ids in the
  // new order; merge into the global spine, replacing only that group's slots.
  const handleGroupReorder = useCallback(
    (orderedSessionIds: string[]) => {
      const idToKey = new Map(sortedSessions.map((s) => [s.id, getSessionOrderKey(s)]))
      const orderedKeys: string[] = []
      for (const id of orderedSessionIds) {
        const key = idToKey.get(id)
        if (key !== undefined) orderedKeys.push(key)
      }
      if (orderedKeys.length === 0) return
      applyManualReorder(orderedKeys, sortedSessions)
    },
    [sortedSessions, applyManualReorder]
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
  }, [])

  useEffect(() => {
    if (!activeId && !overId) return
    const currentIds = new Set(filteredSessions.map((s) => s.id))
    if (activeId && !currentIds.has(activeId)) {
      setActiveId(null)
    }
    if (overId && !currentIds.has(overId)) {
      setOverId(null)
    }
  }, [filteredSessions, activeId, overId])

  const handleRename = (sessionId: string, newName: string) => {
    onRename(sessionId, newName)
    setEditingSessionId(null)
  }

  return (
    <aside className="flex min-h-0 flex-1 flex-col border-r border-border bg-elevated">
      {error && (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex h-10 items-center justify-start gap-2 border-b border-border bg-elevated px-3">
          {showHostInfo && (
            <HostFilterDropdown
              hosts={uniqueHosts}
              selectedHosts={hostFilters}
              onSelect={setHostFilters}
              statuses={hostStatuses}
            />
          )}
          <ProjectFilterDropdown
            projects={uniqueProjects}
            selectedProjects={projectFilters}
            onSelect={setProjectFilters}
            hasHiddenPermissions={hiddenPermissionCount > 0}
          />
        </div>
        {loading ? (
          <div className="space-y-1 p-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded bg-surface"
              />
            ))}
          </div>
        ) : workspaceView ? (
          <WorkspaceSectionList
            view={workspaceView}
            onToggleCollapse={onToggleSectionCollapse ?? (() => {})}
            remountKey={filterKey}
            showHibernating={showHibernating}
            showHistory={showHistory}
            onToggleHibernating={() => setShowHibernating(!showHibernating)}
            onToggleHistory={() => setShowHistory(!showHistory)}
            hibernatingCount={filteredHibernatingSessions.length}
            historyCount={filteredHistorySessions.length}
            historyLimit={historyLimit}
            onShowMoreHistory={() => setHistoryLimit((prev) => prev + 20)}
            onNewSession={onNewSession}
            onNewSessionInWorktree={onNewSessionInWorktree}
            onBrowseBranches={onBrowseBranches}
            selectedSessionId={selectedSessionId}
            selectedHibernatingSessionId={selectedHibernatingSessionId}
            editingSessionId={editingSessionId}
            showSessionIdPrefix={showSessionIdPrefix}
            showProjectName={showProjectName}
            showLastUserMessage={showLastUserMessage}
            showHostInfo={showHostInfo}
            prefersReducedMotion={prefersReducedMotion}
            useSafariLayoutFallback={useSafariLayoutFallback}
            exitDuration={EXIT_DURATION}
            remoteAllowControl={remoteAllowControl}
            onSelect={onSelect}
            onSelectHibernating={onSelectHibernating ?? (() => {})}
            onStartEdit={setEditingSessionId}
            onCancelEdit={() => setEditingSessionId(null)}
            onRename={handleRename}
            onHibernate={onHibernate ?? (() => {})}
            onKill={onKill ? (sessionId) => onKill(sessionId, 'session_list_context_menu') : () => {}}
            onDuplicate={onDuplicate ?? (() => {})}
            onResume={onResume ?? (() => {})}
            onMoveToHistory={onMoveToHistory ?? (() => {})}
            onPreview={setPreviewSession}
            onReorder={handleGroupReorder}
            isNew={(sessionId) =>
              newlyActiveIds.has(sessionId) || newlyFilteredInIds.has(sessionId)
            }
          />
        ) : (
          <>
            <div className="flex items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted">
              <span>Active</span>
              <div className="flex items-center gap-2">
                {filteredSessions.length === 0 && onNewSession && (
                  <button
                    type="button"
                    onClick={onNewSession}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal text-accent hover:bg-hover"
                    title="Start a new session"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    New session
                  </button>
                )}
                <motion.span
                  className="w-8 text-right text-xs"
                  animate={activeCounterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
                  transition={{ duration: 0.3 }}
                  onAnimationComplete={clearActiveCounterBump}
                >
                  {filteredSessions.length}
                </motion.span>
              </div>
            </div>
            {filteredSessions.length > 0 && (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
                <SortableContext
                  items={filteredSessions.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div key={filterKey}>
                    {/* sync (not popLayout): without per-row layout animation,
                        popLayout would overlap an exiting row with the sibling
                        snapping into its place */}
                    <AnimatePresence initial={false} mode="sync">
                      {filteredSessions.map((session, index) => {
                        const isTrulyNew = newlyActiveIds.has(session.id)
                        const isFilteredIn = newlyFilteredInIds.has(session.id)
                        const isRemote = session.remote === true
                        const isManaged = session.source === 'managed'
                        const canControl = !isRemote || (remoteAllowControl && isManaged)
                        const canHibernate = Boolean(
                          onHibernate &&
                          !isRemote &&
                          isManaged &&
                          session.agentSessionId?.trim()
                        )
                        // Calculate drop indicator position
                        const activeIndex = activeId
                          ? filteredSessions.findIndex((s) => s.id === activeId)
                          : -1
                        const isOver = overId === session.id && activeId !== session.id
                        const showDropIndicator = isOver ? (activeIndex > index ? 'above' : 'below') : null
                        // Show bounce for both new and filter-in, but delay only for truly new
                        const isNew = isTrulyNew || isFilteredIn
                        return (
                          <SortableSessionItem
                            key={session.id}
                            session={session}
                            isNew={isNew}
                            exitDuration={EXIT_DURATION}
                            prefersReducedMotion={prefersReducedMotion}
                            useSafariLayoutFallback={useSafariLayoutFallback}
                            isSelected={session.id === selectedSessionId}
                            isEditing={session.id === editingSessionId}
                            showSessionIdPrefix={showSessionIdPrefix}
                            showProjectName={showProjectName}
                            showLastUserMessage={showLastUserMessage}
                            showHostInfo={showHostInfo}
                            dropIndicator={showDropIndicator}
                            onSelect={() => onSelect(session.id)}
                            onStartEdit={canControl ? () => setEditingSessionId(session.id) : undefined}
                            onCancelEdit={() => setEditingSessionId(null)}
                            onRename={(newName) => handleRename(session.id, newName)}
                            onHibernate={
                              canHibernate
                                ? () => onHibernate?.(session.agentSessionId!.trim())
                                : undefined
                            }
                            onKill={
                              onKill && canControl
                                ? () => onKill(session.id, 'session_list_context_menu')
                                : undefined
                            }
                            onDuplicate={onDuplicate && canControl ? () => onDuplicate(session.id) : undefined}
                          />
                        )
                      })}
                    </AnimatePresence>
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {filteredHibernatingSessions.length > 0 && (
              <div className="border-t border-border">
                <button
                  type="button"
                  onClick={() => setShowHibernating(!showHibernating)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted hover:text-primary"
                >
                  <span className="flex items-center gap-2">
                    {showHibernating ? (
                      <ChevronDownIcon className="h-4 w-4" />
                    ) : (
                      <ChevronRightIcon className="h-4 w-4" />
                    )}
                    Hibernating
                  </span>
                  <span className="w-8 text-right text-xs text-muted">
                    {filteredHibernatingSessions.length}
                  </span>
                </button>
                {showHibernating && (
                  <div className="py-1">
                    {filteredHibernatingSessions.map((session) => (
                      <HibernatingSessionItem
                        key={session.sessionId}
                        session={session}
                        isSelected={selectedHibernatingSessionId === session.sessionId}
                        showSessionIdPrefix={showSessionIdPrefix}
                        showProjectName={showProjectName}
                        showLastUserMessage={showLastUserMessage}
                        onSelect={(sessionId) => onSelectHibernating?.(sessionId)}
                        onWake={(sessionId) => onResume?.(sessionId)}
                        onRename={(sessionId, newName) => handleRename(sessionId, newName)}
                        onMoveToHistory={onMoveToHistory}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {!workspaceView && filteredHistorySessions.length > 0 && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setShowHistory(!showHistory)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted hover:text-primary"
            >
              <span className="flex items-center gap-2">
                {showHistory ? (
                  <ChevronDownIcon className="h-4 w-4" />
                ) : (
                  <ChevronRightIcon className="h-4 w-4" />
                )}
                History
              </span>
              <motion.span
                className="w-8 text-right text-xs"
                animate={historyCounterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
                transition={{ duration: 0.3 }}
                onAnimationComplete={clearHistoryCounterBump}
              >
                {filteredHistorySessions.length}
              </motion.span>
            </button>
            {showHistory && (
              <div className="py-1">
                {filteredHistorySessions.slice(0, historyLimit).map((session) => (
                  <HistorySessionItem
                    key={session.sessionId}
                    session={session}
                    showSessionIdPrefix={showSessionIdPrefix}
                    showProjectName={showProjectName}
                    showLastUserMessage={showLastUserMessage}
                    onResume={(sessionId) => onResume?.(sessionId)}
                    onPreview={setPreviewSession}
                  />
                ))}
                {filteredHistorySessions.length > historyLimit && (
                  <button
                    type="button"
                    onClick={() => setHistoryLimit((prev) => prev + 20)}
                    className="w-full px-3 py-2 text-center text-xs text-muted hover:text-primary hover:bg-hover"
                  >
                    Show more ({filteredHistorySessions.length - historyLimit} remaining)
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Keyboard shortcuts hint */}
      <div className="hidden shrink-0 border-t border-border px-3 py-2 md:block">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
          <span>{modDisplay}[ ] nav</span>
          <span>{modDisplay}N new</span>
          <span>{modDisplay}X kill</span>
        </div>
      </div>

      {previewSession && (
        <SessionPreviewModal
          session={previewSession}
          onClose={() => setPreviewSession(null)}
          onResume={(sessionId) => {
            setPreviewSession(null)
            onResume?.(sessionId)
          }}
        />
      )}
    </aside>
  )
}

export { formatRelativeTime }
