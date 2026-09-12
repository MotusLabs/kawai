// WorkspaceGroupedList.tsx - Grouped workspace navigator: live, hibernating,
// and historical session rows rendered inside collapsible worktree groups
// (WorktreeGroupHeader), with explicit local-ungrouped and remote fallback
// sections. Each worktree group owns its own drag context so manual reorder
// stays within the group; flattened cross-group navigation is computed by the
// caller from the same view model. Dormant-row visibility follows the global
// hibernating/history toggles so persisted preferences keep working.

import { useCallback, useState } from 'react'
import { AnimatePresence } from 'motion/react'
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
import type { AgentSession, Session } from '@shared/types'
import type { GroupedSessionEntry, WorkspaceView } from '../utils/workspaceView'
import WorktreeGroupHeader from './WorktreeGroupHeader'
import WorktreeOpenSpecRows from './WorktreeOpenSpecRows'
import HibernatingSessionItem from './HibernatingSessionItem'
import HistorySessionItem from './HistorySessionItem'
import { SortableSessionItem } from './SessionRow'

/** Context shared by every row regardless of its group. */
export interface GroupedRowContext {
  selectedSessionId: string | null
  selectedHibernatingSessionId: string | null
  editingSessionId: string | null
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  showHostInfo: boolean
  prefersReducedMotion: boolean | null
  useSafariLayoutFallback: boolean
  exitDuration: number
  remoteAllowControl: boolean
  onSelect: (sessionId: string) => void
  onSelectHibernating: (sessionId: string) => void
  onStartEdit: (sessionId: string) => void
  onCancelEdit: () => void
  onRename: (sessionId: string, newName: string) => void
  onHibernate: (agentSessionId: string) => void
  onKill: (sessionId: string) => void
  onDuplicate: (sessionId: string) => void
  onResume: (sessionId: string) => void
  onMoveToHistory: (sessionId: string) => void
  onPreview: (session: AgentSession) => void
  /**
   * Manual reorder within one group: the group's live session ids in their
   * new order. The parent merges this into the global manual session order;
   * drops outside the group never reach this callback (per-group DndContext).
   */
  onReorder: (orderedSessionIds: string[]) => void
  /** Per-session new-row marker for entry animations. */
  isNew: (sessionId: string) => boolean
}

interface WorkspaceGroupedListProps extends GroupedRowContext {
  view: WorkspaceView
  onToggleCollapse: (worktreeId: string) => void
  /** Remounts AnimatePresence children when filters change (entry animation). */
  remountKey: string
  /** Global dormant-row visibility (persisted settings). */
  showHibernating: boolean
  showHistory: boolean
  onToggleHibernating: () => void
  onToggleHistory: () => void
  hibernatingCount: number
  historyCount: number
  /** Shared history pagination; each group shows at most this many rows. */
  historyLimit: number
  onShowMoreHistory: () => void
  onNewSession?: () => void
  /** Contextual new-session action on worktree headers. */
  onNewSessionInWorktree?: (worktreePath: string) => void
}

export default function WorkspaceGroupedList(props: WorkspaceGroupedListProps) {
  const {
    view,
    onToggleCollapse,
    remountKey,
    showHibernating,
    showHistory,
    onToggleHibernating,
    onToggleHistory,
    hibernatingCount,
    historyCount,
    historyLimit,
    onShowMoreHistory,
    onNewSession,
    onNewSessionInWorktree,
    ...rowContext
  } = props

  return (
    <div data-testid="workspace-grouped-list">
      {(hibernatingCount > 0 || historyCount > 0) && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted"
          data-testid="workspace-dormant-toggles"
        >
          {hibernatingCount > 0 && (
            <button
              type="button"
              onClick={onToggleHibernating}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-primary"
              aria-expanded={showHibernating}
              data-testid="workspace-hibernating-toggle"
            >
              {showHibernating ? (
                <ChevronDownIcon className="h-3 w-3" />
              ) : (
                <ChevronRightIcon className="h-3 w-3" />
              )}
              Hibernating {hibernatingCount}
            </button>
          )}
          {historyCount > 0 && (
            <button
              type="button"
              onClick={onToggleHistory}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-primary"
              aria-expanded={showHistory}
              data-testid="workspace-history-toggle"
            >
              {showHistory ? (
                <ChevronDownIcon className="h-3 w-3" />
              ) : (
                <ChevronRightIcon className="h-3 w-3" />
              )}
              History {historyCount}
            </button>
          )}
        </div>
      )}

      {view.worktreeGroups.map((group) => (
        <section
          key={group.worktreeId}
          data-testid="worktree-group"
          data-worktree-id={group.worktreeId}
          data-collapsed={group.collapsed ? 'true' : 'false'}
        >
          <WorktreeGroupHeader
            group={group}
            onToggleCollapse={onToggleCollapse}
            actions={
              onNewSessionInWorktree ? (
                <button
                  type="button"
                  className="flex shrink-0 items-center justify-center rounded p-1 text-muted hover:bg-hover hover:text-accent"
                  title={`New session in ${group.worktreePath}`}
                  aria-label={`New session in ${group.repositoryName} worktree ${group.worktreePath}`}
                  data-testid="worktree-new-session"
                  onClick={() => onNewSessionInWorktree(group.worktreePath)}
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                </button>
              ) : undefined
            }
          />
          {!group.collapsed && (
            <>
              <GroupedLiveRows entries={group.entries} ctx={rowContext} remountKey={remountKey} />
              <WorktreeOpenSpecRows openspec={group.openspec} />
              {showHibernating && (
                <GroupedDormantRows
                  entries={group.entries}
                  kind="hibernating"
                  ctx={rowContext}
                />
              )}
              {showHistory && (
                <GroupedDormantRows
                  entries={group.entries}
                  kind="history"
                  ctx={rowContext}
                  limit={historyLimit}
                  onShowMore={onShowMoreHistory}
                />
              )}
            </>
          )}
        </section>
      ))}

      {view.localUngrouped.entries.length > 0 && (
        <section className="border-t border-border" data-testid="local-ungrouped-section">
          <FallbackSectionHeader label="Ungrouped" count={view.localUngrouped.entries.length} />
          <GroupedLiveRows
            entries={view.localUngrouped.entries}
            ctx={rowContext}
            remountKey={remountKey}
          />
          {showHibernating && (
            <GroupedDormantRows
              entries={view.localUngrouped.entries}
              kind="hibernating"
              ctx={rowContext}
            />
          )}
          {showHistory && (
            <GroupedDormantRows
              entries={view.localUngrouped.entries}
              kind="history"
              ctx={rowContext}
              limit={historyLimit}
              onShowMore={onShowMoreHistory}
            />
          )}
        </section>
      )}

      {view.remote.entries.length > 0 && (
        <section className="border-t border-border" data-testid="remote-section">
          <FallbackSectionHeader label="Remote" count={view.remote.entries.length} />
          <GroupedLiveRows
            entries={view.remote.entries}
            ctx={rowContext}
            remountKey={remountKey}
          />
          {showHibernating && (
            <GroupedDormantRows
              entries={view.remote.entries}
              kind="hibernating"
              ctx={rowContext}
            />
          )}
          {showHistory && (
            <GroupedDormantRows
              entries={view.remote.entries}
              kind="history"
              ctx={rowContext}
              limit={historyLimit}
              onShowMore={onShowMoreHistory}
            />
          )}
        </section>
      )}

      {view.visibleEntries.length === 0 && onNewSession && (
        <button
          type="button"
          onClick={onNewSession}
          className="flex w-full items-center gap-1 px-3 py-2 text-xs font-medium text-accent hover:bg-hover"
          data-testid="workspace-new-session"
        >
          + New session
        </button>
      )}
    </div>
  )
}

function FallbackSectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted">
      <span>{label}</span>
      <span className="w-8 text-right text-xs text-muted" aria-label={`${count} session(s)`}>
        {count}
      </span>
    </div>
  )
}

interface GroupedLiveRowsProps {
  entries: GroupedSessionEntry[]
  ctx: GroupedRowContext
  remountKey: string
}

/**
 * The live (active) rows of one group inside their own DndContext: manual
 * reordering is structurally confined to this group — a drop elsewhere is
 * never observed here, so cross-group moves cannot be applied.
 */
function GroupedLiveRows({ entries, ctx, remountKey }: GroupedLiveRowsProps) {
  const liveSessions = entries.flatMap((entry) =>
    entry.kind === 'live' && entry.liveSession ? [entry.liveSession] : []
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement to start drag (prevents accidental drags)
      },
    })
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
      if (!over || active.id === over.id) return
      const keys = liveSessions.map((session) => session.id)
      const oldIndex = keys.indexOf(active.id as string)
      const newIndex = keys.indexOf(over.id as string)
      if (oldIndex === -1 || newIndex === -1) return
      const reordered = [...keys]
      const [removed] = reordered.splice(oldIndex, 1)
      reordered.splice(newIndex, 0, removed)
      ctx.onReorder(reordered)
    },
    [liveSessions, ctx]
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
  }, [])

  if (liveSessions.length === 0) return null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={liveSessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div key={remountKey}>
          {/* sync (not popLayout): without per-row layout animation,
              popLayout would overlap an exiting row with the sibling
              snapping into its place */}
          <AnimatePresence initial={false} mode="sync">
            {liveSessions.map((session, index) => {
              const activeIndex = activeId
                ? liveSessions.findIndex((s) => s.id === activeId)
                : -1
              const isOver = overId === session.id && activeId !== session.id
              const showDropIndicator = isOver ? (activeIndex > index ? 'above' : 'below') : null
              return (
                <SortableSessionItem
                  key={session.id}
                  session={session}
                  isNew={ctx.isNew(session.id)}
                  exitDuration={ctx.exitDuration}
                  prefersReducedMotion={ctx.prefersReducedMotion}
                  useSafariLayoutFallback={ctx.useSafariLayoutFallback}
                  isSelected={session.id === ctx.selectedSessionId}
                  isEditing={session.id === ctx.editingSessionId}
                  showSessionIdPrefix={ctx.showSessionIdPrefix}
                  showProjectName={ctx.showProjectName}
                  showLastUserMessage={ctx.showLastUserMessage}
                  showHostInfo={ctx.showHostInfo}
                  dropIndicator={showDropIndicator}
                  onSelect={() => ctx.onSelect(session.id)}
                  onStartEdit={canControlRow(session, ctx) ? () => ctx.onStartEdit(session.id) : undefined}
                  onCancelEdit={ctx.onCancelEdit}
                  onRename={(newName) => ctx.onRename(session.id, newName)}
                  onHibernate={canHibernateRow(session) ? () => ctx.onHibernate(session.agentSessionId!.trim()) : undefined}
                  onKill={canControlRow(session, ctx) ? () => ctx.onKill(session.id) : undefined}
                  onDuplicate={canControlRow(session, ctx) ? () => ctx.onDuplicate(session.id) : undefined}
                />
              )
            })}
          </AnimatePresence>
        </div>
      </SortableContext>
    </DndContext>
  )
}

function canControlRow(session: Session, ctx: GroupedRowContext): boolean {
  const isRemote = session.remote === true
  const isManaged = session.source === 'managed'
  return !isRemote || (ctx.remoteAllowControl && isManaged)
}

function canHibernateRow(session: Session): boolean {
  return Boolean(
    session.source === 'managed' &&
      session.remote !== true &&
      session.agentSessionId?.trim()
  )
}

interface GroupedDormantRowsProps {
  entries: GroupedSessionEntry[]
  kind: 'hibernating' | 'history'
  ctx: GroupedRowContext
  limit?: number
  onShowMore?: () => void
}

function GroupedDormantRows({ entries, kind, ctx, limit, onShowMore }: GroupedDormantRowsProps) {
  const dormant = entries.flatMap((entry) =>
    entry.kind === kind && entry.agentSession ? [entry.agentSession] : []
  )
  if (dormant.length === 0) return null
  const visible = limit !== undefined ? dormant.slice(0, limit) : dormant

  return (
    <div className="py-1" data-testid={`grouped-${kind}-rows`}>
      {kind === 'hibernating'
        ? visible.map((session) => (
            <HibernatingSessionItem
              key={session.sessionId}
              session={session}
              isSelected={ctx.selectedHibernatingSessionId === session.sessionId}
              showSessionIdPrefix={ctx.showSessionIdPrefix}
              showProjectName={ctx.showProjectName}
              showLastUserMessage={ctx.showLastUserMessage}
              onSelect={(sessionId) => ctx.onSelectHibernating(sessionId)}
              onWake={(sessionId) => ctx.onResume(sessionId)}
              onRename={(sessionId, newName) => ctx.onRename(sessionId, newName)}
              onMoveToHistory={ctx.onMoveToHistory}
            />
          ))
        : visible.map((session) => (
            <HistorySessionItem
              key={session.sessionId}
              session={session}
              showSessionIdPrefix={ctx.showSessionIdPrefix}
              showProjectName={ctx.showProjectName}
              showLastUserMessage={ctx.showLastUserMessage}
              onResume={(sessionId) => ctx.onResume(sessionId)}
              onPreview={ctx.onPreview}
            />
          ))}
      {limit !== undefined && dormant.length > limit && onShowMore && (
        <button
          type="button"
          onClick={onShowMore}
          className="w-full px-3 py-2 text-center text-xs text-muted hover:text-primary hover:bg-hover"
        >
          Show more ({dormant.length - limit} remaining)
        </button>
      )}
    </div>
  )
}
